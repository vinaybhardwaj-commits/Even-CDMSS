/**
 * lib/__tests__/pass-0a-corrections.test.ts — the three defects found in pass 0 after the fact.
 *
 * Pass 0 is committed at `7435845` and is NOT amended. These correct it forward.
 *
 *   §2.1  the widened failure-table CHECKs never reached an EXISTING table
 *   §2.2  MANIFEST_SCHEMA_VERSION did not move when the manifest gained two fields
 *   §2.3  the judge arm fabricated a proof of non-delivery (addendum v8 §2)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDbStub } from './telemetry-db-stub';
import {
  retrievalTelemetryDdl, validateManifest, MANIFEST_SCHEMA_VERSION,
  TELEMETRY_FAILURE_PHASES, RERANK_SEED_STATUSES,
} from '../retrieval-telemetry-core';
import { createTelemetryCapture, buildRetrievalPayload, servedClassOf, RERANK_SEED_STATUSES as CAPTURE_STATUSES } from '../retrieval-capture';
import type { OperationalTelemetry } from '../retrieval-telemetry-core';

const SQL_FILE = readFileSync('migrations/0035_opd_audit_retrieval_telemetry.sql', 'utf8');

const operational = (): OperationalTelemetry => ({
  route: 'opd_audit_worker', route_class: 'worker', retrieval_role: 'primary',
  invocation_id: 'inv', trace_id: null, deployment_sha: null,
  started_at: '2026-08-15T00:00:00.000Z', completed_at: '2026-08-15T00:00:01.000Z',
  routing_flags: {}, active_backfill_run_id: null, active_backfill_target: null,
  active_backfill_state: null, active_lab_experiment_id: null,
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §2.1 — the widened CHECKs must reach an EXISTING table, not only a fresh one
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('§2.1 — the DDL carries a DROP/ADD pair for BOTH failure-table constraints', () => {
  // ⚠️ THE DEFECT. The constraints are written inside `CREATE TABLE IF NOT EXISTS`, which is a
  // NO-OP when the table exists — so on any database that already has the table, the OLD CHECKs
  // survive and `retrieval_terminal_rejected` is rejected by the constraint. That would turn the
  // durable evidence v7 §8 exists to produce into a write error on the very path already failing.
  const keys = retrievalTelemetryDdl().map((s) => s.key);
  for (const k of ['rtf_phase_check_drop', 'rtf_phase_check', 'rtf_run_check_drop', 'rtf_run_check']) {
    assert.ok(keys.includes(k), `missing keyed statement: ${k}`);
  }
  // Ordering is load-bearing: each DROP must precede its own ADD.
  assert.ok(keys.indexOf('rtf_phase_check_drop') < keys.indexOf('rtf_phase_check'));
  assert.ok(keys.indexOf('rtf_run_check_drop') < keys.indexOf('rtf_run_check'));
  // …and the table must exist before either runs.
  assert.ok(keys.indexOf('failure_table') < keys.indexOf('rtf_phase_check_drop'));
});

test('§2.1 — the re-applied CHECKs carry the widened phase list', () => {
  const byKey = new Map(retrievalTelemetryDdl().map((s) => [s.key, s.sql]));
  assert.match(byKey.get('rtf_phase_check') as string, /'retrieval_terminal_rejected'/);
  assert.match(byKey.get('rtf_run_check') as string, /'retrieval_terminal_rejected'/);
  // Generated from the constant, never hand-typed: adding a phase to the vocabulary must move both.
  for (const phase of TELEMETRY_FAILURE_PHASES) {
    assert.match(byKey.get('rtf_phase_check') as string, new RegExp(`'${phase}'`), `phase missing: ${phase}`);
  }
});

test('§2.1 — the pair is idempotent: DROP tolerates absence, ADD names a now-free constraint', () => {
  const byKey = new Map(retrievalTelemetryDdl().map((s) => [s.key, s.sql]));
  assert.match(byKey.get('rtf_phase_check_drop') as string, /DROP CONSTRAINT IF EXISTS opd_rtf_phase_chk/);
  assert.match(byKey.get('rtf_run_check_drop') as string, /DROP CONSTRAINT IF EXISTS opd_rtf_run_chk/);
  assert.match(byKey.get('rtf_phase_check') as string, /ADD CONSTRAINT opd_rtf_phase_chk/);
  assert.match(byKey.get('rtf_run_check') as string, /ADD CONSTRAINT opd_rtf_run_chk/);
});

test('§2.1 — a FRESH table run issues the full sequence, in order', async () => {
  // The whole DDL list, driven against the stub, so the statements are observed as SENT rather
  // than read out of the array that produced them.
  const db = installDbStub();
  for (const stmt of retrievalTelemetryDdl()) await (await import('../db')).sql(stmt.sql, []);
  const sent = db.calls.map((c) => c.query.replace(/\s+/g, ' '));
  const created = sent.findIndex((q) => /CREATE TABLE IF NOT EXISTS opd_retrieval_telemetry_failures/.test(q));
  const dropped = sent.findIndex((q) => /DROP CONSTRAINT IF EXISTS opd_rtf_phase_chk/.test(q));
  const added = sent.findIndex((q) => /ADD CONSTRAINT opd_rtf_phase_chk/.test(q));
  assert.ok(created >= 0 && dropped > created && added > dropped, 'create, then drop, then add');
  assert.match(sent[added], /'retrieval_terminal_rejected'/);
});

test('§2.1 — a PRE-EXISTING table carrying the OLD constraints still ends with the widened form', async () => {
  // ⚠️ THE CASE THE DEFECT WAS ABOUT. The stub answers the CREATE as a no-op, exactly as Postgres
  // does when the table is already there, and the old constraints are treated as present. What
  // matters is that the ALTERs still run and still carry the new phase — so the end state does not
  // depend on whether the table existed.
  const db = installDbStub();
  db.on(/CREATE TABLE IF NOT EXISTS opd_retrieval_telemetry_failures/, []);   // no-op, table exists
  const { sql } = await import('../db');
  for (const stmt of retrievalTelemetryDdl()) await sql(stmt.sql, []);

  const alters = db.calls
    .map((c) => c.query.replace(/\s+/g, ' '))
    .filter((q) => /ALTER TABLE opd_retrieval_telemetry_failures/.test(q));
  assert.equal(alters.length, 4, 'two drops and two adds ran despite the create being a no-op');
  const adds = alters.filter((q) => /ADD CONSTRAINT/.test(q));
  assert.equal(adds.length, 2);
  for (const a of adds) {
    assert.match(a, /'retrieval_terminal_rejected'/, 'the widened form reached the existing table');
  }
});

test('§2.1 — migrations/0035 is in parity with the re-applied constraints', () => {
  // 0035 is DOCUMENTATION — nothing reads it at run time — and a parity test holds it to the DDL
  // function, so both had to move together.
  assert.match(SQL_FILE, /ALTER TABLE opd_retrieval_telemetry_failures DROP CONSTRAINT IF EXISTS opd_rtf_phase_chk;/);
  assert.match(SQL_FILE, /ALTER TABLE opd_retrieval_telemetry_failures ADD CONSTRAINT opd_rtf_phase_chk[\s\S]*'retrieval_terminal_rejected'/);
  assert.match(SQL_FILE, /ALTER TABLE opd_retrieval_telemetry_failures DROP CONSTRAINT IF EXISTS opd_rtf_run_chk;/);
  assert.match(SQL_FILE, /ALTER TABLE opd_retrieval_telemetry_failures ADD CONSTRAINT opd_rtf_run_chk[\s\S]*'retrieval_terminal_rejected'/);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §2.2 — the manifest version moved, and the validator now enforces the two fields
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('§2.2 — the version is 3, and a payload built today claims 3', () => {
  assert.equal(MANIFEST_SCHEMA_VERSION, 3);
  const payload = buildRetrievalPayload(createTelemetryCapture('primary'), { hmacKey: 'k', scorerContext: '' });
  assert.equal(payload.manifest_schema_version, 3);
});

test('§2.2 — a VERSION-2 manifest is unrecognized, which is the point of the bump', () => {
  // A version-2 manifest is one written before v7 §10, so it lacks the two decode fields. Under the
  // new validator it fails TWICE over: the version is unrecognized AND the fields are absent. The
  // validator recognises exactly ONE version, deliberately — there are no stored version-2 rows to
  // keep readable, because the three tables have never existed in production.
  const payload = buildRetrievalPayload(createTelemetryCapture('primary'), { hmacKey: 'k', scorerContext: '' });
  const cfg = { ...payload.retrieval_config } as Record<string, unknown>;
  delete cfg.rerank_temperature;
  delete cfg.rerank_seed_status;
  const v2 = { ...payload, manifest_schema_version: 2, retrieval_config: cfg, operational: operational() };

  const codes = validateManifest(v2);
  assert.ok(codes.includes('manifest_version_unrecognized'), 'the version itself is refused');
  assert.ok(codes.includes('rerank_temperature_field_absent'));
  assert.ok(codes.includes('rerank_seed_status_field_absent'));
});

test('§2.2 — ABSENT and explicit NULL stay distinguishable, which is why `has` is used', () => {
  const payload = buildRetrievalPayload(createTelemetryCapture('primary'), { hmacKey: 'k', scorerContext: '' });

  // Explicit null temperature: VALID. It means no rerank decode ran, which is a fact.
  const withNull = {
    ...payload,
    retrieval_config: { ...payload.retrieval_config, rerank_temperature: null },
    operational: operational(),
  };
  assert.deepEqual(validateManifest(withNull).filter((c) => /rerank_/.test(c)), []);

  // Absent temperature: a DEFECT. It means the writer forgot, or the manifest predates the field.
  const cfg = { ...payload.retrieval_config } as Record<string, unknown>;
  delete cfg.rerank_temperature;
  const absent = { ...payload, retrieval_config: cfg, operational: operational() };
  assert.deepEqual(validateManifest(absent).filter((c) => /rerank_/.test(c)), ['rerank_temperature_field_absent']);
});

test('§2.2 — both fields are TYPE-checked, not merely present', () => {
  const payload = buildRetrievalPayload(createTelemetryCapture('primary'), { hmacKey: 'k', scorerContext: '' });
  const bad = (over: Record<string, unknown>) => validateManifest({
    ...payload, retrieval_config: { ...payload.retrieval_config, ...over }, operational: operational(),
  }).filter((c) => /rerank_/.test(c));

  assert.deepEqual(bad({ rerank_temperature: 'zero' }), ['rerank_temperature_invalid'], 'a string is not a temperature');
  assert.deepEqual(bad({ rerank_temperature: Number.NaN }), ['rerank_temperature_invalid'], 'NaN is not finite');
  assert.deepEqual(bad({ rerank_temperature: Number.POSITIVE_INFINITY }), ['rerank_temperature_invalid']);
  assert.deepEqual(bad({ rerank_seed_status: 'seeded' }), ['rerank_seed_status_invalid'], 'not in the vocabulary');
  assert.deepEqual(bad({ rerank_seed_status: null }), ['rerank_seed_status_invalid'], 'a status is always knowable');
  // …and every legitimate status passes.
  for (const st of RERANK_SEED_STATUSES) assert.deepEqual(bad({ rerank_seed_status: st }), [], `${st} must be valid`);
});

test('§2.2 — the duplicated seed vocabulary cannot drift', () => {
  // ⚠️ TEMPORARY DUPLICATION, PINNED. The manifest contract's copy lives in
  // `retrieval-telemetry-core.ts`; the capture-side copy lives in `retrieval-capture.ts`. Core
  // cannot import from capture (capture imports FROM core — that direction is a cycle), and capture
  // is outside pass 0a's file contract, so the constant could not be moved in this pass. A value
  // added to one and not the other fails HERE rather than producing a manifest the validator
  // silently rejects. FLAGGED: a pass whose contract includes capture should collapse the two.
  assert.deepEqual([...RERANK_SEED_STATUSES], [...CAPTURE_STATUSES]);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §2.3 — neither arm may fabricate a proof of non-delivery (addendum v8 §2)
// ════════════════════════════════════════════════════════════════════════════════════════════════

async function softFailure(backend: 'judge' | 'cohere') {
  const { rerank } = await import('../rerank.ts');
  const capture = createTelemetryCapture('primary');
  const thrower = (async () => { throw new Error('generic, untyped'); }) as never;
  await rerank('q', [{ id: 1, text: 'a' }, { id: 2, text: 'b' }], backend, {
    checkHealthy: (async () => undefined) as never,
    cohereFn: thrower,
    judgeFn: thrower,
  }, capture);
  return capture;
}

test('§2.3 — the JUDGE arm no longer claims an unproven not_served', async () => {
  // ⚠️ THE DEFECT. `provenNotServed: true` asserts that non-delivery is PROVEN. On this branch it
  // is not: the record describes requests that were PLANNED, and the throw carries no transport
  // attribution. v7 §6 fixed Cohere; v8 §2 rules that the same rule governs the judge.
  const capture = await softFailure('judge');
  assert.ok(capture.batches.length > 0, 'boundaries were synthesised, so there is something to check');
  for (const b of capture.batches) {
    assert.equal(b.evidence?.provenNotServed, false, 'no proof exists, so none is claimed');
    assert.equal(servedClassOf(b.evidence), 'unattributed');
  }
});

test('§2.3 — the COHERE arm is unchanged from pass 0', async () => {
  const capture = await softFailure('cohere');
  assert.equal(capture.batches.length, 1);
  assert.equal(capture.batches[0].evidence?.provenNotServed, false);
  assert.equal(servedClassOf(capture.batches[0].evidence), 'unattributed');
});

test('§2.3 — THE REGRESSION GUARD: no synthesised boundary on EITHER arm may assert proof', async () => {
  // One assertion covering both arms, so re-introducing the fabricated proof on either one fails.
  for (const backend of ['judge', 'cohere'] as const) {
    const capture = await softFailure(backend);
    const fabricated = capture.batches.filter((b) => b.evidence?.provenNotServed === true);
    assert.deepEqual(
      fabricated, [],
      `${backend}: a synthesised boundary claimed provenNotServed without transport evidence`,
    );
  }
  // And the source carries no `provenNotServed: true` at all — the served path sets it from real
  // evidence, never as a literal.
  const src = readFileSync('lib/rerank.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.equal(/provenNotServed: true/.test(src), false, 'no literal proof-of-non-delivery in rerank.ts');
});

test('§2.3 — where transport proof EXISTS, the served class still stands', () => {
  // The ruling narrows only the UNPROVEN case. Real evidence is untouched on both arms.
  assert.equal(servedClassOf({ servedProvider: null, servedModel: null, attempts: null, provenNotServed: true }), 'not_served');
  assert.equal(servedClassOf({ servedProvider: 'vertex', servedModel: 'gemini-2.5-flash', attempts: null, provenNotServed: false }), 'vertex');
  assert.equal(servedClassOf({ servedProvider: 'ollama', servedModel: 'llama3.1:8b', attempts: null, provenNotServed: false }), 'local');
});
