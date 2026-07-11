import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleEvidence } from '../member-state/assemble-core';
import { buildMemberState } from '../member-state/aggregate-core';

// Inlined real-shape db13 rows (individuals-prescriptions + joined labs), from the §2 probe.
const RX_ROW = {
  uid: 'presc_abc123',
  visit_date: '2026-03-01',
  age: 62, gender: 'M',
  patient_details__allergies: 'No',
  diagnosis_icd_codes: ['E11.9'],
  impression_icd_codes: [],
  medications: [
    { brand_name: 'DFO 4X Gel', generic_name: 'Diclofenac', dosage: 'LA', frequency: '1-0-1', duration: '5 days' },
    { brand_name: 'Glycomet', generic_name: 'Metformin', dosage: '500mg', frequency: '1-0-1' },
  ],
};
const LAB_ROWS = [
  { booking_id: 'bk1', test_result_uid: 'tr1', test_date: '2026-02-15', investigation_name: 'Creatinine', value: '1.1', investigation_unit: 'mg/dL', investigation_is_abnormal: 'false', individual_uid: 'ind1' },
  { booking_id: 'bk1', test_result_uid: 'tr2', test_date: '2026-02-15', investigation_name: 'HbA1c', value: '6.2', investigation_unit: '%', investigation_is_abnormal: 'false', individual_uid: 'ind1' },
  { booking_id: 'bk2', test_result_uid: 'tr3', test_date: '2026-05-20', investigation_name: 'Creatinine', value: '1.3', investigation_unit: 'mg/dL', investigation_is_abnormal: 'true', individual_uid: 'ind1' },
];
const base = { memberRef: 'ind1', generatedAt: '2026-07-11', sourceWatermarks: { db13: '2026-07-11' } };

test('assembleEvidence: prescription row → opd EncounterEvidence (meds, denied allergy, icd problem, demographics)', () => {
  const ev = assembleEvidence({ ...base, prescriptionRows: [RX_ROW], labRows: [] });
  assert.equal(ev.memberRef, 'ind1');
  const opd = ev.encounters.find((e) => e.kind === 'opd')!;
  assert.equal(opd.encounterRef, 'presc_abc123');
  assert.equal(opd.date, '2026-03-01');
  assert.equal(opd.medicationAssertions.length, 2);
  assert.equal(opd.medicationAssertions[0].status, 'prescribed');
  assert.equal(opd.allergyAssertions.length, 1);
  assert.equal(opd.allergyAssertions[0].status, 'denied');
  assert.equal(opd.problems.length, 1);
  assert.equal(opd.problems[0].icdCode, 'E11.9');
  assert.equal(opd.problems[0].provenance.sourceField, 'individuals-prescriptions.diagnosis_icd_codes');
  assert.deepEqual(opd.demographics, { age: 62, sex: 'M' });
});

test('assembleEvidence: lab rows → lab encounters grouped by booking, investigation points', () => {
  const ev = assembleEvidence({ ...base, prescriptionRows: [], labRows: LAB_ROWS });
  const labs = ev.encounters.filter((e) => e.kind === 'lab');
  assert.equal(labs.length, 2);                                  // bk1, bk2
  const bk1 = labs.find((e) => e.encounterRef === 'bk1')!;
  assert.equal(bk1.investigations.length, 2);
  assert.equal(bk1.date, '2026-02-15');
  assert.equal(bk1.investigations[0].provenance.sourceField, 'test_values_view');
  assert.equal(labs.find((e) => e.encounterRef === 'bk2')!.investigations.length, 1);
});

test('assembleEvidence → buildMemberState: creatinine series spans both bookings, unit consistent', () => {
  const ev = assembleEvidence({ ...base, prescriptionRows: [RX_ROW], labRows: LAB_ROWS });
  const snap = buildMemberState(ev, '2026-07-11T00:00:00Z');
  const creat = snap.investigations.find((i) => i.normalizedAnalyte.normalizedConceptId === 'local:creatinine')!;
  assert.equal(creat.series.length, 2);
  assert.equal(creat.unit, 'mg/dL');
  assert.deepEqual(creat.series.map((p) => p.date), ['2026-02-15', '2026-05-20']);
});

test('assembleEvidence: identifier-free — no name/mobile/dob leaks into evidence', () => {
  const dirty = { ...RX_ROW, first_name: 'Jane', last_name: 'Doe', mobiles: '9999999999', dob: '1964-01-01' };
  const ev = assembleEvidence({ ...base, prescriptionRows: [dirty], labRows: [] });
  const json = JSON.stringify(ev);
  for (const pii of ['Jane', 'Doe', '9999999999', '1964-01-01']) assert.ok(!json.includes(pii), `PII leak: ${pii}`);
});

test('assembleEvidence: malformed / missing rows degrade to empty, never throw', () => {
  assert.doesNotThrow(() => assembleEvidence({ ...base, prescriptionRows: 'garbage' as unknown as [], labRows: null as unknown as [] }));
  const ev = assembleEvidence({ ...base, prescriptionRows: [{ no_uid: true }, RX_ROW], labRows: [{ junk: 1 }] });
  assert.equal(ev.encounters.filter((e) => e.kind === 'opd').length, 1);   // the uid-less row skipped
  assert.equal(ev.encounters.filter((e) => e.kind === 'lab').length, 0);   // junk lab row skipped
});
