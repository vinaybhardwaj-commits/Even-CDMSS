/**
 *   node --test --import tsx lib/__tests__/ipd-review-workflow.test.ts
 *
 * Phase B — IPD clinical review workflow (PRD §6). The two things that can be wrong here in a way
 * a type system cannot see are DOCTOR DISAMBIGUATION (§6.3 / §8.10 — a wrong name is worse than no
 * name) and DATE-RANGE ARITHMETIC (§6.2). Both are pure and are tested directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  resolveDoctor, groupByDoctor, UNATTRIBUTED, UNATTRIBUTED_RESULT, DOCTOR_UNAVAILABLE_NOTICE,
  type DoctorRecord,
} from '../ipd-audit/doctor-lookup.ts';
import { resolveRange, UNASSIGNED_SPECIALITY } from '../ipd-audit/store.ts';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6.3 / §8.10 — doctor disambiguation. THE IPNO-229 CASE IS THE ONE THAT MATTERS.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The real live case from PRD §6.3: one ipd_no, two doctors, two specialities. */
const IPNO_229: DoctorRecord[] = [
  { ipdNo: 'IPNO-229', treatingDoctor: 'Dr Darshana R', treatingSpeciality: 'Internal Medicine', admittingDoctor: null, dischargeDateTime: '2026-07-01T10:00:00Z' },
  { ipdNo: 'IPNO-229', treatingDoctor: 'Dr Vinod Kumar', treatingSpeciality: 'Orthopedics', admittingDoctor: null, dischargeDateTime: '2026-07-09T10:00:00Z' },
];

test('IPNO-229: the Internal Medicine audit resolves to Dr Darshana R, NOT Dr Vinod Kumar', () => {
  // This is PRD §11 step 10's hand-validation, encoded. Note the Orthopedics row is MORE RECENT —
  // so any implementation that reached for recency before speciality would fail this.
  const r = resolveDoctor(IPNO_229, 'Internal Medicine');
  assert.equal(r.name, 'Dr Darshana R');
  assert.equal(r.specialityUnconfirmed, false);
});

test('IPNO-229: the Orthopedics audit resolves to Dr Vinod Kumar', () => {
  assert.equal(resolveDoctor(IPNO_229, 'Orthopedics').name, 'Dr Vinod Kumar');
});

test('NEVER take the first row — order of the input must not change the answer', () => {
  const reversed = [...IPNO_229].reverse();
  assert.equal(resolveDoctor(reversed, 'Internal Medicine').name, 'Dr Darshana R');
  assert.equal(resolveDoctor(reversed, 'Orthopedics').name, 'Dr Vinod Kumar');
  // …and neither ordering ever yields the other speciality's doctor
  for (const rows of [IPNO_229, reversed]) {
    assert.notEqual(resolveDoctor(rows, 'Internal Medicine').name, 'Dr Vinod Kumar');
  }
});

test('step 2 — still ambiguous after the speciality match ⇒ most recent discharge_date_time wins', () => {
  const two: DoctorRecord[] = [
    { ipdNo: 'IP-1', treatingDoctor: 'Dr Older', treatingSpeciality: 'Orthopedics', admittingDoctor: null, dischargeDateTime: '2026-01-01T00:00:00Z' },
    { ipdNo: 'IP-1', treatingDoctor: 'Dr Newer', treatingSpeciality: 'Orthopedics', admittingDoctor: null, dischargeDateTime: '2026-06-01T00:00:00Z' },
  ];
  assert.equal(resolveDoctor(two, 'Orthopedics').name, 'Dr Newer');
  assert.equal(resolveDoctor([...two].reverse(), 'Orthopedics').name, 'Dr Newer', 'order-independent');
});

test('step 3 — a null audit speciality (4 of 345) takes the most recent and marks it unconfirmed', () => {
  const r = resolveDoctor(IPNO_229, null);
  assert.equal(r.name, 'Dr Vinod Kumar', 'the 9 Jul row is the most recent');
  assert.equal(r.specialityUnconfirmed, true, 'the surface must say so rather than look confident');
  assert.equal(resolveDoctor(IPNO_229, '').specialityUnconfirmed, true, 'empty string is not a speciality');
  assert.equal(resolveDoctor(IPNO_229, '   ').specialityUnconfirmed, true);
});

test('a speciality that matches NOTHING falls back to recency and is marked unconfirmed', () => {
  // The important half: it must NOT confidently present another speciality's doctor as this one's.
  const r = resolveDoctor(IPNO_229, 'Cardiology');
  assert.equal(r.specialityUnconfirmed, true);
  assert.ok(r.name === 'Dr Vinod Kumar', 'recency fallback');
});

