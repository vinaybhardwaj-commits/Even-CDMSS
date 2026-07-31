/**
 *   node --test --import tsx lib/__tests__/audit-canonical-sql-twin.test.ts
 *
 * THE RULE has two expressions (addendum C): `canonicalByUid` in TypeScript, for surfaces that
 * fetch rows, and `canonicalDistinctOnSql` in SQL, for the four doctor aggregates that compute
 * server-side and never return rows. Two implementations do not stay in agreement on their own —
 * that is the stated reason lib/audit-canonical.ts has ONE TypeScript implementation — so this
 * feeds the SAME fixture to both and asserts they select the same row.
 *
 * Without this, the SQL fragment becomes the sixth dedup posture the moment either side is edited.
 *
 * The SQL side is evaluated by an in-test reimplementation of Postgres' ordering semantics —
 * `string_to_array(...)::int[] DESC, audited_at DESC` — driven by the REAL exported fragment, so a
 * change to the fragment's ordering is what the test detects. It runs with no database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canonicalByUid, canonicalDistinctOnSql, CANONICAL_RANK_SQL,
} from '../audit-canonical.ts';

interface Row { uid: string | null; engine_version: string; audited_at: string; id: string }

/** The four traps of §7, in one fixture. */
const FIXTURE: Row[] = [
  // 1. lexicographic trap — '0.81.9' sorts above '0.81.17' as text, but 17 > 9 numerically.
  { uid: 'n1', engine_version: 'opd-note-audit/0.81.9', audited_at: '2026-07-29T10:00:00Z', id: 'zzz' },
  { uid: 'n1', engine_version: 'opd-note-audit/0.81.17', audited_at: '2026-07-20T10:00:00Z', id: 'aaa' },
  // 2. same engine version, different audited_at — the tiebreak.
  { uid: 'n2', engine_version: 'opd-note-audit/0.81.17', audited_at: '2026-07-20T10:00:00Z', id: 'bbb' },
  { uid: 'n2', engine_version: 'opd-note-audit/0.81.17', audited_at: '2026-07-30T10:00:00Z', id: 'aaa' },
  // 3. a -mini row, which the engine-family filter removes BEFORE ranking.
  { uid: 'n3', engine_version: 'opd-note-audit/0.81.14-mini', audited_at: '2026-07-31T10:00:00Z', id: 'ccc' },
  { uid: 'n3', engine_version: 'opd-note-audit/0.81.14', audited_at: '2026-07-10T10:00:00Z', id: 'ddd' },
  // 4. a null uid — canonicalByUid PASSES IT THROUGH rather than dropping it (silent data loss).
  { uid: null, engine_version: 'opd-note-audit/0.81.17', audited_at: '2026-07-28T10:00:00Z', id: 'eee' },
];

/** What the caller's engine-family filter does before ranking: `engine_version = ANY(family)`.
 *  No family entry carries a -mini suffix, which is what makes the int[] cast safe. */
const FAMILY = ['opd-note-audit/0.81.9', 'opd-note-audit/0.81.14', 'opd-note-audit/0.81.17'];
const familyFiltered = FIXTURE.filter((r) => FAMILY.includes(r.engine_version));

/**
 * Evaluate the exported SQL ordering the way Postgres would, driven by CANONICAL_RANK_SQL itself
 * so the assertion is against the REAL fragment rather than a copy of it.
 */
