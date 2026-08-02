/**
 *   node --test --import tsx lib/__tests__/vitals-coverage-core.test.ts
 *
 * U4-B C7 v2.0 — the vitals-coverage panel's pure core.
 *
 * THE ONE FAILURE MODE (PRD §3.3, and §8.3 of the verification list): the vitals source begins
 * 2026-05-28. A window reaching before it reports 100% missing, which is a data-availability
 * artefact and not a documentation gap. "A figure near 100% means the 28 May floor is missing."
 * These tests exist mainly to make that impossible.
 *
 * Second concern: metabaseQuery takes ONE SQL STRING WITH NO PARAMETER BINDING, so the date
 * validation is the only thing between a caller and the query text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VITALS_SOURCE_START, WINDOW_DAYS, isDay, addDays, istDay,
  coverageWindow, buildVitalsCoverageSql, shapeCoverage,
} from '../vitals-coverage-core.ts';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The 28 May floor — the failure mode
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the floor holds: a window reaching before the vitals source is CLAMPED, and says so', () => {
  // 30 days back from 10 Jun 2026 would start 12 May — before the source existed.
  const w = coverageWindow('2026-06-10', 30)!;
  assert.equal(w.start, VITALS_SOURCE_START, 'the window must start at the source, never earlier');
  assert.equal(w.clamped, true, 'and the page must be told, so it can say so');
  assert.equal(w.days, 14, '28 May → 10 Jun inclusive');
});

test('an unclamped window is exactly WINDOW_DAYS long and is not flagged', () => {
  const w = coverageWindow('2026-08-02', 30)!;
  assert.equal(w.start, '2026-07-04', '30 days inclusive of today');
  assert.equal(w.lastDay, '2026-08-02');
  assert.equal(w.end, '2026-08-03', 'end is EXCLUSIVE, so today is included');
  assert.equal(w.clamped, false);
  assert.equal(w.days, 30);
});

test('the boundary day itself: a window starting exactly on the source is not clamped', () => {
  const w = coverageWindow(addDays(VITALS_SOURCE_START, WINDOW_DAYS - 1), WINDOW_DAYS)!;
  assert.equal(w.start, VITALS_SOURCE_START);
  assert.equal(w.clamped, false, 'reaching the source exactly is not a clamp');
  assert.equal(w.days, WINDOW_DAYS);
});

test('a window entirely before the source returns null — nothing honest to show', () => {
  assert.equal(coverageWindow('2026-05-01', 30), null);
  assert.equal(coverageWindow('2020-01-01', 30), null);
});

test('a malformed or absurd window returns null rather than guessing', () => {
  for (const bad of ['', 'yesterday', '2026-13-99', '02-08-2026', null, undefined, 42]) {
    assert.equal(coverageWindow(bad as unknown as string, 30), null, String(bad));
  }
  assert.equal(coverageWindow('2026-08-02', 0), null);
  assert.equal(coverageWindow('2026-08-02', -5), null);
  assert.equal(coverageWindow('2026-08-02', NaN), null);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · The SQL — no binding, so validation IS the guard
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the SQL is the measured NOT IN form, bounded, HOSPITAL_GP only', () => {
  const sql = buildVitalsCoverageSql('2026-07-04', '2026-08-03');
  // the measured shape (a LEFT JOIN onto the whole vitals table returned HTTP 504)
  assert.match(sql, /NOT IN \(\s*\n\s*SELECT consult_uid FROM "individuals-individual_vitals_records" WHERE consult_uid IS NOT NULL/);
  assert.ok(!/LEFT JOIN/i.test(sql), 'the LEFT JOIN form times out — it must not come back');
  // bounded on both sides — the bound is what makes the NOT IN affordable
  assert.ok(sql.includes("ip.uploaded_at >= '2026-07-04' AND ip.uploaded_at < '2026-08-03'"));
  // scope
  assert.ok(sql.includes("ip.type_of_prescription = 'HOSPITAL_GP'"), 'DEC-1: one template');
  assert.ok(sql.includes('ip.is_draft = false'));
  assert.ok(!/HOSPITAL_PAEDIATRIC|GYNAECOLOGY|GENERAL_PRACTITIONER|INVESTIGATION_REFERRAL/.test(sql),
    'no other template may appear');
  // grouping is by the IST calendar day
  assert.ok(sql.includes("(ip.uploaded_at AT TIME ZONE 'Asia/Kolkata')::date AS d"));
  assert.ok(sql.trimEnd().endsWith('GROUP BY 1 ORDER BY 1 DESC'));
});

test('THE INJECTION GUARD: a non-date bound THROWS, it is never interpolated', () => {
  const attacks = [
    "2026-07-04'; DROP TABLE x; --",
    "' OR '1'='1",
    '2026-7-4', '26-07-04', '2026/07/04', '', 'now()', null, undefined, 42, {},
  ];
  for (const bad of attacks) {
    assert.throws(() => buildVitalsCoverageSql(bad as unknown as string, '2026-08-03'), /refusing to build SQL/, `start=${String(bad)}`);
    assert.throws(() => buildVitalsCoverageSql('2026-07-04', bad as unknown as string), /refusing to build SQL/, `end=${String(bad)}`);
  }
});

test('isDay accepts only the exact shape — the same guard lib/metabase.ts uses', () => {
  assert.equal(isDay('2026-05-28'), true);
  for (const bad of ['2026-5-28', '2026-05-28T00:00:00Z', ' 2026-05-28', '2026-05-28 ', 20260528, null]) {
    assert.equal(isDay(bad as unknown), false, String(bad));
  }
});

test('addDays is UTC-stable across a month boundary and returns "" on junk', () => {
  assert.equal(addDays('2026-07-31', 1), '2026-08-01');
  assert.equal(addDays('2026-08-01', -1), '2026-07-31');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('nonsense', 1), '');
});

test('istDay reads the Asia/Kolkata calendar day, not UTC', () => {
  // 2026-08-02 19:00 UTC is 2026-08-03 00:30 IST — the boundary that makes a UTC day wrong.
  assert.equal(istDay(new Date('2026-08-02T19:00:00Z')), '2026-08-03');
  assert.equal(istDay(new Date('2026-08-02T18:00:00Z')), '2026-08-02');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · Row shaping — and the measured numbers
// ═════════════════════════════════════════════════════════════════════════════════════════════

const WIN = { start: '2026-07-27', lastDay: '2026-08-01' };

test('the MEASURED window reproduces: 160 of 561 = 28.5%', () => {
  // PRD §3.1, measured 2 Aug against db13.
  const rows = [
    { d: '2026-07-27', gp_notes: 136, no_vitals: 36 },
    { d: '2026-07-28', gp_notes: 79, no_vitals: 28 },
    { d: '2026-07-29', gp_notes: 96, no_vitals: 26 },
    { d: '2026-07-30', gp_notes: 89, no_vitals: 30 },
    { d: '2026-07-31', gp_notes: 71, no_vitals: 18 },
    { d: '2026-08-01', gp_notes: 90, no_vitals: 22 },
  ];
  const r = shapeCoverage(rows, WIN);
  assert.equal(r.totalGpNotes, 561);
  assert.equal(r.totalNoVitals, 160);
  assert.equal(r.pct, 28.5, 'the PRD says "roughly 28%" — a figure near 100% means the floor is gone');
  assert.equal(r.days.length, 6);
  assert.equal(r.days[0].date, '2026-08-01', 'newest first');
  assert.equal(r.days[0].pct, 24.4);
});

test('rows outside the window are DROPPED — a boundary sliver is not a day', () => {
  // The SQL bounds uploaded_at in UTC but groups by IST date, so the range can admit a few hours
  // of the following day. Rendering that as a day would overstate a partial count.
  const r = shapeCoverage([
    { d: '2026-07-26', gp_notes: 50, no_vitals: 10 },   // before start
    { d: '2026-08-02', gp_notes: 3, no_vitals: 3 },     // the sliver after lastDay
    { d: '2026-07-28', gp_notes: 79, no_vitals: 28 },
  ], WIN);
  assert.deepEqual(r.days.map((d) => d.date), ['2026-07-28']);
  assert.equal(r.totalGpNotes, 79);
});

test('Metabase type wobble is absorbed: string counts and ISO timestamps', () => {
  const r = shapeCoverage([
    { d: '2026-07-28T00:00:00Z', gp_notes: '79', no_vitals: '28' },
  ], WIN);
  assert.equal(r.days[0].date, '2026-07-28');
  assert.equal(r.days[0].gpNotes, 79);
  assert.equal(r.days[0].noVitals, 28);
});

test('junk never produces a number that looks real', () => {
  assert.deepEqual(shapeCoverage([], WIN), { days: [], totalGpNotes: 0, totalNoVitals: 0, pct: 0 });
  assert.deepEqual(shapeCoverage(null as unknown as unknown[], WIN).days, []);
  const r = shapeCoverage([{ d: 'nope', gp_notes: 5, no_vitals: 1 }, null, 7, { }], WIN);
  assert.deepEqual(r.days, [], 'a row with no usable date is dropped, not defaulted');
  // a subset can never exceed its whole
  const clamp = shapeCoverage([{ d: '2026-07-28', gp_notes: 10, no_vitals: 99 }], WIN);
  assert.equal(clamp.days[0].noVitals, 10);
  assert.equal(clamp.days[0].pct, 100);
  // negatives and NaN read as zero rather than propagating
  const neg = shapeCoverage([{ d: '2026-07-28', gp_notes: -5, no_vitals: 'abc' }], WIN);
  assert.equal(neg.days[0].gpNotes, 0);
  assert.equal(neg.days[0].pct, 0, 'zero visits ⇒ 0%, never a divide-by-zero');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The build contract — no engine change
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the core is PURE and dependency-free — it must not reach the engine or any score', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('lib/vitals-coverage-core.ts', 'utf8');
  // Comments are stripped first: the header deliberately EXPLAINS why v1.0's finding approach was
  // abandoned, and naming a type in prose is not a dependency on it. This asserts about code.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/^\s*import\s/m.test(code), 'no imports at all: no db, no metabase, no engine, no env');
  assert.ok(!/opd-note-audit|score-core|signal_type|OpdFinding|process\.env/.test(code),
    'C7 v2.0 is a panel count, not a finding — no engine reference and no env read in the core');
});
