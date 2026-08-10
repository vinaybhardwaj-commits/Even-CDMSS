/**
 * lib/__tests__/lvc-ratified-wording.test.ts — LVC JUDGE PINNING PRD v1.0 §3 (D-5), 10 Aug 2026.
 *
 *   node --test --import tsx lib/__tests__/lvc-ratified-wording.test.ts
 *
 * The migration ships clinical wording a doctor will be judged against, so the two things that can
 * go wrong are (a) the text drifting from what V ratified and (b) the migration not being
 * idempotent. Both are asserted here rather than trusted:
 *
 *   · BYTE-EXACT ROUND TRIP — every precondition is parsed back OUT of the dollar-quoted literal in
 *     migrations/0034_lvc_ratified_wording.sql and compared byte-for-byte with the shipped
 *     constant. §3.2 and §3.8 (the merge and the vitamin-D carve-out) get their own named tests,
 *     per the kickoff.
 *
 *     ⚠️ WHY THE .sql FILE AND NOT THE PRD. The PRD these texts were ratified in is a root-level
 *     *.md, which .gitignore excludes (line 73), so it does not exist on a fresh clone or in CI —
 *     a test anchored to it would pass here and throw ENOENT everywhere else. The .sql file IS
 *     the version-controlled ratified record and was GENERATED from the PRD's blockquotes rather
 *     than transcribed. The PRD comparison still runs when the document is present (V's machine,
 *     the build machine) and reports itself when it is not, so nothing is silently skipped.
 *   · IDEMPOTENCE — the migration is run twice against an in-memory table that implements the
 *     documented IS DISTINCT FROM guard. The second run must change ZERO rows.
 *
 * The fake runner is not a Postgres: it implements the semantics of the three exported statements,
 * matched by identity against the constants the production route sends. That tests the runner's
 * own logic — which ids, in which order, with which parameters, counted how — and leaves the SQL
 * strings themselves to live validation, which is why the build report lists them verbatim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  applyRatifiedWording,
  sameInstant,
  RATIFIED_PRECONDITIONS,
  RATIFIED_RETIREMENTS,
  RATIFIED_IDS,
  RATIFIED_BY,
  RATIFIED_AT,
  RETIRED_STATUS,
  WORDING_READBACK_SQL,
  PRECONDITION_UPDATE_SQL,
  RETIREMENT_UPDATE_SQL,
  type SqlRunner,
} from '../lvc-ratified-wording';

const PRD = 'CDMSS-LVC-JUDGE-PINNING-PRD-v1.0-10-AUG-2026.md';
const MIGRATION = 'migrations/0034_lvc_ratified_wording.sql';

/**
 * The ratified text for one id, parsed back out of the tracked .sql record's dollar-quoted
 * literal. This is the round trip that runs everywhere: constant → generated SQL → parsed back.
 */
function sqlText(id: string): string {
  const src = readFileSync(MIGRATION, 'utf8');
  const marker = `SET precondition = $txt$`;
  // The quoted id appears in the statement's WHERE clause; the SET literal is the nearest one above it.
  const at = src.indexOf(`'${id}'`);
  assert.ok(at > 0, `${MIGRATION} has no statement for ${id}`);
  // The statement's SET clause precedes the WHERE id = '<id>' that located it.
  const head = src.lastIndexOf(marker, at);
  assert.ok(head > 0, `${MIGRATION} has no dollar-quoted precondition for ${id}`);
  const start = head + marker.length;
  const end = src.indexOf('$txt$', start);
  assert.ok(end > start, `${MIGRATION} has an unterminated literal for ${id}`);
  return src.slice(start, end);
}

/** The ratified text from the PRD blockquote — null when the (gitignored) document is absent. */
function prdText(section: string): string | null {
  if (!existsSync(PRD)) return null;
  const lines = readFileSync(PRD, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(`### ${section} `)) continue;
    for (let j = i + 1; j < lines.length && !lines[j].startsWith('### '); j++) {
      if (lines[j].startsWith('> ')) return lines[j].slice(2);
    }
  }
  throw new Error(`${PRD} is present but has no ratified blockquote for §${section}`);
}

