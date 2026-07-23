// lib/__tests__/rerank-backend.test.ts — R-10 rerank backend hardening + OpenRouter Cohere ruler.
// Verifies the functional discrimination probe + 3-way error taxonomy (Stage 0) and rerankCohere
// (Stage 1). Injected fetch/clock — no network/LLM. Production stays on judge (score-invariant).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  rerank, resolveRerankBackend, assertRerankBackendHealthy, rerankCohere, _resetRerankHealth,
  RerankBackendError, RerankBackendUnreachable, RerankBackendUnhealthy,
  RERANK_HEALTH_MIN_REL, RERANK_HEALTH_MIN_MARGIN,
  type RerankDeps, type RerankCandidate, type RerankResult,
} from '../rerank.ts';
import { pickScoreFields } from '../mcp-tools.ts';

const cands = () => [{ id: 1, text: 'alpha' }, { id: 2, text: 'beta' }];
function countingBackend(tag: 'judge' | 'cohere', counter: { n: number }): NonNullable<RerankDeps['cohereFn']> {
  return async <U extends RerankCandidate>(_q: string, c: U[]): Promise<RerankResult<U>[]> => {
    counter.n++;
    return c.map((x, i) => ({ ...x, rerank_score: 1 - i / c.length, rerank_backend: tag }));
  };
}
// a Cohere-shaped /rerank response
const cohereRes = (pairs: [number, number][]) =>
  (async () => new Response(JSON.stringify({ results: pairs.map(([index, relevance_score]) => ({ index, relevance_score })) }), { status: 200 })) as unknown as typeof fetch;

const withKey = async (fn: () => Promise<void>) => {
  const prev = process.env.OPENROUTER_API_KEY; process.env.OPENROUTER_API_KEY = 'k';
  try { await fn(); } finally { if (prev === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prev; }
};

// ── routing (pure) — bge is gone; judge default, cohere override ──
test('resolveRerankBackend: explicit override wins, else env default; only judge|cohere', () => {
  assert.equal(resolveRerankBackend('cohere', 'judge'), 'cohere');
  assert.equal(resolveRerankBackend('judge', 'cohere'), 'judge');
  assert.equal(resolveRerankBackend(undefined, 'judge'), 'judge');
  assert.equal(resolveRerankBackend(undefined, 'cohere'), 'cohere');
});

test('no backend arg routes to the env default (judge in the test env), not cohere', async () => {
  const judge = { n: 0 }, cohere = { n: 0 };
  await rerank('q', cands(), undefined, { judgeFn: countingBackend('judge', judge), cohereFn: countingBackend('cohere', cohere), checkHealthy: async () => {} });
  assert.equal(judge.n, 1); assert.equal(cohere.n, 0);
});

// ── §5.1 probe PASSES on a discriminating backend ──
test('assertRerankBackendHealthy passes when rel=0.8, irr=0.02', async () => {
  await withKey(async () => {
    _resetRerankHealth();
    await assertRerankBackendHealthy('cohere', { fetchImpl: cohereRes([[0, 0.8], [1, 0.02]]), now: () => 1000 });
  });
});

// ── §5.2 FAILS Unhealthy on thin margin ──
test('probe fails RerankBackendUnhealthy when the margin < MIN_MARGIN (rel=0.5, irr=0.45)', async () => {
  await withKey(async () => {
    _resetRerankHealth();
    await assert.rejects(
      assertRerankBackendHealthy('cohere', { fetchImpl: cohereRes([[0, 0.5], [1, 0.45]]), now: () => 1000 }),
      (e: unknown) => e instanceof RerankBackendUnhealthy,
    );
  });
});

// ── §5.3 FAILS Unhealthy on constant scores (the silent no-op the OLD guard missed) ──
test('probe fails Unhealthy when the backend returns CONSTANT scores (no discrimination)', async () => {
  await withKey(async () => {
    _resetRerankHealth();
    await assert.rejects(
      assertRerankBackendHealthy('cohere', { fetchImpl: cohereRes([[0, 0.7], [1, 0.7]]), now: () => 1000 }),
      (e: unknown) => e instanceof RerankBackendUnhealthy,   // margin 0 < 0.15
    );
  });
});

// ── §5.4 FAILS Unreachable on fetch throw / non-200 / missing key ──
test('probe fails RerankBackendUnreachable on fetch throw, non-200, or missing key', async () => {
  await withKey(async () => {
    _resetRerankHealth();
    const boom = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await assert.rejects(assertRerankBackendHealthy('cohere', { fetchImpl: boom, now: () => 1 }), (e: unknown) => e instanceof RerankBackendUnreachable);
    _resetRerankHealth();
    const http500 = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    await assert.rejects(assertRerankBackendHealthy('cohere', { fetchImpl: http500, now: () => 2 }), (e: unknown) => e instanceof RerankBackendUnreachable);
  });
  // missing key ⇒ Unreachable (no env key)
  const prev = process.env.OPENROUTER_API_KEY; delete process.env.OPENROUTER_API_KEY;
  try {
    _resetRerankHealth();
    await assert.rejects(assertRerankBackendHealthy('cohere', { fetchImpl: cohereRes([[0, 0.9], [1, 0.0]]), now: () => 3 }), (e: unknown) => e instanceof RerankBackendUnreachable);
  } finally { if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev; }
});

// ── §5.5 memoized per (backend,model), 10-min TTL ──
test('probe is memoized within the TTL — two calls ⇒ one fetch', async () => {
  await withKey(async () => {
    _resetRerankHealth();
    let calls = 0;
    const spy = (async () => { calls++; return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.8 }, { index: 1, relevance_score: 0.02 }] }), { status: 200 }); }) as unknown as typeof fetch;
    await assertRerankBackendHealthy('cohere', { fetchImpl: spy, now: () => 100000 });
    await assertRerankBackendHealthy('cohere', { fetchImpl: spy, now: () => 100000 + 60000 });   // +1min, within 10min TTL
    assert.equal(calls, 1, 'second call within TTL must not re-fetch');
  });
});

