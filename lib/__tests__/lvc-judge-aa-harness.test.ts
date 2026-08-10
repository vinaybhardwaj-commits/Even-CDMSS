/**
 * lib/__tests__/lvc-judge-aa-harness.test.ts
 * LVC HARNESS-AND-ATTRIBUTION kickoff, 10 Aug 2026 — items 1-5.
 *
 *   node --test --import tsx lib/__tests__/lvc-judge-aa-harness.test.ts
 *
 * ⚠️ THE NAMED PRD (CDMSS-LVC-HARNESS-AND-ATTRIBUTION-PRD-v1.0-10-AUG-2026.md) IS NOT IN THE REPO
 * OR ANYWHERE ON THIS MACHINE. Everything below is built from the kickoff text itself, which
 * restates each decision; "Unit C's three cases from PRD 3.3" are therefore the three cases the
 * kickoff's item 4 describes — transport evidence present and saying no cloud answered (whatever
 * the model strings say), and transport evidence absent (rules unchanged, unknown included).
 * Flagged in the build report, not decided. If §3.3 names different cases, this file is the place
 * to reconcile them.
 *
 * What is asserted here:
 *   item 1  the reserve arithmetic admits a 275 s case and refuses one that cannot finish;
 *   item 2  a failed case carries the matching status, and `compared` cannot be earned by refusal;
 *   item 3  both runs' attribution reaches the caller, non-empty when transport evidence exists;
 *   item 4  the hardened resolver — Unit C's three cases.
 */
import './gemini-env-fixture';   // ⚠️ MUST BE FIRST — module-load env capture (see the fixture)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultJudge, matchLowValueCare, resolveJudgeAttribution, judgeRunAttributionFrom,
  buildJudgeAttemptPayload, buildJudgeInvocationPayload,
  type JudgeInvocationRecord, type JudgeRunAttribution,
} from '../lvc';
import {
  canStartCase, caseBudgetMs, classifyAaCase,
  AA_ROUTE_MAX_DURATION_S, AA_DEADLINE_MS, AA_PER_CASE_RESERVE_MS, AA_MEASURED_CASE_MS, AA_MEASURED_JUDGE_CALL_MS,
} from '../lvc-judge-aa-core';
import { attachTransportAttribution, type CdmssTransportAttribution } from '../trace';
import { GEMINI_MODEL } from '../llm';
import type { LvcRecommendation } from '../lvc-core';

const INTENDED = GEMINI_MODEL;
const LOCAL = 'llama3.1:8b';

const rec = (id: string): LvcRecommendation => ({
  id, region: 'IN', society: 'Test Society', specialty: null,
  statement: `do not order ${id}`, precondition: 'when nothing is documented',
  action_type: 'lab', consider_instead: null, rationale: null, keywords: [],
  citation_doi: null, citation_pmid: null, citation_url: null, source_release_year: 2024,
}) as unknown as LvcRecommendation;

const RECS = [rec('r1'), rec('r2')];
const CTX = { scenario: 'adult with fatigue; vitamin D level ordered' };
const CONTENT = JSON.stringify(RECS.map((r) => ({
  id: r.id, verdict: 'applies', confidence: 0.95, why: 'test', consider_instead: null,
})));

const cloud = (provider: CdmssTransportAttribution['dispatched_provider'], model: string): CdmssTransportAttribution =>
  ({ dispatched_provider: provider, dispatched_model: model, cloud_response_received: true });
const localTransport = (model: string | null = LOCAL): CdmssTransportAttribution =>
  ({ dispatched_provider: 'ollama', dispatched_model: model, cloud_response_received: false });

function completion(bodyModel: string | null, transport?: CdmssTransportAttribution) {
  const c: Record<string, unknown> = { choices: [{ message: { content: CONTENT } }] };
  if (bodyModel !== null) c.model = bodyModel;
  return transport ? attachTransportAttribution(c, transport) : c;
}

// ══ ITEM 4 — UNIT C'S THREE CASES ══════════════════════════════════════════════════════════════

test('Unit C.1: transport present and reporting NO cloud response → wrong_model, whatever the body says', () => {
  // The body names the intended Gemini model. It does not matter: the transport says no cloud
  // provider answered, and that is decisive.
  assert.deepEqual(
    resolveJudgeAttribution({ intendedModel: INTENDED, transportModel: null, bodyModel: INTENDED, transportCloudResponse: false }),
    { state: 'wrong_model', reason: 'transport_reports_no_cloud_response' },
  );
  // …and it does not matter what the transport's own model string says either — including nothing.
  for (const t of [null, '', LOCAL, INTENDED, `google/${INTENDED}`]) {
    assert.equal(
      resolveJudgeAttribution({ intendedModel: INTENDED, transportModel: t, bodyModel: t, transportCloudResponse: false }).state,
      'wrong_model',
      `transport model ${JSON.stringify(t)} must not rescue a non-cloud response`,
    );
  }
});