// ── §3 — the shape of the pass ────────────────────────────────────────────────────────────────
test('§3: seven preconditions, two retirements, nine distinct rows', () => {
  assert.equal(RATIFIED_PRECONDITIONS.length, 7);
  assert.equal(RATIFIED_RETIREMENTS.length, 2);
  assert.equal(RATIFIED_IDS.length, 9);
  assert.equal(new Set(RATIFIED_IDS).size, 9, 'no id is touched twice');
  assert.deepEqual(
    RATIFIED_PRECONDITIONS.map((p) => p.section),
    ['3.1', '3.2', '3.5', '3.6', '3.7', '3.8', '3.9'],
  );
  assert.deepEqual(RATIFIED_RETIREMENTS.map((r) => r.section), ['3.3', '3.4']);
  assert.equal(RATIFIED_BY, 'V (Dr Vinay Bhardwaj)');
  assert.equal(RETIRED_STATUS, 'retired');
  assert.equal(RATIFIED_AT.slice(0, 10), '2026-08-10', 'the ratified date, pinned to a fixed instant');
});

test('§3: the ids are exactly the ones the PRD names', () => {
  const bySection = new Map(RATIFIED_PRECONDITIONS.map((p) => [p.section, p.id]));
  assert.equal(bySection.get('3.1'), 'ehrc-f283f2c4-7739-46e2-b5c8-997d89a79f5c');
  assert.equal(bySection.get('3.2'), 'ehrc-f8b0572d-b082-48ec-9774-b7b8970aeb1c');
  assert.equal(bySection.get('3.5'), 'cwus-acr-002');
  assert.equal(bySection.get('3.6'), 'cwus-acr-003');
  assert.equal(bySection.get('3.7'), 'cwus-acp-002');
  assert.equal(bySection.get('3.8'), 'cwus-aace-003');
  assert.equal(bySection.get('3.9'), 'cwus-aace-004');
  assert.deepEqual(RATIFIED_RETIREMENTS.map((r) => r.id), [
    'ehrc-fe8f229b-d818-4e40-a360-367fa85bfb02',   // D-5a, superseded by the §3.2 merge
    'ehrc-cdfcf3bc-b737-4058-91af-600b5ca414fd',   // D-5b, undocumented ICD code
  ]);
});

// ── BYTE-EXACT ROUND TRIP ─────────────────────────────────────────────────────────────────────
test('every shipped precondition round-trips byte-for-byte through the .sql record', () => {
  for (const p of RATIFIED_PRECONDITIONS) {
    const parsed = sqlText(p.id);
    assert.equal(parsed, p.precondition, `§${p.section} (${p.id}) has drifted between the module and ${MIGRATION}`);
    assert.equal(parsed.length, p.precondition.length, 'no whitespace difference either');
  }
});

test('§3.2 round-trips byte-for-byte — the MERGED safety-netting record (D-5a)', () => {
  const spec = RATIFIED_PRECONDITIONS.find((p) => p.section === '3.2')!;
  assert.equal(sqlText(spec.id), spec.precondition, 'module ↔ .sql');
  const ratified = prdText('3.2');
  if (ratified !== null) assert.equal(spec.precondition, ratified, 'module ↔ ratified PRD blockquote');
  assert.ok(spec.precondition.includes('deliberate inverted trigger'), 'the inverted-trigger clause survived');
  assert.ok(spec.precondition.includes('how the response to a prescribed treatment is to be monitored'),
    'the absorbed monitoring claim survived the merge');
  assert.ok(spec.precondition.startsWith('Applies when the note documents a treatment plan, a prescription, or a transfer/hand-off of care,'));
  assert.ok(spec.precondition.endsWith('If the note documents no treatment, no prescription and no hand-off, the recommendation does not apply.'));
});

test('§3.8 round-trips byte-for-byte — the vitamin-D carve-out (D-5c)', () => {
  const spec = RATIFIED_PRECONDITIONS.find((p) => p.section === '3.8')!;
  assert.equal(sqlText(spec.id), spec.precondition, 'module ↔ .sql');
  const ratified = prdText('3.8');
  if (ratified !== null) assert.equal(spec.precondition, ratified, 'module ↔ ratified PRD blockquote');
  assert.ok(
    spec.precondition.includes('Non-specific complaints alone — fatigue, tiredness, generalised body ache — do NOT count as an indication.'),
    'the D-5c carve-out is present verbatim',
  );
  assert.ok(spec.precondition.startsWith('Applies when the note orders a 25-hydroxyvitamin D level in an adult.'));
});

test('when the ratified PRD is present, every text still matches it byte-for-byte', () => {
  if (!existsSync(PRD)) {
    // Not a silent skip: the .sql round trip above is the CI anchor and has already run.
    console.log(`[lvc-wording] ${PRD} absent (root *.md is gitignored) — the .sql round trip is the anchor here`);
    return;
  }
  for (const p of RATIFIED_PRECONDITIONS) {
    assert.equal(p.precondition, prdText(p.section), `§${p.section} (${p.id}) has drifted from the ratified text`);
  }
});

