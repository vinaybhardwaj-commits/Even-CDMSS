// lib/__tests__/retrieval-telemetry-core.test.ts
// CDMSS-RERANK-TELEMETRY-CC-KICKOFF-11-AUG-2026 §4.2, §4.3, §4.6 and the §6 families that apply to
// Stage 0a's off-path work. §6.1 (ranking invariance) and §6.3 (lifecycle/concurrency) are NOT here:
// both require the retrieve/rerank instrumentation and the lifecycle writes, which V ruled out of
// this session. They are named as owed in the build report rather than faked with a stub.
//
// SYNTHETIC ONLY. No DB, no network, no clinical text, no secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RETRIEVAL_PERSISTENCE_STATES, TERMINAL_PERSISTENCE_STATES, isTerminalState,
  TELEMETRY_SCHEMA_VERSION, MANIFEST_SCHEMA_VERSION, HMAC_KEY_VERSION,
  RETRIEVAL_ROUTES, routeClassOf, telemetryHmac, hmacEquals,
  validateManifest, batchCounters, aggregateRerankUsage,
  type RetrievalManifest, type ManifestBatch,
} from '../retrieval-telemetry-core';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const MIGRATION = 'migrations/0035_opd_audit_retrieval_telemetry.sql';

const batch = (i: number, over: Partial<ManifestBatch> = {}): ManifestBatch => ({
  batch_index: i, candidate_start: i * 5, candidate_end: i * 5 + 5,
  intended_provider: 'vertex', intended_model: 'gemini-2.5-flash',
  served_route_class: 'vertex', served_model: 'gemini-2.5-flash',
  attempts: [{ attempt: 1, outcome: 'success', status: 200 }],
  outcome: 'success', expected_score_keys: 5, finite_score_keys: 5,
  prompt_tokens: 100, completion_tokens: 20, ...over,
});

