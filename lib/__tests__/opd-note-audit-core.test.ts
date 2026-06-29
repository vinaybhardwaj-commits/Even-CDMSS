/**
 *   node --experimental-strip-types --test lib/__tests__/opd-note-audit-core.test.ts
 * Pure cores: row→case ingest (opd-ingest-core) + completeness/prescribing/parse (opd-note-audit-core).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowToOpdCase } from '../opd-ingest-core.ts';
import { opdCompleteness, prescribingChecks, parseOpdAnalysis } from '../opd-note-audit-core.ts';

// Mirrors a real GP row (medications + jsonb arrive as JSON strings via Metabase).
const ROW: Record<string, unknown> = {
  uid: 'MqG3ihcPeU4ptLWCBiY6', consult_uid: 'tg3doq', doctor_uid: 'HalPy', kx_encounter_id: null,
  type_of_prescription: 'GENERAL_PRACTITIONER', consult_type: null, timestamp: '2026-06-29T05:00:00+05:30',
  presenting_complaints: '[]',
  diagnosis_icd_codes: ['R10.12', 'E78.2', 'E55'],
  impression_icd_codes: [],
  medications: '[{"generic_name":"Dicyclomine+Mefenamic Acid","brand_name":"Mef Spas","strength":"10mg+250mg","dosage":"1 tab","frequency":"1-1-1","duration":"3 days","route_of_administration":"oral","instruction_to_patient":"after meal"},{"generic_name":"Fenofibrate+Rosuvastatin","brand_name":"Rosuvas F","strength":"160mg+20mg","dosage":"1 tablet","frequency":"0-0-1","duration":"3 months","route_of_administration":""}]',
  further_investigation: '[{"investigation":{"name":"USG ABDOMEN"}}]',
  general_advice: '{}',
  patient_details__allergies: null,
  followup__followup_type: 'FOLLOW_UP_WITH_REPORTS', next_follow_up_date: null,
  relevant_medical_history: '[]', comorbidities: '[]',
};

test('rowToOpdCase parses stringified JSONB + separates de-identified case from keys', () => {
  const { case: c, keys } = rowToOpdCase(ROW);
  assert.equal(c.medications.length, 2);
  assert.equal(c.medications[0].generic, 'Dicyclomine+Mefenamic Acid');
  assert.deepEqual(c.diagnosisCodes, ['R10.12', 'E78.2', 'E55']);
  assert.deepEqual(c.investigations, ['USG ABDOMEN']);
  assert.equal(c.presentingComplaints.length, 0); // no nested + empty top-level
  assert.equal(c.followUpType, 'FOLLOW_UP_WITH_REPORTS');
  assert.equal(c.followUpDateSet, false);
  assert.equal(keys.uid, 'MqG3ihcPeU4ptLWCBiY6');
  assert.equal(keys.doctorUid, 'HalPy');
});

// The extraction fix: medical-consult content lives in the nested GP fields, not top-level.
const GP_ROW: Record<string, unknown> = {
  uid: 'abc123def', doctor_uid: 'doc1', type_of_prescription: 'GENERAL_PRACTITIONER', timestamp: '2026-06-29T05:00:00+05:30',
  presenting_complaints: '[]', relevant_medical_history: '[]', general_advice: '{}',
  general_practitioner_prescription__presenting_complaints: '[{"symptoms":"<ul><li>cough since 3 days</li><li>mild fever</li></ul>","diagnoses":[{"icd_code":"J06.9","diagnosis_or_impression":"Acute URTI","general_advice":"steam inhalation","treatment_plan":""}]}]',
  general_practitioner_prescription__plan_of_management: '[{"management_plan":"<p>rest and oral fluids</p>"}]',
  general_practitioner_prescription__examination: '<p>throat congested</p>',
  diagnosis_icd_codes: ['J06.9'], impression_icd_codes: [],
  medications: '[{"generic_name":"Paracetamol","dosage":"650mg","frequency":"1-1-1","duration":"3d","route_of_administration":"oral"}]',
  further_investigation: '[]', followup__followup_type: 'FOLLOW_UP_AS_NEEDED',
  prescription_url: 'https://storage.googleapis.com/even-prod-prescription/abc_2.pdf',
};

test('rowToOpdCase reads the NESTED GP fields (the extraction fix)', () => {
  const { case: c, keys } = rowToOpdCase(GP_ROW);
  assert.ok(c.presentingComplaints.includes('cough since 3 days'));
  assert.ok(c.presentingComplaints.includes('mild fever'));
  assert.deepEqual(c.impressions, ['Acute URTI']);
  assert.ok(c.advice.some((a) => /rest and oral fluids/.test(a)));
  assert.ok(c.advice.some((a) => /steam inhalation/.test(a)));
  assert.ok(c.examination.includes('throat congested'));
  assert.equal(keys.prescriptionUrl, 'https://storage.googleapis.com/even-prod-prescription/abc_2.pdf');
  const comp = opdCompleteness(c);
  assert.ok(!comp.missing.includes('Presenting complaint'));
  assert.ok(!comp.missing.includes('Advice / plan'));
  assert.ok(!comp.missing.includes('Diagnosis / impression'));
});

test('opdCompleteness flags the real gaps; allergy + history items removed', () => {
  const { case: c } = rowToOpdCase(ROW);
  const comp = opdCompleteness(c);
  assert.ok(comp.coverage < 1);
  assert.ok(comp.missing.includes('Presenting complaint'));
  assert.ok(comp.missing.includes('Advice / plan'));
  assert.ok(comp.missing.includes('Complete medication dosing')); // 2nd med has no route
  assert.ok(!comp.missing.includes('Allergy status documented')); // removed — never stored
  assert.ok(!comp.missing.includes('Relevant history'));          // removed — folded into complaint
  assert.equal(comp.items.length, 5);
  assert.equal(comp.items.find((i) => i.key === 'diagnosis')!.present, true);
  assert.deepEqual(comp.patientCentred, { present: 1, total: 2 });
});

test('prescribingChecks catches incomplete dosing (deterministic)', () => {
  const { case: c } = rowToOpdCase(ROW);
  const f = prescribingChecks(c);
  assert.ok(f.some((x) => x.subject.startsWith('Incomplete dosing') && x.domain === 'prescribing_safety'));
  assert.ok(f.every((x) => x.source === 'deterministic'));
});

test('prescribingChecks catches non-generic + duplicate', () => {
  const c = {
    consultType: null, reasonForConsult: null, presentingComplaints: [], diagnosisCodes: [], impressionCodes: [],
    impressions: [], history: [], comorbidities: [], investigations: [], advice: [], examination: [],
    allergies: null, followUpType: null, followUpDateSet: false,
    medications: [
      { brand: 'Brandonly', dose: '1', frequency: '1-0-1', route: 'PO', duration: '5d' },
      { generic: 'paracetamol', dose: '500mg', frequency: '1-1-1', route: 'PO', duration: '3d' },
      { generic: 'paracetamol', dose: '650mg', frequency: '0-0-1', route: 'PO', duration: '3d' },
    ],
  };
  const f = prescribingChecks(c);
  assert.ok(f.some((x) => x.subject.startsWith('Non-generic')));
  assert.ok(f.some((x) => x.subject.startsWith('Duplicate prescription: paracetamol')));
});

test('parseOpdAnalysis extracts findings + PDQI-9 + suggestions and clamps citations', () => {
  const json = `{"findings":[{"subject":"Antibiotic for viral URTI","verdict":"low-value","confidence":0.85,"domain":"prescribing_safety","rationale":"viral","evidence":["x"],"estimates":[],"citation_ids":[1,5]}],"pdqi9":{"thorough":2,"accurate":4,"bogus":9},"suggestions":[{"priority":2,"text":"add complaint"},{"priority":1,"text":"document plan"}]}`;
  const a = parseOpdAnalysis(json, 2);
  assert.ok(a);
  assert.equal(a!.findings.length, 1);
  assert.equal(a!.findings[0].domain, 'prescribing_safety');
  assert.deepEqual(a!.findings[0].citation_ids, [1]); // 5 dropped (only 2 sources)
  assert.equal(a!.pdqi9!.thorough, 2);
  assert.equal(a!.pdqi9!.accurate, 4);
  assert.equal((a!.pdqi9 as Record<string, number>).bogus, undefined);
  assert.equal(a!.suggestions[0].priority, 1); // sorted
});