test('the .sql record and the shipped constants cannot drift', () => {
  const sqlFile = readFileSync(MIGRATION, 'utf8');
  for (const p of RATIFIED_PRECONDITIONS) {
    assert.ok(sqlFile.includes(p.precondition), `§${p.section} text missing from ${MIGRATION}`);
    assert.ok(sqlFile.includes(`'${p.id}'`), `§${p.section} id missing from ${MIGRATION}`);
  }
  for (const r of RATIFIED_RETIREMENTS) {
    assert.ok(sqlFile.includes(`'${r.id}'`), `§${r.section} id missing from ${MIGRATION}`);
  }
  assert.ok(sqlFile.includes(`'${RATIFIED_BY}'`), 'ratified_by missing from the .sql record');
  assert.ok(sqlFile.includes(`'${RATIFIED_AT}'::timestamptz`), 'ratified_at missing from the .sql record');
  assert.ok(!/\bDROP\b|\bDELETE\b|\bTRUNCATE\b|\bALTER\b/i.test(sqlFile), 'data-only: no destructive or DDL statement');
});

test('every shipped precondition encodes the ratified drafting convention', () => {
  // The whole point of the pass (§3): a fact not written in the note is ABSENT, and the verdict is
  // then definite. A text that lost that instruction would silently re-open the flips it was
  // written to close. TWO ratified phrasings satisfy it, and §3.2 is deliberately the second:
  //   · six texts say it by naming the wrong answer — "rather than / never insufficient information";
  //   · §3.2 is the INVERTED trigger (the absence IS the finding), so it says the same thing as
  //     "must be read as genuinely missing, not as unknown".
  const CONVENTION = /insufficient information|not as unknown/;
  for (const p of RATIFIED_PRECONDITIONS) {
    assert.match(p.precondition, CONVENTION,
      `§${p.section} no longer says what to do about a fact the note does not mention`);
  }
  const inverted = RATIFIED_PRECONDITIONS.find((p) => p.section === '3.2')!;
  assert.match(inverted.precondition, /must be read as genuinely missing, not as unknown/);
  for (const p of RATIFIED_PRECONDITIONS.filter((x) => x.section !== '3.2')) {
    assert.match(p.precondition, /insufficient information/, `§${p.section}`);
  }
});

// ── THE MIGRATION ─────────────────────────────────────────────────────────────────────────────

interface FakeRow { id: string; precondition: string | null; status: string | null; ratified_by: string | null; ratified_at: string | null }

/**
 * An in-memory `lvc_recommendations` implementing the documented semantics of the three exported
 * statements: read by id set, and update ONLY when a targeted column differs (IS DISTINCT FROM),
 * returning the id when it did. Counts every statement so the tests can assert call shape too.
 */
function fakeDb(seed: FakeRow[]) {
  const rows = new Map(seed.map((r) => [r.id, { ...r }]));
  const calls: { sql: string; params: unknown[] }[] = [];
  const run: SqlRunner = async (text, params) => {
    calls.push({ sql: text, params });
    if (text === WORDING_READBACK_SQL) {
      const ids = new Set((params[0] as string[]) ?? []);
      return [...rows.values()].filter((r) => ids.has(r.id)).map((r) => ({ ...r }));
    }
    if (text === PRECONDITION_UPDATE_SQL) {
      const [id, precondition, by, at] = params as [string, string, string, string];
      const r = rows.get(id);
      if (!r) return [];
      if (r.precondition === precondition && r.ratified_by === by && sameInstant(r.ratified_at, at)) return [];
      r.precondition = precondition; r.ratified_by = by; r.ratified_at = at;
      return [{ id }];
    }
    if (text === RETIREMENT_UPDATE_SQL) {
      const [id, status, by, at] = params as [string, string, string, string];
      const r = rows.get(id);
      if (!r) return [];
      if (r.status === status && r.ratified_by === by && sameInstant(r.ratified_at, at)) return [];
      r.status = status; r.ratified_by = by; r.ratified_at = at;
      return [{ id }];
    }
    throw new Error(`unexpected SQL: ${text.slice(0, 60)}`);
  };
  return { run, rows, calls };
}

/** The table as it stands today: the ratified rows present, none of them ratified. */
const preMigrationRows = (): FakeRow[] => RATIFIED_IDS.map((id) => ({
  id, precondition: 'the old, ambiguous precondition', status: 'active', ratified_by: null, ratified_at: null,
}));

