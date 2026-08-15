/**
 * lib/__tests__/attempt-taxonomy.test.ts — PROOF 11, kickoff v11 line 1125.
 *
 *   > **The attempt taxonomy.** Every manifest attempt carries one of the six committed outcomes,
 *   > and a timeout attempt is recorded as `timeout`, not folded into a transport error.
 *
 * ⚠️ PROOF 11 WAS NOT ALREADY DONE. `CDMSS-RERANK-TELEMETRY-ONPATH-BUILD-11-AUG-2026.md:3779` lists
 * it as written and green. Saul's later ruling at
 * `CDMSS-SAUL-RULING-GUARDRAILS-CRITICAL-PATH-14-AUG-2026.md:343-356` lists it among the missing,
 * and Saul is later and governs. The tree carried no implementation.
 *
 * ⚠️ AND UNTIL THIS PASS THE FIRST HALF WAS NOT PROVABLE. Nothing validated an attempt outcome
 * anywhere: `retrieval-telemetry-core.ts:707` and `:765` look like validation and are field-presence
 * checks, the multi-query block never read `vg.attempts`, and the only line reading `a.outcome` was
 * the 429 counter. The count was zero of three. v11 §4 adds the branch in all three locations, and
 * the second half of this file is what that makes provable.
 *
 * PURE UNIT TEST. No database, no network, no judge server. The timeout is proven with a test-local
 * method mock (review 22 item 7) — never a wall clock, never an external host.
 *
 * Proof 12 lives in `batch-outcome-precedence.test.ts` because it needs a live loopback judge server
 * and a load-bearing import order; keeping it out of here leaves this file pure and fast.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TRANSPORT_ATTEMPT_OUTCOMES, classifyAttemptOutcome, classifyLocalAttempt, localAttemptSuccess,
} from '../transport-attribution-core';
import { createTelemetryCapture, buildRetrievalPayload } from '../retrieval-capture';
import { validateManifest, routeClassOf } from '../retrieval-telemetry-core';
import type { OperationalTelemetry, RetrievalRole } from '../retrieval-telemetry-core';

const DEFECT = 'attempt_outcome_absent_or_invalid';

const operational = (role: RetrievalRole): OperationalTelemetry => ({
  // `lab_batch` is the hosted-lab route (core:205) and `routeClassOf` maps it to 'lab' (:229).
  // Derived rather than hand-paired, so the two can never disagree.
  route: role === 'lab_multi_query' ? 'lab_batch' : 'opd_audit_worker',
  route_class: routeClassOf(role === 'lab_multi_query' ? 'lab_batch' : 'opd_audit_worker'),
  retrieval_role: role,
  invocation_id: 'inv-proof-11', trace_id: null, deployment_sha: null,
  started_at: '2026-08-15T00:00:00.000Z', completed_at: '2026-08-15T00:00:01.000Z',
  routing_flags: {}, active_backfill_run_id: null, active_backfill_target: null,
  active_backfill_state: null, active_lab_experiment_id: null,
});

/**
 * A real manifest, built through the real capture, then given the attempts under test.
 *
 * ⚠️ BUILT, NOT HAND-WRITTEN. `manifestAttempts` at `lib/retrieval-capture.ts:122` is not exported
 * and must stay that way, so the only honest way to reach the manifest shape is
 * `buildRetrievalPayload`. A hand-assembled object would be testing my idea of the manifest.
 */
function manifestWith(role: RetrievalRole): Record<string, unknown> {
  const capture = createTelemetryCapture(role);
  const payload = buildRetrievalPayload(capture, {
    hmacKey: 'proof-11-key',
    scorerContext: role === 'primary' ? '' : null,
  });
  return { ...payload, operational: operational(role) } as unknown as Record<string, unknown>;
}

/** How many attempt-outcome defects this manifest carries. Only that defect — the fixtures carry
 *  unrelated ones (`index_version_absent`) that are not this proof's subject. */
