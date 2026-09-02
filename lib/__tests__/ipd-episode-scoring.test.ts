/**
 * lib/__tests__/ipd-episode-scoring.test.ts — PRD §13 items 5–11, 16 and 17. Pure core only.
 *
 * EVERY RULE HERE IS TESTED AS CODE, NOT AS PROMPT TEXT. That is the whole design: the prompts
 * state the Tier C rule, the uncited cap, the A2 domain fence and the commentary ban on numbers,
 * and then this layer re-applies each of them to whatever actually came back. A prompt is an
 * instruction; only these functions are a guarantee.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTierCRule, applyUncitedCap, attachAttribution, attributedParty, completenessPct,
  countFindings, divergenceIndex, dropInvalidFidelityFindings, evidenceTiersOf, finalizeFindings,
  parseFindings, validateCommentary, asLvcCategory, SEVERITY_PENALTY,
  type EpisodeFinding, type Severity, type Verdict, type Domain, type AuditPass,
} from '../ipd-episode/judge-core';
import { checkpointEntryRefs, parseExpectedCourse, buildRetrievalQuery, type CheckpointEntryRef } from '../ipd-episode/checkpoint-core';
import { checkpointModel, IPD_EPISODE_CHECKPOINT_MODEL_DEFAULT } from '../ipd-episode/checkpoint';
import { judgeModel, IPD_EPISODE_JUDGE_MODEL_DEFAULT } from '../ipd-episode/judge';
import { assertKnownBedrockModel, isKnownBedrockModel } from '../bedrock-core';
import { skipIsRetryable, SKIP_RETRY_DAYS } from '../ipd-episode/store';
import type { EpisodeEvent } from '../ipd-episode/assemble-core';

const f = (o: Partial<EpisodeFinding> & { finding_id: string }): EpisodeFinding => ({
  pass: 'divergence' as AuditPass, finding_type: 'omission', verdict: 'divergent' as Verdict,
  domain: 'diagnostics' as Domain, day_index: 0, checkpoint_ref: null, statement: 'a statement',
  severity: 'minor' as Severity, evidence_tier: 'A',
  evidence_basis: [{ source_table: 'kx_clinical_template_progress_reports', source_record_id: 'n1', source_timestamp: null }],
  author_name: null, author_role: null, responsible_clinician_id: null, lvc_category: null, citation_ids: [],
  ...o,
});

const refs = (entries: [string, number[]][]): Map<string, CheckpointEntryRef> =>
  new Map(entries.map(([ref, citation_ids]) => [ref, { ref, citation_ids }]));

// ── 5. divergence index ──────────────────────────────────────────────────────────────────────

test('divergence index: 100 minus 8·major + 4·moderate + 1·minor', () => {
  assert.equal(SEVERITY_PENALTY.major, 8);
  assert.equal(SEVERITY_PENALTY.moderate, 4);
  assert.equal(SEVERITY_PENALTY.minor, 1);
  assert.equal(divergenceIndex([]), 100);
  assert.equal(divergenceIndex([f({ finding_id: '1', severity: 'major' })]), 92);
  assert.equal(divergenceIndex([f({ finding_id: '1', severity: 'moderate' })]), 96);
  assert.equal(divergenceIndex([f({ finding_id: '1', severity: 'minor' })]), 99);
  assert.equal(divergenceIndex([
    f({ finding_id: '1', severity: 'major' }), f({ finding_id: '2', severity: 'moderate' }), f({ finding_id: '3', severity: 'minor' }),
  ]), 100 - 13);
});

test('divergence index floors at zero and never goes negative', () => {
  const many = Array.from({ length: 20 }, (_, i) => f({ finding_id: String(i), severity: 'major' }));
  assert.equal(divergenceIndex(many), 0);
});

test('divergence index: only `divergent` contributes — the other three verdicts are free', () => {
  for (const verdict of ['context_dependent', 'unassessable', 'concordant'] as Verdict[]) {
    assert.equal(divergenceIndex([f({ finding_id: '1', severity: 'major', verdict })]), 100, verdict);
  }
});

test('divergence index: A1 and A2 findings BOTH count, on one shared penalty (decision 16)', () => {
  const both = [
    f({ finding_id: 'a1', pass: 'divergence', severity: 'major' }),
    f({ finding_id: 'a2', pass: 'fidelity', domain: 'documentation', finding_type: 'commission', severity: 'moderate' }),
  ];
  assert.equal(divergenceIndex(both), 100 - 12);
});

// ── 6. the Tier C rule ───────────────────────────────────────────────────────────────────────

test('Tier C rule: a divergent finding resting only on Tier C sources is rewritten to unassessable', () => {
  const only_c = f({ finding_id: '1', evidence_basis: [{ source_table: 'kx_radiology_reports', source_record_id: 'r1', source_timestamp: null }] });
  const res = applyTierCRule(only_c);
  assert.equal(res.rewritten, true);
  assert.equal(res.finding.verdict, 'unassessable');
});

test('Tier C rule: an EMPTY evidence basis is rewritten too — an uncited claim is not a verdict', () => {
  const res = applyTierCRule(f({ finding_id: '1', evidence_basis: [] }));
  assert.equal(res.rewritten, true);
  assert.equal(res.finding.verdict, 'unassessable');
});

test('Tier C rule: a MIXED A-and-C basis is left alone — one real source is enough', () => {
  const mixed = f({ finding_id: '1', evidence_basis: [
    { source_table: 'kx_radiology_reports', source_record_id: 'r1', source_timestamp: null },
    { source_table: 'kx_billing_records', source_record_id: 'b1', source_timestamp: null },
  ] });
  const res = applyTierCRule(mixed);
  assert.equal(res.rewritten, false);
  assert.equal(res.finding.verdict, 'divergent');
});

test('Tier C rule reads the SOURCE TABLE, not the model’s own evidence_tier claim', () => {
  // the model says tier A; the basis says radiology, which this mirror does not hold
  const lying = f({ finding_id: '1', evidence_tier: 'A', evidence_basis: [{ source_table: 'kx_radiology_reports', source_record_id: 'r1', source_timestamp: null }] });
  assert.equal(applyTierCRule(lying).finding.verdict, 'unassessable');
});

test('Tier C rule touches only `divergent` findings — a context_dependent one is already honest', () => {
  const cd = f({ finding_id: '1', verdict: 'context_dependent', evidence_basis: [] });
  assert.equal(applyTierCRule(cd).rewritten, false);
  assert.equal(applyTierCRule(cd).finding.verdict, 'context_dependent');
});

// ── 7. the uncited cap ───────────────────────────────────────────────────────────────────────

test('uncited cap: an A1 finding on an entry with no citations is capped to minor / context_dependent', () => {
  const map = refs([['cp-d1/diagnostics/1', []]]);
  const res = applyUncitedCap(f({ finding_id: '1', severity: 'major', checkpoint_ref: 'cp-d1/diagnostics/1' }), map);
  assert.equal(res.capped, true);
  assert.equal(res.finding.severity, 'minor');
  assert.equal(res.finding.verdict, 'context_dependent');
});

test('uncited cap does NOT apply to a fidelity finding — A2 measures against the record, not an expectation', () => {
  const map = refs([['cp-d1/diagnostics/1', []]]);
  const a2 = f({ finding_id: '1', pass: 'fidelity', domain: 'documentation', finding_type: 'commission', severity: 'major', checkpoint_ref: 'cp-d1/diagnostics/1' });
  const res = applyUncitedCap(a2, map);
  assert.equal(res.capped, false);
  assert.equal(res.finding.severity, 'major');
});

test('uncited cap: a CITED entry leaves the finding alone', () => {
  const map = refs([['cp-d1/diagnostics/1', [3]]]);
  const res = applyUncitedCap(f({ finding_id: '1', severity: 'major', checkpoint_ref: 'cp-d1/diagnostics/1' }), map);
  assert.equal(res.capped, false);
  assert.equal(res.finding.severity, 'major');
});

test('uncited cap: an UNRESOLVABLE checkpoint_ref is not evidence the entry was uncited, so nothing is capped', () => {
  const map = refs([['cp-d1/diagnostics/1', []]]);
  for (const ref of ['cp-d9/diagnostics/7', null]) {
    const res = applyUncitedCap(f({ finding_id: '1', severity: 'major', checkpoint_ref: ref }), map);
    assert.equal(res.capped, false, String(ref));
    assert.equal(res.finding.severity, 'major');
  }
});

test('checkpoint entry refs address every entry of an expected course, section by section', () => {
  const course = parseExpectedCourse(JSON.stringify({
    expected_diagnostics: [{ item: 'CBC', by_day: 0, rationale: 'r', citation_ids: [1] }, { item: 'CRP', by_day: 1, rationale: 'r', citation_ids: [] }],
    expected_therapeutics: [{ item: 'IV fluids', by_day: 0, rationale: 'r', citation_ids: [] }],
    expected_monitoring: [{ item: 'hourly urine output', frequency: 'hourly', rationale: 'r', citation_ids: [2] }],
    escalation_triggers: [{ trigger: 'SBP < 90', action: 'escalate', citation_ids: [] }],
    expected_los_days: 3, expected_disposition: 'home', uncertainty: ['no vitals in this substrate'],
  }), 3);
  assert.ok(course);
  const r = checkpointEntryRefs('cp-d0', course);
  assert.deepEqual(r.map((x) => x.ref), [
    'cp-d0/diagnostics/1', 'cp-d0/diagnostics/2', 'cp-d0/therapeutics/1', 'cp-d0/monitoring/1', 'cp-d0/escalation/1',
  ]);
  assert.deepEqual(r.find((x) => x.ref === 'cp-d0/diagnostics/1')!.citation_ids, [1]);
  assert.deepEqual(r.find((x) => x.ref === 'cp-d0/diagnostics/2')!.citation_ids, []);
});

test('checkpoint parsing clamps a citation to the excerpts actually shown — never renumbers one', () => {
  const course = parseExpectedCourse(JSON.stringify({
    expected_diagnostics: [{ item: 'CBC', by_day: 0, rationale: 'r', citation_ids: [1, 9, 0, -2, 3] }],
  }), 3);
  assert.deepEqual(course!.expected_diagnostics[0].citation_ids, [1, 3], 'ids outside [1..k] are dropped');
});

// ── 8. the A2 domain drop ────────────────────────────────────────────────────────────────────

test('A2 domain drop: a fidelity finding in therapeutics is DROPPED and counted, never relabelled', () => {
  const list = [
    f({ finding_id: 'a2-1', pass: 'fidelity', domain: 'documentation', finding_type: 'commission' }),
    f({ finding_id: 'a2-2', pass: 'fidelity', domain: 'therapeutics', finding_type: 'commission' }),
    f({ finding_id: 'a1-1', pass: 'divergence', domain: 'therapeutics' }),
  ];
  const { kept, dropped } = dropInvalidFidelityFindings(list);
  assert.equal(dropped, 1);
  assert.deepEqual(kept.map((x) => x.finding_id), ['a2-1', 'a1-1']);
  assert.ok(!kept.some((x) => x.pass === 'fidelity' && x.domain !== 'documentation'));
});

test('the A2 drop count lands in n_dropped_invalid, where a reader can see it', () => {
  const list = [
    f({ finding_id: 'a2-1', pass: 'fidelity', domain: 'documentation', finding_type: 'commission' }),
    f({ finding_id: 'a2-2', pass: 'fidelity', domain: 'escalation', finding_type: 'commission' }),
  ];
  const res = finalizeFindings(list, new Map(), []);
  assert.equal(res.counters.n_dropped_invalid, 1);
  assert.equal(res.counters.n_findings, 1);
});

// ── 9. completeness ──────────────────────────────────────────────────────────────────────────

test('completeness: nine-source denominator; all nine present is 100', () => {
  assert.equal(completenessPct([
    'kx_ip_admissions', 'kx_clinical_template_progress_reports', 'kx_billing_records', 'kx_lab_reports',
    'kx_discharge_summary_records', 'kx_clinical_template_initial_assessment_adults',
    'kx_clinical_template_shift_handovers', 'kx_clinical_template_ot_notes', 'kx_ip_transfers',
  ]), 100);
});

test('completeness: the floor is 33 — selection already requires three of the nine', () => {
  assert.equal(completenessPct(['kx_ip_admissions', 'kx_clinical_template_progress_reports', 'kx_discharge_summary_records']), 33);
  assert.equal(completenessPct(['kx_ip_admissions', 'kx_clinical_template_progress_reports', 'kx_discharge_summary_records', 'kx_billing_records']), 44);
});

test('completeness ignores a table that is not one of the nine, and never double-counts one', () => {
  assert.equal(completenessPct(['kx_ip_admissions', 'kx_ip_admissions', 'kx_radiology_reports']), 11);
});

test('evidence_tiers records which source tables appeared, by tier', () => {
  const t = evidenceTiersOf(['kx_ip_admissions', 'kx_ip_transfers', 'kx_billing_records']);
  assert.deepEqual(t.A, ['kx_billing_records', 'kx_ip_admissions']);
  assert.deepEqual(t.B, ['kx_ip_transfers']);
  assert.deepEqual(t.C, []);
});

// ── 10. author attribution ───────────────────────────────────────────────────────────────────

const NOTE_EVENT: EpisodeEvent = {
  event_id: 'note-n1', occurred_at: '2026-08-02T04:00:00.000Z', day_index: 0, event_type: 'note',
  summary: 'ward round', detail: {}, author_name: 'Dr Testperson Alpha', author_role: 'RMO',
  responsible_clinician_id: 'DOC-77',
  provenance: { source_table: 'kx_clinical_template_progress_reports', source_record_id: 'n1', source_timestamp: '2026-08-02T04:00:00.000Z' },
  evidence_tier: 'A',
};

test('attribution: a note-derived finding carries BOTH the author and the responsible clinician', () => {
  const attached = attachAttribution(f({ finding_id: '1' }), [NOTE_EVENT]);
  assert.equal(attached.author_name, 'Dr Testperson Alpha');
  assert.equal(attached.author_role, 'RMO');
  assert.equal(attached.responsible_clinician_id, 'DOC-77');
});

test('attribution: a DOCUMENTATION finding is the author’s; every other domain is the responsible clinician’s', () => {
  const doc = attachAttribution(f({ finding_id: '1', domain: 'documentation', pass: 'fidelity', finding_type: 'commission' }), [NOTE_EVENT]);
  assert.deepEqual(attributedParty(doc), { kind: 'author', value: 'Dr Testperson Alpha' });
  const ther = attachAttribution(f({ finding_id: '2', domain: 'therapeutics' }), [NOTE_EVENT]);
  assert.deepEqual(attributedParty(ther), { kind: 'responsible_clinician', value: 'DOC-77' });
});

test('attribution: an unattributable finding is reported unattributed, never assigned to the nearest name', () => {
  const orphan = f({ finding_id: '1', evidence_basis: [{ source_table: 'kx_billing_records', source_record_id: 'b-999', source_timestamp: null }] });
  const attached = attachAttribution(orphan, [NOTE_EVENT]);
  assert.equal(attached.author_name, null);
  assert.equal(attributedParty(attached), null);
});

// ── 11. commentary rejection ─────────────────────────────────────────────────────────────────

test('commentary: a score field anywhere in the object graph is rejected', () => {
  for (const body of [
    { narrative: 'n', outcome_context: 'o', score: 71 },
    { narrative: 'n', outcome_context: 'o', findings_context: [{ finding_id: 'a1-1', note: 'x', severity: 'major' }] },
    { narrative: 'n', outcome_context: 'o', summary: { divergence_index: 88 } },
  ]) {
    const v = validateCommentary(JSON.stringify(body), ['a1-1']);
    assert.equal(v.ok, false, JSON.stringify(body));
  }
});

test('commentary: an unknown finding_id is rejected', () => {
  const v = validateCommentary(JSON.stringify({
    narrative: 'n', outcome_context: 'o', findings_context: [{ finding_id: 'invented-9', note: 'x' }],
  }), ['a1-1']);
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /unknown finding_id/);
});

test('commentary: valid prose annotating a real finding is accepted', () => {
  const v = validateCommentary(JSON.stringify({
    narrative: 'A short admission that ran close to the expected course.',
    outcome_context: 'The outcome makes the day-1 omission look less consequential than it reads.',
    findings_context: [{ finding_id: 'a1-1', note: 'hindsight makes this look harsh' }],
  }), ['a1-1']);
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.commentary.findings_context.length, 1);
    assert.match(v.commentary.narrative, /short admission/);
  }
});

test('commentary: an empty or unparseable response is rejected rather than stored as blank prose', () => {
  assert.equal(validateCommentary('', ['a1-1']).ok, false);
  assert.equal(validateCommentary('sorry, I cannot', ['a1-1']).ok, false);
  assert.equal(validateCommentary(JSON.stringify({ findings_context: [] }), ['a1-1']).ok, false);
});

// ── parsing and enums ────────────────────────────────────────────────────────────────────────

test('finding parsing drops a malformed finding rather than inventing a default verdict for it', () => {
  const text = JSON.stringify({ findings: [
    { finding_id: 'ok', finding_type: 'omission', verdict: 'divergent', domain: 'diagnostics', severity: 'minor', statement: 'a', day_index: 1, evidence_basis: [{ source_table: 'kx_billing_records', source_record_id: 'b1' }] },
    { finding_id: 'bad-verdict', finding_type: 'omission', verdict: 'terrible', domain: 'diagnostics', severity: 'minor', statement: 'a' },
    { finding_id: 'no-statement', finding_type: 'omission', verdict: 'divergent', domain: 'diagnostics', severity: 'minor' },
    { finding_id: 'bad-domain', finding_type: 'omission', verdict: 'divergent', domain: 'vibes', severity: 'minor', statement: 'a' },
  ] });
  const { findings, dropped } = parseFindings(text, { pass: 'divergence', idPrefix: 'a1', excerptCount: 4 });
  assert.equal(findings.length, 1);
  assert.equal(dropped, 3);
  assert.equal(findings[0].finding_id, 'a1-ok');
  assert.equal(findings[0].pass, 'divergence');
});

test('lvc_category rides only on a commission finding in therapeutics or diagnostics, and only a known value', () => {
  const mk = (domain: string, finding_type: string, lvc_category: string) => JSON.stringify({ findings: [
    { finding_id: 'x', finding_type, verdict: 'divergent', domain, severity: 'minor', statement: 'a', lvc_category },
  ] });
  const one = (t: string) => parseFindings(t, { pass: 'divergence', idPrefix: 'a1', excerptCount: 0 }).findings[0];
  assert.equal(one(mk('therapeutics', 'commission', 'antibiotic')).lvc_category, 'antibiotic');
  assert.equal(one(mk('diagnostics', 'commission', 'imaging')).lvc_category, 'imaging');
  assert.equal(one(mk('monitoring', 'commission', 'antibiotic')).lvc_category, null, 'wrong domain');
  assert.equal(one(mk('therapeutics', 'omission', 'antibiotic')).lvc_category, null, 'wrong finding type');
  assert.equal(one(mk('therapeutics', 'commission', 'made_up_tag')).lvc_category, null, 'unknown value → null');
  assert.equal(asLvcCategory('other'), 'other');
  assert.equal(asLvcCategory('nope'), null);
});

test('counters tally every dimension the audit row stores', () => {
  const list = [
    f({ finding_id: '1', pass: 'divergence', finding_type: 'omission', verdict: 'divergent', severity: 'major' }),
    f({ finding_id: '2', pass: 'divergence', finding_type: 'timing', verdict: 'context_dependent' }),
    f({ finding_id: '3', pass: 'divergence', finding_type: 'sequencing', verdict: 'concordant' }),
    f({ finding_id: '4', pass: 'fidelity', domain: 'documentation', finding_type: 'commission', verdict: 'unassessable', lvc_category: null }),
    f({ finding_id: '5', pass: 'divergence', finding_type: 'commission', domain: 'therapeutics', verdict: 'divergent', severity: 'minor', lvc_category: 'antibiotic' }),
  ];
  const c = countFindings(list, 2);
  assert.equal(c.n_findings, 5);
  assert.equal(c.n_divergence_pass, 4);
  assert.equal(c.n_fidelity_pass, 1);
  assert.equal(c.n_omission, 1);
  assert.equal(c.n_commission, 2);
  assert.equal(c.n_timing, 1);
  assert.equal(c.n_sequencing, 1);
  assert.equal(c.n_divergent, 2);
  assert.equal(c.n_context_dependent, 1);
  assert.equal(c.n_unassessable, 1);
  assert.equal(c.n_concordant, 1);
  assert.equal(c.n_low_value, 1);
  assert.equal(c.n_dropped_invalid, 2);
});

test('finalizeFindings applies the whole chain in one place, so its order cannot drift between callers', () => {
  const map = refs([['cp-d1/diagnostics/1', []]]);
  const res = finalizeFindings([
    // capped by the uncited rule (major → minor / context_dependent), so it scores 0
    f({ finding_id: 'capped', severity: 'major', checkpoint_ref: 'cp-d1/diagnostics/1' }),
    // rewritten by the Tier C rule, so it scores 0
    f({ finding_id: 'tierc', severity: 'major', evidence_basis: [] }),
    // dropped: a fidelity finding outside documentation
    f({ finding_id: 'dropped', pass: 'fidelity', domain: 'monitoring', finding_type: 'commission', severity: 'major' }),
    // the only finding that actually scores
    f({ finding_id: 'real', severity: 'moderate' }),
  ], map, [NOTE_EVENT]);
  assert.equal(res.n_uncited_capped, 1);
  assert.equal(res.n_tier_c_rewritten, 1);
  assert.equal(res.counters.n_dropped_invalid, 1);
  assert.equal(res.counters.n_findings, 3);
  assert.equal(res.divergence_index, 96, 'one moderate divergent finding only');
});

// ── retrieval query ──────────────────────────────────────────────────────────────────────────

test('the retrieval query is built in the PRD order and reads only events the checkpoint may see', () => {
  const before: EpisodeEvent[] = [
    { ...NOTE_EVENT, event_id: 'n-old', occurred_at: '2026-08-01T20:00:00.000Z', summary: 'older note' },
    { ...NOTE_EVENT, event_id: 'n-new', occurred_at: '2026-08-02T04:00:00.000Z', summary: 'newest note before the cutoff' },
  ];
  const q = buildRetrievalQuery({
    treatingDepartmentName: 'General Medicine', admissionType: 'direct_admission',
    admitSource: 'OPD', remarks: 'fever 4 days', eventsBeforeCutoff: before,
  });
  assert.match(q, /^General Medicine direct_admission OPD fever 4 days/);
  assert.ok(q.includes('newest note before the cutoff'), 'the LATEST note before the cutoff is used');
  assert.ok(!q.includes('older note'));
});

test('the retrieval query survives an empty envelope and an empty event list', () => {
  assert.equal(buildRetrievalQuery({
    treatingDepartmentName: null, admissionType: null, admitSource: null, remarks: null, eventsBeforeCutoff: [],
  }), '');
});

// ── 16. the skip retry window ────────────────────────────────────────────────────────────────

test('skip retry: a skip whose discharge is 15 days old is not selected again', () => {
  assert.equal(SKIP_RETRY_DAYS, 14);
  const now = new Date('2026-09-02T00:00:00.000Z');
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  assert.equal(skipIsRetryable(daysAgo(15), now), false);
  assert.equal(skipIsRetryable(daysAgo(14), now), false, 'the window closes AT 14 days');
  assert.equal(skipIsRetryable(daysAgo(13), now), true);
  assert.equal(skipIsRetryable(daysAgo(0), now), true);
});

test('skip retry: an undateable skip keeps being retried — the engine does not stop looking at what it cannot date', () => {
  assert.equal(skipIsRetryable(null), true);
  assert.equal(skipIsRetryable('not a date'), true);
});

// ── 17. the model environment ────────────────────────────────────────────────────────────────

test('model env: the two defaults are real entries in the Bedrock allowlist', () => {
  assert.equal(IPD_EPISODE_CHECKPOINT_MODEL_DEFAULT, 'global.anthropic.claude-haiku-4-5-20251001-v1:0');
  assert.equal(IPD_EPISODE_JUDGE_MODEL_DEFAULT, 'global.anthropic.claude-opus-4-6-v1');
  assert.ok(isKnownBedrockModel(IPD_EPISODE_CHECKPOINT_MODEL_DEFAULT));
  assert.ok(isKnownBedrockModel(IPD_EPISODE_JUDGE_MODEL_DEFAULT));
  assert.doesNotThrow(() => assertKnownBedrockModel(IPD_EPISODE_CHECKPOINT_MODEL_DEFAULT));
  assert.doesNotThrow(() => assertKnownBedrockModel(IPD_EPISODE_JUDGE_MODEL_DEFAULT));
});

test('model env: an override is honoured; an unknown id is REFUSED before any work, never fallen back from', () => {
  assert.equal(checkpointModel({}), IPD_EPISODE_CHECKPOINT_MODEL_DEFAULT);
  assert.equal(checkpointModel({ IPD_EPISODE_CHECKPOINT_MODEL: '  ' }), IPD_EPISODE_CHECKPOINT_MODEL_DEFAULT);
  assert.equal(checkpointModel({ IPD_EPISODE_CHECKPOINT_MODEL: 'global.anthropic.claude-sonnet-4-6' }), 'global.anthropic.claude-sonnet-4-6');
  assert.equal(judgeModel({ IPD_EPISODE_JUDGE_MODEL: 'global.anthropic.claude-sonnet-4-6' }), 'global.anthropic.claude-sonnet-4-6');
  // the refusal is the point: a mistyped variable must cost a throw, not a silently cheaper grader
  assert.throws(() => assertKnownBedrockModel(judgeModel({ IPD_EPISODE_JUDGE_MODEL: 'gpt-4o' })), /unknown model/);
  assert.throws(() => assertKnownBedrockModel(checkpointModel({ IPD_EPISODE_CHECKPOINT_MODEL: 'claude-haiku-4-5' })), /unknown model/);
});
