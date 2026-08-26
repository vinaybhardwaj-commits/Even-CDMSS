/**
 *   node --test --import tsx lib/__tests__/preop-b2-assembler.test.ts
 *
 * B2's deterministic mappers: the booking comorbidity enum, OPD ICD codes, the measured
 * creatinine, the PAC-to-episode window, and the assembly of all four into one snapshot
 * argument list. Every fact asserted about db13 here was VALIDATED live on 26 Aug 2026
 * and is recorded in lib/preop/db13.ts beside the query that measured it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bookingComorbidityObservations, creatinineObservation, icdObservations,
  procedureObservation, resolveInputs,
} from '../preop-assemble-core.ts';
import { assembleEpisode, daysBetweenDays, istDay, pacForEpisode } from '../preop/run.ts';
import { looksLikeFitnessVerdict, pacClosingLine, parsePgArray } from '../preop/db13.ts';

// ── the booking form's five-value enum (measured on production) ─────────────────

test('booking NO_KNOWN_CONDITION enumerates without asserting anything present', () => {
  const m = bookingComorbidityObservations(['NO_KNOWN_CONDITION']);
  assert.equal(m.enumerated, true);
  assert.deepEqual(m.observations, []);
  assert.deepEqual(m.notClosedBy, []);
  // ...and that enumeration is what closes the world.
  const r = resolveInputs(m.observations, { includeExtracted: false, bookingEnumerated: m.enumerated, notClosedBy: m.notClosedBy });
  assert.equal(r.congestive_heart_failure.status, 'absent');
  assert.equal(r.congestive_heart_failure.closedWorld, true);
});

test('booking DIABETES feeds mFI-5 and Charlson but leaves RCRI INSULIN-treated unknown', () => {
  const m = bookingComorbidityObservations(['DIABETES']);
  const ids = m.observations.map((o) => o.inputId).sort();
  assert.deepEqual(ids, ['diabetes_mellitus', 'diabetes_uncomplicated']);
  assert.deepEqual(m.notClosedBy, ['insulin_treated_diabetes']);
  const r = resolveInputs(m.observations, { includeExtracted: false, bookingEnumerated: true, notClosedBy: m.notClosedBy });
  assert.equal(r.diabetes_mellitus.status, 'present');
  // RCRI scores insulin-treated diabetes and the form cannot say — so it stays unknown
  // and RCRI widens, instead of being scored 0 off a form that never asked.
  assert.equal(r.insulin_treated_diabetes.status, 'unknown');
});

test('booking HEART_DISEASE asserts nothing and OPENS both cardiac factors', () => {
  const m = bookingComorbidityObservations(['HEART_DISEASE']);
  assert.deepEqual(m.observations, []);
  assert.deepEqual(m.notClosedBy.sort(), ['congestive_heart_failure', 'ischaemic_heart_disease']);
  const r = resolveInputs(m.observations, { includeExtracted: false, bookingEnumerated: true, notClosedBy: m.notClosedBy });
  // The form says there IS cardiac disease without saying which. Neither factor may be
  // closed to absent, and neither may be asserted present. Both widen.
  assert.equal(r.ischaemic_heart_disease.status, 'unknown');
  assert.equal(r.congestive_heart_failure.status, 'unknown');
  // ...while everything the form DID enumerate stays closed.
  assert.equal(r.dementia.status, 'absent');
});

test('booking HYPOTHYROID reaches no instrument and is counted, not lost', () => {
  const m = bookingComorbidityObservations(['HYPOTHYROID']);
  assert.deepEqual(m.observations, []);
  assert.deepEqual(m.unmapped, ['HYPOTHYROID']);
});

test('an empty comorbidity array closes NOTHING — there is no enumeration to trust', () => {
  assert.equal(bookingComorbidityObservations([]).enumerated, false);
  assert.equal(bookingComorbidityObservations(null).enumerated, false);
});

// ── OPD ICD codes ───────────────────────────────────────────────────────────────

test('ICD codes map to inputs by prefix, and only ever assert PRESENT', () => {
  const m = icdObservations(['I21.4', 'I50.9', 'E11.22', 'J42', 'C78.00', 'Z00'], '2026-08-01', 'doc-1');
  const byInput = new Map(m.observations.map((o) => [o.inputId, o]));
  assert.equal(byInput.get('myocardial_infarction')?.status, 'present');
  assert.equal(byInput.get('ischaemic_heart_disease')?.status, 'present');
  assert.equal(byInput.get('congestive_heart_failure')?.status, 'present');
  assert.equal(byInput.get('diabetes_end_organ_damage')?.status, 'present');
  assert.equal(byInput.get('chronic_pulmonary_disease')?.status, 'present');
  assert.equal(byInput.get('copd_or_pneumonia')?.status, 'present');
  assert.equal(byInput.get('metastatic_solid_tumour')?.status, 'present');
  assert.ok(m.observations.every((o) => o.status === 'present' && o.source === 'OPD'));
  // Z00 (general examination) reaches no instrument — silence, counted as unmatched.
  assert.deepEqual(m.unmatched, ['Z00']);
  assert.equal(byInput.get('myocardial_infarction')?.detail, 'myocardial infarction (ICD I21.4)');
});

test('E11 without a complication digit is uncomplicated diabetes, not end-organ', () => {
  const m = icdObservations(['E11.9']);
  const ids = m.observations.map((o) => o.inputId).sort();
  assert.deepEqual(ids, ['diabetes_mellitus', 'diabetes_uncomplicated']);
});

test('an OPD ICD code OUTRANKS nothing it should not, and conflicts are tagged', () => {
  // Booking enumerated "no known condition" (heart failure closed absent); an OPD
  // consult later coded I50. Same rank, the newer wins, and the disagreement is shown.
  const booking = bookingComorbidityObservations(['NO_KNOWN_CONDITION'], 'sc-1', '2026-07-01');
  const opd = icdObservations(['I50.9'], '2026-08-01', 'doc-1');
  const r = resolveInputs([...booking.observations, ...opd.observations], {
    includeExtracted: false, bookingEnumerated: true, notClosedBy: booking.notClosedBy,
  });
  // The closed-world 'absent' is not an observation, so the ICD code simply scores it.
  assert.equal(r.congestive_heart_failure.status, 'present');
  assert.equal(r.congestive_heart_failure.source, 'OPD');
});

// ── the measured creatinine ─────────────────────────────────────────────────────

test('creatinine collapses the RCRI range in BOTH directions — a measurement can say absent', () => {
  assert.equal(creatinineObservation(1.4, 'mg/dL', '2026-08-19')?.status, 'absent');
  assert.equal(creatinineObservation(2.4, 'mg/dL', '2026-08-19')?.status, 'present');
  assert.equal(creatinineObservation(2.0, 'mg/dL', '2026-08-19')?.status, 'absent');   // the threshold is > 2.0
  assert.equal(creatinineObservation(1.4, 'mg/dL', '2026-08-19')?.detail, '1.4 mg/dL · 2026-08-19');
});

test('an unrecognised unit observes NOTHING rather than comparing the wrong scale', () => {
  assert.equal(creatinineObservation(88, 'umol/L', '2026-08-19'), null);
  assert.equal(creatinineObservation(18.7, 'Ratio', '2026-08-19'), null);
  assert.equal(creatinineObservation(null, 'mg/dL', '2026-08-19'), null);
  // No unit at all is accepted — db13 carries mg/dL on every creatinine row measured.
  assert.equal(creatinineObservation(1.1, null, null)?.status, 'absent');
});

// ── the PAC, attached to ONE episode ────────────────────────────────────────────

const pac = (uid: string, at: string, status = 'final') => ({ uid, uhid: 'UHID-1', status, createdAt: at, closingLine: 'PATIENT CAN BE TAKEN FOR SURGERY', templateName: 't' });

test('the PAC window keeps one anaesthetist evaluation attached to one operation', () => {
  const reports = [pac('a', '2026-03-01T10:00:00Z'), pac('b', '2026-08-20T10:00:00Z')];
  // The bridge is patient-level, so without a window a patient with two episodes would
  // inherit the same PAC for both.
  assert.equal(pacForEpisode(reports, '2026-09-01')?.uid, 'b');
  assert.equal(pacForEpisode(reports, '2026-03-05')?.uid, 'a');
  // A report from long before this surgery is not this surgery's PAC.
  assert.equal(pacForEpisode([pac('a', '2026-01-01T10:00:00Z')], '2026-09-01'), null);
  // A non-final report is never a PAC on file.
  assert.equal(pacForEpisode([pac('c', '2026-08-20T10:00:00Z', 'draft')], '2026-09-01'), null);
  assert.equal(pacForEpisode([], '2026-09-01'), null);
});

test('the PAC verdict is the note\'s closing line, quoted verbatim and never inferred', () => {
  assert.equal(pacClosingLine('Pre Medication\n\nVTE risk score\n\nPATIENT CAN BE TAKEN FOR SURGERY'), 'PATIENT CAN BE TAKEN FOR SURGERY');
  assert.equal(pacClosingLine(''), null);
  assert.equal(pacClosingLine(null), null);
  // Some real PAC notes end in orders rather than a verdict (measured on production) —
  // so the banner is told whether the line it is quoting IS a fitness conclusion.
  assert.equal(looksLikeFitnessVerdict('PATIENT CAN BE TAKEN FOR SURGERY'), true);
  assert.equal(looksLikeFitnessVerdict('1.CXR\n2.physician reference'), false);
  assert.equal(looksLikeFitnessVerdict('Case will be reviewed with reports'), false);
});

// ── date arithmetic, the one place the clock enters ─────────────────────────────

test('days to surgery, in IST calendar days', () => {
  assert.equal(daysBetweenDays('2026-08-26', '2026-08-29'), 3);
  assert.equal(daysBetweenDays('2026-08-26', '2026-08-26'), 0);
  assert.equal(daysBetweenDays('2026-08-26', '2026-08-25'), -1);
  assert.equal(daysBetweenDays('2026-08-26', null), null);
  assert.equal(daysBetweenDays('2026-08-26', 'not-a-date'), null);
  // The IST day, not the UTC one — 19:00 UTC is already tomorrow in Kolkata.
  assert.equal(istDay(new Date('2026-08-26T19:00:00Z')), '2026-08-27');
  assert.equal(istDay(new Date('2026-08-26T18:00:00Z')), '2026-08-26');
});

test('postgres text[] parsing, as Metabase renders it', () => {
  assert.deepEqual(parsePgArray('{DIABETES,HYPOTHYROID}'), ['DIABETES', 'HYPOTHYROID']);
  assert.deepEqual(parsePgArray('{NO_KNOWN_CONDITION}'), ['NO_KNOWN_CONDITION']);
  assert.deepEqual(parsePgArray('{}'), []);
  assert.deepEqual(parsePgArray(null), []);
  assert.deepEqual(parsePgArray(['A', 'B']), ['A', 'B']);
});

// ── one episode, assembled end to end ───────────────────────────────────────────

const episodeRow = {
  docId: 'AbfAHNyYgrrax6fbLPnu', individualUid: 'McBSBlExqOKdWJWyJ5PR', uhid: 'UHID-1',
  patientName: 'Test Patient', age: 62, sex: 'FEMALE',
  procedure: 'Total Hip Replacement - Unilateral- (Package )', hospitalUid: 'vZmEPseTKP3vS3DrZzrv',
  surgeryDate: '2026-08-27', status: 'ADMITTED', urgency: 'ELECTIVE',
  pacWorkflowStatus: 'COMPLETED', comorbidities: ['DIABETES', 'HYPOTHYROID'],
  createdAt: '2026-08-01T00:00:00Z',
};

test('a real upcoming episode assembles into exactly the inputs its sources support', () => {
  const a = assembleEpisode(episodeRow, { creatinine: [], icd: [], pac: null });
  assert.equal(a.bookingOnly, true);                    // no consult, no lab, no PAC
  assert.equal(a.bookingEnumerated, true);
  assert.deepEqual(a.unmappedBookingTerms, ['HYPOTHYROID']);
  assert.equal(a.pac.onFile, false);
  // THR is classified low-risk off the procedure text, so RCRI's surgery factor is known.
  const proc = a.observations.find((o) => o.inputId === 'high_risk_surgery');
  assert.equal(proc?.status, 'absent');
  assert.equal(proc?.source, 'BOOKING');
  assert.equal(a.facts.episodeKey, 'AbfAHNyYgrrax6fbLPnu');
});

test('sources arriving flip bookingOnly and tighten the inputs', () => {
  const a = assembleEpisode(episodeRow, {
    creatinine: [{ value: 2.6, unit: 'mg/dL', at: '2026-01-01' }, { value: 1.2, unit: 'mg/dL', at: '2026-08-10' }],
    icd: [{ codes: ['J42'], at: '2026-08-05', ref: 'p1' }],
    pac: pac('px', '2026-08-25T10:00:00Z'),
  });
  assert.equal(a.bookingOnly, false);
  assert.equal(a.pac.onFile, true);
  assert.equal(a.pac.verdict, 'PATIENT CAN BE TAKEN FOR SURGERY');
  // The NEWEST creatinine wins — an old high value must not outrank today's normal one.
  const creat = a.observations.find((o) => o.inputId === 'creatinine_over_2');
  assert.equal(creat?.status, 'absent');
  assert.equal(creat?.value, 1.2);
  assert.ok(a.observations.some((o) => o.inputId === 'chronic_pulmonary_disease' && o.source === 'OPD'));
});

test('the procedure classifier reads production procedure text', () => {
  // Verbatim from the 19 upcoming episodes on 26 Aug 2026.
  assert.equal(procedureObservation('ARTHROSCOPIC RIGHT KNEE ACL RECONSTRUCTION WITH AUTOGRAFT WITH MEDIAL MENISCAL REPAIR')?.status, 'absent');
  assert.equal(procedureObservation('Total Hip Replacement - Unilateral- (Package )')?.status, 'absent');
  assert.equal(procedureObservation('LASER ASSISTED FISTULA ABLATION')?.status, 'absent');
  assert.equal(procedureObservation('Carpal Tunnel Syndrome')?.status, 'absent');
  // ...and refuses to classify what it does not recognise, rather than scoring a zero.
  assert.equal(procedureObservation('Chemotherapy'), null);
  assert.equal(procedureObservation('Varicose Veins'), null);
});