test('Unit C.2: transport present and reporting a cloud response leaves the table alone', () => {
  assert.deepEqual(
    resolveJudgeAttribution({ intendedModel: INTENDED, transportModel: INTENDED, bodyModel: null, transportCloudResponse: true }),
    { state: 'verified', reason: 'transport_agrees' },
  );
  assert.equal(
    resolveJudgeAttribution({ intendedModel: INTENDED, transportModel: null, bodyModel: null, transportCloudResponse: true }).state,
    'unknown', 'a cloud response that named nothing anywhere is still unknown, still accepted',
  );
  assert.equal(
    resolveJudgeAttribution({ intendedModel: INTENDED, transportModel: LOCAL, bodyModel: null, transportCloudResponse: true }).state,
    'wrong_model',
  );
});

test('Unit C.3: transport evidence ABSENT entirely → every existing rule unchanged, unknown included', () => {
  for (const absent of [undefined, null]) {
    assert.deepEqual(
      resolveJudgeAttribution({ intendedModel: INTENDED, transportModel: null, bodyModel: null, transportCloudResponse: absent }),
      { state: 'unknown', reason: 'no_model_reported' },
      'absence of evidence is not evidence of a local answer',
    );
    assert.equal(resolveJudgeAttribution({ intendedModel: INTENDED, bodyModel: INTENDED, transportCloudResponse: absent }).state, 'verified');
    assert.equal(resolveJudgeAttribution({ intendedModel: INTENDED, bodyModel: LOCAL, transportCloudResponse: absent }).state, 'wrong_model');
    assert.equal(resolveJudgeAttribution({ intendedModel: INTENDED, transportModel: INTENDED, bodyModel: LOCAL, transportCloudResponse: absent }).state, 'wrong_model');
  }
  // The pre-hardening call shape (three keys, no boolean) is byte-identical in behaviour.
  assert.deepEqual(
    resolveJudgeAttribution({ intendedModel: INTENDED, transportModel: null, bodyModel: null }),
    { state: 'unknown', reason: 'no_model_reported' },
  );
});

test('Unit C: the hardening reaches the real judge — a local branch that echoes a Gemini slug still refuses', async () => {
  // The failure the boolean exists for: a local branch reporting the REQUESTED model. Before the
  // hardening the strings would have resolved `verified` and a local verdict would have been served.
  let calls = 0;
  const judged = await defaultJudge(CTX, RECS, 'surface', undefined, false, {
    call: async () => { calls++; return completion(INTENDED, localTransport(INTENDED)); },
  });
  assert.equal(calls, 2, 'wrong_model buys exactly one retry');
  assert.ok(judged.every((j) => j.verdict === 'insufficient_info'), 'no local verdict is served');
});

// ══ ITEM 3 — ATTRIBUTION REACHES THE CALLER, PER RUN ═══════════════════════════════════════════

test('item 3: a completed run carries non-empty attribution when transport evidence exists', async () => {
  const seen: JudgeInvocationRecord[] = [];
  await defaultJudge(CTX, RECS, 'surface', undefined, false, {
    call: async () => completion('', cloud('openrouter', `google/${INTENDED}`)),
    onInvocation: (r) => { seen.push(r); },
  });
  assert.equal(seen.length, 1, 'exactly one invocation record per judge invocation');

  const attr = judgeRunAttributionFrom(seen[0]);
  assert.equal(attr.dispatched_provider, 'openrouter');
  assert.equal(attr.dispatched_model, `google/${INTENDED}`);
  assert.equal(attr.body_model, null, 'the body named nothing, and that is null — not empty string');
  assert.equal(attr.attribution_state, 'verified');
  assert.equal(attr.outcome, 'verdict');
  assert.equal(attr.retry_count, 0);
  // The gap 101e4e4 left: these were the fields the stored case could not fill.
  assert.ok(attr.dispatched_provider && attr.dispatched_model, 'provider and model are NOT empty');
});

