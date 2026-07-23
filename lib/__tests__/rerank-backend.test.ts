// lib/__tests__/rerank-backend.test.ts — deterministic rerank backend override + scoresOnly trim
// (R-10, the BM25 Stage-2 A/B ruler). Injected collaborators — no network/LLM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rerank, resolveRerankBackend, assertBgeAvailable, RerankBackendUnavailableError,
  type RerankDeps, type RerankCandidate, type RerankResult,
} from '../rerank.ts';
import { pickScoreFields } from '../mcp-tools.ts';

const cands = () => [{ id: 1, text: 'alpha' }, { id: 2, text: 'beta' }];

// a backend stub that counts its calls and tags every result with its name
function countingBackend(tag: 'bge' | 'judge', counter: { n: number }): NonNullable<RerankDeps['bgeFn']> {
  return async <U extends RerankCandidate>(_q: string, c: U[]): Promise<RerankResult<U>[]> => {
    counter.n++;
    return c.map((x, i) => ({ ...x, rerank_score: 1 - i / c.length, rerank_backend: tag }));
  };
}

// ── Test 5 (routing decision, pure) — explicit override wins, else env default ──
test('resolveRerankBackend: explicit override wins, else the env default', () => {
  assert.equal(resolveRerankBackend('bge', 'judge'), 'bge');
  assert.equal(resolveRerankBackend('judge', 'bge'), 'judge');
  assert.equal(resolveRerankBackend(undefined, 'judge'), 'judge');
  assert.equal(resolveRerankBackend(undefined, 'bge'), 'bge');
});

// ── Test 1 — no backend arg ⇒ identical to today (uses env BACKEND, 'judge' in the test env) ──
test('no backend argument routes via the env default (judge), not bge', async () => {
  const bge = { n: 0 }, judge = { n: 0 };
  const deps: RerankDeps = { bgeFn: countingBackend('bge', bge), judgeFn: countingBackend('judge', judge), checkBgeAvailable: async () => {} };
  await rerank('q', cands(), undefined, deps);
  assert.equal(judge.n, 1, 'env default is judge');
  assert.equal(bge.n, 0);
});

// ── Test 2 — explicit backend routes to that path ──
test('rerank(query, cands, "bge") routes to bge; "judge" routes to judge', async () => {
  const bge = { n: 0 }, judge = { n: 0 };
  const deps: RerankDeps = { checkBgeAvailable: async () => {}, bgeFn: countingBackend('bge', bge), judgeFn: countingBackend('judge', judge) };
  const b = await rerank('q', cands(), 'bge', deps);
  const j = await rerank('q', cands(), 'judge', deps);
  assert.equal(bge.n, 1); assert.equal(judge.n, 1);
  assert.equal(b[0].rerank_backend, 'bge');
  assert.equal(j[0].rerank_backend, 'judge');
});

// ── Test 4 — bge requested + unavailable ⇒ named error, NO silent fallback ──
test('explicit bge + unavailable throws RerankBackendUnavailableError and never runs bge', async () => {
  await assert.rejects(
    rerank('q', cands(), 'bge', {
      checkBgeAvailable: async () => { throw new RerankBackendUnavailableError('bge-reranker-v2-m3'); },
      bgeFn: (async () => { throw new Error('bge must not run when unavailable'); }) as RerankDeps['bgeFn'],
    }),
    (e: unknown) => e instanceof RerankBackendUnavailableError && (e as Error).name === 'RerankBackendUnavailableError',
  );
});

test('a TRANSIENT bge failure still soft-falls-back to input order (only the named error hard-fails)', async () => {
  const out = await rerank('q', cands(), 'bge', {
    checkBgeAvailable: async () => {},
    bgeFn: (async () => { throw new Error('transient HTTP 500'); }) as RerankDeps['bgeFn'],
  });
  assert.equal(out.length, 2);
  assert.ok(out.every((h) => h.rerank_backend === 'none'), 'transient failure preserves input order, not a hard error');
});

test('assertBgeAvailable: 404 / no-base ⇒ named error, 200 ⇒ resolves', async () => {
  const f = (status: number) => (async () => new Response('', { status })) as unknown as typeof fetch;
  await assert.rejects(assertBgeAvailable('http://mini', f(404)), (e: unknown) => e instanceof RerankBackendUnavailableError);
  await assert.rejects(assertBgeAvailable(undefined, f(200)), (e: unknown) => e instanceof RerankBackendUnavailableError);
  await assertBgeAvailable('http://mini', f(200));   // present ⇒ no throw
});

// ── Test 3 — scoresOnly trims text (and section); keeps ids + scores ──
test('pickScoreFields drops text + section, keeps ids and all score fields', () => {
  const h = {
    final_rank: 1, id: 7, source: 'uptodate', book: 'UpToDate', chapter: 'ch', section: 'SECRET SECTION',
    item_number: 'i1', similarity: 0.5, vector_rank: 2, bm25_rank: 3, bm25_variant_ranks: [3, null],
    rrf_score: 0.12, rerank_score: 0.9, rerank_backend: 'bge', source_quality_weight: 0.95, text: 'BIG CHUNK TEXT',
  };
  const t = pickScoreFields(h);
  assert.equal('text' in t, false, 'no chunk text in scoresOnly');
  assert.equal('section' in t, false, 'no section in scoresOnly');
  assert.equal(t.id, 7);
  assert.equal(t.rerank_score, 0.9);
  assert.equal(t.rerank_backend, 'bge');
  assert.equal(t.bm25_rank, 3);
  assert.deepEqual(t.bm25_variant_ranks, [3, null]);
  assert.equal(t.source_quality_weight, 0.95);
});
