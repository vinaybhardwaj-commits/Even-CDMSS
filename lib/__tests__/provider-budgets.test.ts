/**
 *   node --test --import tsx lib/__tests__/provider-budgets.test.ts
 *
 * PROVIDER-SWITCH Unit A (PRD §4, 2 Aug 2026) — the provider catalogue.
 *
 * WHY THE BUDGETS EXIST. Both of 2 August's outages were the same missing fact: nobody could state,
 * as a number, how long a call of a given class on a given provider may take. A 110 s per-attempt
 * constant sat in front of a p50 267 s audit and silently degraded the cloud grader to the local
 * model from 30 July to 2 August (126 notes by qwen, zero by Gemini, every row still labelled
 * gemini-2.5-pro). The same day the IPD worker's ~1,530 s batch sat in an 800 s route and 504'd on
 * every run. This table is the fact both were missing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAB_PROVIDERS, PROVIDER_BUDGETS, totalBudgetMs, backoffAllowanceMs, resolveProvider,
  DEFAULT_PAID_CEILING, checkPaidCeiling,
  type LabProvider, type CallClass,
} from '../lab-provider-core.ts';
import { probeReachable } from '../lab-override.ts';

const CALL_CLASSES: CallClass[] = ['audit', 'audit_ipd', 'utility', 'doc_read'];
const MINI = 'qwen2.5:14b';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The catalogue is complete
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('bedrock is in LAB_PROVIDERS, and the other three are untouched', () => {
  assert.deepEqual([...LAB_PROVIDERS], ['ollama', 'openrouter', 'vertex', 'bedrock']);
});

test('EVERY provider has an entry for EVERY call class', () => {
  for (const p of LAB_PROVIDERS) {
    assert.ok(PROVIDER_BUDGETS[p], `${p} has a budget block`);
    for (const c of CALL_CLASSES) {
      assert.ok(c in PROVIDER_BUDGETS[p], `${p}.${c} is declared`);
      const b = PROVIDER_BUDGETS[p][c];
      // null is a legitimate DECLARED value meaning "this provider does not serve this class";
      // undefined would mean somebody forgot.
      assert.ok(b === null || (typeof b.perAttemptMs === 'number' && typeof b.maxTries === 'number'),
        `${p}.${c} is a budget or an explicit null`);
      if (b) {
        assert.ok(b.perAttemptMs > 0, `${p}.${c} perAttemptMs > 0`);
        assert.ok(b.maxTries >= 1, `${p}.${c} maxTries >= 1`);
      }
    }
  }
});

test('the measured table, verbatim', () => {
  const expect: Record<LabProvider, Record<CallClass, [number, number] | null>> = {
    ollama:     { audit: [380_000, 1], audit_ipd: [200_000, 1], utility: [90_000, 1],  doc_read: null },
    openrouter: { audit: [380_000, 1], audit_ipd: [200_000, 1], utility: [110_000, 3], doc_read: [180_000, 1] },
    vertex:     { audit: [380_000, 1], audit_ipd: [200_000, 1], utility: [110_000, 3], doc_read: [180_000, 1] },
    bedrock:    { audit: [380_000, 1], audit_ipd: [200_000, 1], utility: [110_000, 3], doc_read: [180_000, 1] },
  };
  for (const p of LAB_PROVIDERS) {
    for (const c of CALL_CLASSES) {
      const want = expect[p][c];
      const got = PROVIDER_BUDGETS[p][c];
      if (want === null) { assert.equal(got, null, `${p}.${c} must be n/a`); continue; }
      assert.deepEqual({ perAttemptMs: got!.perAttemptMs, maxTries: got!.maxTries },
        { perAttemptMs: want[0], maxTries: want[1] }, `${p}.${c}`);
    }
  }
});

test('OLLAMA AUDIT IS SINGLE-TRY — a local box that missed the budget will not answer on a re-ask', () => {
  assert.equal(PROVIDER_BUDGETS.ollama.audit!.maxTries, 1);
  assert.equal(PROVIDER_BUDGETS.ollama.audit_ipd!.maxTries, 1);
  assert.equal(PROVIDER_BUDGETS.ollama.utility!.maxTries, 1);
});

/**
 * ⚠️ THIS ASSERTION REVERSED ON 3 AUGUST, and the reversal is the point rather than an erosion.
 *
 * It used to read: "every PAID provider retries, because there a retry buys something", pinning
 * audit.maxTries === 3 on openrouter/vertex/bedrock. DEC-B4 (Addendum B) overturned that once the
 * arithmetic was done honestly: a retry ladder is MULTIPLICATIVE against the route's box, and the
 * OPD audit fires up to OPD_AUDIT_LEGS legs, so 3 tries × 380 s × 2 legs is 2,280 s inside an
 * 800 s maxDuration. The route could not hold its own retry policy — it died mid-batch and wrote
 * nothing for the notes still in flight, which is strictly worse than not retrying.
 *
 * THE RETRY DID NOT DISAPPEAR, IT MOVED (Addendum B §4.2). Both workers sweep for un-audited work
 * every tick, so the sweep is the retry with a whole window of budget rather than the tail of one
 * invocation; a transient 429 now costs one note one tick. `utility` KEEPS its three tries — it is
 * seconds long and no route sizes itself against it.
 */
