import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMemberState } from '../member-state/aggregate-core';
import type { MemberEvidence, EncounterEvidence } from '../member-state/schema';
import type { Provenance, MedicationAssertion, AllergyAssertion, MedicationStatus, AllergyStatus } from '../clinical-state/schema';

const COMPUTED = '2026-07-11T00:00:00.000Z';
function prov(sf = 'src'): Provenance { return { sourceField: sf, rawText: 'x', extractionMethod: 'reported', confidence: 0.9 }; }
function enc(encounterRef: string, date: string, over: Partial<EncounterEvidence> = {}): EncounterEvidence {
  return { encounterRef, date, kind: 'opd', problems: [], medicationAssertions: [], allergyAssertions: [], investigations: [], ...over };
}
function problem(conceptRaw: string, explicitStatus: 'active' | 'resolved' | null = null, icdCode: string | null = null) {
  return { conceptRaw, icdCode, explicitStatus, provenance: prov('dx') };
}
function med(raw: string, status: MedicationStatus = 'prescribed'): MedicationAssertion {
  return { id: `m-${raw}`, medicationConcept: { raw, generic: raw, normalizedConceptId: null }, status, dose: '1', frequency: '1-0-1', provenance: prov('meds') };
}
function allergy(raw: string, status: AllergyStatus): AllergyAssertion {
  return { id: `a-${raw}-${status}`, substance: { raw, normalized: null }, status, reaction: null, provenance: prov('allergy') };
}
function inv(analyteRaw: string, value: string, unit: string | null, abnormal: string | null = null) {
  return { analyteRaw, value, unit, abnormal, provenance: prov('lab') };
}
function member(encounters: EncounterEvidence[], memberRef = 'M1'): MemberEvidence {
  return { memberRef, encounters, sourceWatermarks: { db13: '2026-07-11' }, generatedAt: '2026-07-11' };
}
const findP = (s: ReturnType<typeof buildMemberState>, id: string) => s.problems.find((p) => p.normalizedConcept.normalizedConceptId === id);

// ── Part A invariants ──────────────────────────────────────────────────────────

test('inv1 / stratum4: problem omitted at a later encounter → uncertain_current_status, never resolved', () => {
  const s = buildMemberState(member([
    enc('e1', '2026-01-15', { problems: [problem('hypertension')] }),
    enc('e2', '2026-02-20', { problems: [problem('diabetes')] }),   // htn omitted here; asOf = Feb
  ]), COMPUTED);
  const htn = findP(s, 'local:hypertension')!;
  assert.equal(htn.latestDocumentedStatus, 'uncertain_current_status');
  assert.notEqual(htn.latestDocumentedStatus, 'documented_resolved');
});

test('inv1 / stratum3: explicit later resolved → documented_resolved', () => {
  const s = buildMemberState(member([
    enc('e1', '2026-01-15', { problems: [problem('bronchial asthma', 'active')] }),
    enc('e2', '2026-03-15', { problems: [problem('bronchial asthma', 'resolved')] }),
  ]), COMPUTED);
  assert.equal(findP(s, 'local:asthma')!.latestDocumentedStatus, 'documented_resolved');
});

test('inv2: empty memberRef is a hard error (single-member invariant)', () => {
  assert.throws(() => buildMemberState(member([enc('e1', '2026-01-01')], ''), COMPUTED));
});

test('inv3: two distinct raws with no dictionary hit stay separate (no fuzzy merge)', () => {
  const s = buildMemberState(member([
    enc('e1', '2026-01-01', { problems: [problem('foobar syndrome')] }),
    enc('e1b', '2026-01-02', { problems: [problem('bazqux disease')] }),
  ]), COMPUTED);
  assert.equal(s.problems.length, 2);
  assert.ok(s.problems.every((p) => p.normalizedConcept.relation === 'unresolved'));
});

test('inv4 + inv5: every occurrence carries provenance and the derived status keeps its occurrences', () => {
  const s = buildMemberState(member([
    enc('e1', '2025-01-01', { problems: [problem('hypertension')] }),
    enc('e2', '2025-06-01', { problems: [problem('hypertension')] }),
  ]), COMPUTED);
  const htn = findP(s, 'local:hypertension')!;
  assert.equal(htn.occurrences.length, 2);
  assert.ok(htn.occurrences.every((o) => o.provenance && o.provenance.sourceField.length > 0));
});