// ── §5.6 rerankCohere maps results[].index back, sets cohere, NO sigmoid ──
test('rerankCohere maps index→candidate, uses relevance_score directly (no sigmoid), tags cohere', async () => {
  await withKey(async () => {
    // candidate 0='alpha', 1='beta'; Cohere ranks beta(0.8) > alpha(0.02), returned out of order
    const out = await rerankCohere('q', cands(), cohereRes([[1, 0.8], [0, 0.02]]));
    assert.equal(out[0].id, 2, 'beta (index 1, score 0.8) sorts first');
    assert.equal(out[0].rerank_score, 0.8, 'relevance_score used directly — NOT sigmoided (0.8, not ~0.69)');
    assert.equal(out[0].rerank_backend, 'cohere');
    assert.equal(out[1].id, 1);
    assert.equal(out[1].rerank_score, 0.02);
  });
});

// ── §5.7 explicit cohere is STRICT: probe runs before scoring; a probe failure propagates ──
test('explicit cohere runs the health probe BEFORE scoring, and a probe failure propagates (not swallowed)', async () => {
  const order: string[] = [];
  await rerank('q', cands(), 'cohere', {
    checkHealthy: async () => { order.push('probe'); },
    cohereFn: async (_q, c) => { order.push('score'); return c.map((x) => ({ ...x, rerank_score: 0.5, rerank_backend: 'cohere' as const })); },
  });
  assert.deepEqual(order, ['probe', 'score'], 'probe strictly precedes scoring');

  await assert.rejects(
    rerank('q', cands(), 'cohere', {
      checkHealthy: async () => { throw new RerankBackendUnhealthy('cohere', 'm', 'no discrimination'); },
      cohereFn: async () => { throw new Error('cohere must not run when the probe fails'); },
    }),
    (e: unknown) => e instanceof RerankBackendError && e instanceof RerankBackendUnhealthy,
  );
});

test('a TRANSIENT (generic, non-typed) failure still soft-falls to input order', async () => {
  const out = await rerank('q', cands(), 'cohere', {
    checkHealthy: async () => {},
    cohereFn: async () => { throw new Error('transient 503') /* NOT a RerankBackendError */; },
  });
  assert.equal(out.length, 2);
  assert.ok(out.every((h) => h.rerank_backend === 'none'), 'generic failure ⇒ input order preserved');
});

// ── §5.8 no 'bge' symbol remains ──
test('the rerank module no longer contains any bge symbol', () => {
  const src = readFileSync('lib/rerank.ts', 'utf8');
  assert.ok(!/\bbge\b/i.test(src), 'no bge identifier/comment should remain');
  assert.ok(!/rerankBge|assertBgeAvailable|BGE_MODEL/.test(src));
});

// thresholds are the settled defaults
test('discrimination thresholds default to 0.40 / 0.15', () => {
  assert.equal(RERANK_HEALTH_MIN_REL, 0.40);
  assert.equal(RERANK_HEALTH_MIN_MARGIN, 0.15);
});

// scoresOnly trim (unchanged) — kept from the prior file
test('pickScoreFields drops text/section, keeps ids + scores', () => {
  const t = pickScoreFields({ final_rank: 1, id: 7, source: 's', book: 'b', chapter: 'c', section: 'sec', item_number: 'i', similarity: 0.5, vector_rank: 2, bm25_rank: 3, bm25_variant_ranks: [3, null], rrf_score: 0.1, rerank_score: 0.9, rerank_backend: 'cohere', source_quality_weight: 0.95, text: 'BIG' });
  assert.equal('text' in t, false);
  assert.equal('section' in t, false);
  assert.equal(t.rerank_backend, 'cohere');
});