test('step 4 — a null treating doctor falls back to admitting', () => {
  const rows: DoctorRecord[] = [
    { ipdNo: 'IP-2', treatingDoctor: null, treatingSpeciality: 'Orthopedics', admittingDoctor: 'Dr Admitting', dischargeDateTime: '2026-06-01T00:00:00Z' },
  ];
  const r = resolveDoctor(rows, 'Orthopedics');
  assert.equal(r.name, 'Dr Admitting');
  assert.equal(r.fromAdmitting, true);
});

test('step 5 — nothing usable ⇒ Unattributed, never a guess and never a throw', () => {
  assert.deepEqual(resolveDoctor([], 'Orthopedics'), UNATTRIBUTED_RESULT);
  assert.deepEqual(resolveDoctor(null as unknown as DoctorRecord[], null), UNATTRIBUTED_RESULT);
  assert.equal(resolveDoctor([{ ipdNo: 'IP-3', treatingDoctor: null, treatingSpeciality: null, admittingDoctor: null, dischargeDateTime: null }], null).name, UNATTRIBUTED);
  assert.equal(resolveDoctor([{ ipdNo: 'IP-3', treatingDoctor: '  ', treatingSpeciality: null, admittingDoctor: '', dischargeDateTime: null }], null).name, UNATTRIBUTED);
  assert.doesNotThrow(() => resolveDoctor([undefined as unknown as DoctorRecord], 'x'));
});

test('speciality matching tolerates case and whitespace but nothing more', () => {
  assert.equal(resolveDoctor(IPNO_229, ' internal medicine ').name, 'Dr Darshana R');
  // it must NOT do fuzzy/substring matching — "Medicine" is not "Internal Medicine"
  assert.equal(resolveDoctor(IPNO_229, 'Medicine').specialityUnconfirmed, true);
});

test('rows with no timestamp sort last and never win over a dated row', () => {
  const rows: DoctorRecord[] = [
    { ipdNo: 'IP-4', treatingDoctor: 'Dr NoDate', treatingSpeciality: 'Ortho', admittingDoctor: null, dischargeDateTime: null },
    { ipdNo: 'IP-4', treatingDoctor: 'Dr Dated', treatingSpeciality: 'Ortho', admittingDoctor: null, dischargeDateTime: '2026-01-01T00:00:00Z' },
  ];
  assert.equal(resolveDoctor(rows, 'Ortho').name, 'Dr Dated');
  assert.equal(resolveDoctor([...rows].reverse(), 'Ortho').name, 'Dr Dated');
  // an unparseable timestamp is treated as absent, not as epoch 0 or NaN chaos
  const bad: DoctorRecord[] = [
    { ipdNo: 'IP-5', treatingDoctor: 'Dr Bad', treatingSpeciality: 'Ortho', admittingDoctor: null, dischargeDateTime: 'not-a-date' },
    { ipdNo: 'IP-5', treatingDoctor: 'Dr Good', treatingSpeciality: 'Ortho', admittingDoctor: null, dischargeDateTime: '2026-01-01T00:00:00Z' },
  ];
  assert.equal(resolveDoctor(bad, 'Ortho').name, 'Dr Good');
});

// ── grouping ──

test('groupByDoctor aggregates count, mean completeness and band distribution', () => {
  const byIpUid = {
    'IP-1': { name: 'Dr A', specialityUnconfirmed: false, fromAdmitting: false },
    'IP-2': { name: 'Dr A', specialityUnconfirmed: false, fromAdmitting: false },
    'IP-3': { name: 'Dr B', specialityUnconfirmed: false, fromAdmitting: false },
  };
  const groups = groupByDoctor([
    { id: '1', ipUid: 'IP-1', completeness: 80, band: 'B' },
    { id: '2', ipUid: 'IP-2', completeness: 60, band: 'C' },
    { id: '3', ipUid: 'IP-3', completeness: 90, band: 'A' },
  ], byIpUid);
  const a = groups.find((g) => g.name === 'Dr A')!;
  assert.equal(a.n, 2);
  assert.equal(a.meanCompleteness, 70, '(80 + 60) / 2');
  assert.deepEqual(a.bands, { B: 1, C: 1 });
  assert.deepEqual(a.auditIds, ['1', '2']);
  assert.equal(groups.find((g) => g.name === 'Dr B')!.meanCompleteness, 90);
});