const defects = (m: unknown): number =>
  validateManifest(m as never).filter((d) => d === DEFECT).length;

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1. The classifier produces exactly five of the six, and never `success`
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('11.1 — the six outcomes are the runtime authority, in the committed order', () => {
  assert.deepEqual([...TRANSPORT_ATTEMPT_OUTCOMES], [
    'http_429', 'http_other', 'timeout', 'transport_error', 'bad_response', 'success',
  ]);
  assert.equal(TRANSPORT_ATTEMPT_OUTCOMES.length, 6);
  // v11 §4 item 1: the array is the authority and the type is derived from it, so the two cannot
  // disagree. Pinned as source text because a derived type leaves no runtime trace to assert.
  const src = readFileSync('lib/transport-attribution-core.ts', 'utf8');
  assert.match(src, /export type TransportAttemptOutcome = typeof TRANSPORT_ATTEMPT_OUTCOMES\[number\];/);
  // v11 §4 item 2 / review 22 item 3: the MANIFEST field stays `string`. A compile-time narrowing
  // does not stop a value arriving from JSONB, which is exactly why the runtime branch exists.
  const core = readFileSync('lib/retrieval-telemetry-core.ts', 'utf8');
  assert.match(core, /export interface ManifestAttempt \{[\s\S]*?\n {2}outcome: string;/);
});

test('11.2 — `classifyAttemptOutcome` produces five of the six and NEVER `success`', () => {
  // It is only reached on a FAILURE (D15). Success attempts are pushed at the call sites, so a path
  // that only funnelled through the classifier would record failures and lose every success.
  const produced = new Set<string>([
    classifyAttemptOutcome('timeout', null),
    classifyAttemptOutcome('transport', null),
    classifyAttemptOutcome('bad_response', null),
    classifyAttemptOutcome('http', 429),
    classifyAttemptOutcome('http', 503),
  ]);
  assert.deepEqual([...produced].sort(),
    ['bad_response', 'http_429', 'http_other', 'timeout', 'transport_error']);
  assert.equal(produced.size, 5);
  assert.equal(produced.has('success'), false, 'the classifier must never produce success');

  // Every value it produces is one of the six, for any input — including inputs it has no branch
  // for, which fall through to the 429/other decision rather than inventing a seventh value.
  for (const kind of ['timeout', 'transport', 'bad_response', 'http', 'something_unknown', '']) {
    for (const status of [null, 200, 429, 500, 0]) {
      const out = classifyAttemptOutcome(kind, status);
      assert.ok((TRANSPORT_ATTEMPT_OUTCOMES as readonly string[]).includes(out),
        `classifyAttemptOutcome(${kind}, ${status}) produced ${out}, which is outside the six`);
      assert.notEqual(out, 'success');
    }
  }
  // The 429 rule is not tier-dependent: it lives in one function that both ladder tiers reach.
  assert.equal(classifyAttemptOutcome('http', 429), 'http_429');
  assert.equal(classifyAttemptOutcome('http', 503), 'http_other');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2. Each of the FOUR success sites produces `success`
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('11.3 — all four success sites record `success`, two of them through localAttemptSuccess()', () => {
  // The two LOCAL sites, behaviourally: lib/llm.ts:360 and :563 both spread `localAttemptSuccess()`.
  const local = localAttemptSuccess();
  assert.deepEqual(local, { tier: 'ollama', attempt: 1, outcome: 'success', status: 200 });
  assert.ok((TRANSPORT_ATTEMPT_OUTCOMES as readonly string[]).includes(local.outcome));

  // The two CLOUD sites push the literal inline, so they are pinned at source — there is no
  // exported function to call, and §8 forbids editing lib/llm.ts to create one.
  const llm = readFileSync('lib/llm.ts', 'utf8');
  const inline = llm.split('\n')
    .map((l, i) => [i + 1, l] as const)
    .filter(([, l]) => /attempts\.push\(\{ tier: '(openrouter|vertex)'/.test(l) && /outcome: 'success', status: 200/.test(l));
  assert.equal(inline.length, 2, 'exactly two inline cloud success pushes');
  assert.deepEqual(inline.map(([n]) => n), [435, 505], 'at the lines v11 §5 names');
  const viaHelper = llm.split('\n')
    .map((l, i) => [i + 1, l] as const)
    .filter(([, l]) => l.includes('localAttemptSuccess()'));
  assert.deepEqual(viaHelper.map(([n]) => n), [360, 563], 'and the two local sites use the helper');

  // ⚠️ ALL FOUR, AND NO FIFTH SHAPE. A success attempt written any other way would not be counted
  // by this test and could carry any string; the union of the two forms is the whole population.
  const allSuccessSites = (llm.match(/outcome: 'success'|localAttemptSuccess\(\)/g) || []).length;
  assert.equal(allSuccessSites, 4, 'four success sites in lib/llm.ts, no more');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3. A timeout is `timeout`, on BOTH detectors, and is never folded into a transport error
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('11.4 — detector one: a declared timeout kind classifies `timeout`, not `transport_error`', () => {
  assert.equal(classifyAttemptOutcome('timeout', null), 'timeout');
  assert.notEqual(classifyAttemptOutcome('timeout', null), 'transport_error');
  // …and the neighbouring kind still classifies as itself, so the two are genuinely distinguished
  // rather than both mapping to whatever this assertion happens to expect.
  assert.equal(classifyAttemptOutcome('transport', null), 'transport_error');
});

test('11.5 — detector two: a THROWN SDK timeout classifies `timeout`, by the name the SDK declares', async () => {
  // ⚠️ A TEST-LOCAL METHOD MOCK, NOT A WALL CLOCK (review 22 item 7). Waiting for a real timeout
  // would be slow and flaky and would prove the clock rather than the classifier. The SDK's own
  // `APIConnectionTimeoutError` name is the declared evidence `classifyLocalAttempt` reads.
  class APIConnectionTimeoutError extends Error {
    constructor() { super('Request timed out.'); this.name = 'APIConnectionTimeoutError'; }
  }
  const thrown = await (async () => { throw new APIConnectionTimeoutError(); })().catch((e) => e);

  const { outcome, status } = classifyLocalAttempt(thrown);
  assert.equal(outcome, 'timeout', 'the timeout must not be folded into a transport error');
  assert.equal(status, null, 'a timeout declares no HTTP status, and none is invented');

  // THE CONTRAST that makes the assertion above mean something: an error declaring NEITHER a status
  // nor the timeout name is the honest `transport_error`, not a sharpened guess.
  assert.equal(classifyLocalAttempt(new Error('socket hang up')).outcome, 'transport_error');
  // …and a declared status still routes by the one 429 rule, on this detector too.
  assert.equal(classifyLocalAttempt(Object.assign(new Error('x'), { status: 429 })).outcome, 'http_429');
  assert.equal(classifyLocalAttempt(Object.assign(new Error('x'), { status: 500 })).outcome, 'http_other');
  // A timeout NAME wins over an absent status — the name is what the SDK declares, and §4.4 forbids
  // guessing from requested model, environment or timing.
  assert.equal(classifyLocalAttempt({ name: 'APIConnectionTimeoutError' }).outcome, 'timeout');
  // Nothing at all is still transport_error, never a crash and never `success`.
  for (const junk of [null, undefined, 0, '', {}]) {
    assert.equal(classifyLocalAttempt(junk).outcome, 'transport_error');
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 4. The manifest branch, in ALL THREE locations (v11 §4, review 22 item 2)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** The three locations, each with the path to its attempts array inside a built manifest. */
const LOCATIONS = [
  {
    name: 'expansion attempts',
    role: 'primary' as const,
    put: (m: Record<string, unknown>, a: unknown) => { (m.expansion as Record<string, unknown>).attempts = a; },
  },
  {
    name: 'rerank batch attempts',
    role: 'primary' as const,
    put: (m: Record<string, unknown>, a: unknown) => {
      m.batches = [{
        batch_index: 0, candidate_start: 0, candidate_end: 2,
        intended_provider: 'vertex', intended_model: 'gemini', served_route_class: 'vertex',
        served_model: 'gemini', attempts: a, outcome: 'success',
        expected_score_keys: 2, finite_score_keys: 2,
      }];
    },
  },
  {
    name: 'variant-generation attempts',
    role: 'lab_multi_query' as const,
    put: (m: Record<string, unknown>, a: unknown) => {
      const mq = m.multi_query as Record<string, unknown>;
      (mq.variant_generation as Record<string, unknown>).attempts = a;
    },
  },
];

test('11.6 — an outcome OUTSIDE the six is a manifest defect, in all three locations', () => {
  for (const loc of LOCATIONS) {
    const m = manifestWith(loc.role);
    loc.put(m, [{ provider: 'vertex', attempt: 1, outcome: 'not_one_of_the_six', status: null }]);
    assert.ok(defects(m) >= 1, `${loc.name}: an invalid outcome must be a defect`);
  }
});

test('11.7 — an outcome INSIDE the six is not a defect, in all three locations', () => {
  // The other half of 11.6. Without it, a branch that flagged everything would pass 11.6.
  for (const loc of LOCATIONS) {
    for (const good of TRANSPORT_ATTEMPT_OUTCOMES) {
      const m = manifestWith(loc.role);
      loc.put(m, [{ provider: 'vertex', attempt: 1, outcome: good, status: null }]);
      assert.equal(defects(m), 0, `${loc.name}: ${good} is committed and must be accepted`);
    }
  }
});

test('11.8 — an ABSENT outcome, a wrong-shaped attempts value, and a mixed array are all defects', () => {
  for (const loc of LOCATIONS) {
    const cases: Array<[string, unknown]> = [
      ['outcome field absent', [{ provider: 'vertex', attempt: 1, status: null }]],
      ['outcome null', [{ provider: 'vertex', attempt: 1, outcome: null, status: null }]],
      ['outcome empty string', [{ provider: 'vertex', attempt: 1, outcome: '', status: null }]],
      ['attempts is a string', 'transport_error'],
      ['attempts is an object', { outcome: 'success' }],
      ['one good then one bad', [
        { provider: 'vertex', attempt: 1, outcome: 'success', status: 200 },
        { provider: 'vertex', attempt: 2, outcome: 'nope', status: null },
      ]],
      ['a null member', [null]],
    ];
    for (const [label, value] of cases) {
      const m = manifestWith(loc.role);
      loc.put(m, value);
      assert.ok(defects(m) >= 1, `${loc.name}: ${label} must be a defect`);
    }
  }
});

test('11.9 — `attempts: null` is LEGAL at all three locations and must NOT be flagged', () => {
  // ⚠️ THIS IS TODAY'S TRUTH AND IT IS DEFERRED, NOT ENDORSED. A skipped expansion stage emits null
  // (`retrieval-capture.ts:309`) and `manifestAttempts` returns null for absent evidence
  // (`:122-123`). Addendum v11 §6.1 moves the `null` to `[]` correction to PASS 3. A branch that
  // treated null as defective would flag every skipped stage and would make pass 3's decision early.
  for (const loc of LOCATIONS) {
    for (const empty of [null, undefined, []]) {
      const m = manifestWith(loc.role);
      loc.put(m, empty);
      assert.equal(defects(m), 0, `${loc.name}: ${String(empty)} says nothing and must be tolerated`);
    }
  }
  // And the DEFAULT built manifest — the one production emits for a skipped stage — is clean of
  // this defect, which is why no existing fixture had to be corrected in this pass.
  for (const role of ['primary', 'lab_multi_query'] as const) {
    assert.equal(defects(manifestWith(role)), 0, `${role}: a default manifest carries no attempt defect`);
  }
});

test('11.10 — the defect name is the SAME stable string at all three locations', () => {
  // Review 22 item 4. Three different names would make a census group one fact three ways.
  const names = new Set<string>();
  for (const loc of LOCATIONS) {
    const m = manifestWith(loc.role);
    loc.put(m, [{ provider: 'vertex', attempt: 1, outcome: 'bad', status: null }]);
    for (const d of validateManifest(m as never)) if (d.includes('attempt_outcome')) names.add(d);
  }
  assert.deepEqual([...names], [DEFECT], 'one name, used identically in all three locations');
});
