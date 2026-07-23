// lib/__tests__/lab-batch-eval-drain.test.ts — R-11 Phase 2 eval-drain concurrency. The mini path
// (no evalModel) must stay byte-identical (n≤2, serial, mini-yield honoured); the eval path fans out
// bounded via OpenRouter and skips the mini-yield. Pure — no DB/network (fetch/sleep injected).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  drainPlan, boundedPool, clampEvalConcurrency, parseBatchState, LB_KEYS,
  EVAL_TICK_MAX, EVAL_CONCURRENCY_DEFAULT, EVAL_CONCURRENCY_MAX,
} from '../lab-batch-core.ts';
import { openRouterGenerate, openRouterRetryable, openRouterBackoffMs, OPENROUTER_MAX_TRIES } from '../opd-note-audit.ts';

// ── Test 1 — no evalModel ⇒ the mini drain plan is EXACTLY the legacy shape (regression guard) ──
test('mini path (no evalModel): n≤2, serial (concurrency 1), mini-yield honoured', () => {
  const plan = drainPlan({ evalModel: null, n: 2 });
  assert.deepEqual(plan, { evalMode: false, sliceSize: 2, concurrency: 1, useMiniYield: true });
  assert.deepEqual(drainPlan({ evalModel: null, n: 1 }), { evalMode: false, sliceSize: 1, concurrency: 1, useMiniYield: true });
});

// ── Test 2 — evalModel set ⇒ EVAL_TICK_MAX slice, no mini-yield ──
test('eval path (evalModel set): drains up to EVAL_TICK_MAX and skips the mini-yield', () => {
  const plan = drainPlan({ evalModel: 'google/gemini-3.1-flash-lite', evalConcurrency: 10, n: 2 });
  assert.deepEqual(plan, { evalMode: true, sliceSize: EVAL_TICK_MAX, concurrency: 10, useMiniYield: false });
  assert.equal(EVAL_TICK_MAX, 50);
  // concurrency defaults + clamps
  assert.equal(drainPlan({ evalModel: 'm', n: 2 }).concurrency, EVAL_CONCURRENCY_DEFAULT);
  assert.equal(drainPlan({ evalModel: 'm', evalConcurrency: 999, n: 2 }).concurrency, EVAL_CONCURRENCY_MAX);
});

test('clampEvalConcurrency: default 10, clamp 1..25', () => {
  assert.equal(clampEvalConcurrency(undefined), 10);
  assert.equal(clampEvalConcurrency('abc'), 10);
  assert.equal(clampEvalConcurrency(0), 10);
  assert.equal(clampEvalConcurrency(1), 1);
  assert.equal(clampEvalConcurrency(25), 25);
  assert.equal(clampEvalConcurrency(26), 25);
});

// ── Test 3 — the pool is BOUNDED: never more than `limit` tasks in flight ──
test('boundedPool never exceeds its concurrency limit and preserves result order', async () => {
  const LIMIT = 5;
  let inFlight = 0, maxInFlight = 0;
  const items = Array.from({ length: 23 }, (_, i) => i);
  const results = await boundedPool(items, LIMIT, async (i) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 2 + (i % 3)));
    inFlight--;
    return i * 10;
  });
  assert.ok(maxInFlight <= LIMIT, `in-flight peaked at ${maxInFlight} > ${LIMIT}`);
  assert.ok(maxInFlight > 1, 'pool must actually run concurrently');
  assert.deepEqual(results, items.map((i) => i * 10), 'results index-aligned to items');
});

test('boundedPool handles limit > items and empty input', async () => {
  assert.deepEqual(await boundedPool([1, 2], 10, async (x) => x + 1), [2, 3]);
  assert.deepEqual(await boundedPool([], 10, async (x) => x), []);
});

// ── Test 4 — 429/5xx retried (bounded, backoff) then thrown; success after transient yields output ──
test('openRouterGenerate retries 429 then succeeds; sleeps between attempts', async () => {
  const prev = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'k';
  try {
    let calls = 0; const sleeps: number[] = [];
    const fetchSeq = (async () => {
      calls++;
      if (calls < 3) return new Response('rate limited', { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK-AFTER-RETRY' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await openRouterGenerate('m', 's', 'u', fetchSeq, async (ms) => { sleeps.push(ms); });
    assert.equal(out, 'OK-AFTER-RETRY');
    assert.equal(calls, 3);
    assert.equal(sleeps.length, 2, 'backoff sleep between each retry');
    assert.ok(sleeps.every((ms) => ms > 0));
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prev;
  }
});

test('openRouterGenerate throws after OPENROUTER_MAX_TRIES persistent 5xx — no silent fallback', async () => {
  const prev = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'k';
  try {
    let calls = 0;
    const fetch500 = (async () => { calls++; return new Response('boom', { status: 500 }); }) as unknown as typeof fetch;
    await assert.rejects(openRouterGenerate('m', 's', 'u', fetch500, async () => {}), /OpenRouter HTTP 500/);
    assert.equal(calls, OPENROUTER_MAX_TRIES, 'bounded: exactly max tries');
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prev;
  }
});

test('non-transient status (400) throws immediately — no retry', async () => {
  const prev = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'k';
  try {
    let calls = 0; const sleeps: number[] = [];
    const fetch400 = (async () => { calls++; return new Response('bad request', { status: 400 }); }) as unknown as typeof fetch;
    await assert.rejects(openRouterGenerate('m', 's', 'u', fetch400, async (ms) => { sleeps.push(ms); }), /OpenRouter HTTP 400/);
    assert.equal(calls, 1);
    assert.equal(sleeps.length, 0);
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prev;
  }
});

test('retryable statuses are exactly 429 + 5xx; backoff is jittered-exponential and positive', () => {
  assert.equal(openRouterRetryable(429), true);
  assert.equal(openRouterRetryable(500), true);
  assert.equal(openRouterRetryable(503), true);
  assert.equal(openRouterRetryable(400), false);
  assert.equal(openRouterRetryable(401), false);
  assert.equal(openRouterRetryable(404), false);
  // attempt 1 ~ [250,750), attempt 2 ~ [500,1500) — monotone base, bounded
  assert.equal(openRouterBackoffMs(1, () => 0), 250);
  assert.equal(openRouterBackoffMs(1, () => 0.999), 750);
  assert.equal(openRouterBackoffMs(2, () => 0), 500);
});

// ── Test 5 — eval path still writes lab_analyses only (structural, unchanged from b216d86) ──
test('the eval drain still writes lab_analyses only — never opd_note_audits', () => {
  const src = readFileSync('lib/lab-batch.ts', 'utf8');
  assert.ok(src.includes('saveLabAnalysis'));
  assert.ok(!src.includes('saveOpdAudit'));
  assert.ok(!/opd-audit-store/.test(src));
  assert.ok(!/INSERT\s+INTO\s+opd_note_audits/i.test(src));
});

// batch state round-trips the concurrency; absent ⇒ default
test('parseBatchState reads evalConcurrency; absent ⇒ default 10', () => {
  assert.equal(parseBatchState({}).evalConcurrency, 10);
  assert.equal(parseBatchState({ [LB_KEYS.evalConcurrency]: '25' } as Record<string, string>).evalConcurrency, 25);
  assert.equal(parseBatchState({ [LB_KEYS.evalConcurrency]: '99' } as Record<string, string>).evalConcurrency, 25);
});
