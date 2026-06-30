/**
 *   node --experimental-strip-types --test lib/__tests__/ccb-fetch-core.test.ts
 * Pure episode-bundler core (ccb-fetch-core): validators, window math, validated SQL
 * builders (injection-safe), row mappers, and the coverage flip. Pins the data-spine
 * contract verified live in db13 on 30 Jun (CCB build spec §2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUid, isUhid, isDay, dayOf, bundleWindow,
  prescriptionSql, bridgeSql, ordersSql, reportsSql,
  mapPrescription, mapOrders, mapReports, episodeCoverage, buildBundle, specialityFromLabel,
  type EpisodeKeys, type EpisodePrescription,
} from '../ccb-fetch-core.ts';

test('validators accept real ids/days and reject junk', () => {
  assert.equal(isUid('uTAWDQinrFFW'), true);
  assert.equal(isUid('FHpN3DmRklMEbdQAr4oV'), true);
  assert.equal(isUid("x'; DROP TABLE--"), false);
  assert.equal(isUid('short'), false);            // <6 chars
  assert.equal(isUhid('EHRC123456'), true);
  assert.equal(isUhid("123'); --"), false);
  assert.equal(isDay('2026-06-30'), true);
  assert.equal(isDay('2026-6-3'), false);
});

test('dayOf truncates a timestamp to the IST calendar day; bad input throws', () => {
  assert.equal(dayOf('2026-06-30 19:58:33+05:30'), '2026-06-30');
  assert.equal(dayOf('2026-06-30T00:00:00Z'), '2026-06-30');
  assert.throws(() => dayOf('not-a-date'));
});

test('bundleWindow is asymmetric (reports land after the visit) and crosses month boundaries', () => {
  assert.deepEqual(bundleWindow('2026-06-30'), { d0: '2026-06-28', d1: '2026-07-05' });
  assert.deepEqual(bundleWindow('2026-06-30', 0, 0), { d0: '2026-06-30', d1: '2026-06-30' });
  assert.deepEqual(bundleWindow('2026-03-01', 2, 2), { d0: '2026-02-27', d1: '2026-03-03' });
});

test('SQL builders target the right tables/keys and embed only validated values', () => {
  const p = prescriptionSql('uTAWDQinrFFW');
  assert.match(p, /FROM "individuals-prescriptions" WHERE uid = 'uTAWDQinrFFW'/);
  assert.match(p, /_parent_id AS individual_uid/);
  assert.match(p, /specialist_type_uids/);

  assert.match(bridgeSql('FHpN3DmRklMEbdQAr4oV'), /SELECT kx_uhid FROM individuals WHERE uid = 'FHpN3DmRklMEbdQAr4oV'/);

  const o = ordersSql('EHRC777', '2026-06-28', '2026-07-05');
  assert.match(o, /FROM kx_lab_reports WHERE uhid = 'EHRC777'/);
  assert.match(o, /FROM kx_radiology_reports WHERE uhid = 'EHRC777'/);
  assert.match(o, /service_date::date BETWEEN '2026-06-28' AND '2026-07-05'/);

  const r = reportsSql('FHpN3DmRklMEbdQAr4oV', '2026-06-28', '2026-07-05');
  // radiology + diagnostic join child→parent on c._parent_id = p._id ; hcu uses the parent url
  assert.match(r, /individuals-radiology_reports-radiology_booking_reports" c ON c\._parent_id = p\._id/);
  assert.match(r, /individuals-diagnostic_reports-diagnostic_booking_reports" c ON c\._parent_id = p\._id/);
  assert.match(r, /coalesce\(consolidated_report_url, report_url\)/);
  assert.match(r, /p\._parent_id = 'FHpN3DmRklMEbdQAr4oV'/);
});

test('SQL builders refuse injection (throw, never interpolate)', () => {
  assert.throws(() => prescriptionSql("x'; DROP TABLE individuals; --"));
  assert.throws(() => bridgeSql('not a uid'));
  assert.throws(() => ordersSql("u'; --", '2026-06-28', '2026-07-05'));
  assert.throws(() => reportsSql('FHpN3DmRklMEbdQAr4oV', 'bad-date', '2026-07-05'));
});

test('specialityFromLabel parses the trailing-parens speciality', () => {
  assert.equal(specialityFromLabel('Dr. Reshma(General Physician)'), 'General Physician');
  assert.equal(specialityFromLabel('Dr. No Speciality'), null);
});

test('mapPrescription extracts keys + coerces array/json fields', () => {
  const row: Record<string, unknown> = {
    uid: 'uTAWDQinrFFW', individual_uid: 'FHpN3DmRklMEbdQAr4oV', kx_encounter_id: 'ENC1',
    doctor_uid: 'docABCDEF', doctor_name_with_speciality: 'Dr. A(Orthopaedics)',
    consult_type: 'HOSPITAL_GP', type_of_prescription: 'GENERAL_PRACTITIONER',
    ts: '2026-06-30 10:00:00+05:30', prescription_url: 'https://gcs/p.pdf',
    medications: [{ generic: 'paracetamol' }], diagnosis_icd_codes: ['M54.5'],
    impression_icd_codes: '["R52"]',  // json string form
    specialist_type_uids: ['ortho'], in_house_specialist_type_uids: ['ortho', 'spine'],
    presenting_complaint: 'low back pain', plan_of_management: 'MRI advised',
  };
  const { keys, prescription } = mapPrescription(row);
  assert.equal(keys.prescUid, 'uTAWDQinrFFW');
  assert.equal(keys.individualUid, 'FHpN3DmRklMEbdQAr4oV');
  assert.equal(keys.kxEncounterId, 'ENC1');
  assert.equal(keys.doctorSpeciality, 'Orthopaedics');
  assert.equal(keys.noteDate, '2026-06-30');
  assert.deepEqual(prescription.dxCodes, ['M54.5']);
  assert.deepEqual(prescription.impressionCodes, ['R52']);            // json-string coerced
  assert.deepEqual(prescription.specialistReferral, ['ortho', 'spine']); // de-duped union
  assert.equal(prescription.presentingComplaint, 'low back pain');
});

test('mapReports filters null urls; episodeCoverage flips on PDF presence', () => {
  const rows = [
    { kind: 'radiology', url: 'https://gcs/r.pdf', dt: '2026-06-30' },
    { kind: 'hcu', url: null, dt: '2026-06-30' },        // dropped (no url)
    { kind: 'diagnostic', url: 'https://gcs/d.pdf', dt: '2026-07-01' },
  ];
  const reports = mapReports(rows);
  assert.equal(reports.length, 2);
  assert.equal(episodeCoverage(reports), 'rich');
  assert.equal(episodeCoverage([]), 'order_only');
});

test('buildBundle assembles + sets coverage', () => {
  const keys = { prescUid: 'uTAWDQinrFFW', individualUid: 'FHpN3DmRklMEbdQAr4oV', kxUhid: 'EHRC1',
    kxEncounterId: null, doctorUid: null, doctorSpeciality: null, noteDate: '2026-06-30',
    consultType: null, prescriptionType: null } as EpisodeKeys;
  const presc = { url: null, meds: null, dxCodes: [], impressionCodes: [], furtherInvestigation: null,
    presentingComplaint: null, planOfManagement: null, specialistReferral: [] } as EpisodePrescription;
  const orders = mapOrders([{ kind: 'lab', service_name: 'CBC', ord: 'Dr X', service_date: '2026-06-30', patient_type: 'OP' }]);
  const richer = buildBundle(keys, presc, orders, mapReports([{ kind: 'radiology', url: 'u://x', dt: '2026-06-30' }]));
  assert.equal(richer.coverage, 'rich');
  assert.equal(richer.orders[0].serviceName, 'CBC');
  const lean = buildBundle(keys, presc, orders, []);
  assert.equal(lean.coverage, 'order_only');
});