test('BOTH AUDIT CLASSES ARE SINGLE-TRY on every provider (DEC-B4, reversing Unit A)', () => {
  for (const p of LAB_PROVIDERS) {
    assert.equal(PROVIDER_BUDGETS[p].audit!.maxTries, 1, `${p}.audit`);
    assert.equal(PROVIDER_BUDGETS[p].audit_ipd!.maxTries, 1, `${p}.audit_ipd`);
  }
  for (const p of ['openrouter', 'vertex', 'bedrock'] as const) {
    assert.equal(PROVIDER_BUDGETS[p].utility!.maxTries, 3, `${p}.utility still retries`);
  }
});

test('ollama does not serve doc_read at all — null, not a number', () => {
  assert.equal(PROVIDER_BUDGETS.ollama.doc_read, null, 'the mini is not multimodal');
  assert.equal(totalBudgetMs('ollama', 'doc_read'), null,
    'a budget for an impossible call would be a number that lies');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · The arithmetic
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the backoff allowance is the exact upper bound of the shipped curve', () => {
  // openRouterBackoffMs = round(500 × 2^(k-1) × (0.5 + rand())), rand ∈ [0,1) ⇒ ≤ 750 × 2^(k-1).
  // N tries ⇒ N−1 sleeps ⇒ Σ(k=1..N-1) 750 × 2^(k-1) = 750 × (2^(N-1) − 1).
  assert.equal(backoffAllowanceMs(1), 0, 'one try never sleeps');
  assert.equal(backoffAllowanceMs(2), 750);
  assert.equal(backoffAllowanceMs(3), 2_250);
  assert.equal(backoffAllowanceMs(4), 5_250);
  // and it is total on junk rather than NaN — a budget must never be unusable
  for (const bad of [0, -3, NaN, undefined, 'x']) {
    assert.equal(backoffAllowanceMs(bad as number), 0, String(bad));
  }
});

test('totalBudgetMs = perAttemptMs × maxTries + the backoff allowance', () => {
  // ⚠️ The audit numbers moved on 3 Aug (DEC-B3/DEC-B4). The FORMULA this test names is unchanged;
  // only the inputs are. Both audit classes are now single-try, so their allowance is zero.
  // ollama audit: 380 000 × 1 + 0
  assert.equal(totalBudgetMs('ollama', 'audit'), 380_000);
  // audit_ipd: 200 000 × 1 + 0, on every provider
  assert.equal(totalBudgetMs('ollama', 'audit_ipd'), 200_000);
  assert.equal(totalBudgetMs('openrouter', 'audit_ipd'), 200_000);
  // ollama utility: 90 000 × 1 + 0
  assert.equal(totalBudgetMs('ollama', 'utility'), 90_000);
  // openrouter utility: 110 000 × 3 + 2 250 — UNCHANGED by Unit D
  assert.equal(totalBudgetMs('openrouter', 'utility'), 332_250);
  // openrouter audit: 380 000 × 1 + 0
  assert.equal(totalBudgetMs('openrouter', 'audit'), 380_000);
  // doc_read is single-try, so no backoff at all
  assert.equal(totalBudgetMs('openrouter', 'doc_read'), 180_000);
  // vertex and bedrock match openrouter class for class
  for (const c of CALL_CLASSES) {
    assert.equal(totalBudgetMs('vertex', c), totalBudgetMs('openrouter', c), `vertex ${c}`);
    assert.equal(totalBudgetMs('bedrock', c), totalBudgetMs('openrouter', c), `bedrock ${c}`);
  }
});

