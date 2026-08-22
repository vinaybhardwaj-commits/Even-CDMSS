/**
 * lib/__tests__/rule-governance-activation.test.ts — R3-A2, the activation-event writer.
 *
 * ⚠️ AN INJECTED FAKE SQL RUNNER, NOT A DATABASE. `recordActivationEvent` takes its runner as a
 * parameter, so every case here observes the EXACT statement and the EXACT parameter array the
 * function would have sent, and decides the reply. Two things follow that a live database could
 * not give as cheaply: the flag-off case can prove ZERO calls were made rather than that a call
 * failed, and every refusal reason is reachable without constructing the row that would produce it.
 *
 * ⚠️ WHAT THIS FILE CANNOT PROVE, STATED SO NOBODY MISREADS IT. A fake runner proves the statement
 * SENT and the outcome MAPPING. It does not execute SQL, so it cannot prove the CTE's own logic
 * evaluates as intended — that is the migration test's structural pins plus, ultimately, a live
 * run of migration 0039, which has not happened and is not authorised here. The preconditions are
 * pinned STRUCTURALLY below: each is asserted present in the statement, in order, with its refusal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVATION_PRECONDITIONS, ACTIVATION_REFUSALS, validateActivationRequest,
  type ActivationRequest,
} from '../rule-governance-core';
import { RECORD_ACTIVATION_EVENT_SQL, recordActivationEvent } from '../rule-governance-store';

const FLAG = 'LVC_RULE_GOVERNANCE_ENABLED';
const EVIDENCE = {
  ratified_by: 'V (Dr Vinay Bhardwaj)', rationale: 'ruled on the 22 Aug sample',
  sample_size: 40, reviewed_n: 12, sample_seed: 'r3a2-2026-08-22', n_not_belonging: 3,
};
const REQ: ActivationRequest = {
  event_ref: '11111111-2222-4333-8444-555555555555',
  rule_ref: 'lvc-rule-0007', version: 2, event: 'activate', evidence: EVIDENCE,
};

interface Call { text: string; params: unknown[] }

/**
 * The statement with its `--` comment lines removed.
 *
 * ⚠️ EVERY STRUCTURAL PIN BELOW READS THIS, NOT THE RAW STRING, AND THAT IS NOT TIDINESS. Three of
 * these assertions failed first against the raw statement because ITS OWN COMMENTS contain the very
 * words being searched for: the comment explaining the 0023 boundary names `lvc_recommendations`,
 * and the comment recording that there is "no bypass" contains `bypass`. A source scan that reads
 * prose reads the explanation as the defect it warns against. This is the same trap the telemetry
 * guard test recorded, and it caught this file too.
 */
const CODE = (() => {
  // ⚠️ TRAILING comments too, not only whole comment lines. The first version dropped lines
  // BEGINNING with `--` and left `... THEN NULL   -- already applied; not a refusal` intact — whose
  // semicolon then made the one-statement pin count two. Stripping from `--` to end of line is
  // sound here and is asserted to be: no string literal in this statement contains `--`.
  const stripped = RECORD_ACTIVATION_EVENT_SQL.replace(/--.*$/gm, '');
  const literals = RECORD_ACTIVATION_EVENT_SQL.match(/'[^']*'/g) ?? [];
  assert.ok(literals.length > 0, 'the statement has string literals to check');
  assert.ok(literals.every((l) => !l.includes('--')),
    'no string literal contains `--`, so stripping to end of line cannot remove executable text');
  return stripped;
})();

/** A runner that records every call and replies with one canned row. */
function fakeRunner(reply: Record<string, unknown>) {
  const calls: Call[] = [];
  const run = async (text: string, params?: unknown[]) => {
    calls.push({ text, params: params ?? [] });
    return [reply];
  };
  return { run: run as never, calls };
}

/** Run with the flag in a chosen state, always restoring it. */
async function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG]; else process.env[FLAG] = value;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env[FLAG]; else process.env[FLAG] = saved;
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1. THE FLAG — proven behaviourally
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('A1 — FLAG OFF ⇒ ZERO writes, proven by a runner that counts calls', async () => {
  // ⚠️ NOT A SOURCE INSPECTION (acceptance 7). The runner records every call it receives; the
  // assertion is that it received NONE. A source check would prove a line exists, not that no
  // statement was sent.
  for (const off of ['', '0', 'true', 'yes', '2', 'on', ' 1 ', undefined]) {
    const { run, calls } = fakeRunner({ status: 'inserted', id: '1' });
    await withFlag(off, async () => {
      await assert.rejects(() => recordActivationEvent(REQ, run), /disabled/);
    });
    assert.equal(calls.length, 0, `flag=${String(off)} must send no statement at all`);
  }
});