test('inv6 / stratum5: contradictory allergy → reported_allergy AND a safety_critical status_conflict', () => {
  const s = buildMemberState(member([
    enc('e1', '2026-01-01', { allergyAssertions: [allergy('penicillin', 'reported_allergy')] }),
    enc('e2', '2026-02-01', { allergyAssertions: [allergy('penicillin', 'denied')] }),
  ]), COMPUTED);
  assert.equal(s.allergies.length, 1);
  assert.equal(s.allergies[0].status, 'reported_allergy');   // reported dominates denied
  const conflict = s.conflicts.find((c) => c.domain === 'allergy' && c.type === 'status_conflict');
  assert.ok(conflict);
  assert.equal(conflict!.severity, 'safety_critical');
  assert.equal(conflict!.resolutionStatus, 'open');
});

test('inv7: buildMemberState is reproducible — same evidence + versions → deep-equal', () => {
  const ev = member([
    enc('e1', '2025-01-01', { problems: [problem('hypertension')], medicationAssertions: [med('metformin')] }),
    enc('e2', '2025-06-01', { allergyAssertions: [allergy('penicillin', 'reported_allergy')], investigations: [inv('creatinine', '1.1', 'mg/dL')] }),
  ]);
  assert.deepEqual(buildMemberState(ev, COMPUTED), buildMemberState(ev, COMPUTED));
});

test('inv7 / stratum13: buildMemberState does not mutate input; corrected evidence → corrected snapshot', () => {
  const ev = member([enc('e1', '2026-01-01', { problems: [problem('hypertension')] })]);
  const before = JSON.parse(JSON.stringify(ev));
  const s1 = buildMemberState(ev, COMPUTED);
  assert.deepEqual(ev, before);   // evidence immutable
  const ev2 = member([...ev.encounters, enc('e2', '2026-05-01', { problems: [problem('diabetes')] })]);
  const s2 = buildMemberState(ev2, COMPUTED);
  assert.notDeepEqual(s1.problems.length, s2.problems.length);
});

test('inv9: version + as-of metadata is mandatory and stamped', () => {
  const s = buildMemberState(member([enc('e1', '2026-03-01'), enc('e2', '2026-05-01')]), COMPUTED);
  assert.equal(s.version, 'member-state/1.0');
  assert.equal(s.normalizationVersion, 'member-norm/0.1');
  assert.equal(s.reconciliationVersion, 'member-reconcile/0.1');
  assert.equal(s.computedAt, COMPUTED);
  assert.equal(s.asOf, '2026-05-01');   // max encounter date
  assert.deepEqual(s.sourceEncounterRefs, ['e1', 'e2']);
});

test('inv10: unresolved concept flows through as data (null id, relation unresolved)', () => {
  const s = buildMemberState(member([enc('e1', '2026-01-01', { problems: [problem('mystery ailment')] })]), COMPUTED);
  assert.equal(s.problems[0].normalizedConcept.normalizedConceptId, null);
  assert.equal(s.problems[0].normalizedConcept.relation, 'unresolved');
});

// ── Part B strata ────────────────────────────────────────────────────────────────

test('stratum1: persistent chronic (multi-touch, span>1yr, no long gap) → persistent + active', () => {
  const dates = ['2024-01-01', '2024-04-01', '2024-07-01', '2024-10-01', '2025-01-01', '2025-06-01'];
  const s = buildMemberState(member(dates.map((d, i) => enc(`e${i}`, d, { problems: [problem('hypertension')] }))), COMPUTED);
  const htn = findP(s, 'local:hypertension')!;
  assert.equal(htn.course, 'persistent');
  assert.equal(htn.latestDocumentedStatus, 'documented_active');   // last touch == asOf
});

test('stratum2: recurrent (present → long gap → present) → recurrent', () => {
  const s = buildMemberState(member([
    enc('e1', '2024-01-01', { problems: [problem('hypertension')] }),
    enc('e2', '2024-10-01', { problems: [problem('hypertension')] }),   // gap ~274d > 180
  ]), COMPUTED);
  assert.equal(findP(s, 'local:hypertension')!.course, 'recurrent');
});

test('stratum6: medication prescribed → status prescribed, currentness never inferred to taking', () => {
  const s = buildMemberState(member([enc('e1', '2026-01-01', { medicationAssertions: [med('metformin', 'prescribed')] })]), COMPUTED);
  assert.equal(s.medications.length, 1);
  assert.equal(s.medications[0].status, 'prescribed');
  assert.notEqual(s.medications[0].status, 'reported_taking');
});