test('item 3: matchLowValueCare surfaces both runs\' attribution — and omits it when no judge ran', async () => {
  // Run A/B as the harness runs them: recall pinned, judge NOT injected, so defaultJudge answers.
  const { setLvcChatTransportForTest } = await import('../lvc');
  setLvcChatTransportForTest(async () => completion(INTENDED, cloud('vertex', INTENDED)));
  try {
    const a = await matchLowValueCare(
      { scenario: CTX.scenario, proposedActions: ['vitamin D'], surface: 'surface', trace: false },
      { recall: async () => RECS },
    );
    const b = await matchLowValueCare(
      { scenario: CTX.scenario, proposedActions: ['vitamin D'], surface: 'surface', trace: false },
      { recall: async () => RECS },
    );
    for (const [name, r] of [['A', a], ['B', b]] as const) {
      const attr = r.judgeAttribution as JudgeRunAttribution;
      assert.ok(attr, `run ${name} carries attribution`);
      assert.equal(attr.dispatched_provider, 'vertex', `run ${name} provider`);
      assert.equal(attr.dispatched_model, INTENDED, `run ${name} model`);
      assert.equal(attr.body_model, INTENDED, `run ${name} body model`);
      assert.equal(attr.attribution_state, 'verified', `run ${name} state`);
    }
  } finally {
    setLvcChatTransportForTest(null);
  }

  // An INJECTED judge (the harness's pass 0) judged nothing, so nothing is claimed about a model.
  const pass0 = await matchLowValueCare(
    { scenario: CTX.scenario, proposedActions: ['vitamin D'], surface: 'surface', trace: false },
    { recall: async () => RECS, judge: async (_c, recs) => recs.map((r) => ({ rec: r, verdict: 'insufficient_info' as const, confidence: 0, why: '', consider_instead: null })) },
  );
  assert.equal(pass0.judgeAttribution, undefined, 'no judge ran ⇒ no attribution invented');

  // No recall ⇒ the judge is never called ⇒ still nothing claimed.
  const noRecall = await matchLowValueCare(
    { scenario: CTX.scenario, proposedActions: ['vitamin D'], surface: 'surface', trace: false },
    { recall: async () => [] },
  );
  assert.equal(noRecall.judgeAttribution, undefined);
});

test('item 3: a REFUSED run still carries attribution, saying so', async () => {
  const seen: JudgeInvocationRecord[] = [];
  await defaultJudge(CTX, RECS, 'surface', undefined, false, {
    call: async () => { throw new Error('vertex 403'); },
    onInvocation: (r) => { seen.push(r); },
  });
  const attr = judgeRunAttributionFrom(seen[0]);
  assert.equal(attr.outcome, 'refusal');
  assert.equal(attr.refuse_reason, 'call_failed');
  assert.equal(attr.attribution_state, null, 'a failed call attributes to nothing');
  assert.equal(attr.retry_count, 1);
  assert.equal(attr.attempts, 2);
});

test('item 3: judgeRunAttributionFrom(null) is an all-null shape, never missing keys', () => {
  assert.deepEqual(judgeRunAttributionFrom(null), {
    dispatched_provider: null, dispatched_model: null, body_model: null,
    attribution_state: null, attribution_reason: null, outcome: null, refuse_reason: null,
    attempts: 0, retry_count: 0,
  });
  assert.deepEqual(judgeRunAttributionFrom(undefined), judgeRunAttributionFrom(null));
});

// ══ ITEM 2 — THE PER-CASE STATUS ═══════════════════════════════════════════════════════════════

/** The compact attribution a run would carry, built through the real builders. */
const attrFor = (o: { state?: 'verified' | 'wrong_model' | 'unknown'; reason?: string; outcome: 'verdict' | 'refusal'; refuseReason?: string }): JudgeRunAttribution =>
  judgeRunAttributionFrom(buildJudgeInvocationPayload({
    intendedModel: INTENDED,
    attempts: [buildJudgeAttemptPayload({
      attempt: 1, status: o.outcome === 'refusal' && !o.state ? 'error' : 'ok', intendedModel: INTENDED,
      attribution: o.state ? { state: o.state, reason: o.reason ?? 'x' } : null,
    })],
    outcome: o.outcome, refuseReason: o.refuseReason, surface: 'surface', recIds: ['r1'],
  }));

test('item 2: two runs that both REFUSED are never `compared` — the headline cannot be earned by silence', () => {
  // Both runs return a full insufficient_info set, so the verdict counts look perfect. This is the
  // case that would otherwise report 100% repeatability while measuring nothing at all.
  const refused = attrFor({ state: 'wrong_model', reason: 'body_names_other_model', outcome: 'refusal', refuseReason: 'body_names_other_model' });
  const { status, detail } = classifyAaCase({ attrA: refused, attrB: refused, nVerdictsA: 2, nVerdictsB: 2 });
  assert.equal(status, 'integrity_failure');
  assert.match(detail ?? '', /run A/);
});