test('the allowance is never optimistic — the total is at least the naive product', () => {
  for (const p of LAB_PROVIDERS) {
    for (const c of CALL_CLASSES) {
      const b = PROVIDER_BUDGETS[p][c];
      if (!b) continue;
      assert.ok(totalBudgetMs(p, c)! >= b.perAttemptMs * b.maxTries,
        `${p}.${c}: a budget a route is checked against must never understate`);
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · Resolution and reachability — the loud-error property is unchanged
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('bedrock:anthropic.claude-x RESOLVES, and is marked paid', () => {
  const r = resolveProvider('bedrock:anthropic.claude-x', MINI);
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.provider === 'bedrock');
  assert.ok(r.ok && r.model === 'anthropic.claude-x');
  assert.ok(r.ok && r.paid === true, 'every non-ollama provider is paid');
});

/**
 * ⚠️ REWRITTEN 7 Aug 2026 (Bedrock S1), and the rewrite is the point.
 *
 * This test used to gate on `BEDROCK_API_KEY` + `BEDROCK_REGION`, because when it was written the
 * client did not exist and an API key was the assumed shape of the credential. THERE IS NO AWS
 * SECRET. The transport federates a Google ID token into STS, so the gate is the four OIDC vars —
 * `GCP_SA_KEY` (already present for Vertex) plus the three non-secret BEDROCK_* ones. The property
 * being asserted has not changed at all: a provider that resolves but cannot be reached returns
 * false, so the override is refused with a typed reason instead of running somewhere else.
 */
test('…and it PROBES REACHABLE only when the WHOLE OIDC chain is configured', () => {
  const VARS = ['GCP_SA_KEY', 'BEDROCK_REGION', 'BEDROCK_ROLE_ARN', 'BEDROCK_OIDC_AUDIENCE'] as const;
  const had = Object.fromEntries(VARS.map((k) => [k, process.env[k]])) as Record<string, string | undefined>;
  const VALUES: Record<string, string> = {
    GCP_SA_KEY: '{"client_email":"x@y.iam.gserviceaccount.com","private_key":"k"}',
    BEDROCK_REGION: 'ap-south-1',
    BEDROCK_ROLE_ARN: 'arn:aws:iam::819481466105:role/GCPBedrockRole',
    BEDROCK_OIDC_AUDIENCE: '588427270277',
  };
  try {
    for (const k of VARS) delete process.env[k];
    assert.equal(probeReachable('bedrock'), false, 'nothing configured ⇒ not reachable');
    // Each var alone, and each three-of-four, must still refuse: a chain missing any link cannot
    // be addressed, and "partly configured" is the state a rollback deliberately creates.
    for (const missing of VARS) {
      for (const k of VARS) process.env[k] = VALUES[k];
      delete process.env[missing];
      assert.equal(probeReachable('bedrock'), false, `missing ${missing} ⇒ not reachable`);
    }
    for (const k of VARS) process.env[k] = VALUES[k];
    assert.equal(probeReachable('bedrock'), true, 'all four present ⇒ reachable');
    // The dead name must not be able to open the gate on its own.
    for (const k of VARS) delete process.env[k];
    process.env.BEDROCK_API_KEY = 'k';
    assert.equal(probeReachable('bedrock'), false, 'BEDROCK_API_KEY is dead configuration, not a credential');
  } finally {
    delete process.env.BEDROCK_API_KEY;
    for (const k of VARS) { if (had[k] === undefined) delete process.env[k]; else process.env[k] = had[k] as string; }
  }
});

test('an unknown prefix STILL errors and never falls back', () => {
  const r = resolveProvider('gpt5:foo', MINI);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && /unknown provider prefix 'gpt5'/.test(r.error));
  assert.ok(!r.ok && /Never falls back to the mini\./.test(r.error), 'the guarantee is stated in the error');
  // the error must now offer bedrock among the alternatives, since the list drives the message
  assert.ok(!r.ok && /bedrock/.test(r.error), 'the new provider appears in the expected-one-of list');
  assert.equal(probeReachable('gpt5'), false, 'and an unknown provider is never reachable');
});

test('EXISTING resolution semantics are untouched', () => {
  // unprefixed ⇒ the mini, free
  assert.deepEqual(resolveProvider('', MINI), { ok: true, provider: 'ollama', model: MINI, paid: false, raw: '' });
  assert.deepEqual(resolveProvider(null, MINI), { ok: true, provider: 'ollama', model: MINI, paid: false, raw: '' });
  assert.deepEqual(resolveProvider('llama3', MINI), { ok: true, provider: 'ollama', model: 'llama3', paid: false, raw: 'llama3' });
  // a bare vendor-looking id is a forgotten prefix, not a mini run
  const slash = resolveProvider('google/gemini-2.5-pro', MINI);
  assert.equal(slash.ok, false);
  assert.ok(!slash.ok && /has no provider prefix but looks like a vendor id/.test(slash.error));
  // the three original providers still resolve exactly as before
  assert.ok(resolveProvider('ollama:x', MINI).ok);
  assert.deepEqual(resolveProvider('openrouter:google/gemini-2.5-pro', MINI),
    { ok: true, provider: 'openrouter', model: 'google/gemini-2.5-pro', paid: true, raw: 'openrouter:google/gemini-2.5-pro' });
  assert.deepEqual(resolveProvider('vertex:gemini-2.5-pro', MINI),
    { ok: true, provider: 'vertex', model: 'gemini-2.5-pro', paid: true, raw: 'vertex:gemini-2.5-pro' });
  // a missing id after the prefix is still an error
  assert.equal(resolveProvider('bedrock:', MINI).ok, false);
  assert.equal(resolveProvider('vertex:  ', MINI).ok, false);
});

test('the paid ceiling is untouched', () => {
  assert.equal(DEFAULT_PAID_CEILING, 250);
  assert.deepEqual(checkPaidCeiling(0), { ok: true, used: 0, ceiling: 250, remaining: 250 });
  assert.equal(checkPaidCeiling(250).ok, false);
  assert.deepEqual(checkPaidCeiling(5, 10), { ok: true, used: 5, ceiling: 10, remaining: 5 });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The finding this table surfaces immediately
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ⚠️ THIS TEST INVERTED ON 3 AUGUST, AND THAT IS THE POINT.
 *
 * Unit A could only SURFACE the problem: it asserted that one worst-case audit budget
 * (600,000 × 3 + 2,250 = 1,802,250 ms) EXCEEDED the 800,000 ms worker box it ran in — 2.25× over —
 * and recorded it as "not a failure of this unit, for the unit that wires this up". Unit D is that
 * unit. DEC-B4 cut the audit class to one try at 380,000 ms, so a single audit leg now fits.
 *
 * Keeping the assertion and reversing it preserves the record: if a future change puts one leg back
 * over the box, this fails again with the history attached rather than being quietly deleted.
 *
 * ⚠️ FITTING ONE LEG IS NECESSARY, NOT SUFFICIENT. A route runs LEGS × WAVES of these, and that is
 * what lib/__tests__/route-budget-guard.test.ts checks. This test alone would pass a route that is
 * still 2× over, which is exactly the mistake the first cut of Unit D made.
 */
test('RESOLVED BY UNIT D: one audit leg now fits the worker box it runs in', () => {
  const WORKER_BOX_MS = 800_000;
  assert.ok(totalBudgetMs('openrouter', 'audit')! <= WORKER_BOX_MS,
    'Unit A recorded this as 1,802,250 in an 800,000 box; DEC-B4 brought it inside');
  assert.ok(totalBudgetMs('openrouter', 'audit_ipd')! <= WORKER_BOX_MS);
  // a utility call and a doc read still fit comfortably
  assert.ok(totalBudgetMs('openrouter', 'utility')! < WORKER_BOX_MS);
  assert.ok(totalBudgetMs('openrouter', 'doc_read')! < WORKER_BOX_MS);
});