test('groupByDoctor: unknown ip_uids become Unattributed, and it always sorts LAST', () => {
  const groups = groupByDoctor([
    { id: '1', ipUid: 'IP-unknown', completeness: 50, band: 'D' },
    { id: '2', ipUid: 'IP-1', completeness: 90, band: 'A' },
    { id: '3', ipUid: 'IP-1', completeness: 90, band: 'A' },
  ], { 'IP-1': { name: 'Dr A', specialityUnconfirmed: false, fromAdmitting: false } });
  assert.equal(groups[groups.length - 1].name, UNATTRIBUTED, 'never leads the view');
  assert.equal(groups[0].name, 'Dr A');
  // even when Unattributed is the BIGGER group
  const big = groupByDoctor([
    { id: '1', ipUid: 'x', completeness: 1, band: 'E' },
    { id: '2', ipUid: 'x', completeness: 1, band: 'E' },
    { id: '3', ipUid: 'IP-1', completeness: 1, band: 'A' },
  ], { 'IP-1': { name: 'Dr A', specialityUnconfirmed: false, fromAdmitting: false } });
  assert.equal(big[big.length - 1].name, UNATTRIBUTED);
});

test('groupByDoctor: a null completeness does not poison the mean', () => {
  const groups = groupByDoctor([
    { id: '1', ipUid: 'IP-1', completeness: 80, band: 'B' },
    { id: '2', ipUid: 'IP-1', completeness: null, band: null },
  ], { 'IP-1': { name: 'Dr A', specialityUnconfirmed: false, fromAdmitting: false } });
  assert.equal(groups[0].meanCompleteness, 80, 'the null row is counted in n but not in the mean');
  assert.equal(groups[0].n, 2);
  // all-null ⇒ null, not NaN and not 0
  const none = groupByDoctor([{ id: '1', ipUid: 'IP-1', completeness: null, band: null }], { 'IP-1': { name: 'Dr A', specialityUnconfirmed: false, fromAdmitting: false } });
  assert.equal(none[0].meanCompleteness, null);
});

test('a group is only "speciality unconfirmed" if EVERY member is', () => {
  const mixed = groupByDoctor([
    { id: '1', ipUid: 'IP-1', completeness: 1, band: 'A' },
    { id: '2', ipUid: 'IP-2', completeness: 1, band: 'A' },
  ], {
    'IP-1': { name: 'Dr A', specialityUnconfirmed: true, fromAdmitting: false },
    'IP-2': { name: 'Dr A', specialityUnconfirmed: false, fromAdmitting: false },
  });
  assert.equal(mixed[0].specialityUnconfirmed, false, 'one confirmed attribution settles it');
});