test('item 2: each failure kind carries its own status', () => {
  const verified = attrFor({ state: 'verified', reason: 'transport_agrees', outcome: 'verdict' });

  // transport failure — the provider call failed twice
  assert.equal(classifyAaCase({
    attrA: verified, attrB: attrFor({ outcome: 'refusal', refuseReason: 'call_failed' }),
    nVerdictsA: 2, nVerdictsB: 2,
  }).status, 'transport_failure');

  // …and "no cloud model could be resolved" is the same kind: nothing answered.
  assert.equal(classifyAaCase({
    attrA: attrFor({ outcome: 'refusal', refuseReason: 'no_gemini_model_resolved' }), attrB: verified,
    nVerdictsA: 2, nVerdictsB: 2,
  }).status, 'transport_failure');

  // integrity failure — the wrong model answered, INCLUDING the hardened no-cloud-response reason
  assert.equal(classifyAaCase({
    attrA: verified,
    attrB: attrFor({ state: 'wrong_model', reason: 'transport_reports_no_cloud_response', outcome: 'refusal', refuseReason: 'transport_reports_no_cloud_response' }),
    nVerdictsA: 2, nVerdictsB: 2,
  }).status, 'integrity_failure');

  // integrity OUTRANKS transport: a wrong-model run is not filed as a plumbing problem
  assert.equal(classifyAaCase({
    attrA: attrFor({ state: 'wrong_model', reason: 'body_names_other_model', outcome: 'refusal', refuseReason: 'body_names_other_model' }),
    attrB: attrFor({ outcome: 'refusal', refuseReason: 'call_failed' }),
    nVerdictsA: 2, nVerdictsB: 2,
  }).status, 'integrity_failure');

  // parse failure — verdicts could not be read for a run
  const parse = classifyAaCase({ attrA: verified, attrB: verified, nVerdictsA: 2, nVerdictsB: 0 });
  assert.equal(parse.status, 'parse_failure');
  assert.match(parse.detail ?? '', /cannot tell these apart/, 'the conflation is stated in the row itself');

  // compared — both runs verified, both verdict sets readable
  assert.deepEqual(classifyAaCase({ attrA: verified, attrB: verified, nVerdictsA: 2, nVerdictsB: 2 }), { status: 'compared', detail: null });
});

test('item 2: an r1-shaped case with NO attribution still classifies exactly as it used to', () => {
  // r1 rows predate attribution entirely. Absent attribution must not manufacture a failure.
  assert.equal(classifyAaCase({ attrA: null, attrB: null, nVerdictsA: 3, nVerdictsB: 3 }).status, 'compared');
  assert.equal(classifyAaCase({ attrA: null, attrB: null, nVerdictsA: 0, nVerdictsB: 0 }).status, 'parse_failure');
  assert.equal(classifyAaCase({ nVerdictsA: 3, nVerdictsB: 3 }).status, 'compared');
});

// ══ ITEM 1 — THE RESERVE ARITHMETIC ════════════════════════════════════════════════════════════

test('item 1: the reserve admits a 275 s case and refuses one that cannot finish', () => {
  // Exactly one measured case must fit inside the reserve, with margin to spare.
  assert.ok(AA_PER_CASE_RESERVE_MS >= AA_MEASURED_CASE_MS, 'the reserve is at least one full case');
  assert.ok(AA_PER_CASE_RESERVE_MS - AA_MEASURED_CASE_MS >= 25_000, 'and carries real margin on top');

  assert.equal(canStartCase(AA_PER_CASE_RESERVE_MS), true, 'exactly the reserve is enough');
  assert.equal(canStartCase(AA_PER_CASE_RESERVE_MS + 1), true);
  assert.equal(canStartCase(AA_PER_CASE_RESERVE_MS - 1), false, 'one ms short is not enough');
  assert.equal(canStartCase(AA_MEASURED_CASE_MS), false, 'a bare 275 s left is NOT started — no margin');
  assert.equal(canStartCase(60_000), false, 'the OLD reserve would have started a case that then died');
  assert.equal(canStartCase(0), false);
  assert.equal(canStartCase(-1), false);
  assert.equal(canStartCase(NaN), false, 'a broken clock never starts a case');
});