test('A2 — the flag is checked BEFORE validation: an invalid request with the flag off still throws the flag error', async () => {
  // Order matters. If validation ran first, a caller could learn whether their payload was
  // well-formed from a module that is supposed to be entirely inert.
  const { run, calls } = fakeRunner({});
  await withFlag(undefined, async () => {
    await assert.rejects(
      () => recordActivationEvent({ ...REQ, version: -1, event_ref: 'not-a-uuid' } as ActivationRequest, run),
      /disabled/);
  });
  assert.equal(calls.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2. VALIDATION
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('A3 — validation: event UUID, rule ref, POSITIVE version, activate|retire only', () => {
  assert.deepEqual(validateActivationRequest(REQ), []);
  const bad = (patch: Record<string, unknown>, re: RegExp) => {
    const p = validateActivationRequest({ ...REQ, ...patch });
    assert.ok(p.some((x) => re.test(x)), `${JSON.stringify(patch)} → ${JSON.stringify(p)}`);
  };
  bad({ event_ref: '' }, /^event_ref: required/);
  bad({ event_ref: 'not-a-uuid' }, /^event_ref: must be a UUID$/);
  bad({ event_ref: '11111111-2222-4333-8444-55555555555' }, /must be a UUID/);   // one short
  bad({ rule_ref: '  ' }, /^rule_ref: required$/);
  for (const v of [0, -1, 1.5, '2', null]) bad({ version: v }, /^version: required/);
  for (const e of ['', 'ACTIVATE', 'delete', 'retired', null]) bad({ event: e }, /^event: must be/);
  // The evidence tuple is validated through the same request.
  bad({ evidence: { ...EVIDENCE, ratified_by: 'admin' } }, /^ratified_by:/);
  bad({ evidence: { ...EVIDENCE, n_not_belonging: 99 } }, /n_not_belonging: cannot exceed reviewed_n/);
});

test('A4 — a caller-supplied timestamp is REFUSED, not silently ignored', async () => {
  // §3: the database stamps now(). A caller that believes it is setting the instant must learn
  // otherwise HERE — because the validity window is derived from event order, so a wrong instant
  // rewrites which version was live rather than merely mislabelling a row.
  const p = validateActivationRequest({ ...REQ, effective_at: '2026-01-01T00:00:00Z' });
  assert.ok(p.some((x) => /^effective_at: not accepted/.test(x)));
  // …and an explicit null is fine, since that is not a claim.
  assert.deepEqual(validateActivationRequest({ ...REQ, effective_at: null }), []);
  // The statement carries no effective_at parameter and does not name it in the INSERT columns.
  const cols = /INSERT INTO lvc_rule_activation_events\s*\(([^)]*)\)/.exec(RECORD_ACTIVATION_EVENT_SQL);
  assert.ok(cols, 'the insert column list is findable');
  assert.equal(/effective_at/.test(cols[1]), false, 'effective_at must not be an inserted column');
  const { run, calls } = fakeRunner({ status: 'inserted', id: '9' });
  await withFlag('1', () => recordActivationEvent(REQ, run));
  assert.equal(calls[0].params.length, 10, 'ten parameters, none of them an instant');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3. PARAMETER MAPPING AND THE ONE STATEMENT
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('A5 — ONE statement, ONE await, and the parameters map in declared order', async () => {
  const { run, calls } = fakeRunner({ status: 'inserted', id: '42', event_ref: REQ.event_ref });
  const out = await withFlag('1', () => recordActivationEvent(REQ, run));
  assert.equal(calls.length, 1, 'exactly one statement — one statement is one transaction on Neon');
  assert.equal(calls[0].text, RECORD_ACTIVATION_EVENT_SQL);
  assert.deepEqual(calls[0].params, [
    REQ.event_ref, REQ.rule_ref, REQ.version, REQ.event,
    EVIDENCE.ratified_by, EVIDENCE.rationale, EVIDENCE.sample_size,
    EVIDENCE.reviewed_n, EVIDENCE.sample_seed, EVIDENCE.n_not_belonging,
  ]);
  assert.deepEqual(out, { status: 'inserted', event_ref: REQ.event_ref, id: '42' });
});

test('A6 — the statement writes ONE table, and reads the rest', () => {
  // Events only (§3). Everything else appears only in read-only subqueries.
  const writes = [...CODE.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/gi)]
    .map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.deepEqual(writes, ['INSERT INTO lvc_rule_activation_events']);
  // …and the tables it must NEVER write are nonetheless present as reads, so the assertion above
  // is not passing merely because they are absent from the statement altogether.
  for (const t of ['lvc_rule_versions', 'lvc_recommendation_proposals', 'lvc_ratifications']) {
    assert.ok(RECORD_ACTIVATION_EVENT_SQL.includes(t), `${t} must be read`);
  }
  assert.equal(/lvc_recommendations\b(?!_)/.test(CODE), false,
    'lvc_recommendations is not named in executable text — the 0023 boundary');
  // ⚠️ AND NOT IN THE COMMENTS EITHER, deliberately. `rule-governance-dormancy.test.ts` proof 3
  // counts the string literals in the whole module that name the registry and requires exactly
  // ONE — the bootstrap SELECT. A mention in a comment here made that count two. The comment was
  // reworded rather than the proof relaxed: it is load-bearing and naming the registry was not.
  assert.equal(/lvc_recommendations/.test(RECORD_ACTIVATION_EVENT_SQL), false);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 4. THE SIX ACTIVATION PRECONDITIONS, INSIDE THE STATEMENT
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('A7 — all six activation preconditions are enforced INSIDE the statement, in order', () => {
  // Acceptance 3. Each precondition's refusal word must appear in the CTE, and they must appear in
  // the declared order — a precondition evaluated after the one it is supposed to precede would
  // report the wrong reason to an operator.
  const positions = ACTIVATION_PRECONDITIONS.map((p) => {
    const at = CODE.indexOf(`'${p.refusal}'`);
    assert.notEqual(at, -1, `precondition ${p.id} → ${p.refusal} is not in the statement`);
    return at;
  });
  assert.deepEqual([...positions].sort((a, b) => a - b), positions,
    'the six preconditions must be evaluated in their declared order');
  // …and they are inside ONE statement, not checked around it: there is exactly one statement.
  assert.equal(CODE.trim().split(/;\s/).length, 1, 'exactly one statement');
});

test('A8 — every refusal word in the closed set is reachable and maps to a typed outcome', async () => {
  for (const reason of ACTIVATION_REFUSALS) {
    const { run } = fakeRunner({ status: 'refused', refusal: reason, event_ref: REQ.event_ref });
    const out = await withFlag('1', () => recordActivationEvent(REQ, run));
    assert.deepEqual(out, { status: 'refused', event_ref: REQ.event_ref, reason });
    // Each word is also present in the statement, so the type and the SQL cannot drift.
    assert.ok(CODE.includes(`'${reason}'`), `${reason} missing from the statement`);
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 5. THE TWO REFUSALS THE KICKOFF NAMES — intended, and there is no bypass
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('A9 — SHELF-ORIGIN versions REFUSE activation: no matcher keywords, no complete definition', async () => {
  // ⚠️ INTENDED (§4). A pattern promoted from the shelf has no matcher keywords, so it has no
  // complete executable definition and cannot be activated. This is the correct outcome, not a gap
  // to engineer around.
  const { run } = fakeRunner({ status: 'refused', refusal: 'incomplete_definition', event_ref: REQ.event_ref });
  const out = await withFlag('1', () => recordActivationEvent(REQ, run));
  assert.equal(out.status, 'refused');
  assert.equal(out.status === 'refused' && out.reason, 'incomplete_definition');
  // The keyword emptiness test is IN the statement, and it tests all three ways a jsonb keyword
  // list can be absent: null, not an array, or an empty array.
  assert.match(CODE, /\(SELECT keywords FROM ver\) IS NOT NULL/);
  assert.match(CODE, /jsonb_typeof\(\(SELECT keywords FROM ver\)\) = 'array'/);
  assert.match(CODE, /jsonb_array_length\(\(SELECT keywords FROM ver\)\) > 0/);
});

test('A10 — BOOTSTRAP-ORIGIN versions REFUSE activation: bootstrap is not ratification', async () => {
  // ⚠️ INTENDED (§3.8, §4). A bootstrap snapshot records what a rule WAS; it is not a human ruling
  // that it should be live. It gets its OWN refusal word rather than falling through to
  // `not_ratified_proposal`, because the operator action differs: a bootstrap row can never be
  // activated, while an unratified proposal can be ratified.
  const { run } = fakeRunner({
    status: 'refused', refusal: 'bootstrap_origin_not_ratification', event_ref: REQ.event_ref,
  });
  const out = await withFlag('1', () => recordActivationEvent(REQ, run));
  assert.equal(out.status === 'refused' && out.reason, 'bootstrap_origin_not_ratification');
  assert.match(CODE, /origin FROM ver\) = 'bootstrap_snapshot'/);
  // …and it is checked BEFORE the proposal test, so the more specific word wins.
  assert.ok(CODE.indexOf("'bootstrap_origin_not_ratification'")
    < CODE.indexOf("'not_ratified_proposal'"));
});

test('A11 — THERE IS NO BYPASS: no force flag, no seed path, no override anywhere in the module', () => {
  // §4, in as many words: "Do not add a bypass, a force flag, or a 'seed activation' path."
  // Asserted on the statement AND on the exported surface, because a bypass could be either.
  for (const word of [/\bforce\b/i, /\bbypass\b/i, /\boverride\b/i, /seed_activation/i, /skip_precondition/i]) {
    assert.equal(word.test(CODE), false, `${word} must not appear in the executable statement`);
  }
  // The module's own prose DOES say "there is no bypass", and that must stay sayable — which is
  // exactly why the pin reads CODE. A check that forbade the word outright would forbid the
  // explanation of why the thing is absent.
  assert.ok(/no bypass/i.test(RECORD_ACTIVATION_EVENT_SQL));
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 6. IDEMPOTENCY, REACTIVATION, RETIREMENT
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('A12 — an exact replay returns ALREADY APPLIED, and it is a success not a refusal', async () => {
  const { run } = fakeRunner({ status: 'already_applied', id: '7', event_ref: REQ.event_ref });
  const out = await withFlag('1', () => recordActivationEvent(REQ, run));
  assert.deepEqual(out, { status: 'already_applied', event_ref: REQ.event_ref, id: '7' });
  // ⚠️ THE DISTINCTION THAT MATTERS TO A RETRY LOOP. A caller retrying after a timeout must tell
  // "your write landed the first time" from "your write will never land"; folding both into a
  // falsy result turns a permanent refusal into an infinite retry.
  assert.notEqual(out.status, 'refused');
  assert.match(CODE, /WHEN d\.replayed THEN 'already_applied'/);
});

test('A13 — reusing an event_ref with a DIFFERENT payload is an IDEMPOTENCY CONFLICT', async () => {
  const { run } = fakeRunner({ status: 'refused', refusal: 'idempotency_conflict', event_ref: REQ.event_ref });
  const out = await withFlag('1', () => recordActivationEvent({ ...REQ, version: 3 }, run));
  assert.equal(out.status === 'refused' && out.reason, 'idempotency_conflict');
  // The statement decides this on the PAYLOAD, not on the key alone: same key + same payload is a
  // replay, same key + different payload is the caller's bug.
  assert.match(CODE, /same_payload/);
  assert.match(CODE,
    /e\.rule_ref = r\.rule_ref AND e\.version = r\.version AND e\.event = r\.event/);
  // …and the conflict is decided BEFORE anything else, so a reused key never silently activates.
  assert.ok(CODE.indexOf("'idempotency_conflict'")
    < CODE.indexOf("'unknown_version'"));
});

test('A14 — RETIREMENT requires that exact version to be currently active', async () => {
  const { run, calls } = fakeRunner({ status: 'inserted', id: '5', event_ref: REQ.event_ref });
  const out = await withFlag('1', () => recordActivationEvent({ ...REQ, event: 'retire' }, run));
  assert.equal(out.status, 'inserted');
  assert.equal(calls[0].params[3], 'retire');
  // The statement branches on the event and compares against the DERIVED current version.
  assert.match(CODE, /WHEN r\.event = 'retire' THEN/);
  assert.match(CODE, /\(SELECT version FROM cur\) IS DISTINCT FROM r\.version/);
  const { run: run2 } = fakeRunner({ status: 'refused', refusal: 'version_not_active', event_ref: REQ.event_ref });
  const refused = await withFlag('1', () => recordActivationEvent({ ...REQ, event: 'retire' }, run2));
  assert.equal(refused.status === 'refused' && refused.reason, 'version_not_active');
  // ⚠️ RETIREMENT DOES NOT RE-RUN THE SIX ACTIVATION PRECONDITIONS, and that is deliberate: a
  // version that IS live must be retirable even if its definition would no longer qualify for
  // activation — otherwise a rule could become impossible to turn off.
  assert.ok(CODE.indexOf("WHEN r.event = 'retire' THEN")
    < CODE.indexOf("'incomplete_definition'"));
});

test('A15 — REACTIVATION closes the prior window, because the window is DERIVED not stored', () => {
  // The current version is read from v_lvc_rule_validity's open window; activating another valid
  // version simply appends, and the view's lead() closes the previous one. There is no UPDATE.
  assert.match(CODE, /FROM v_lvc_rule_validity w, req r/);
  assert.match(CODE, /w\.valid_to IS NULL/);
  assert.equal(/UPDATE\s+lvc_rule_activation_events/i.test(CODE), false,
    'closing a window is an append, never an update');
});

test('A16 — the residual constraint is documented AT THE MODULE, not only in a report', async () => {
  // Rep 46 point 8: a future reader deciding whether to call this function must find the
  // limitation at the call site.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('lib/rule-governance-store.ts', 'utf8');
  assert.match(src, /cannot guarantee serialization between/i);
  assert.match(src, /different idempotency uuids/i);
  assert.match(src, /zero production callers until\s+\/\/\s+R3-B|ZERO PRODUCTION CALLERS UNTIL/i);
});