test('groupByDoctor never throws on rubbish input', () => {
  assert.deepEqual(groupByDoctor([], {}), []);
  assert.doesNotThrow(() => groupByDoctor(null as never, {}));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6.2 — date-range presets
// ═════════════════════════════════════════════════════════════════════════════════════════════

// 15 Jul 2026, 12:00 UTC → 17:30 IST, comfortably inside the same IST day.
const NOW = new Date('2026-07-15T12:00:00Z');

test('the DEFAULT is Last 3 months (§6.2)', () => {
  assert.deepEqual(resolveRange(undefined, null, null, NOW), { from: '2026-05-01', to: '2026-07-15' });
  assert.deepEqual(resolveRange('last_3_months', null, null, NOW), { from: '2026-05-01', to: '2026-07-15' });
});

test('This month / Last month', () => {
  assert.deepEqual(resolveRange('this_month', null, null, NOW), { from: '2026-07-01', to: '2026-07-15' });
  assert.deepEqual(resolveRange('last_month', null, null, NOW), { from: '2026-06-01', to: '2026-06-30' });
});

test('Last month across a year boundary, and February leap-year length', () => {
  assert.deepEqual(resolveRange('last_month', null, null, new Date('2026-01-10T12:00:00Z')), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(resolveRange('last_month', null, null, new Date('2028-03-10T12:00:00Z')), { from: '2028-02-01', to: '2028-02-29' }, '2028 is a leap year');
  assert.deepEqual(resolveRange('last_month', null, null, new Date('2026-03-10T12:00:00Z')), { from: '2026-02-01', to: '2026-02-28' });
});

test('Last 3 months across a year boundary', () => {
  assert.deepEqual(resolveRange('last_3_months', null, null, new Date('2026-02-10T12:00:00Z')), { from: '2025-12-01', to: '2026-02-10' });
  assert.deepEqual(resolveRange('last_3_months', null, null, new Date('2026-01-05T12:00:00Z')), { from: '2025-11-01', to: '2026-01-05' });
});

test('custom: both bounds, one bound, or neither', () => {
  assert.deepEqual(resolveRange('custom', '2026-03-01', '2026-03-31', NOW), { from: '2026-03-01', to: '2026-03-31' });
  // a half-open range is honoured on the side that IS given — not silently widened to everything
  assert.deepEqual(resolveRange('custom', '2026-03-01', null, NOW), { from: '2026-03-01', to: '2026-07-15' });
  assert.deepEqual(resolveRange('custom', null, '2026-03-31', NOW), { from: '1970-01-01', to: '2026-03-31' });
  assert.equal(resolveRange('custom', null, null, NOW), null, 'no bounds ⇒ no range predicate at all');
  assert.equal(resolveRange('custom', 'garbage', 'also-garbage', NOW), null, 'malformed dates are not dates');
});

test('the IST boundary is respected — 23:00 UTC is already tomorrow in Kolkata', () => {
  // 2026-07-15T23:00Z = 2026-07-16 04:30 IST. "This month" must end on the 16th, not the 15th.
  assert.deepEqual(resolveRange('this_month', null, null, new Date('2026-07-15T23:00:00Z')), { from: '2026-07-01', to: '2026-07-16' });
  // and 18:00 UTC on the last day of a month rolls the month over in IST
  assert.deepEqual(resolveRange('this_month', null, null, new Date('2026-07-31T19:00:00Z')), { from: '2026-08-01', to: '2026-08-01' });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Structural — the validated schema, fail-soft, batching, and the migration
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the doctor lookup uses the VALIDATED table and join key, and none of the three rejected ones', () => {
  const src = readFileSync('lib/ipd-audit/doctor-lookup.ts', 'utf8');
  // the query itself
  const q = src.slice(src.indexOf('SELECT ipd_no'), src.indexOf('` ,') > 0 ? src.indexOf('` ,') : src.length);
  assert.ok(/FROM kx_discharge_summary_records/.test(src), 'the validated table');
  assert.ok(/WHERE ipd_no IN \(/.test(src), 'joined on ipd_no');
  for (const col of ['treating_doctor_team', 'treating_doctor_speciality', 'admitting_doctor_team', 'discharge_date_time']) {
    assert.ok(q.includes(col), `${col} must be selected`);
  }
  // §2.11's three rejected candidates must appear ONLY in the do-not-use comment, never in a query
  const codeOnly = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
  for (const bad of ['kx_ip_admissions', 'kx_discharged_completed_patients', 'additional_metadata__doctor_uid']) {
    assert.ok(!codeOnly.includes(bad), `${bad} is a REJECTED candidate and must not be queried`);
  }
});

test('the doctor lookup is BATCHED — one call per page, never one per row', () => {
  const src = readFileSync('lib/ipd-audit/doctor-lookup.ts', 'utf8');
  // exactly one metabaseQuery call site in the whole module
  assert.equal((src.match(/await metabaseQuery\(/g) || []).length, 1, 'one query, for the whole batch');
  // and it is not inside a loop over audits
  const idx = src.indexOf('await metabaseQuery(');
  const before = src.slice(Math.max(0, idx - 500), idx);
  assert.ok(!/for \(const .* of audits\)/.test(before), 'the query must not be inside a per-audit loop');
  assert.ok(/Array\.from\(new Set\(/.test(src), 'ids are de-duplicated before the call');
});

test('the doctor lookup FAILS SOFT — the catch returns Unattributed, never throws', () => {
  const src = readFileSync('lib/ipd-audit/doctor-lookup.ts', 'utf8');
  assert.ok(/catch \{\s*\n\s*\/\/ FAIL-SOFT[\s\S]*?return \{ byIpUid: \{\}, unavailable: true \};/.test(src),
    'a Metabase failure must resolve to an empty map + unavailable, not a throw');
  assert.equal(DOCTOR_UNAVAILABLE_NOTICE, 'Doctor names are temporarily unavailable', 'verbatim per §6.3');
});

test('inputs are validated and escaped before interpolation (no bound params in a native query)', () => {
  const src = readFileSync('lib/ipd-audit/doctor-lookup.ts', 'utf8');
  assert.ok(/const isIpUid = /.test(src) && /filter\(\(u\) => u && isIpUid\(u\)\)/.test(src), 'non-uids never reach the query');
  assert.ok(/const esc = \(s: string\) => s\.replace\(\/'\/g, "''"\)/.test(src), 'single quotes are escaped');
  assert.ok(/`'\$\{esc\(u\)\}'`/.test(src), 'ids are escaped at the interpolation site');
});

test('migration 0028 is additive and idempotent; existing rows keep reading', () => {
  const m = readFileSync('migrations/0028_review_notes.sql', 'utf8');
  assert.ok(/ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'finding'/.test(m),
    "existing per-finding rows must classify as 'finding' with no backfill");
  assert.ok(/ADD COLUMN IF NOT EXISTS reviewed_by_name text/.test(m));
  assert.ok(/ALTER COLUMN finding_ref DROP NOT NULL/.test(m));
  // nothing destructive
  const sqlOnly = m.replace(/--.*$/gm, '');
  assert.ok(!/\b(DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|UPDATE )\b/i.test(sqlOnly), 'nothing destructive');
  // one review per audit is structural
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS ipd_audit_feedback_one_review_per_audit[\s\S]*WHERE kind = 'review'/.test(m));
});

test('the review route writes kind=review with a null finding_ref, and overwrites in place', () => {
  const src = readFileSync('app/api/ipd-audit/review/route.ts', 'utf8');
  assert.ok(/UPDATE ipd_audit_feedback/.test(src) && /INSERT INTO ipd_audit_feedback/.test(src),
    '§6.4: edits overwrite in place, so UPDATE-then-INSERT');
  assert.ok(/finding_ref, verdict, note, kind, reviewed_by_name\)\s*\n\s*VALUES \(\$1, NULL,/.test(src), 'finding_ref is NULL');
  assert.ok(/created_at = NOW\(\)/.test(src), 'an edit updates the timestamp');
  // the NOT NULL verdict workaround is explicit, not accidental
  assert.ok(/REVIEW_VERDICT = 'review'/.test(src));
  assert.ok(/admin required/.test(src), 'admin-gated');
});

test('the list query degrades when 0028 has not run — it never 500s', () => {
  const src = readFileSync('lib/ipd-audit/store.ts', 'utf8');
  assert.ok(/withoutReviewed/.test(src), 'a fallback query without the reviewed marker exists');
  assert.ok(/catch \{ rows = \[\]; \}/.test(src), 'and a final fallback to an empty list');
  // the reviewed marker is a correlated EXISTS, so a duplicate review row cannot multiply rows
  assert.ok(/EXISTS \(SELECT 1 FROM ipd_audit_feedback f WHERE f\.audit_id = a\.id AND f\.kind = 'review'\)/.test(src));
  assert.ok(!/JOIN ipd_audit_feedback/.test(src), 'must not be a JOIN — that could duplicate rows');
});

test('the speciality filter renders RAW values and offers Unassigned for the nulls (§6.1)', () => {
  const src = readFileSync('lib/ipd-audit/store.ts', 'utf8');
  assert.equal(UNASSIGNED_SPECIALITY, 'Unassigned');
  assert.ok(/ORDER BY n DESC/.test(src), 'ordered by count descending');
  assert.ok(/coalesce\(nullif\(trim\(speciality\), ''\), \$2\)/.test(src), 'nulls become Unassigned');
  // NO normalisation in v1 — nothing that would merge the messy compounds
  assert.ok(!/replace\(speciality/i.test(src) && !/lower\(speciality\)/i.test(src), 'raw values, no normalisation');
});

test('the shared report renderer stays byte-identical for callers that pass no Phase B props', () => {
  const src = readFileSync('components/CaseAuditReport.tsx', 'utf8');
  // every new prop is optional
  for (const p of ['weightsVersion', 'weightedCompletenessPct', 'reviewPanel']) {
    assert.ok(new RegExp(`${p}\\?:`).test(src), `${p} must be optional`);
  }
  // and the weighted number falls back to the stored one
  assert.ok(/const shownPct = weightedCompletenessPct == null \? pct : weightedCompletenessPct;/.test(src));
  // the version chip only renders when a version was supplied
  assert.ok(/\{weightsVersion && /.test(src));
  // §6.5: both numbers, side by side
  assert.ok(/NABH mandatory gaps: \{gapCount\} of \{c\.mandatoryTotal\}/.test(src));
  // grouped by section, and the extractor's note is shown
  assert.ok(/SECTION_LABEL\[section\]/.test(src));
  assert.ok(/\{it\.note && /.test(src), "the extractor's note must render where present");
});
