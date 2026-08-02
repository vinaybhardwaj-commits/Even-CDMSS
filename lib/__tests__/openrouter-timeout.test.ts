/**
 *   node --test --import tsx lib/__tests__/openrouter-timeout.test.ts
 *
 * OPENROUTER-TIMEOUT-ROOT-CAUSE PRD v1.0 (2 Aug 2026) — the retry helper honours the caller.
 *
 * THE DEFECT: openrouterCreateWithRetry hard-coded OPENROUTER_TIMEOUT_MS (110 s) for BOTH the
 * AbortController deadline and the SDK timeout, discarding the caller's. The OPD audit runs
 * p50 267 s / p75 425 s and passes LLM_AUDIT_TIMEOUT_MS (600 s) through governedChat — so on the
 * OpenRouter bridge THE MEDIAN AUDIT COULD NEVER COMPLETE. From 30 July (bridge live) every
 * median-or-slower audit aborted three times and fell through to the local model: 126 notes graded
 * by qwen2.5:14b overnight, ZERO by Gemini.
 *
 * The fast tail still succeeded — a 79 s manual audit reached Gemini — which is why it read as
 * intermittent rather than broken.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  openrouterCreateWithRetry, OPENROUTER_TIMEOUT_MS, OPENROUTER_MAX_TRIES,
  openRouterRetryable, openRouterBackoffMs, type OpenrouterAttemptOpts,
} from '../openrouter-retry.ts';

/** A doAttempt that records the opts it was handed and resolves with a valid completion. */
function recorder(result: unknown = { choices: [{ message: { content: 'ok' } }] }) {
  const seen: OpenrouterAttemptOpts[] = [];
  const fn = async (o: OpenrouterAttemptOpts) => { seen.push(o); return result; };
  return { fn, seen };
}
/** Reads the AbortController deadline actually armed, by racing the signal rather than the clock. */
const noSleep = async () => {};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The ceiling actually applied
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('NO timeoutMs → OPENROUTER_TIMEOUT_MS, byte-identical to before', async () => {
  const { fn, seen } = recorder();
  await openrouterCreateWithRetry(fn, { sleepFn: noSleep });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].timeout, OPENROUTER_TIMEOUT_MS, 'the SDK timeout is the module default');
  assert.equal(seen[0].timeout, 110_000, 'and that default is still 110 s');
  assert.equal(seen[0].maxRetries, 0, 'SDK-internal retries stay off');
});

test('timeoutMs: 600_000 → the doAttempt timeout is 600 000, not 110 000', async () => {
  const { fn, seen } = recorder();
  await openrouterCreateWithRetry(fn, { timeoutMs: 600_000, sleepFn: noSleep });
  assert.equal(seen[0].timeout, 600_000, 'the audit ceiling reaches the provider call');
  assert.notEqual(seen[0].timeout, OPENROUTER_TIMEOUT_MS);
});

