/**
 *   node --experimental-strip-types --test lib/__tests__/ccb-dossier-core.test.ts
 * Pure member-dossier core: injection-safe SQL builders, timeline stitching/merge, snapshot.
 * Pins the whole-person assembly (OPD + diagnostics + radiology + IPD/discharge).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  individualSql, episodesSql, dpipeByUidsSql, reportsSql, dischargeSql,
  parseSpeciality, prettyPrescriptionType, mapEpisodeRow,
  opdTimeline, reportTimeline, ipdTimeline, mergeTimeline, computeSnapshot, buildMember,
  type EpisodeRowLite, type TimelineItem,
} from '../ccb-dossier-core.ts';

// ── SQL builders target the right tables/keys, embed only validated ids ──────────
test('builders target the right tables and validate ids', () => {
  assert.match(individualSql('3cK6aGinZxFUhgF65NqM'), /FROM individuals WHERE uid = '3cK6aGinZxFUhgF65NqM'/);
  assert.match(episodesSql('3cK6aGinZxFUhgF65NqM'), /FROM "individuals-prescriptions"/);
  assert.match(episodesSql('3cK6aGinZxFUhgF65NqM'), /_parent_id = '3cK6aGinZxFUhgF65NqM' AND is_draft = false/);
  assert.match(reportsSql('diagnostic', '3cK6aGinZxFUhgF65NqM'), /FROM "individuals-diagnostic_reports"/);
  assert.match(reportsSql('radiology', '3cK6aGinZxFUhgF65NqM'), /FROM "individuals-radiology_reports"/);
  assert.match(dischargeSql('UHID-41072'), /FROM kx_discharge_summary_records WHERE uhid = 'UHID-41072'/);
  assert.match(dischargeSql('UHID-41072'), /DISTINCT ON \(coalesce\(nullif\(ipd_no/);   // dedupe revised versions per admission
  assert.match(dischargeSql('AH2425/007334'), /uhid = 'AH2425\/007334'/);   // slash-form uhid allowed
  assert.match(dpipeByUidsSql(['lFe7BzBrSyekYqYRRlZe']), /dpipe_prescription_pipeline WHERE presc_uid IN \('lFe7BzBrSyekYqYRRlZe'\)/);
});

test('builders reject junk ids (injection guard)', () => {
  assert.throws(() => individualSql("x'; DROP--"));
  assert.throws(() => episodesSql('bad uid'));
  assert.throws(() => reportsSql('diagnostic', "'; DELETE"));
  assert.throws(() => dischargeSql("bad'quote"));
  assert.throws(() => dpipeByUidsSql(['nope!']));
});

// ── Pure transforms ──────────────────────────────────────────────────────────────
test('parseSpeciality pulls the trailing parens; prettyPrescriptionType humanizes', () => {
  assert.equal(parseSpeciality('Dr. Sheetal(Internal Medicine Specialist)'), 'Internal medicine specialist');
  assert.equal(parseSpeciality('Dr. No Parens'), null);
  assert.equal(parseSpeciality(null), null);
  assert.equal(prettyPrescriptionType('HOSPITAL_GYNAECOLOGY_ASSESSMENT'), 'Gynaecology assessment');
  assert.equal(prettyPrescriptionType('GENERAL_PRACTITIONER'), 'General practitioner');
  assert.equal(prettyPrescriptionType(null), 'OPD visit');
});

test('mapEpisodeRow validates + coerces', () => {
  assert.equal(mapEpisodeRow({ uid: 'bad uid' }), null);
  const e = mapEpisodeRow({ uid: 'lFe7BzBrSyekYqYRRlZe', type_of_prescription: 'GENERAL_PRACTITIONER', doctor_name_with_speciality: 'Dr. X(Cardiology)', visit_date: '2026-03-17', n_meds: 3 });
  assert.equal(e?.speciality, 'Cardiology');
  assert.equal(e?.nMeds, 3);
});

test('opdTimeline folds clean complaint+dx into the subtitle', () => {
  const eps: EpisodeRowLite[] = [
    { uid: 'aaaaaa1', type: 'GENERAL_PRACTITIONER', speciality: 'Orthopedics', date: '2026-05-20', nMeds: 2 },
    { uid: 'bbbbbb2', type: 'HOSPITAL_GP', speciality: null, date: '2026-01-01', nMeds: 0 },
  ];
  const dp = { aaaaaa1: { pc: 'knee pain', dx: 'osteoarthritis' }, bbbbbb2: { pc: null, dx: null } };
  const out = opdTimeline(eps, dp);
  assert.equal(out[0].title, 'Orthopedics');
  assert.equal(out[0].subtitle, 'knee pain → osteoarthritis');
  assert.equal(out[0].refUid, 'aaaaaa1');
  assert.equal(out[1].title, 'Gp');           // speciality null → prettified type
  assert.equal(out[1].subtitle, null);
});

test('reportTimeline falls back to a generic label and appends vendor', () => {
  const d = reportTimeline([{ report_date: '2026-04-02', document_name: null, vendor: 'Healthians' }], 'diagnostic');
  assert.equal(d[0].kind, 'diagnostic');
  assert.equal(d[0].subtitle, 'Diagnostic report · Healthians');
  const r = reportTimeline([{ report_date: '2026-06-12', document_name: 'MRI right knee', vendor: null }], 'radiology');
  assert.equal(r[0].subtitle, 'MRI right knee');
});

test('ipdTimeline computes LOS and labels discharge vs admission', () => {
  const d = ipdTimeline([{ admit_date: '2026-06-25', discharge_date: '2026-06-30', treating_doctor_speciality: 'Orthopedics', ward: 'General Ward', discharge_type: 'Normal Discharge', status: 'Final' }]);
  assert.equal(d[0].title, 'IPD discharge');
  assert.equal(d[0].date, '2026-06-30');
  assert.match(d[0].subtitle!, /Orthopedics · General Ward · Normal Discharge · 5 days/);
  const open = ipdTimeline([{ admit_date: '2026-06-28', discharge_date: null, treating_doctor_speciality: 'Pediatrics', ward: 'Cradle' }]);
  assert.equal(open[0].title, 'IPD admission');
  assert.equal(open[0].date, '2026-06-28');
});

test('mergeTimeline sorts newest-first and sinks undated rows', () => {
  const items: TimelineItem[] = [
    { date: '2024-11-27', kind: 'opd', title: 'a', subtitle: null, refUid: 'x' },
    { date: null, kind: 'diagnostic', title: 'undated', subtitle: null, refUid: null },
    { date: '2026-06-30', kind: 'ipd', title: 'b', subtitle: null, refUid: null },
  ];
  const out = mergeTimeline(items);
  assert.equal(out[0].date, '2026-06-30');
  assert.equal(out[1].date, '2024-11-27');
  assert.equal(out[2].title, 'undated');
});

test('computeSnapshot counts + lastContact + medsLastVisit', () => {
  const eps: EpisodeRowLite[] = [
    { uid: 'aaaaaa1', type: 'GENERAL_PRACTITIONER', speciality: null, date: '2026-05-20', nMeds: 4 },
    { uid: 'bbbbbb2', type: 'GENERAL_PRACTITIONER', speciality: null, date: '2024-01-01', nMeds: 1 },
  ];
  const dx: TimelineItem[] = [{ date: '2026-04-02', kind: 'diagnostic', title: 'Diagnostic', subtitle: null, refUid: null }];
  const rad: TimelineItem[] = [];
  const ipd: TimelineItem[] = [{ date: '2026-06-30', kind: 'ipd', title: 'IPD discharge', subtitle: null, refUid: null }];
  const timeline = mergeTimeline(opdTimeline(eps, {}), dx, rad, ipd);
  const s = computeSnapshot(eps, dx, rad, ipd, timeline);
  assert.equal(s.opdVisits, 2);
  assert.equal(s.ipdAdmissions, 1);
  assert.equal(s.diagnostics, 1);
  assert.equal(s.lastContact, '2026-06-30');
  assert.equal(s.medsLastVisit, 4);   // most recent episode is first in the array
});

test('buildMember shapes identity + age + allergies', () => {
  const m = buildMember({ uid: '3cK6aGinZxFUhgF65NqM', first_name: 'Jeniffer', last_name: 'Fernandes', gender: 'FEMALE', dob: '1995-11-09', kx_uhid: 'UHID-41072', mobiles: ['+919082955048'], allergies: ['Penicillin'] }, '950137113001', new Date(Date.UTC(2026, 6, 1)));
  assert.equal(m.name, 'Jeniffer Fernandes');
  assert.equal(m.age, 30);
  assert.equal(m.uhid, 'UHID-41072');
  assert.equal(m.membershipId, '950137113001');
  assert.deepEqual(m.allergies, ['Penicillin']);
});