const manifest = (batches: ManifestBatch[]): RetrievalManifest => ({
  manifest_schema_version: MANIFEST_SCHEMA_VERSION, hmac_key_version: HMAC_KEY_VERSION,
  expansion: { status: 'expanded', input_hmac: 'k1:aa' },
  pre_rerank_candidate_ids: [1, 2, 3], pre_rerank_passage_hmacs: ['k1:a', 'k1:b', 'k1:c'],
  candidate_pool_size: 32, expected_batch_count: batches.length,
  intended_backend: 'judge', intended_model: 'gemini-2.5-flash',
  ordered_final_candidate_ids: [3, 1, 2], scorer_context_hmac: 'k1:ctx',
  retrieval_config: { topK: 8, useReranker: true }, corpus_version: 'corpus/1',
  batches,
  operational: {
    route: 'opd_audit_worker', route_class: 'worker', invocation_id: 'inv-1',
    deployment_sha: 'deadbeef', started_at: '2026-08-11T18:00:00Z', completed_at: null,
    active_backfill_run_id: null, active_lab_experiment_id: null, routing_flags: {},
  },
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §4.2 — the state vocabulary is ONE fact
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('the runtime states and the CHECK constraint are the same list, in the same order', () => {
  const sql = read(MIGRATION);
  const block = sql.slice(sql.indexOf('persistence_state IN ('), sql.indexOf('));', sql.indexOf('persistence_state IN (')));
  const inSql = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(inSql, [...RETRIEVAL_PERSISTENCE_STATES],
    'a state the constraint rejects must not be writable from the runtime, and vice versa');
  assert.equal(RETRIEVAL_PERSISTENCE_STATES.length, 8);
});

test('`started` is the only non-terminal state — a window cannot close on one', () => {
  assert.equal(isTerminalState('started'), false);
  for (const s of TERMINAL_PERSISTENCE_STATES) assert.equal(isTerminalState(s), true);
  assert.equal(TERMINAL_PERSISTENCE_STATES.length, RETRIEVAL_PERSISTENCE_STATES.length - 1);
  assert.equal(isTerminalState('not_a_state'), false);
});

test('the migration is idempotent and declares its retention and access controls (§4.2)', () => {
  const sql = read(MIGRATION);
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS opd_audit_retrieval_telemetry'));
  assert.equal((sql.match(/CREATE INDEX IF NOT EXISTS/g) || []).length, 6, 'every index is guarded');
  assert.equal(/CREATE INDEX (?!IF NOT EXISTS)/.test(sql), false);
  // the FK target verified present at migrations/0007:12
  assert.ok(sql.includes('REFERENCES opd_note_audits(id) ON DELETE SET NULL'),
    'losing the audit must not delete the evidence that a retrieval happened');
  for (const required of ['RETENTION', 'ACCESS', 'DELETION', 'NO CLINICAL TEXT']) {
    assert.ok(sql.includes(required), `§4.2 requires ${required} to be documented`);
  }
  assert.ok(/uid.*re-identification key/s.test(sql), 'uid is named as a re-identification key');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §4.3 — keyed HMAC. A plain hash of patient-derived text is not acceptable.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('the HMAC is keyed, versioned, and unreproducible with an unkeyed hash', async () => {
  const { createHash } = await import('node:crypto');
  const value = 'synthetic candidate passage';
  const keyed = telemetryHmac('secret-a', value);
  assert.match(keyed, /^k1:[0-9a-f]{64}$/);
  assert.notEqual(keyed.split(':')[1], createHash('sha256').update(value).digest('hex'),
    'an unkeyed sha256 fixture must not reproduce it — that is the whole protection');
  // a different key gives a different digest for identical input
  assert.notEqual(telemetryHmac('secret-b', value), keyed);
  // stable for the same key + input
  assert.equal(telemetryHmac('secret-a', value), keyed);
});

test('key version travels with the value, so a rotation is visible rather than inferred', () => {
  const a = telemetryHmac('s', 'x', 'k1');
  const b = telemetryHmac('s', 'x', 'k2');
  assert.ok(a.startsWith('k1:') && b.startsWith('k2:'));
  assert.notEqual(a, b, 'same digest bytes, different label — comparison must not silently succeed');
  assert.equal(hmacEquals(a, b), false);
  assert.equal(hmacEquals(a, telemetryHmac('s', 'x', 'k1')), true);
  assert.equal(hmacEquals(a, 'k1:'), false);
});

test('a missing secret THROWS rather than degrading to something weaker', () => {
  assert.throws(() => telemetryHmac('', 'x'), /secret is required/);
  assert.throws(() => telemetryHmac(undefined as unknown as string, 'x'));
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §4.3 / §6.4 — manifest structure and privacy
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('a well-formed manifest validates; each defect is its own code', () => {
  assert.deepEqual(validateManifest(manifest([batch(0), batch(1)])), []);
  assert.ok(validateManifest({ ...manifest([batch(0)]), manifest_schema_version: 99 }).includes('manifest_version_unrecognized'));
  assert.ok(validateManifest({ ...manifest([batch(0), batch(1)]), expected_batch_count: 7 }).includes('batch_count_mismatch'));
  assert.ok(validateManifest(manifest([batch(0), batch(0)])).includes('duplicate_batch_index'));
  assert.ok(validateManifest(manifest([batch(0, { candidate_end: 0 })])).includes('bad_candidate_boundaries'));
  assert.ok(validateManifest(manifest([batch(0, { finite_score_keys: 9 })])).includes('score_keys_exceed_expected'));
});

test('an unattributed batch may not also name a model (§4.4 forbids guessing)', () => {
  const bad = manifest([batch(0, { served_route_class: 'unattributed', served_model: 'gemini-2.5-flash' })]);
  assert.ok(validateManifest(bad).includes('unattributed_with_model'));
  const good = manifest([batch(0, { served_route_class: 'unattributed', served_model: null })]);
  assert.deepEqual(validateManifest(good), []);
});

test('batch order is a property of candidate boundaries, never of completion order (constraint 7)', () => {
  const inCompletionOrder = manifest([batch(2), batch(0), batch(1)]);
  assert.deepEqual(validateManifest(inCompletionOrder), [], 'arrival order does not invalidate');
  const counters = batchCounters(inCompletionOrder);
  assert.equal(counters.vertex, 3, 'and the counters are order-independent');
  // overlapping boundaries ARE a defect, whatever the arrival order
  assert.ok(validateManifest(manifest([batch(0), batch(1, { candidate_start: 2 })])).includes('overlapping_batches'));
});

test('counters derive from the manifest, so row and payload cannot disagree', () => {
  const m = manifest([
    batch(0),
    batch(1, { served_route_class: 'local', served_model: 'llama3.1:8b', outcome: 'success',
      attempts: [{ attempt: 1, outcome: 'http_429', status: 429 }, { attempt: 2, outcome: 'http_429', status: 429 },
        { attempt: 3, outcome: 'http_429', status: 429 }] }),
    batch(2, { served_route_class: 'unattributed', served_model: null, outcome: 'terminal_failure' }),
  ]);
  const c = batchCounters(m);
  assert.deepEqual(c, { vertex: 1, openrouter: 0, local: 1, failed: 1, unattributed: 1, retries_429: 3 });
});

test('the manifest type has no field that could carry clinical text (§6.4)', () => {
  const src = read('lib/retrieval-telemetry-core.ts');
  const iface = src.slice(src.indexOf('export interface RetrievalManifest'), src.indexOf('/** Structural validation'));
  for (const banned of ['query', 'passage_text', 'prompt', 'content', 'scenario', 'note_text']) {
    assert.equal(new RegExp(`^\\s*${banned}\\??:`, 'm').test(iface), false, `${banned} must not be a manifest field`);
  }
  const serialized = JSON.stringify(manifest([batch(0)]));
  assert.equal(/[A-Za-z]{30,}/.test(serialized), false, 'nothing free-text-shaped survives serialization');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §5 step 1 — route taxonomy
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('every route maps to a class, and an unknown caller is never assigned to the nearest match', () => {
  for (const r of RETRIEVAL_ROUTES) assert.notEqual(routeClassOf(r), undefined);
  assert.equal(routeClassOf('opd_audit_worker'), 'worker');
  assert.equal(routeClassOf('opd_audit_mini_backfill'), 'backfill');
  assert.equal(routeClassOf('lab_batch'), 'lab');
  assert.equal(routeClassOf('a_route_that_does_not_exist'), 'unknown', 'guessing is forbidden (§4.4)');
  assert.ok(RETRIEVAL_ROUTES.includes('unknown_route'));
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §4.6 — cost. Missing usage never becomes zero cost.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('usage aggregates by served provider/model, not by intended', () => {
  const m = manifest([
    batch(0),
    batch(1, { served_route_class: 'local', served_model: 'llama3.1:8b', prompt_tokens: null, completion_tokens: null }),
  ]);
  const buckets = aggregateRerankUsage([m]);
  assert.equal(buckets.length, 2);
  const local = buckets.find((b) => b.provider === 'local')!;
  assert.equal(local.model, 'llama3.1:8b', 'the SUBSTITUTED model is billed, not the requested one');
  const vertex = buckets.find((b) => b.provider === 'vertex')!;
  assert.equal(vertex.prompt_tokens, 100);
});

test('a bucket with no usage reports null tokens and counts the unknowns — never zero (§4.6)', () => {
  const m = manifest([batch(0, { prompt_tokens: null, completion_tokens: null })]);
  const [b] = aggregateRerankUsage([m]);
  assert.equal(b.prompt_tokens, null, 'zero would price as ₹0 and read as "this cost nothing"');
  assert.equal(b.completion_tokens, null);
  assert.equal(b.batches_with_unknown_usage, 1);
  assert.equal(b.batches, 1);
});

test('partial usage is summed without inventing the missing half', () => {
  const m = manifest([
    batch(0, { prompt_tokens: 100, completion_tokens: null }),
    batch(1, { prompt_tokens: 50, completion_tokens: 7 }),
  ]);
  const [b] = aggregateRerankUsage([m]);
  assert.equal(b.prompt_tokens, 150);
  assert.equal(b.completion_tokens, 7, 'only the batch that reported one contributes');
  assert.equal(b.batches_with_unknown_usage, 0, 'a batch reporting either half is not "unknown"');
});

test('this module prices nothing — money has ONE source of truth', () => {
  const src = read('lib/retrieval-telemetry-core.ts');
  for (const banned of ['fxUsdInr', 'costInr', 'llm-pricing', 'perCallInr']) {
    assert.equal(src.includes(banned), false, `${banned} belongs to lib/llm-cost-core.ts, not here`);
  }
  assert.equal(aggregateRerankUsage([]).length, 0);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Versioning
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('the row contract and the manifest contract version independently (§4.3)', () => {
  assert.equal(TELEMETRY_SCHEMA_VERSION, 1);
  assert.equal(MANIFEST_SCHEMA_VERSION, 1);
  assert.equal(HMAC_KEY_VERSION, 'k1');
  // the column exists to carry the row contract version
  assert.ok(read(MIGRATION).includes('telemetry_schema_version     INTEGER NOT NULL'));
});