test('timeoutMs: 600_000 → the ABORTCONTROLLER deadline is 600 000 too, not just the SDK belt', async () => {
  // Both were hard-coded; fixing only one would still abort the call at 110 s. Rather than wait,
  // capture the delay the timer was armed with by intercepting setTimeout for the duration.
  const realSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).setTimeout = ((cb: () => void, ms?: number, ...rest: unknown[]) => {
    if (typeof ms === 'number') delays.push(ms);
    return realSetTimeout(cb, ms as number, ...(rest as []));
  }) as typeof setTimeout;
  try {
    const { fn } = recorder();
    await openrouterCreateWithRetry(fn, { timeoutMs: 600_000, sleepFn: noSleep });
    assert.ok(delays.includes(600_000), `the abort timer was armed with ${JSON.stringify(delays)}, expected 600000`);
    assert.ok(!delays.includes(110_000), 'and NOT with the old constant');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('a junk timeoutMs degrades to the default — a deadline may never be switched off', async () => {
  for (const bad of [0, -1, NaN, Infinity, undefined]) {
    const { fn, seen } = recorder();
    await openrouterCreateWithRetry(fn, { timeoutMs: bad as number, sleepFn: noSleep });
    assert.equal(seen[0].timeout, OPENROUTER_TIMEOUT_MS, `timeoutMs=${String(bad)}`);
  }
});

test('the terminal error message reports the APPLIED timeout, not the constant', async () => {
  const abortOnly = async (o: OpenrouterAttemptOpts) => {
    // simulate the deadline firing: abort the signal, then throw as the SDK does
    (o.signal as AbortSignal & { dispatchEvent?: unknown });
    await new Promise<void>((r) => setTimeout(r, 0));
    const err = new Error('The user aborted a request.');
    // force ctrl.signal.aborted by aborting through the timer the helper armed
    throw err;
  };
  // Drive a real abort by giving a 1 ms ceiling and never resolving.
  const hang = (o: OpenrouterAttemptOpts) => new Promise((_res, rej) => {
    o.signal.addEventListener('abort', () => rej(new Error('The user aborted a request.')));
  });
  void abortOnly;
  await assert.rejects(
    () => openrouterCreateWithRetry(hang, { timeoutMs: 7, sleepFn: noSleep }),
    (e: Error) => {
      assert.match(e.message, /openrouter TIMEOUT after 7ms/, `got: ${e.message}`);
      assert.ok(!/110000/.test(e.message), 'must not report the constant it did not use');
      assert.match(e.message, new RegExp(`attempt ${OPENROUTER_MAX_TRIES}/${OPENROUTER_MAX_TRIES}`));
      return true;
    },
  );
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · What must NOT change
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('OPENROUTER_MAX_TRIES is still 3 and OPENROUTER_TIMEOUT_MS still defaults to 110 000', () => {
  assert.equal(OPENROUTER_MAX_TRIES, 3);
  assert.equal(OPENROUTER_TIMEOUT_MS, 110_000);
  const src = readFileSync('lib/openrouter-retry.ts', 'utf8');
  assert.ok(src.includes('export const OPENROUTER_MAX_TRIES = 3;'));
  assert.ok(src.includes('export const OPENROUTER_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS) || 110_000;'));
});

test('retry CLASSIFICATION is unchanged: 429 and 5xx retry, 4xx does not', () => {
  assert.equal(openRouterRetryable(429), true);
  assert.equal(openRouterRetryable(500), true);
  assert.equal(openRouterRetryable(503), true);
  assert.equal(openRouterRetryable(400), false);
  assert.equal(openRouterRetryable(401), false);
  assert.equal(openRouterRetryable(404), false);
  assert.equal(openRouterRetryable(422), false);
});

test('a 4xx throws immediately — one attempt, no retry', async () => {
  let calls = 0;
  const http = async () => { calls++; const e = new Error('bad request') as Error & { status: number }; e.status = 400; throw e; };
  await assert.rejects(() => openrouterCreateWithRetry(http, { sleepFn: noSleep }));
  assert.equal(calls, 1, 'a non-transient status must not consume the retry budget');
});

test('a 429 retries the full budget', async () => {
  let calls = 0;
  const rate = async () => { calls++; const e = new Error('rate limited') as Error & { status: number }; e.status = 429; throw e; };
  await assert.rejects(() => openrouterCreateWithRetry(rate, { sleepFn: noSleep, rand: () => 0.5 }));
  assert.equal(calls, OPENROUTER_MAX_TRIES);
});

test('an ABORT retries — a deadline that ended the call must not end the budget', async () => {
  let calls = 0;
  const hang = (o: OpenrouterAttemptOpts) => { calls++; return new Promise((_r, rej) => {
    o.signal.addEventListener('abort', () => rej(new Error('The user aborted a request.')));
  }); };
  await assert.rejects(() => openrouterCreateWithRetry(hang, { timeoutMs: 5, sleepFn: noSleep }));
  assert.equal(calls, OPENROUTER_MAX_TRIES, 'aborts retry on the same bounded budget');
});

test('the backoff curve is untouched', () => {
  assert.equal(openRouterBackoffMs(1, () => 0.5), 500);
  assert.equal(openRouterBackoffMs(2, () => 0.5), 1000);
  assert.equal(openRouterBackoffMs(3, () => 0.5), 2000);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · The plumbing and the boxes
// ═════════════════════════════════════════════════════════════════════════════════════════════

test("chatWithFallback's OpenRouter branch passes the caller's timeout through", () => {
  const src = readFileSync('lib/llm.ts', 'utf8');
  const branch = src.slice(src.indexOf('await openrouterCreateWithRetry'), src.indexOf('endProviderCall(\'openrouter\');'));
  assert.ok(/\btimeoutMs,/.test(branch), 'the branch that previously dropped it now forwards it');
  // the Vertex/Ollama branches keep using reqOpts, untouched
  assert.ok(src.includes('const reqOpts = timeoutMs ? { timeout: timeoutMs } : undefined;'), 'reqOpts unchanged');
  assert.ok(src.includes('return llm.chat.completions.create(params, reqOpts);'), 'the Ollama path is unchanged');
});

test('the IPD worker box is 800 s, matching the OPD worker', () => {
  const ipd = readFileSync('app/api/ipd-audit/worker/route.ts', 'utf8');
  assert.ok(ipd.includes('export const maxDuration = 800;'), 'a 600 s call cannot live in a 300 s box');
  const opd = readFileSync('app/api/opd-audit/worker/route.ts', 'utf8');
  assert.ok(opd.includes('export const maxDuration = 800;'), 'the OPD worker is untouched and still 800');
});

test('vercel.json has NO /api/ipd-audit/worker cron, and every other cron survives', () => {
  const cfg = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: { path: string; schedule: string }[] };
  assert.ok(!cfg.crons.some((c) => c.path.startsWith('/api/ipd-audit/worker')),
    'DEC-2: disabled — it 504d on every run and produced nothing');
  // the removal must be surgical: 14 crons remain, and the OPD window is untouched
  assert.equal(cfg.crons.length, 14);
  assert.ok(cfg.crons.some((c) => c.path === '/api/opd-audit/worker?conc=4' && c.schedule === '*/4 18-23,0-2 * * *'),
    'the OPD overnight window is not disturbed');
  // and the reason is recorded where someone re-enabling it will look (JSON cannot hold a comment)
  const ipd = readFileSync('app/api/ipd-audit/worker/route.ts', 'utf8');
  assert.ok(/THE CRON FOR THIS ROUTE IS DISABLED/.test(ipd));
  assert.ok(/DO NOT RE-ENABLE until the 800 s box is verified/.test(ipd));
});