test('stratum7: medication explicitly stopped → status stopped + a medication status_conflict', () => {
  const s = buildMemberState(member([
    enc('e1', '2026-01-01', { medicationAssertions: [med('metformin', 'prescribed')] }),
    enc('e2', '2026-03-01', { medicationAssertions: [med('metformin', 'stopped')] }),
  ]), COMPUTED);
  assert.equal(s.medications[0].status, 'stopped');   // latest asserted status
  assert.ok(s.conflicts.some((c) => c.domain === 'medication' && c.type === 'status_conflict' && c.severity === 'review'));
});

test('stratum8: broader/narrower wording NOT merged (diabetes vs type-2-diabetes → 2 problems)', () => {
  const s = buildMemberState(member([enc('e1', '2026-01-01', { problems: [problem('diabetes'), problem('type 2 diabetes')] })]), COMPUTED);
  assert.equal(s.problems.length, 2);
  assert.ok(findP(s, 'local:diabetes-mellitus'));
  assert.ok(findP(s, 'local:type-2-diabetes'));
});

test('stratum9: same analyte, different units → one series, unit null, value_conflict Discrepancy', () => {
  const s = buildMemberState(member([
    enc('e1', '2026-01-01', { investigations: [inv('creatinine', '1.0', 'mg/dL')] }),
    enc('e2', '2026-02-01', { investigations: [inv('creatinine', '88', 'umol/L')] }),
  ]), COMPUTED);
  assert.equal(s.investigations.length, 1);
  assert.equal(s.investigations[0].unit, null);
  assert.equal(s.investigations[0].series.length, 2);
  assert.ok(s.conflicts.some((c) => c.domain === 'investigation' && c.type === 'value_conflict'));
});

test('stratum10: abnormal→normal investigation series is date-ordered, unit preserved', () => {
  const s = buildMemberState(member([
    enc('e2', '2026-06-01', { investigations: [inv('hba1c', '6.1', '%', 'false')] }),
    enc('e1', '2026-01-01', { investigations: [inv('hba1c', '9.2', '%', 'true')] }),
  ]), COMPUTED);
  const hba1c = s.investigations.find((i) => i.normalizedAnalyte.normalizedConceptId === 'local:hba1c')!;
  assert.equal(hba1c.unit, '%');
  assert.deepEqual(hba1c.series.map((p) => p.date), ['2026-01-01', '2026-06-01']);   // sorted ascending
  assert.equal(hba1c.series[0].abnormal, 'true');
});

test('stratum12: two simultaneous conditions → two parallel problems', () => {
  const s = buildMemberState(member([enc('e1', '2026-01-01', { problems: [problem('hypertension'), problem('hypothyroidism')] })]), COMPUTED);
  assert.equal(s.problems.length, 2);
});

test('stratum14: "rule out PE" is never merged with confirmed PE', () => {
  const s = buildMemberState(member([
    enc('e1', '2026-01-01', { problems: [problem('rule out PE')] }),
    enc('e2', '2026-02-01', { problems: [problem('PE')] }),
  ]), COMPUTED);
  assert.equal(s.problems.length, 2);
  assert.ok(findP(s, 'local:pulmonary-embolism'));                                   // "PE"
  assert.ok(s.problems.some((p) => p.normalizedConcept.relation === 'unresolved'));  // "rule out PE"
});

test('demographic identity_conflict: sex flip across encounters → review Discrepancy', () => {
  const s = buildMemberState(member([
    enc('e1', '2026-01-01', { demographics: { age: 50, sex: 'M' } }),
    enc('e2', '2026-02-01', { demographics: { age: 50, sex: 'F' } }),
  ]), COMPUTED);
  assert.ok(s.conflicts.some((c) => c.domain === 'demographic' && c.type === 'identity_conflict' && c.severity === 'review'));
});

test('single occurrence → single_episode course', () => {
  const s = buildMemberState(member([enc('e1', '2026-01-01', { problems: [problem('hypertension')] })]), COMPUTED);
  assert.equal(findP(s, 'local:hypertension')!.course, 'single_episode');
});

test('normal aging does NOT raise an identity_conflict (consistent birth year)', () => {
  const s = buildMemberState(member([
    enc('e1', '2020-01-01', { demographics: { age: 60, sex: 'M' } }),
    enc('e2', '2026-01-01', { demographics: { age: 66, sex: 'M' } }),   // same birth year 1960
  ]), COMPUTED);
  assert.ok(!s.conflicts.some((c) => c.domain === 'demographic'));
});
