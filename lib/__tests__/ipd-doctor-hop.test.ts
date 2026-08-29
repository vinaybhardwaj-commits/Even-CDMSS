/**
 * lib/__tests__/ipd-doctor-hop.test.ts — S3, the partial inpatient→clinician hop
 * (CDMSS-STEWARDSHIP-MS-AGENT-KICKOFF-v2-29-AUG-2026, A1; acceptance #6 as amended).
 *
 *   node --test --import tsx lib/__tests__/ipd-doctor-hop.test.ts
 *
 * Acceptance #6 asks for three things and this file is all three: the checked-in measure at this
 * cut, a unique practitioner id resolving to its clinician, and an AMBIGUOUS-id fixture staying
 * unjoined with the banner. The fixtures are not invented — they are the real ids from
 * `handoff-docs/CDMSS-STEWARDSHIP-SQL-VALIDATION-AND-HOP-MEASURE-29-AUG-2026.md` §6, including the
 * one that proves e-mail cannot break the tie either.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildPractitionerMap, fetchIpdDoctorHop, hopCoverage, hopCoverageLine, resolveStays,
  HOP_INFERRED_SQL, type AdmissionRow, type PractitionerMapRow,
} from '../ipd-doctor-hop';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const HOP = 'lib/ipd-doctor-hop.ts';

// ── the real ids, from the 29 Aug measure ─────────────────────────────────────────────────

/** UNIQUE: resolves. (A stand-in for the 61 unambiguous ids of the 68 that match.) */
const UNIQUE_PID = '9f1c4a20-71cf-11f0-9659-1243a45a76a3-1000000001';
const UNIQUE_UID = 'HalPyIorNPSOYBL7KSJy';

/** AMBIGUOUS, and the honest worst case: 10 stays behind it, two live `doctors` rows, the SAME
 *  display name on both, and two DIFFERENT e-mails so e-mail cannot break the tie. */
const AMBIGUOUS_PID = '0dd90283-71cf-11f0-9659-1243a45a76a3-1021357153';
const AMBIGUOUS_UIDS = ['b8uerqB7pAmnTI9cr3c4', 'l6FdC9GTBGemrKDOOtTG'];

/** AMBIGUOUS, and the cleanest disproof of the e-mail repair: both rows share `mahijain@yahoo.com`. */
const SHARED_EMAIL_PID = '5bbd0741-a698-11f0-bc8d-3298c1e077e7-1232548516';

const MAP_ROWS: PractitionerMapRow[] = [
  { pid: UNIQUE_PID, nUids: 1, uid: UNIQUE_UID },
  { pid: AMBIGUOUS_PID, nUids: 2, uid: AMBIGUOUS_UIDS[0] },     // min(uid) is present and must be IGNORED
  { pid: SHARED_EMAIL_PID, nUids: 2, uid: '74zZm5tNZYe1NRoipidm' },
];

// ── the map ───────────────────────────────────────────────────────────────────────────────

test('A1: a practitioner id claimed by two clinicians is kept as AMBIGUOUS, never collapsed', () => {
  const m = buildPractitionerMap(MAP_ROWS);
  assert.equal(m.unique.get(UNIQUE_PID), UNIQUE_UID);
  assert.equal(m.unique.has(AMBIGUOUS_PID), false, 'an ambiguous id must not be lookup-able');
  assert.equal(m.ambiguous.has(AMBIGUOUS_PID), true);
  assert.equal(m.ambiguous.has(SHARED_EMAIL_PID), true);
  // `min(uid)` is in the row and is a trap: it is only ever read when the count is 1.
  assert.ok(!AMBIGUOUS_UIDS.includes(m.unique.get(AMBIGUOUS_PID) ?? ''));
});

test('A1: an id that arrives ambiguous AFTER arriving unique is still ambiguous', () => {
  // Row order out of a GROUP BY is not guaranteed, and "the last row wins" would make the join a
  // function of the planner.
  const m = buildPractitionerMap([
    { pid: AMBIGUOUS_PID, nUids: 1, uid: AMBIGUOUS_UIDS[0] },
    { pid: AMBIGUOUS_PID, nUids: 2, uid: AMBIGUOUS_UIDS[1] },
  ]);
  assert.equal(m.unique.has(AMBIGUOUS_PID), false);
  assert.equal(m.ambiguous.has(AMBIGUOUS_PID), true);
});

// ── the stays (acceptance #6) ─────────────────────────────────────────────────────────────

test('acceptance #6: a unique practitioner id resolves to its clinician', () => {
  const m = buildPractitionerMap(MAP_ROWS);
  const out = resolveStays([{ ipUid: 'IP-1250', treatingId: UNIQUE_PID }], m);
  assert.deepEqual(out['IP-1250'], { doctorUid: UNIQUE_UID, reason: 'resolved' });
});

