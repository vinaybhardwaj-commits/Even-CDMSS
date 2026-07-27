// NQI coverage metric — PHASE 1. Persisting the scorecard (PRD 27 Jul 2026).
//
// These are SOURCE-LEVEL assertions over lib/opd-audit-store.ts and migrations/0025, not runtime
// tests. That is deliberate: the risk in this build is not logic, it is SQL parameter alignment and
// column-list drift across three write paths — the class of fault that a type system cannot see and
// that has produced seven schema defects on this project this week. A misnumbered $n writes the
// right value into the wrong column, silently.
//
// lib/opd-audit-store.ts imports ./db, so it cannot be imported here without breaking the
// strip-types contract; reading its source is the way to assert against it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeOpdScore } from '../opd-note-score-core.ts';

const STORE = readFileSync(new URL('../opd-audit-store.ts', import.meta.url), 'utf8');
const MIGRATION = readFileSync(new URL('../../migrations/0025_opd_note_audits_scorecard.sql', import.meta.url), 'utf8');

test('migration 0025 is exactly one additive, idempotent statement', () => {
  const stmts = MIGRATION.replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);
  assert.equal(stmts.length, 1, 'PRD §4: nothing but the ALTER');
  assert.equal(stmts[0], 'ALTER TABLE opd_note_audits ADD COLUMN IF NOT EXISTS scorecard jsonb');
  // no index, no NOT NULL, no default, and nothing destructive
  assert.doesNotMatch(MIGRATION.replace(/--.*$/gm, ''), /CREATE INDEX/i);
  assert.doesNotMatch(MIGRATION.replace(/--.*$/gm, ''), /NOT NULL/i);
  assert.doesNotMatch(MIGRATION.replace(/--.*$/gm, ''), /DEFAULT/i);
  assert.doesNotMatch(MIGRATION.replace(/--.*$/gm, ''), /\b(DROP|UPDATE|DELETE|TRUNCATE|INSERT)\b/i);
});

test('ALL THREE write paths carry the scorecard — a row written without one is a bug', () => {
  // 1. ON CONFLICT DO UPDATE (force mode)
  assert.match(STORE, /scorecard = EXCLUDED\.scorecard,/);
  // 2. INSERT column list + placeholder
  assert.match(STORE, /complexity_band, complexity_inputs, scorecard\$\{withGen \? ', quieting_gen' : ''\}\)/);
  assert.match(STORE, /\$30, \$31::jsonb, \$32::jsonb\$\{withGen \? ', \$33' : ''\}\)/);
  // 3. force-overwrite UPDATE
  assert.match(STORE, /scorecard = \$20::jsonb\$\{withGen \? ', quieting_gen = \$21' : ''\}/);
});

test('INSERT: columns and arguments align in BOTH withGen branches', () => {
  const colBlock = STORE.slice(STORE.indexOf('(uid, consult_uid, doctor_uid'), STORE.indexOf('VALUES ($1'));
  for (const withGen of [false, true]) {
    const cols = colBlock
      .replace(/\$\{withGen \? ', quieting_gen' : ''\}/, withGen ? ', quieting_gen' : '')
      .replace(/[()\n]/g, ' ').split(',').map((x) => x.trim()).filter(Boolean);
    assert.equal(cols.length, withGen ? 33 : 32, `withGen=${withGen}`);
    // scorecard is the 32nd column in both branches, immediately after complexity_inputs
    assert.equal(cols[31], 'scorecard', `withGen=${withGen}: scorecard must be column 32`);
    assert.equal(cols[30], 'complexity_inputs');
    if (withGen) assert.equal(cols[32], 'quieting_gen');
  }
});

test('INSERT placeholders are 1..33, sequential and unique — no gap, no reuse', () => {
  // NB: the file's opening docblock also contains the literal "ON CONFLICT (uid, engine_version)",
  // so the end anchor MUST be searched from after VALUES or the slice runs backwards and is empty —
  // which would make this assertion vacuously pass on an empty set. Found while writing it.
  const vStart = STORE.indexOf('VALUES ($1');
  const vals = STORE.slice(vStart, STORE.indexOf('ON CONFLICT (uid, engine_version)', vStart));
  assert.ok(vals.length > 50, 'slice must be non-empty or the assertions below are vacuous');
  const ph = [...vals.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  assert.equal(new Set(ph).size, ph.length, 'no placeholder may be reused');
  assert.deepEqual(ph.slice().sort((a, b) => a - b), Array.from({ length: 33 }, (_, i) => i + 1));
  // the scorecard placeholder is cast, like every other jsonb column in this file
  assert.match(vals, /\$32::jsonb/);
});

test('UPDATE placeholders are 1..21 and scorecard is $20, quieting_gen $21', () => {
  const up = STORE.slice(STORE.indexOf('UPDATE opd_note_audits SET'), STORE.indexOf('WHERE uid = $1 AND engine_version = $19'));
  assert.match(up, /scorecard = \$20::jsonb/);
  assert.match(up, /quieting_gen = \$21/);
  // $19 stays the engine_version predicate — the scorecard must not have displaced it
  assert.match(STORE, /WHERE uid = \$1 AND engine_version = \$19/);
});

test('serialisation is FAIL-SAFE: a scorecard fault must never cost an audit', () => {
  assert.match(STORE, /function scorecardJson\(sc: unknown\): string \| null \{/);
  assert.match(STORE, /catch \{ return null; \}/);
  // null in ⇒ null out, so a missing scorecard writes SQL NULL rather than the string "null"
  assert.match(STORE, /if \(sc == null\) return null;/);
});

test('the scorecard is stored AS COMPUTED — not pruned, reshaped or renamed', () => {
  // the argument is the whole object already in scope, the same `sc` headline/band are read from
  assert.match(STORE, /\n      scorecardJson\(sc\),\n/);
  // no field-picking on the way to the column
  assert.doesNotMatch(STORE, /scorecardJson\(\{/);
  assert.doesNotMatch(STORE, /scorecardJson\(sc\.\w/);
});

test('THE POINT: an unassessed note carries note_quality with weight 0 and a stating basis', () => {
  // Reproduce the unassessed case through the REAL scorer, then assert the shape that gets stored.
  const sc = computeOpdScore({
    findings: [], completenessCoverage: 1, pdqi9: null,
    patientCentred: { present: 2, total: 2 },
  });
  const nq = sc.domains.find((d) => d.domain === 'note_quality');
  assert.ok(nq, 'note_quality is always emitted, even unassessed');
  assert.equal(nq.weight, 0, 'weight 0 is the contradicting field this build persists');
  assert.match(nq.basis, /not assessed/i);
  // …and the headline is high BECAUSE the zero-weight domain dropped out of the normalised mean.
  // Phase 1 does NOT change this — it makes it visible. Asserted so a later "fix" here is deliberate.
  assert.ok(sc.headline >= 90, `unassessed notes still score high (got ${sc.headline}) — Phase 2/3 problem`);
  // the serialised form retains the weight
  const round = JSON.parse(JSON.stringify(sc)) as typeof sc;
  assert.equal(round.domains.find((d) => d.domain === 'note_quality')?.weight, 0);
});

test('an ASSESSED note keeps a non-zero note_quality weight — the control', () => {
  const sc = computeOpdScore({
    findings: [], completenessCoverage: 1,
    pdqi9: { thorough: 3, accurate: 3 } as never,
    patientCentred: { present: 2, total: 2 },
  });
  const nq = sc.domains.find((d) => d.domain === 'note_quality');
  assert.ok(nq && nq.weight > 0, 'an assessed note must carry a real weight');
  assert.doesNotMatch(nq.basis, /not assessed/i);
});