test('first run updates all nine rows and verifies them', async () => {
  const db = fakeDb(preMigrationRows());
  const r = await applyRatifiedWording(db.run);
  assert.equal(r.ok, true, r.error ?? '');
  assert.equal(r.changed, 9);
  assert.equal(r.unchanged, 0);
  assert.equal(r.missing, 0);
  assert.equal(r.verified, true, 'the post-write readback confirms every row');
  for (const p of RATIFIED_PRECONDITIONS) {
    const row = db.rows.get(p.id)!;
    assert.equal(row.precondition, p.precondition, `§${p.section} text written verbatim`);
    assert.equal(row.ratified_by, RATIFIED_BY);
    assert.ok(sameInstant(row.ratified_at, RATIFIED_AT));
    assert.equal(row.status, 'active', 'a re-worded rec stays active');
  }
  for (const t of RATIFIED_RETIREMENTS) {
    const row = db.rows.get(t.id)!;
    assert.equal(row.status, RETIRED_STATUS);
    assert.equal(row.ratified_by, RATIFIED_BY);
    assert.equal(row.precondition, 'the old, ambiguous precondition', 'retirement does not rewrite text');
  }
});

test('IDEMPOTENCE: the second run changes zero rows', async () => {
  const db = fakeDb(preMigrationRows());
  const first = await applyRatifiedWording(db.run);
  assert.equal(first.changed, 9);

  const second = await applyRatifiedWording(db.run);
  assert.equal(second.ok, true, second.error ?? '');
  assert.equal(second.changed, 0, 'RE-RUNNING THE MIGRATION MUST CHANGE ZERO ROWS');
  assert.equal(second.unchanged, 9);
  assert.equal(second.verified, true, 'and the rows still read back exactly');

  const third = await applyRatifiedWording(db.run);
  assert.equal(third.changed, 0, 'and stays at zero');
});

test('the readback runs FIRST, so a broken schema writes nothing at all', async () => {
  const attempted: string[] = [];
  const run: SqlRunner = async (text) => {
    attempted.push(text);
    throw new Error('column "ratified_by" does not exist');
  };
  const r = await applyRatifiedWording(run);
  assert.equal(r.ok, false);
  assert.equal(r.changed, 0);
  assert.match(r.error ?? '', /nothing written/);
  assert.deepEqual(attempted, [WORDING_READBACK_SQL], 'exactly one statement was ever sent, and it was a SELECT');
});

test('a dry run reads and plans without writing', async () => {
  const db = fakeDb(preMigrationRows());
  const r = await applyRatifiedWording(db.run, { dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.rows.filter((x) => x.result === 'updated').length, 9, 'nine rows WOULD change');
  assert.deepEqual(db.calls.map((c) => c.sql), [WORDING_READBACK_SQL], 'no UPDATE was sent');
  assert.equal(db.rows.get(RATIFIED_IDS[0])!.precondition, 'the old, ambiguous precondition');
});

test('a missing id is reported, never silently skipped', async () => {
  const db = fakeDb(preMigrationRows().filter((r) => r.id !== 'cwus-aace-004'));
  const r = await applyRatifiedWording(db.run);
  assert.equal(r.ok, false, 'a missing row is not a success');
  assert.equal(r.missing, 1);
  assert.equal(r.changed, 8);
  assert.ok(r.rows.some((x) => x.id === 'cwus-aace-004' && x.result === 'missing'));
});

test('a row already carrying the ratified value is left alone even on the first run', async () => {
  const seed = preMigrationRows();
  const done = RATIFIED_PRECONDITIONS[0];
  const target = seed.find((r) => r.id === done.id)!;
  target.precondition = done.precondition;
  target.ratified_by = RATIFIED_BY;
  target.ratified_at = RATIFIED_AT;
  const db = fakeDb(seed);
  const r = await applyRatifiedWording(db.run);
  assert.equal(r.changed, 8);
  assert.equal(r.unchanged, 1);
});

test('sameInstant compares instants, not strings — a Postgres timestamptz still verifies', () => {
  assert.equal(sameInstant('2026-08-10 00:00:00+00', RATIFIED_AT), true);
  assert.equal(sameInstant('2026-08-10T05:30:00+05:30', RATIFIED_AT), true);
  assert.equal(sameInstant('2026-08-11T00:00:00Z', RATIFIED_AT), false);
  assert.equal(sameInstant(null, RATIFIED_AT), false);
  assert.equal(sameInstant(null, null), true);
});