test('acceptance #6: the ambiguous-id fixture stays UNJOINED — two consultants are not collapsed', () => {
  const m = buildPractitionerMap(MAP_ROWS);
  const out = resolveStays([
    { ipUid: 'IPNO-229', treatingId: AMBIGUOUS_PID },
    { ipUid: 'IPNO-230', treatingId: SHARED_EMAIL_PID },
  ], m);
  assert.deepEqual(out['IPNO-229'], { doctorUid: null, reason: 'ambiguous_practitioner' });
  assert.deepEqual(out['IPNO-230'], { doctorUid: null, reason: 'ambiguous_practitioner' });
  // and the refusal is a NAMED one, so the surface can say which kind of not-knowing it is
  assert.notEqual(out['IPNO-229'].reason, 'unmatched_practitioner');
});

test('A1: an unmatched id is unjoined, and it is a different refusal from an ambiguous one', () => {
  const m = buildPractitionerMap(MAP_ROWS);
  const out = resolveStays([{ ipUid: 'ER-511', treatingId: 'not-in-the-roster-at-all' }], m);
  assert.deepEqual(out['ER-511'], { doctorUid: null, reason: 'unmatched_practitioner' });
});

test('A1: a stay naming TWO different treating ids resolves to neither', () => {
  // kx_ip_admissions is not guaranteed one row per encounter. A handover recorded as a second row is
  // exactly where "last one wins" attributes a stay to the wrong named clinician.
  const m = buildPractitionerMap(MAP_ROWS);
  const out = resolveStays([
    { ipUid: 'IP-9', treatingId: UNIQUE_PID },
    { ipUid: 'IP-9', treatingId: '9f1c4a20-71cf-11f0-9659-1243a45a76a3-1000000002' },
  ], m);
  assert.deepEqual(out['IP-9'], { doctorUid: null, reason: 'ambiguous_stay' });
});

test('A1: the same treating id twice on one stay is not a conflict', () => {
  const m = buildPractitionerMap(MAP_ROWS);
  const out = resolveStays([
    { ipUid: 'IP-10', treatingId: UNIQUE_PID },
    { ipUid: 'IP-10', treatingId: UNIQUE_PID },
  ], m);
  assert.deepEqual(out['IP-10'], { doctorUid: UNIQUE_UID, reason: 'resolved' });
});

test('A1: a stay with no treating id recorded is its own refusal, not an unmatched id', () => {
  const m = buildPractitionerMap(MAP_ROWS);
  const out = resolveStays([{ ipUid: 'IP-11', treatingId: null }], m);
  assert.deepEqual(out['IP-11'], { doctorUid: null, reason: 'no_treating_id' });
  // a null followed by a real id is the real id — an empty row is absence, not a competing claim
  const out2 = resolveStays([{ ipUid: 'IP-12', treatingId: null }, { ipUid: 'IP-12', treatingId: UNIQUE_PID }], m);
  assert.deepEqual(out2['IP-12'], { doctorUid: UNIQUE_UID, reason: 'resolved' });
});

// ── the honest counts A1 requires ─────────────────────────────────────────────────────────

test('A1: the coverage line names every kind of not-knowing, with a denominator', () => {
  const m = buildPractitionerMap(MAP_ROWS);
  const by = resolveStays([
    { ipUid: 'a', treatingId: UNIQUE_PID },
    { ipUid: 'b', treatingId: AMBIGUOUS_PID },
    { ipUid: 'c', treatingId: 'nope' },
    { ipUid: 'd', treatingId: null },
  ], m);
  const c = hopCoverage(6, by);   // 6 asked, 4 known to the admissions table
  assert.equal(c.resolved, 1);
  assert.equal(c.ambiguousPractitioner, 1);
  assert.equal(c.unmatched, 1);
  assert.equal(c.noTreatingId, 1);
  assert.equal(c.known, 4);
  const line = hopCoverageLine(c);
  assert.match(line, /IPD joined for 1 of 6 stays/);
  assert.match(line, /5 unjoined/);
  assert.match(line, /2 not found in the admissions table/);
  // a rate on its own is how 46% becomes "most of them"
  assert.ok(!/^\d+%/.test(line));
});

test('A1: db13 unreachable means EVERY stay unjoined, and the line says so', () => {
  const c = hopCoverage(1045, {}, true);
  assert.equal(c.resolved, 0);
  assert.match(hopCoverageLine(c), /could not be read just now, so every stay is shown unjoined/);
});

test('A1: an empty ask makes no db13 call at all', async () => {
  const out = await fetchIpdDoctorHop([]);
  assert.deepEqual(out.byIpUid, {});
  assert.equal(out.coverage.asked, 0);
  assert.equal(out.coverage.unavailable, false, 'nothing was attempted, so nothing was unavailable');
});