test('item 1: the three timing values, and that they are consistent with each other', () => {
  assert.equal(AA_ROUTE_MAX_DURATION_S, 800);
  assert.equal(AA_DEADLINE_MS, 665_000);
  assert.equal(AA_PER_CASE_RESERVE_MS, 305_000);
  assert.equal(AA_MEASURED_CASE_MS, 275_000);
  assert.equal(AA_MEASURED_JUDGE_CALL_MS, 135_000);

  const boxMs = AA_ROUTE_MAX_DURATION_S * 1000;
  assert.ok(AA_DEADLINE_MS < boxMs, 'the internal deadline sits inside the platform box');
  // Today's safety margin was 250/300 = 83.3% of the box. The new pair keeps at least that much
  // headroom in reserve — never less.
  assert.ok(AA_DEADLINE_MS / boxMs <= 250 / 300 + 1e-9, 'the fraction of the box used has not grown');
  assert.ok(boxMs - AA_DEADLINE_MS >= 130_000, 'and the absolute headroom is far larger than the old 50 s');

  // The worst legal case: started with exactly the reserve left, running to the full watchdog.
  const worstFinish = (AA_DEADLINE_MS - AA_PER_CASE_RESERVE_MS) + AA_PER_CASE_RESERVE_MS;
  assert.ok(worstFinish <= AA_DEADLINE_MS, 'a case started at the reserve line ends by the deadline');
  assert.ok(AA_DEADLINE_MS + 0 < boxMs, 'leaving the platform box to write the response');

  // Two full cases fit in one invocation; the third is correctly refused.
  let t = 0, started = 0;
  while (canStartCase(AA_DEADLINE_MS - t)) { started++; t += AA_MEASURED_CASE_MS; }
  assert.equal(started, 2, 'two measured cases per call — the old pair managed at most one');
  assert.ok(t <= AA_ROUTE_MAX_DURATION_S * 1000, 'and they finish inside the box');
});

// ══ ITEM 3, THE STORED CASE ════════════════════════════════════════════════════════════════════
/**
 * The store call lives in an App Router route, which the `lib/**` test glob cannot import and Next
 * will not let export helpers. So the stored SHAPE is pinned by source assertion — the same idiom
 * the architecture tests use. It proves what a unit test here can prove: that the field reaches
 * `saveLabAnalysis`, that `served` was left beside it rather than replaced, and that the columns
 * no longer take an empty lookup as their only source. It does NOT prove the row that lands in
 * lab_analyses; the orchestrator validates that against the live store before r2. Stated in the
 * build report.
 */
test('item 3: the route stores attribution for BOTH runs, and leaves `served` alone', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../app/api/admin/lvc-judge-aa/route.ts', import.meta.url), 'utf8');

  assert.match(src, /const attrA = a\.judgeAttribution \?\? null;/, 'run A attribution comes off the result');
  assert.match(src, /const attrB = b\.judgeAttribution \?\? null;/, 'run B attribution comes off the result');
  assert.match(src, /const attribution = \{ runA: attrA, runB: attrB \};/, 'both runs, named separately');
  // Two store calls (the compared case and the failed case) must BOTH carry it.
  assert.equal((src.match(/^\s+attribution,$/gm) ?? []).length, 2, 'both the compared and the failed store call carry it');
  // `served` survives untouched beside the new field — readers of r1 rows must find it.
  assert.match(src, /servedCallForAudit\(a\.traceId, 'lvc_judge'\)/, 'the older lookup is still called');
  assert.match(src, /^\s+served,$/m, 'and still stored, unchanged, beside the new field');
  // The columns prefer the new evidence and fall back to the old lookup.
  assert.match(src, /model: attrA\?\.dispatched_model \?\? served\.model/);
  assert.match(src, /provider: attrA\?\.dispatched_provider \?\? served\.provider/);
});

test('item 1: the route\'s maxDuration literal and AA_ROUTE_MAX_DURATION_S cannot drift apart', async () => {
  // Next parses segment config statically, so `maxDuration` must be a literal and cannot be the
  // imported constant. This is what stops the literal and the arithmetic disagreeing later.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../app/api/admin/lvc-judge-aa/route.ts', import.meta.url), 'utf8');
  const m = src.match(/export const maxDuration = (\d+);/);
  assert.ok(m, 'the route declares maxDuration as a literal');
  assert.equal(Number(m![1]), AA_ROUTE_MAX_DURATION_S, 'and it equals the constant the arithmetic uses');
  // The internal deadline must come from the constant, not a second hand-written number.
  assert.match(src, /const deadlineAt = Date\.now\(\) \+ AA_DEADLINE_MS;/);
  assert.match(src, /if \(!canStartCase\(left\)\)/, 'and the reserve check goes through the tested predicate');
});

test('item 1: the watchdog budget is what remains, never negative', () => {
  assert.equal(caseBudgetMs(305_000), 305_000);
  assert.equal(caseBudgetMs(0), 0);
  assert.equal(caseBudgetMs(-5), 0);
  assert.equal(caseBudgetMs(1.9), 1);
});
