// lib/__tests__/retrieval-telemetry-core.test.ts
// PRD v2.1 §4.2, §4.3, §4.6 and the on-path kickoff's D2, D9, D15, D16, D17.
//
// AUTHORIZED REWRITE. The committed version of this file hard-coded eight persistence states,
// `started` as the only non-terminal one, six migration indexes, the old manifest type name, a
// CHECK slice whose `));` delimiter did not exist in the file it read, and a whole-object equality
// on a six-field `batchCounters()` result. Every one of those moved in this build. What each
// assertion PROTECTED is preserved and, where the old shape let it pass weakly, strengthened —
// the vacuous-slice guards below exist because the old CHECK test would have passed on an empty
// slice and nobody would have known.
//
// Exhaustive per-field validation lives in retrieval-telemetry-validation.test.ts, transitions in
// retrieval-telemetry-transitions.test.ts, canonicalization in
// retrieval-telemetry-canonicalization.test.ts. This file owns the vocabulary, the HMAC, the
// counters, the cost aggregation and the privacy pin.
//
// SYNTHETIC ONLY. No DB, no network, no clinical text, no secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RETRIEVAL_PERSISTENCE_STATES, TERMINAL_PERSISTENCE_STATES, NON_TERMINAL_PERSISTENCE_STATES,
  OUTCOME_REQUIRED_STATES, OUTCOME_EITHER_STATES, isTerminalState,
  TELEMETRY_SCHEMA_VERSION, MANIFEST_SCHEMA_VERSION, HMAC_KEY_VERSION,
  RETRIEVAL_ROUTES, INVOCATION_ROUTES, RETRIEVAL_ROLES, routeClassOf,
  telemetryHmac, hmacEquals, validateManifest, batchCounters, aggregateRerankUsage,
  isPriceableClass,
  type StampedRetrievalManifest, type ManifestBatch,
} from '../retrieval-telemetry-core';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const MIGRATION = 'migrations/0035_opd_audit_retrieval_telemetry.sql';
const CORE = 'lib/retrieval-telemetry-core.ts';

export const batch = (i: number, over: Partial<ManifestBatch> = {}): ManifestBatch => ({
  batch_index: i, candidate_start: i * 5, candidate_end: i * 5 + 5,
  intended_provider: 'vertex', intended_model: 'gemini-2.5-flash',
  served_route_class: 'vertex', served_model: 'gemini-2.5-flash',
  attempts: [{ provider: 'vertex', attempt: 1, outcome: 'success', status: 200 }],
  outcome: 'success', expected_score_keys: 5, finite_score_keys: 5,
  missing_score_keys: 0, nonnumeric_score_keys: 0,
  prompt_tokens: 100, completion_tokens: 20, ...over,
});

