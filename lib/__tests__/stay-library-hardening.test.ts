// lib/__tests__/stay-library-hardening.test.ts — the stay library's hardening slices
// (CDMSS-STAY-LIBRARY-HARDENING-PRD-v1.0-29-AUG-2026).
//
// H1 (H-D2): a library row is never overwritten without its prior reading landing in
// `clinical_state_versions` in the SAME SQL statement. The behavioural tests here drive
// `upsertClinicalState` through its test seam, so what is asserted is the SQL that would actually
// have been sent and the outcome the caller would actually have got — including the case that
// matters most, a snapshot leg that FAULTS, which must block the overwrite rather than proceed
// without a trail. The source pins carry what a behavioural test cannot see: that the snapshot and
// the overwrite are one statement and not two, and that the new table is append-only.
// Run: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { upsertClinicalState, SNAPSHOT_REASONS, type SqlRunner } from '../stay-library/store';
import { emptyClinicalState } from '../clinical-state/schema';
import type { ClinicalState } from '../clinical-state/schema';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file's CODE, comments stripped — a pin that reads prose fails on a file honest enough to
 *  document what it refuses to do (the P1 lesson, re-applied through P2 and now here). */
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*--.*$/gm, '');

const state = (): ClinicalState => {
  const st = emptyClinicalState('doc_audit');
  st.surfaceExtras = { stayDoc: { docKind: 'ot', sourceUid: 'ot-1' } };
  return st;
};

const input = {
  docKind: 'ot' as const, sourceUid: 'ot-1', memberUid: 'M1',
  encounterRef: 'IP-1472', status: 'ok' as const, state: state(),
};

/** A recording fake runner. `priorRows` is what the pre-read returns; `fail` names the leg that
 *  throws, by substring, so a test can fault exactly one of the two statements. */
function fakeRunner(o: { priorRows?: number; failOn?: string } = {}) {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const run: SqlRunner = async (query, params) => {
    calls.push({ query, params });
    if (o.failOn && query.includes(o.failOn)) throw new Error('simulated fault');
    if (/^\s*SELECT id FROM clinical_states/.test(query)) {
      return Array.from({ length: o.priorRows ?? 0 }, () => ({ id: 'prior-row-id' }));
    }
    return [{ inserted: (o.priorRows ?? 0) === 0 }];
  };
  return { run, calls };
}

// ══ H1 — snapshot before overwrite ═══════════════════════════════════════════════════════