// ── the four refusals, as properties of the source ────────────────────────────────────────

test('refusal: e-mail is never read — the measured tie shares one address', () => {
  // Mahendra Jain's two competing rows both carry `mahijain@yahoo.com`. The "prefer the matching
  // e-mail" repair is not merely unimplemented; it is disproven, and the column is never selected.
  const src = code(HOP);
  assert.ok(!/\bemail\b/i.test(src), 'the hop must not read an e-mail column');
  for (const q of Object.values(HOP_INFERRED_SQL)) {
    assert.ok(!/email/i.test(q), 'no hop query may select an e-mail');
  }
});

test('refusal: no display-name join, and no name column in any hop query', () => {
  const src = code(HOP);
  for (const banned of ['name_with_prefix', 'doctor_name', 'treating_doctor_team', 'normalizeDoctorName', 'resolveDoctor']) {
    assert.ok(!src.includes(banned), `the hop names ${banned} — a name is not an identity (D-identity)`);
  }
  for (const q of Object.values(HOP_INFERRED_SQL)) {
    assert.ok(!/name/i.test(q), 'no hop query may select a name');
  }
});

test('refusal: nothing is written, and no doctor_uid lands on ipd_discharge_audits', () => {
  const src = code(HOP);
  // SQL-shaped, not word-shaped: `Map.prototype.delete` is not a DELETE statement, and a test that
  // could not tell the difference would be a test nobody trusted.
  assert.ok(!/\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+TABLE)\b/i.test(src),
    'the hop is read-time only (A1)');
  assert.ok(!/ipd_discharge_audits/.test(src), 'the hop must not touch the audit table at all');
  // and nothing anywhere on this branch writes the column A1 forbids
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name === '__tests__') continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  };
  for (const f of [...walk('lib'), ...walk('app')]) {
    const src2 = code(f);
    assert.ok(!/(INSERT\s+INTO|UPDATE)\s+ipd_discharge_audits[\s\S]{0,400}?doctor_uid/i.test(src2),
      `${f} writes a doctor_uid onto ipd_discharge_audits`);
  }
});

test('refusal: `resolveDoctor` in lib/ipd-audit/doctor-lookup.ts is untouched (§7)', () => {
  const src = read('lib/ipd-audit/doctor-lookup.ts');
  assert.ok(src.includes('export function resolveDoctor('), 'it must still exist');
  assert.ok(!/practitioner/i.test(src), 'A1 lives in new read-time join code, not in resolveDoctor');
  assert.ok(!/ipd-doctor-hop/.test(src), 'and the name chrome must not start calling the hop');
});

// ── the checked-in measure (acceptance #6, first clause) ──────────────────────────────────

test('acceptance #6: the hop measure at this cut is checked in beside the code', () => {
  // The measure is a FACT about a date, so it lives in the file it constrains. If someone widens the
  // hop's rule, this comment is what says what the rule was worth when it was written.
  const src = read(HOP);
  for (const fact of ['1267', '1045', '110', '68 / 110', '483 / 1045', '46.2%']) {
    assert.ok(src.includes(fact), `the checked-in measure is missing "${fact}"`);
  }
  assert.ok(src.includes('CDMSS-STEWARDSHIP-SQL-VALIDATION-AND-HOP-MEASURE-29-AUG-2026'),
    'the measure must name the document it came from');
  // 0/110 on both of the rejected key columns — the two joins that look right and are not
  assert.match(src, /match `doctors\.uid`\s+0 \/ 110/);
  assert.match(src, /match `karexpert_metadata__uid`\s+0 \/ 110/);
});

test('the hop reads BOTH halves of the practitioner namespace', () => {
  const q = HOP_INFERRED_SQL.practitioner_map;
  assert.match(q, /karexpert_metadata__practitioner_id AS pid/);
  assert.match(q, /karexpert_metadata__practitioner_id_by_hospital/);
  assert.match(q, /UNION ALL/);
  assert.match(q, /count\(DISTINCT uid\)::int AS n_uids/, 'ambiguity must be counted, not collapsed');
  // the admissions read joins on the column the spec names, and escapes what it interpolates
  assert.match(HOP_INFERRED_SQL.admissions, /FROM kx_ip_admissions/);
  assert.match(HOP_INFERRED_SQL.admissions, /WHERE encounter_id IN \('IP-1250', 'IPNO-229'\)/);
  assert.ok(!/kx_ip_admissions\.uid|additional_metadata__doctor_uid|kx_discharged_completed_patients/.test(
    Object.values(HOP_INFERRED_SQL).join('\n')), 'the three rejected joins must not reappear');
});