export const manifest = (
  batches: ManifestBatch[],
  over: Partial<StampedRetrievalManifest> = {},
): StampedRetrievalManifest => ({
  manifest_schema_version: MANIFEST_SCHEMA_VERSION,
  hmac_key_version: HMAC_KEY_VERSION,
  telemetry_error: null,
  retrieval_outcome: 'success',
  retrieval_error_class: null,
  expansion: {
    status: 'expanded', input_hmac: 'k1:aa',
    served_route_class: 'vertex', served_model: 'gemini-2.5-flash',
    attempts: [{ provider: 'vertex', attempt: 1, outcome: 'success', status: 200 }],
  },
  fused_candidate_ids: [1, 2, 3],
  hydrated_candidate_ids: [1, 2, 3],
  fused_candidate_count: 3,
  hydrated_candidate_count: 3,
  pre_rerank_passage_hmacs: ['k1:a', 'k1:b', 'k1:c'],
  intended_backend: 'judge', intended_model: 'gemini-2.5-flash',
  served_backend: 'judge', rerank_backend_downgraded: false,
  expected_batch_count: batches.length, recorded_rerank_batches: batches.length,
  rerank_soft_failed: false,
  ordered_final_candidate_ids: [3, 1, 2],
  scorer_context_hmac: 'k1:ctx',
  // ⚠️ MANIFEST VERSION 3 REQUIRES THE TWO DECODE FIELDS (pass 0a, kickoff §2.2). This shared
  // fixture is hand-built rather than produced by `buildRetrievalPayload`, so it does not get them
  // for free — and the validator now says so, which is the whole point of the version bump.
  retrieval_config: { topK: 8, useReranker: true, rerank_temperature: 0, rerank_seed_status: 'unseeded' },
  corpus_version: 'corpus/1',
  index_version: 'embedding|nomic-embed-text',
  batches,
  operational: {
    route: 'opd_audit_worker', route_class: 'worker', retrieval_role: 'primary',
    invocation_id: 'inv-1', trace_id: null, deployment_sha: 'deadbeef',
    started_at: '2026-08-11T18:00:00Z', completed_at: '2026-08-11T18:00:09Z',
    routing_flags: {}, active_backfill_run_id: null, active_backfill_target: null,
    active_backfill_state: 'idle', active_lab_experiment_id: null,
  },
  ...over,
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §4.2 / D9 — the state vocabulary is ONE fact, and it is fourteen values
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Slice a named constraint's body out of the migration, bounded by a delimiter that EXISTS.
 *
 * ⚠️ RE-POINTED AGAIN (v9 §6.1). This bounded the slice at the next `;`, which was the right end
 * only while every ADD CONSTRAINT was a statement of its own. The three CHECKs on
 * `opd_audit_retrieval_telemetry` are now subcommands of ONE `ALTER TABLE`, so slicing the first of
 * them to the next `;` swallowed the two that follow — and the state-list test then compared the
 * state vocabulary against states PLUS roles PLUS the outcome CHECK's states and failed.
 *
 * ⚠️ This break is NOT in addendum v9 §8's pre-listed consequences. Reported as found, not
 * presented as expected.
 *
 * The bound is now the CHECK's own matching close parenthesis, which is correct under either shape
 * and does not depend on what follows the constraint.
 */
function constraintBody(sql: string, constraintName: string): string {
  const marker = `ADD CONSTRAINT ${constraintName} CHECK (`;
  const start = sql.indexOf(marker);
  assert.notEqual(start, -1, `${constraintName} must be present in the migration`);
  const open = start + marker.length;
  let depth = 1;
  let i = open;
  for (; i < sql.length && depth > 0; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') depth--;
  }
  assert.equal(depth, 0, `${constraintName} has an unbalanced CHECK — a slice to EOF is not a slice`);
  const body = sql.slice(open, i - 1);
  assert.ok(body.trim().length > 0, `${constraintName} sliced to nothing — this test may not pass vacuously`);
  // The slice must stop at its OWN constraint: a neighbour's name inside it means it over-ran.
  for (const sibling of ['opd_audit_retrieval_telemetry_role_chk', 'opd_audit_retrieval_telemetry_outcome_chk',
    'opd_audit_retrieval_telemetry_persistence_state_chk']) {
    if (sibling === constraintName) continue;
    assert.equal(body.includes(sibling), false, `${constraintName}'s slice ran into ${sibling}`);
  }
  return body;
}

test('the runtime states and the state CHECK are the same list, in the same order', () => {
  // RE-POINTED (D2). The old version sliced from the first `persistence_state IN (` to the next
  // `));` — a delimiter that did not exist in the file, so the slice ran to end-of-file and passed
  // only because nothing else in those bytes matched its regex. There are now THREE such blocks
  // (two in the outcome CHECK, one here), so it is anchored on the constraint NAME instead.
  const body = constraintBody(read(MIGRATION), 'opd_audit_retrieval_telemetry_persistence_state_chk');
  const inSql = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  // Checked BEFORE the deepEqual below: assert.deepEqual is a TS assertion function, so it narrows
  // `inSql` to the state union and a later `.includes('not_eligible')` stops compiling.
  assert.equal(inSql.includes('not_eligible'), false,
    'D9 removed it: every case that would have used it is really retrieval_not_run, ' +
    'no_persistence_intended or persistence_skipped, which say WHY');
  assert.equal(RETRIEVAL_PERSISTENCE_STATES.length, 14);
  assert.deepEqual(inSql, [...RETRIEVAL_PERSISTENCE_STATES],
    'a state the constraint rejects must not be writable from the runtime, and vice versa');
});

test('the outcome CHECK pins its two state lists the same way, and neither slice is empty', () => {
  const body = constraintBody(read(MIGRATION), 'opd_audit_retrieval_telemetry_outcome_chk');
  const blocks = [...body.matchAll(/persistence_state IN \(([^)]*)\)/g)].map((m) => m[1]);
  assert.equal(blocks.length, 2, 'the required set and the either set');
  for (const b of blocks) assert.ok(b.trim().length > 0, 'neither block may be empty');
  const [required, either] = blocks.map((b) => [...b.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  assert.deepEqual(required, [...OUTCOME_REQUIRED_STATES]);
  assert.deepEqual(either, [...OUTCOME_EITHER_STATES]);
  assert.ok(/persistence_state = 'started' AND retrieval_outcome IS NULL/.test(body),
    'the worker inserts `started` before retrieval starts, so an outcome cannot be required there');
});

test('the three outcome-CHECK sets PARTITION all fourteen states — no overlap, none omitted', () => {
  // By set arithmetic, never by a typed count: an earlier kickoff version hand-typed a count here
  // and got it wrong, then hand-typed thirteen state names two paragraphs after forbidding it.
  const started = new Set(['started']);
  const required = new Set<string>(OUTCOME_REQUIRED_STATES);
  const either = new Set<string>(OUTCOME_EITHER_STATES);
  const all = new Set<string>(RETRIEVAL_PERSISTENCE_STATES);

  for (const [a, b, label] of [[started, required, 'started/required'], [started, either, 'started/either'],
    [required, either, 'required/either']] as Array<[Set<string>, Set<string>, string]>) {
    for (const s of a) assert.equal(b.has(s), false, `${s} is in both halves of ${label}`);
  }
  const union = new Set([...started, ...required, ...either]);
  assert.equal(union.size, all.size, 'the three sets cover exactly the fourteen');
  for (const s of all) assert.ok(union.has(s), `${s} is in no set — the CHECK would reject every row carrying it`);
  // and the one placement that is easy to get backwards
  assert.ok(either.has('audit_generation_failed'),
    'a row settled from `started` never recorded an outcome, so requiring one makes the only honest settlement unreachable');
  assert.equal(required.has('audit_generation_failed'), false);
});

test('two states are non-terminal, and a window cannot close on either', () => {
  assert.deepEqual([...NON_TERMINAL_PERSISTENCE_STATES], ['started', 'retrieval_complete']);
  for (const s of NON_TERMINAL_PERSISTENCE_STATES) assert.equal(isTerminalState(s), false);
  for (const s of TERMINAL_PERSISTENCE_STATES) assert.equal(isTerminalState(s), true);
  assert.equal(TERMINAL_PERSISTENCE_STATES.length, RETRIEVAL_PERSISTENCE_STATES.length - 2);
  assert.equal(TERMINAL_PERSISTENCE_STATES.length, 12);
  assert.equal(isTerminalState('not_a_state'), false);
  assert.equal(isTerminalState('not_eligible'), false, 'the removed state is terminal for nothing');
});

test('the migration still declares its retention, access and deletion controls (§4.2)', () => {
  const sql = read(MIGRATION);
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS opd_audit_retrieval_telemetry'));
  // The FK target verified present at migrations/0007:12.
  assert.ok(sql.includes('REFERENCES opd_note_audits(id) ON DELETE SET NULL'),
    'losing the audit must not delete the evidence that a retrieval happened');
  for (const required of ['RETENTION', 'ACCESS', 'DELETION', 'NO CLINICAL TEXT']) {
    assert.ok(sql.includes(required), `§4.2 requires ${required} to be documented`);
  }
  assert.ok(/uid.*re-identification key/s.test(sql), 'uid is named as a re-identification key');
  // RE-POINTED: the index COUNT assertion moved to migrate-retrieval-telemetry-parity.test.ts,
  // which counts both sides. The guard it stood for — every index guarded — stays here.
  assert.equal(/CREATE INDEX (?!IF NOT EXISTS)/.test(sql), false, 'every index is guarded');
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
  assert.notEqual(telemetryHmac('secret-b', value), keyed);
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

test('a missing secret THROWS, and a whitespace-only key counts as missing (D8, test 71)', () => {
  assert.throws(() => telemetryHmac('', 'x'), /secret is required/);
  assert.throws(() => telemetryHmac(undefined as unknown as string, 'x'));
  // ⚠️ THE DISAGREEMENT THIS CLOSES. The guard tested `length === 0` while the build-time check
  // trimmed, so a key of three spaces was ABSENT to the deploy guard and USABLE here — production
  // would have been "unconfigured" and "configured" at the same time.
  assert.throws(() => telemetryHmac('   ', 'x'), /secret is required/);
  assert.throws(() => telemetryHmac('\t\n ', 'x'), /secret is required/);
  assert.ok(telemetryHmac(' s ', 'x'), 'a key with real content is still usable, trimmed or not');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// D15 / test 61 — the counters, and the bare `else` that merged three facts
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('every served class increments its OWN counter, and a null increments none', () => {
  // This test exists because the committed helper attributed classes with a chain ending in a bare
  // `else` that incremented `unattributed`. Once `not_served` and a null class exist, three
  // different facts would have been reported as one, which §2 forbids.
  const one = (cls: ManifestBatch['served_route_class']) =>
    batchCounters({ batches: [batch(0, { served_route_class: cls, served_model: null })] });

  assert.equal(one('vertex').vertex, 1);
  assert.equal(one('openrouter').openrouter, 1);
  assert.equal(one('local').local, 1);
  assert.equal(one('not_served').not_served, 1);
  assert.equal(one('unattributed').unattributed, 1);
  assert.equal(one('not_served').unattributed, 0, 'a proven non-delivery is NOT an attribution gap');
  assert.equal(one('unattributed').not_served, 0, 'and an attribution gap is not proof of non-delivery');

  const nulled = one(null);
  for (const k of ['vertex', 'openrouter', 'local', 'not_served', 'unattributed'] as const) {
    assert.equal(nulled[k], 0, `a null class must not increment ${k}`);
  }

  // one of each: five ones, no double count
  const all = batchCounters({
    batches: (['vertex', 'openrouter', 'local', 'not_served', 'unattributed'] as const)
      .map((cls, i) => batch(i, { served_route_class: cls, served_model: null })),
  });
  assert.equal(all.vertex + all.openrouter + all.local + all.not_served + all.unattributed, 5);
  assert.deepEqual(
    { v: all.vertex, o: all.openrouter, l: all.local, n: all.not_served, u: all.unattributed },
    { v: 1, o: 1, l: 1, n: 1, u: 1 },
  );
});

test('counters derive from the manifest, so row and payload cannot disagree', () => {
  // AUTHORIZED: the seventh field. The old assertion deep-equalled a six-field object; the shape
  // gains `not_served` and the equality is otherwise unchanged.
  const m = manifest([
    batch(0),
    batch(1, {
      served_route_class: 'local', served_model: 'llama3.1:8b', outcome: 'success',
      attempts: [
        { provider: 'vertex', attempt: 1, outcome: 'http_429', status: 429 },
        { provider: 'vertex', attempt: 2, outcome: 'http_429', status: 429 },
        { provider: 'openrouter', attempt: 1, outcome: 'http_429', status: 429 },
      ],
    }),
    batch(2, { served_route_class: 'unattributed', served_model: null, outcome: 'terminal_failure' }),
  ]);
  assert.deepEqual(batchCounters(m), {
    vertex: 1, openrouter: 0, local: 1, not_served: 0, failed: 1, unattributed: 1, retries_429: 3,
  });
});

test('rerank_429_attempts is the count of http_429 attempts, wherever they happened (test 13)', () => {
  const m = manifest([
    batch(0, { attempts: [{ provider: 'vertex', attempt: 1, outcome: 'http_429', status: 429 }] }),
    batch(1, { attempts: [
      { provider: 'vertex', attempt: 1, outcome: 'timeout', status: null },
      { provider: 'openrouter', attempt: 1, outcome: 'http_429', status: 429 },
      { provider: 'ollama', attempt: 1, outcome: 'success', status: 200 },
    ] }),
    batch(2, { attempts: null }),
  ]);
  assert.equal(batchCounters(m).retries_429, 2, 'the number this workstream exists to produce');
  assert.equal(batchCounters({ batches: [] }).retries_429, 0);
});

test('batch order is a property of candidate boundaries, never of completion order (constraint 7)', () => {
  const inCompletionOrder = manifest([batch(2), batch(0), batch(1)]);
  assert.deepEqual(validateManifest(inCompletionOrder), [], 'arrival order does not invalidate');
  assert.equal(batchCounters(inCompletionOrder).vertex, 3, 'and the counters are order-independent');
  assert.ok(validateManifest(manifest([batch(0), batch(1, { candidate_start: 2 })])).includes('overlapping_batches'));
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §6.4 — PRIVACY. Rewritten so it cannot pass on an empty slice.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Slice a declaration's body by name. Asserts non-empty, because an `indexOf` that returns −1
 *  turns a ban loop into a loop over nothing — which is how a renamed type silently disarms it. */
function declarationBody(src: string, decl: string): string {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist — this pin may not pass because the name moved`);
  const rest = src.slice(start + decl.length);
  const end = rest.indexOf('\n}');
  assert.notEqual(end, -1, `${decl} must be a braced declaration`);
  const body = rest.slice(0, end);
  assert.ok(body.trim().length > 0, `${decl} sliced to nothing`);
  return body;
}

test('neither field-bearing manifest declaration has a field that could carry clinical text', () => {
  const src = read(CORE);
  const BANNED = ['query', 'passage_text', 'prompt', 'content', 'scenario', 'note_text', 'messages', 'raw'];
  for (const decl of ['export interface RetrievalPayload {', 'export interface OperationalTelemetry {']) {
    const body = declarationBody(src, decl);
    assert.ok(body.length > 200, `${decl} is suspiciously short — did the slice find the real body?`);
    for (const banned of BANNED) {
      assert.equal(new RegExp(`^\\s*${banned}\\??:`, 'm').test(body), false,
        `${banned} must not be a field of ${decl}`);
    }
  }
  const serialized = JSON.stringify(manifest([batch(0)]));
  assert.equal(/[A-Za-z]{30,}/.test(serialized), false, 'nothing free-text-shaped survives serialization');
});

test('the ban loop really bans — it fails when a banned field is added', () => {
  // Proves the assertion above is load-bearing rather than a loop over a slice that never matches.
  const synthetic = 'export interface RetrievalPayload {\n  id: number;\n  query: string;\n}\n';
  const body = declarationBody(synthetic, 'export interface RetrievalPayload {');
  assert.equal(/^\s*query\??:/m.test(body), true, 'a banned field IS detectable by this matcher');
});

test('TelemetryCapture is not declared in the core — the raw bytes live elsewhere (D5)', () => {
  const src = read(CORE);
  assert.equal(src.includes('TelemetryCapture'), false,
    'the capture holds RAW passage bytes on their way to being HMAC-ed; the header of this file '
    + 'promises no clinical text reaches a field defined in it, and that is only true if it stays out');
  assert.ok(read('lib/retrieval-capture.ts').includes('TelemetryCapture'), 'it lives in the capture module');
});

test('StampedRetrievalManifest is EXACTLY the intersection, so nothing can be smuggled through it', () => {
  // It is a one-line alias with no field list, so a third ban loop over its source would pass
  // vacuously forever. Assert the SHAPE instead: its keys are exactly the payload's plus
  // `operational`, which means a new field can only enter through a declaration the pin scans.
  const m = manifest([batch(0)]);
  const keys = new Set(Object.keys(m));
  assert.ok(keys.has('operational'));
  keys.delete('operational');
  const payloadOnly = { ...m } as Record<string, unknown>;
  delete payloadOnly.operational;
  // every remaining key is declared in RetrievalPayload's body
  const body = declarationBody(read(CORE), 'export interface RetrievalPayload {');
  for (const k of keys) {
    assert.ok(new RegExp(`^\\s*${k}\\??:`, 'm').test(body), `${k} must be declared in RetrievalPayload, not grafted on`);
  }
  const opBody = declarationBody(read(CORE), 'export interface OperationalTelemetry {');
  for (const k of Object.keys(m.operational)) {
    assert.ok(new RegExp(`^\\s*${k}\\??:`, 'm').test(opBody), `${k} must be declared in OperationalTelemetry`);
  }
  // and the alias really is an intersection of exactly those two
  assert.ok(/export type StampedRetrievalManifest = RetrievalPayload & \{ operational: OperationalTelemetry \};/
    .test(read(CORE)));
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §5 step 1 — route taxonomy and roles
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('every route maps to a class, and an unknown caller is never assigned to the nearest match', () => {
  for (const r of RETRIEVAL_ROUTES) assert.notEqual(routeClassOf(r), undefined);
  assert.equal(routeClassOf('opd_audit_worker'), 'worker');
  assert.equal(routeClassOf('opd_audit_mini_backfill'), 'backfill');
  assert.equal(routeClassOf('lab_batch'), 'lab');
  assert.equal(routeClassOf('a_route_that_does_not_exist'), 'unknown', 'guessing is forbidden (§4.4)');
  assert.ok(RETRIEVAL_ROUTES.includes('unknown_route'));
});

test('the reconciler is an INVOCATION route and never a retrieval route (D17)', () => {
  assert.equal((RETRIEVAL_ROUTES as readonly string[]).includes('reconciler'), false,
    'a reconciler row on a retrieval table would be a retrieval that never happened');
  assert.ok((INVOCATION_ROUTES as readonly string[]).includes('reconciler'));
  assert.equal(INVOCATION_ROUTES.length, RETRIEVAL_ROUTES.length + 1);
  assert.equal(routeClassOf('reconciler'), 'reconciler');
});

test('the five roles are closed, and the appropriateness exclusion is by ROUTE not by role', () => {
  assert.deepEqual([...RETRIEVAL_ROLES],
    ['primary', 'normative_channel', 'lvc_recall', 'lab_direct', 'lab_multi_query']);
  // A3: lvc_recall rows from the appropriateness surface carry `unknown_route` and are excluded by
  // NAME at the gate. The role itself stays a normal, recognised role — excluding the role would
  // also exclude the A/A route's rows, which do have a taxonomy member.
  assert.ok(RETRIEVAL_ROUTES.includes('lvc_judge_aa'));
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
  assert.equal(buckets.find((b) => b.provider === 'vertex')!.prompt_tokens, 100);
});

test('a bucket with no usage reports null tokens and counts the unknowns — never zero (§4.6)', () => {
  const [b] = aggregateRerankUsage([manifest([batch(0, { prompt_tokens: null, completion_tokens: null })])]);
  assert.equal(b.prompt_tokens, null, 'zero would price as ₹0 and read as "this cost nothing"');
  assert.equal(b.completion_tokens, null);
  assert.equal(b.batches_with_unknown_usage, 1);
  assert.equal(b.batches, 1);
});

test('partial usage is summed without inventing the missing half', () => {
  const [b] = aggregateRerankUsage([manifest([
    batch(0, { prompt_tokens: 100, completion_tokens: null }),
    batch(1, { prompt_tokens: 50, completion_tokens: 7 }),
  ])]);
  assert.equal(b.prompt_tokens, 150);
  assert.equal(b.completion_tokens, 7, 'only the batch that reported one contributes');
  assert.equal(b.batches_with_unknown_usage, 0, 'a batch reporting either half is not "unknown"');
});

test('local, not-served and skipped stages are UNPRICED; unattributed and parse failures are not', () => {
  // §4.6, exactly. A malformed served completion still consumed tokens, so it is priced from its
  // preserved usage. A `not_served` batch bought nothing and must never appear as spend.
  assert.equal(isPriceableClass('vertex'), true);
  assert.equal(isPriceableClass('openrouter'), true);
  assert.equal(isPriceableClass('unattributed'), true, 'a completion may have arrived and been billed');
  assert.equal(isPriceableClass('local'), false);
  assert.equal(isPriceableClass('not_served'), false, 'proven non-delivery cannot have cost money');
  assert.equal(isPriceableClass(null), false);

  const buckets = aggregateRerankUsage([manifest([
    batch(0, { served_route_class: 'not_served', served_model: null, outcome: 'terminal_failure', prompt_tokens: null, completion_tokens: null }),
    batch(1, { served_route_class: 'unattributed', served_model: null, outcome: 'parse_failure', prompt_tokens: 80, completion_tokens: 5 }),
  ])]);
  assert.equal(buckets.find((b) => b.provider === 'not_served')!.priceable, false);
  const unattributed = buckets.find((b) => b.provider === 'unattributed')!;
  assert.equal(unattributed.priceable, true);
  assert.equal(unattributed.prompt_tokens, 80, 'a parse failure keeps the usage it really spent');
});

test('this module prices nothing — money has ONE source of truth', () => {
  const src = read(CORE);
  for (const banned of ['fxUsdInr', 'costInr', 'llm-pricing', 'perCallInr']) {
    assert.equal(src.includes(banned), false, `${banned} belongs to lib/llm-cost-core.ts, not here`);
  }
  assert.equal(aggregateRerankUsage([]).length, 0);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Versioning
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('the row contract and the manifest contract version independently (§4.3)', () => {
  assert.equal(TELEMETRY_SCHEMA_VERSION, 2, 'the on-path build changes columns');
  // ⚠️ 2 → 3 (pass 0a). v7 §10 added `rerank_temperature` and `rerank_seed_status` to
  // `retrieval_config` and the version did not move, so two different manifest shapes both claimed
  // version 2. PRD §7 gates the canary on recognised manifest versions, and a version that does not
  // discriminate cannot gate.
  assert.equal(MANIFEST_SCHEMA_VERSION, 3, 'and manifest fields — bumped for the v7 §10 decode fields');
  assert.equal(HMAC_KEY_VERSION, 'k1', 'the key did not rotate');
  assert.ok(read(MIGRATION).includes('telemetry_schema_version INTEGER NOT NULL'));
});