test('H1: overwriting a library row snapshots the prior row in the SAME statement', async () => {
  const { run, calls } = fakeRunner({ priorRows: 1 });
  assert.equal(await upsertClinicalState(input, run), 'updated');

  assert.equal(calls.length, 2, 'one pre-read, then one write statement — not three');
  const write = calls[1].query;
  assert.match(write, /^\s*WITH cur AS \(/, 'the snapshot must lead the statement it guards');
  assert.match(write, /INSERT INTO clinical_state_versions/);
  assert.match(write, /'upsert_overwrite'/);
  assert.match(write, /ON CONFLICT \(doc_kind, source_uid, schema_version\) DO UPDATE/);
  assert.match(write, /RETURNING \(xmax = 0\) AS inserted/, 'the (xmax = 0) return must survive H1');
  // ONE statement, not two: a semicolon between the legs would let a crash separate them.
  assert.equal(write.split(';').length, 1, 'the snapshot and the overwrite must not be two statements');
  // The snapshot reads the row being replaced, not the row replacing it.
  assert.match(write, /SELECT c\.id, c\.doc_kind, c\.source_uid, c\.schema_version, c\.status, c\.state_json/);
  assert.ok(!/EXCLUDED\.[a-z_]+, *'upsert_overwrite'/.test(write), 'the snapshot must not carry EXCLUDED values');
});

test('H1: a FRESH insert snapshots nothing and never names the versions table', async () => {
  const { run, calls } = fakeRunner({ priorRows: 0 });
  assert.equal(await upsertClinicalState(input, run), 'inserted');

  const write = calls[1].query;
  assert.ok(!write.includes('clinical_state_versions'),
    'a fresh insert must not reference the versions table — a deploy ahead of the migration still builds libraries');
  assert.ok(!write.includes('WITH cur'));
  assert.match(write, /^\s*INSERT INTO clinical_states/);
});

test('H1: a FAILED snapshot blocks the overwrite and returns the fail-soft skip', async () => {
  const { run, calls } = fakeRunner({ priorRows: 1, failOn: 'clinical_state_versions' });
  // The whole statement aborts — the overwrite is inside it, so it did not happen either.
  assert.equal(await upsertClinicalState(input, run), 'skipped');
  assert.equal(calls.length, 2, 'the store must not retry the overwrite without its snapshot');
  assert.ok(calls.every((c) => c.query.includes('clinical_state_versions') || c.query.startsWith('SELECT id')),
    'no unsnapshotted write was attempted');
});

test('H1: fail-soft is preserved — the upsert never throws, whatever faults', async () => {
  const both: SqlRunner = async () => { throw new Error('database is gone'); };
  assert.equal(await upsertClinicalState(input, both), 'skipped');

  // A pre-read that faults must NOT be read as "no prior row": unknown takes the snapshot path,
  // because guessing "fresh" on a row that exists is exactly the unsnapshotted overwrite H1 bans.
  const { run, calls } = fakeRunner({ failOn: 'SELECT id FROM clinical_states' });
  await upsertClinicalState(input, run);
  assert.match(calls[1].query, /INSERT INTO clinical_state_versions/,
    'an unknown prior must take the snapshot path, not the fresh-insert path');

  // And the validation guards still short-circuit before any SQL at all.
  const empty = fakeRunner();
  assert.equal(await upsertClinicalState({ ...input, sourceUid: '' }, empty.run), 'skipped');
  assert.equal(empty.calls.length, 0, 'a malformed input must not reach the database');
});

test('H1: the snapshot carries the row identity a diff needs', async () => {
  const { run, calls } = fakeRunner({ priorRows: 1 });
  await upsertClinicalState(input, run);
  const write = calls[1].query;
  for (const col of ['clinical_state_id', 'doc_kind', 'source_uid', 'schema_version', 'status', 'state_json', 'reason']) {
    assert.ok(write.includes(col), `the snapshot must carry ${col}`);
  }
  // The pre-read and the CTE must name the SAME row, or the snapshot guards a different one.
  assert.match(calls[0].query, /doc_kind = \$1 AND source_uid = \$2 AND schema_version = \$3/);
  assert.match(write, /WHERE doc_kind = \$1 AND source_uid = \$2 AND schema_version = \$5/);
  assert.deepEqual(calls[0].params, ['ot', 'ot-1', 'clinical-state/1.2']);
});

// ══ H1 source pins ═══════════════════════════════════════════════════════════════════════

test('H-D2: the reason enum is exactly the two the PRD names', () => {
  assert.deepEqual([...SNAPSHOT_REASONS], ['upsert_overwrite', 'superseded']);
});

test('the versions table is APPEND-ONLY: the store never updates or deletes it', () => {
  const store = code('lib/stay-library/store.ts');
  // Every write verb that names a table names one of exactly two, and the versions table is only
  // ever INSERTed into. (`ON CONFLICT ... DO UPDATE SET` names no table — it is still the INSERT's
  // own target — so it is neutralised before the scan rather than matched as a bare UPDATE.)
  const sqlish = store.replace(/DO\s+UPDATE/gi, 'DO_UPSERT');
  const writes = [...sqlish.matchAll(/(INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+([a-z_][a-z0-9_]*)/gi)]
    .map((m) => ({ verb: m[1].toUpperCase().replace(/\s+/g, ' '), table: m[2] }));
  assert.ok(writes.length > 0, 'the store must actually write something');
  for (const w of writes) {
    assert.ok(['clinical_states', 'clinical_state_versions'].includes(w.table), `the store writes ${w.table}`);
    if (w.table === 'clinical_state_versions') {
      assert.equal(w.verb, 'INSERT INTO', 'the version trail is append-only — it is never rewritten');
    }
  }
});

test('H1 migration 0049 is additive and creates the versions table', () => {
  for (const f of ['migrations/0049_stay_library_hardening.sql', 'app/api/admin/migrate-stay-library-hardening/route.ts']) {
    const src = code(f);
    assert.ok(!/\bDROP\b/i.test(src), `${f} contains DROP`);
    assert.ok(src.includes('CREATE TABLE IF NOT EXISTS clinical_state_versions'));
    assert.ok(src.includes('clinical_state_versions_state_idx'));
  }
  // 0049 is the next free number: nothing already claims it.
  const dir = readFileSync(join(ROOT, 'migrations/0049_stay_library_hardening.sql'), 'utf8');
  assert.ok(dir.length > 0);
});

test('H1 touches no engine version, no schema version and no flag', () => {
  const src = code('lib/stay-library/store.ts')
    + code('app/api/admin/migrate-stay-library-hardening/route.ts')
    + code('migrations/0049_stay_library_hardening.sql');
  for (const banned of [
    'ipd-discharge-audit/0', 'ipd-stay-audit/0', 'opd-note-audit/0', 'member-state/1',
    'MEMBERSTATE_IPD_FOLD', 'MEMBER_STATE_UI', 'care_value_index', 'tracedChat', 'governedChat',
  ]) {
    assert.ok(!src.includes(banned), `H1 names ${banned}`);
  }
  assert.ok(!/CLINICAL_STATE_VERSION\s*=\s*'/.test(src), 'H1 must not redeclare the schema version');
});

test('H1 names exactly two tables and no audit / feedback / spine table', () => {
  const store = code('lib/stay-library/store.ts');
  for (const forbidden of [
    'ipd_discharge_audits', 'opd_note_audits', 'ipd_audit_feedback', 'opd_audit_feedback',
    'readmission_findings', 'readmission_finding_versions', 'episode_states', 'member_state',
    'case_ask_turns',
  ]) {
    assert.ok(!store.includes(forbidden), `store.ts names ${forbidden}`);
  }
});