function sqlDistinctOn(rows: Row[]): Row[] {
  assert.match(CANONICAL_RANK_SQL, /string_to_array\(split_part\(engine_version, '\/', 2\), '\.'\)::int\[\] DESC/,
    'the fragment must rank by the component-wise numeric tail');
  assert.match(CANONICAL_RANK_SQL, /audited_at DESC/, 'ties must break on latest audited_at');

  const tail = (v: string): number[] => v.split('/')[1].split('.').map(Number);   // string_to_array(...)::int[]
  const cmpIntArray = (a: number[], b: number[]): number => {                      // Postgres int[] compare
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  const byUid = new Map<string, Row[]>();
  const nullUid: Row[] = [];
  for (const r of rows) {
    if (r.uid == null) { nullUid.push(r); continue; }
    if (!byUid.has(r.uid)) byUid.set(r.uid, []);
    byUid.get(r.uid)!.push(r);
  }
  const winners = [...byUid.values()].map((group) =>
    [...group].sort((a, b) =>
      cmpIntArray(tail(b.engine_version), tail(a.engine_version))
      || Date.parse(b.audited_at) - Date.parse(a.audited_at))[0]);
  return [...winners, ...nullUid];
}

test('SQL twin and canonicalByUid select the SAME row — all four traps', () => {
  const ts = canonicalByUid(familyFiltered);
  const pg = sqlDistinctOn(familyFiltered);

  const key = (rows: Row[]) => rows.map((r) => `${r.uid ?? 'NULL'}:${r.id}`).sort();
  assert.deepEqual(key(ts as Row[]), key(pg), 'the two expressions of THE RULE must agree');

  const pick = (rows: Row[], uid: string) => rows.find((r) => r.uid === uid)!;
  // 1. numeric tail beats lexicographic: 0.81.17 wins over 0.81.9 despite the older audited_at.
  assert.equal(pick(ts as Row[], 'n1').engine_version, 'opd-note-audit/0.81.17');
  assert.equal(pick(pg, 'n1').engine_version, 'opd-note-audit/0.81.17');
  // 2. same version ⇒ latest audited_at wins (NOT id).
  assert.equal(pick(ts as Row[], 'n2').audited_at, '2026-07-30T10:00:00Z');
  assert.equal(pick(pg, 'n2').audited_at, '2026-07-30T10:00:00Z');
  // 3. the -mini row was removed by the family filter, so the base version wins on both sides
  //    even though the mini row has the latest audited_at of the whole fixture.
  assert.equal(pick(ts as Row[], 'n3').engine_version, 'opd-note-audit/0.81.14');
  assert.equal(pick(pg, 'n3').engine_version, 'opd-note-audit/0.81.14');
  // 4. the null-uid row survives on both sides — never silently dropped.
  assert.ok((ts as Row[]).some((r) => r.uid == null), 'canonicalByUid passes a null identity through');
  assert.ok(pg.some((r) => r.uid == null), 'the SQL twin must not drop it either');
});

test('the ordering is the one THE RULE states — reverting it fails this test', () => {
  // Guards the exact defect §4 found: `note_date DESC, id DESC` never breaks a duplicate tie
  // (note_date is identical across re-audits of one note), so the winner was an arbitrary UUID.
  assert.ok(!/note_date/.test(CANONICAL_RANK_SQL), 'note_date cannot rank re-audits of the same note');
  assert.ok(!/\bid DESC/.test(CANONICAL_RANK_SQL), 'a UUID tiebreak is arbitrary, not canonical');
  assert.ok(!/engine_version DESC/.test(CANONICAL_RANK_SQL), 'a bare lexicographic sort ranks 0.81.9 above 0.81.17');
});

test('no doctor-facing surface writes its own NOTE-IDENTITY dedup', () => {
  // lib/audit-canonical.ts: "no surface writes its own DISTINCT ON". Enforced, not trusted.
  //
  // Scoped to NOTE IDENTITY. `DISTINCT ON (uid)` is THE RULE and must come from the shared
  // fragment. A `DISTINCT ON` over a DIFFERENT key is a different operation and stays legal —
  // fetchDeptFindingNotes uses `DISTINCT ON (l.id)` to collapse a CROSS JOIN LATERAL fan-out (one
  // row per matching finding) back to one row per note, over rows the shared fragment has ALREADY
  // made canonical. Banning that outright would be a false positive.
  const doctor = readFileSync('lib/opd-audit-doctor.ts', 'utf8');
  assert.ok(!/DISTINCT ON \(\s*uid\s*\)/.test(doctor),
    'a hand-written DISTINCT ON (uid) is a competing dedup posture — use canonicalDistinctOnSql');
  assert.ok(doctor.includes('canonicalDistinctOnSql'), 'and it must use the shared fragment');
  // The lateral de-fan is keyed on the canonical row's id, never on uid.
  for (const m of doctor.match(/DISTINCT ON \([^)]*\)/g) ?? []) {
    assert.ok(/\bid\b/.test(m), `unexpected DISTINCT ON key: ${m}`);
  }
});

test('ONE RULE across every surface — governance and stewardship included (addendum D)', () => {
  // The real defect was three surfaces holding three different rules over one table: the doctor
  // pages deduped one way, governance PINNED a version, stewardship took the newest by TIME. This
  // is the test that stops a fourth appearing.
  for (const f of ['lib/opd-gov-read.ts', 'app/admin/stewardship/page.tsx', 'lib/opd-audit-doctor.ts']) {
    const src = readFileSync(f, 'utf8');
    assert.ok(src.includes('canonicalDistinctOnSql'), `${f} must dedup through the shared fragment`);
    assert.ok(!/DISTINCT ON \(\s*uid\s*\)/.test(src), `${f} must not hand-write a note-identity dedup`);
  }

  // Governance: the version pin is gone from the METRICS path. It showed 4-7% of a doctor's notes
  // and collapsed at every engine bump. (resolveInstances still pins — reported, not changed here.)
  const gov = readFileSync('lib/opd-gov-read.ts', 'utf8');
  const metrics = gov.slice(gov.indexOf('export async function doctorAuditMetrics'));
  assert.ok(!/engine_version\s*=\s*\$\d/.test(metrics), 'doctorAuditMetrics must not pin a single engine version');
  assert.ok(metrics.includes('ENG_FAMILY_SQL'), 'it reads the engine family, like every other surface');
  // Option C, not B: the mix is DECLARED, never hidden.
  assert.ok(/engine_versions: number; oldest_engine_version: string \| null;/.test(gov),
    'AuditMetrics must carry the version spread behind the number');
  assert.ok(metrics.includes('count(DISTINCT engine_version)'), 'and it must actually be computed');

  // Stewardship: newest-by-time is not THE RULE, and it had no engine filter at all.
  const stew = readFileSync('app/admin/stewardship/page.tsx', 'utf8');
  assert.ok(!/ORDER BY uid, audited_at DESC/.test(stew), 'newest-by-time ranking must be gone');
  assert.ok(stew.includes('ENG_FAMILY_SQL'), 'and it must now filter the engine family');
});

test('canonicalDistinctOnSql composes the identity, the columns and the rank tail', () => {
  const sqlText = canonicalDistinctOnSql({
    table: 'opd_note_audits', identity: 'uid', cols: 'band, note_date', where: 'app_source = $1',
  });
  assert.match(sqlText, /SELECT DISTINCT ON \(uid\) uid, band, note_date/);
  assert.match(sqlText, /FROM opd_note_audits/);
  assert.match(sqlText, /WHERE app_source = \$1/);
  assert.ok(sqlText.includes(`ORDER BY uid, ${CANONICAL_RANK_SQL}`), 'the rank tail is the shared constant');
});
