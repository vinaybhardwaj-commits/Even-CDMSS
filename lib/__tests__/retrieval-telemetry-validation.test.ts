/**
 * lib/__tests__/retrieval-telemetry-validation.test.ts — exhaustive per-field validation (D17), and
 * the four D17 edge cases. Proofs 45, 46, 47 and 49.
 *
 * GOVERNED BY addendum v23 (authorized by the orchestrator on V's explicit delegation, 18 August
 * 2026, under Saul review 34), §4 (the proof texts, verbatim from kickoff v11 §6, the numbering
 * authority) and §6 (this file, named by `retrieval-telemetry-core.test.ts`'s header since 11 August
 * and never created until now). Addendum v15 §3 sets the conventions.
 *
 *   45  Every required field in D17, one absent-or-invalid test each, with own-property checks
 *       distinguishing missing, null, empty array, empty string and invalid number.
 *   46  `expansion.served_route_class` null with status `skipped` is valid, so a `normative_channel`
 *       row is not partial.
 *   47  The scorer-context HMAC by role: required on `primary`, null on the other four, and those
 *       nulls not partial. Computed over the exact `citedContext`, including the empty-string case.
 *   49  All four edge cases in D17, including the two zero-candidate shapes producing different
 *       `fused_candidate_count` and `hydrated_candidate_count`.
 *
 * WHAT THIS FILE DOES NOT CLAIM. It does not run a retrieval: the four edge cases are the payload
 * builder's synthesised shapes (D17: "all synthesised by the payload builder"), driven through the
 * real `createTelemetryCapture` and `buildRetrievalPayload` and stamped with a literal operational
 * block — not through `retrieve()`. It does not claim `validateManifest`'s codes are the persisted
 * state; the row state is settlement's (D9/D12), and this file reads only the code list. It does not
 * touch a database, a socket or a secret: the HMAC key here is a literal test string.
 *
 * ⚠️ FIXTURES ARE LITERALS. Nothing here is derived from the constant it tests. The one imported
 * constant, `MANIFEST_SCHEMA_VERSION`, is used only to build a manifest the validator accepts as
 * current; the test that pins its VALUE lives in `retrieval-telemetry-core.test.ts`.
 *
 * ⚠️ REPAIRED IN THE PASS 3 REPAIR (Saul review 36; addendum v25 §3.2, §3.3). Proof 45 gained the two
 * per-batch usage fields, `prompt_tokens` and `completion_tokens`, which the validator did not check at
 * all until v25 — a production defect that shipped in commit 13. Proof 47 gained the non-primary
 * rejection (a non-null HMAC on any of the four non-primary roles is now a defect), the real
 * `assembleAuditContext` output as the keyed context, and a comment-stripped source pin of the
 * production caller's handoff in `lib/opd-note-audit.ts` (`writeRetrievalTerminals` is module-private
 * and nothing in this repository can drive it in-process; the pin proves the wiring is written, not
 * that it executes — stated here rather than papered over).
 *
 * ⚠️ REPAIRED AGAIN IN THE SECOND PASS 3 REPAIR (Saul review 37; addendum v26 §3.1–§3.6). The validator
 * now DERIVES its field checks from `D17_FIELD_MATRIX`, and this file ENUMERATES that matrix: for every
 * entry it generates an absent case, a null case and a wrong-type case (45.200 onwards), prints the
 * matrix length as the ONLY coverage number this file states, checks D17's transcribed field list
 * against the matrix, and proves `validateManifest` never throws on malformed input — `batches: [null]`
 * included (v26 §3.2). `candidate_start` has its own rows (v26 §3.3); the HMAC-absent licence's
 * accompanying fields must be present and typed (v26 §3.4); the variant-generation usage pair is
 * validated (v26 §3.5); and proof 47 now EXECUTES the production terminal-payload path through
 * `retrievalTerminalsSeam` in `lib/opd-note-audit.ts` with real `assembleAuditContext` output (v26
 * §3.6, tests 47.7/47.8) — the source pin 47.6 remains as supporting evidence only.
 *
 * ⚠️ D17 SAYS `retrieval_config` "{} permitted"; addendum v7 §10 (manifest version 3) then made
 * `rerank_temperature` and `rerank_seed_status` REQUIRED inside it, so `{}` now carries those two
 * field-absent codes. 45 pins today's contract and names the amendment beside it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateManifest, telemetryHmac, batchCounters, MANIFEST_SCHEMA_VERSION, D17_FIELD_MATRIX,
  type StampedRetrievalManifest, type OperationalTelemetry, type RetrievalRole, type ManifestBatch,
  type D17FieldRule,
} from '../retrieval-telemetry-core';
import { createTelemetryCapture, buildRetrievalPayload } from '../retrieval-capture';
import { readFileSync } from 'node:fs';
import { assembleAuditContext, retrievalTerminalsSeam, type AuditOpdOpts } from '../opd-note-audit.ts';
import type { CiteHit } from '../citations-core.ts';
import { installDbStub, run as lifecycleRun } from './telemetry-db-stub';
import type { LifecycleHandle, ManifestDefectsByRole } from '../retrieval-telemetry-store';

// ── A stamped manifest the validator accepts, hand-built from literals ─────────────────────────
type Obj = Record<string, unknown>;
/** Type GUARDS, not casts: the mutation helpers narrow `unknown` by checking, and fail loudly
 *  when a fixture is not the shape the row expects. */
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isObjArray = (v: unknown): v is Obj[] => Array.isArray(v) && v.every(isObj);

const operational = (role: RetrievalRole = 'primary'): OperationalTelemetry => ({
  route: 'opd_audit_worker', route_class: 'worker', retrieval_role: role,
  invocation_id: 'inv-45', trace_id: null, deployment_sha: null,
  started_at: '2026-08-18T00:00:00.000Z', completed_at: '2026-08-18T00:00:02.000Z',
  routing_flags: {}, active_backfill_run_id: null, active_backfill_target: null,
  active_backfill_state: null, active_lab_experiment_id: null,
});

/** One rerank batch, valid. */
const validBatch = (): ManifestBatch => ({
  batch_index: 0, candidate_start: 0, candidate_end: 3,
  intended_provider: 'vertex', intended_model: 'gemini-2.5-flash',
  served_route_class: 'vertex', served_model: 'gemini-2.5-flash',
  attempts: [{ provider: 'vertex', attempt: 1, outcome: 'success', status: 200 }],
  outcome: 'success', expected_score_keys: 3, finite_score_keys: 3,
  missing_score_keys: 0, nonnumeric_score_keys: 0, prompt_tokens: 90, completion_tokens: 12,
});

/** A complete, valid, keyed primary manifest with one batch. Deep-copied per test via JSON so a
 *  mutation in one test cannot leak into the next. */
function validManifest(role: RetrievalRole = 'primary'): StampedRetrievalManifest {
  const m: StampedRetrievalManifest = {
    manifest_schema_version: MANIFEST_SCHEMA_VERSION,
    hmac_key_version: 'k1',
    telemetry_error: null,
    retrieval_outcome: 'success',
    retrieval_error_class: null,
    expansion: {
      status: 'expanded', input_hmac: 'k1:0011', served_route_class: 'vertex', served_model: 'gemini-2.5-flash',
      attempts: [{ provider: 'vertex', attempt: 1, outcome: 'success', status: 200 }],
    },
    fused_candidate_ids: [11, 12, 13],
    hydrated_candidate_ids: [11, 12, 13],
    fused_candidate_count: 3,
    hydrated_candidate_count: 3,
    pre_rerank_passage_hmacs: ['k1:aa', 'k1:bb', 'k1:cc'],
    intended_backend: 'judge', intended_model: 'gemini-2.5-flash',
    served_backend: 'judge', rerank_backend_downgraded: false,
    expected_batch_count: 1, recorded_rerank_batches: 1, rerank_soft_failed: false,
    ordered_final_candidate_ids: [12, 11, 13],
    scorer_context_hmac: role === 'primary' ? 'k1:ctx' : null,
    retrieval_config: { topK: 8, rerank_temperature: 0, rerank_seed_status: 'unseeded' },
    corpus_version: null,
    index_version: 'embedding|nomic-embed-text',
    batches: [validBatch()],
    operational: operational(role),
  };
  return JSON.parse(JSON.stringify(m));
}
/** The same manifest as a plain object, for mutation by key — parsed as `unknown` and narrowed by
 *  the guard, so no cast is involved. */
function asObj(m: StampedRetrievalManifest): Obj {
  const parsed: unknown = JSON.parse(JSON.stringify(m));
  assert.ok(isObj(parsed), 'the fixture serializes to an object');
  return parsed;
}
const codes = (m: unknown): string[] => validateManifest(m);
/** The nested object at `k`, checked. */
function nested(o: Obj, k: string): Obj {
  const v = o[k];
  assert.ok(isObj(v), `${k} is an object in the fixture`);
  return v;
}
/** The first batch record, checked. */
function batch0(m: Obj): Obj {
  const b = m.batches;
  assert.ok(isObjArray(b) && b.length > 0, 'the fixture has a batch record');
  return b[0];
}

test('45.0 — the fixture is CLEAN: the valid manifest returns no code, so every code below is caused by the one mutation named beside it', () => {
  assert.deepEqual(codes(validManifest()), []);
  assert.deepEqual(codes(validManifest('lvc_recall')), []);
});

// ── 45. One absent-or-invalid test per required field ──────────────────────────────────────────
// Each row: a label, a mutation on the plain object, and the code that mutation must produce.
// `del` removes the OWN property (missing); other rows set null / '' / [] / a bad number.
type Row = { field: string; how: string; mutate: (m: Obj) => void; code: string };
const del = (o: Obj, k: string) => { delete o[k]; };
const ROWS: Row[] = [
  { field: 'manifest_schema_version', how: 'null', mutate: (m) => { m.manifest_schema_version = null; }, code: 'manifest_version_unrecognized' },
  { field: 'manifest_schema_version', how: 'wrong version 2', mutate: (m) => { m.manifest_schema_version = 2; }, code: 'manifest_version_unrecognized' },
  { field: 'hmac_key_version', how: 'null WITHOUT hmac_key_absent', mutate: (m) => { m.hmac_key_version = null; }, code: 'hmac_key_version_absent' },
  { field: 'hmac_key_version', how: 'empty string', mutate: (m) => { m.hmac_key_version = ''; }, code: 'hmac_key_version_absent' },
  { field: 'operational', how: 'missing', mutate: (m) => del(m, 'operational'), code: 'operational_absent' },
  { field: 'operational.route', how: 'missing', mutate: (m) => del(nested(m, 'operational'), 'route'), code: 'route_absent_or_invalid' },
  { field: 'operational.route', how: 'invalid (not in RETRIEVAL_ROUTES)', mutate: (m) => { nested(m, 'operational').route = 'reconciler'; }, code: 'route_absent_or_invalid' },
  { field: 'operational.route_class', how: 'null', mutate: (m) => { nested(m, 'operational').route_class = null; }, code: 'route_class_absent' },
  { field: 'operational.retrieval_role', how: 'invalid', mutate: (m) => { nested(m, 'operational').retrieval_role = 'secondary'; }, code: 'retrieval_role_absent_or_invalid' },
  { field: 'operational.started_at', how: 'null', mutate: (m) => { nested(m, 'operational').started_at = null; }, code: 'started_at_absent' },
  { field: 'operational.completed_at', how: 'empty string', mutate: (m) => { nested(m, 'operational').completed_at = ''; }, code: 'completed_at_absent' },
  { field: 'operational.invocation_id', how: 'empty string', mutate: (m) => { nested(m, 'operational').invocation_id = ''; }, code: 'invocation_id_absent' },
  { field: 'operational.trace_id', how: 'missing (null is permitted)', mutate: (m) => del(nested(m, 'operational'), 'trace_id'), code: 'trace_id_field_absent' },
  { field: 'operational.deployment_sha', how: 'missing (null is permitted)', mutate: (m) => del(nested(m, 'operational'), 'deployment_sha'), code: 'deployment_sha_field_absent' },
  { field: 'operational.routing_flags', how: 'null ({} is permitted)', mutate: (m) => { nested(m, 'operational').routing_flags = null; }, code: 'routing_flags_absent' },
  { field: 'operational.routing_flags', how: 'an array is not a flags object', mutate: (m) => { nested(m, 'operational').routing_flags = []; }, code: 'routing_flags_absent' },
  { field: 'operational.active_backfill_run_id', how: 'missing (null is permitted)', mutate: (m) => del(nested(m, 'operational'), 'active_backfill_run_id'), code: 'active_backfill_run_id_field_absent' },
  { field: 'operational.active_backfill_target', how: 'missing (null is permitted)', mutate: (m) => del(nested(m, 'operational'), 'active_backfill_target'), code: 'active_backfill_target_field_absent' },
  { field: 'operational.active_backfill_state', how: 'missing (null is permitted)', mutate: (m) => del(nested(m, 'operational'), 'active_backfill_state'), code: 'active_backfill_state_field_absent' },
  { field: 'operational.active_backfill_state', how: 'invalid (not active/idle)', mutate: (m) => { nested(m, 'operational').active_backfill_state = 'running'; }, code: 'active_backfill_state_invalid' },
  { field: 'operational.active_lab_experiment_id', how: 'missing (null is permitted)', mutate: (m) => del(nested(m, 'operational'), 'active_lab_experiment_id'), code: 'active_lab_experiment_id_field_absent' },
  { field: 'retrieval_outcome', how: 'null', mutate: (m) => { m.retrieval_outcome = null; }, code: 'retrieval_outcome_absent_or_invalid' },
  { field: 'retrieval_outcome', how: 'invalid', mutate: (m) => { m.retrieval_outcome = 'partial'; }, code: 'retrieval_outcome_absent_or_invalid' },
  { field: 'retrieval_error_class', how: 'missing (null is permitted on success)', mutate: (m) => del(m, 'retrieval_error_class'), code: 'retrieval_error_class_field_absent' },
  { field: 'retrieval_error_class', how: 'null when the outcome is retrieval_failure', mutate: (m) => { m.retrieval_outcome = 'retrieval_failure'; m.retrieval_error_class = null; }, code: 'retrieval_error_class_absent_on_failure' },
  { field: 'expansion', how: 'missing', mutate: (m) => del(m, 'expansion'), code: 'expansion_absent' },
  { field: 'expansion.status', how: 'null', mutate: (m) => { nested(m, 'expansion').status = null; }, code: 'expansion_status_absent_or_invalid' },
  { field: 'expansion.input_hmac', how: 'missing', mutate: (m) => del(nested(m, 'expansion'), 'input_hmac'), code: 'expansion_input_hmac_field_absent' },
  { field: 'expansion.input_hmac', how: 'null on an EXPANDED stage without hmac_key_absent', mutate: (m) => { nested(m, 'expansion').input_hmac = null; }, code: 'expansion_input_hmac_absent' },
  { field: 'expansion.served_route_class', how: 'missing', mutate: (m) => del(nested(m, 'expansion'), 'served_route_class'), code: 'expansion_served_route_class_field_absent' },
  { field: 'expansion.served_route_class', how: 'null on an EXPANDED stage', mutate: (m) => { nested(m, 'expansion').served_route_class = null; }, code: 'expansion_served_route_class_absent' },
  { field: 'expansion.served_route_class', how: 'invalid', mutate: (m) => { nested(m, 'expansion').served_route_class = 'gemini'; }, code: 'expansion_served_route_class_invalid' },
  { field: 'expansion.served_model', how: 'missing (null is permitted)', mutate: (m) => del(nested(m, 'expansion'), 'served_model'), code: 'expansion_served_model_field_absent' },
  { field: 'expansion.attempts', how: 'missing (null and [] are permitted)', mutate: (m) => del(nested(m, 'expansion'), 'attempts'), code: 'expansion_attempts_field_absent' },
  { field: 'expansion.attempts', how: 'a non-array, non-null value', mutate: (m) => { nested(m, 'expansion').attempts = 'vertex'; }, code: 'attempt_outcome_absent_or_invalid' },
  { field: 'fused_candidate_ids', how: 'null ([] is permitted)', mutate: (m) => { m.fused_candidate_ids = null; }, code: 'fused_candidate_ids_absent' },
  { field: 'fused_candidate_ids', how: 'a non-numeric member', mutate: (m) => { m.fused_candidate_ids = [11, 'x']; }, code: 'fused_candidate_ids_absent' },
  { field: 'hydrated_candidate_ids', how: 'null ([] is permitted)', mutate: (m) => { m.hydrated_candidate_ids = null; }, code: 'hydrated_candidate_ids_absent' },
  { field: 'fused_candidate_count', how: 'null', mutate: (m) => { m.fused_candidate_count = null; }, code: 'fused_candidate_count_absent' },
  { field: 'fused_candidate_count', how: 'invalid number: negative', mutate: (m) => { m.fused_candidate_count = -1; }, code: 'fused_candidate_count_absent' },
  { field: 'fused_candidate_count', how: 'invalid number: NaN', mutate: (m) => { m.fused_candidate_count = Number.NaN; }, code: 'fused_candidate_count_absent' },
  { field: 'fused_candidate_count', how: 'invalid number: a numeric STRING', mutate: (m) => { m.fused_candidate_count = '3'; }, code: 'fused_candidate_count_absent' },
  { field: 'hydrated_candidate_count', how: 'invalid number: Infinity', mutate: (m) => { m.hydrated_candidate_count = Number.POSITIVE_INFINITY; }, code: 'hydrated_candidate_count_absent' },
  { field: 'hydrated_candidate_count', how: 'null', mutate: (m) => { m.hydrated_candidate_count = null; }, code: 'hydrated_candidate_count_absent' },
  { field: 'pre_rerank_passage_hmacs', how: 'missing', mutate: (m) => del(m, 'pre_rerank_passage_hmacs'), code: 'pre_rerank_passage_hmacs_field_absent' },
  { field: 'pre_rerank_passage_hmacs', how: 'null WITHOUT hmac_key_absent', mutate: (m) => { m.pre_rerank_passage_hmacs = null; }, code: 'pre_rerank_passage_hmacs_absent' },
  { field: 'pre_rerank_passage_hmacs', how: 'a non-array', mutate: (m) => { m.pre_rerank_passage_hmacs = 'k1:aa'; }, code: 'pre_rerank_passage_hmacs_absent' },
  { field: 'pre_rerank_passage_hmacs', how: 'cardinality ≠ hydrated_candidate_ids (one per HYDRATED row)', mutate: (m) => { m.pre_rerank_passage_hmacs = ['k1:aa', 'k1:bb']; }, code: 'passage_hmac_cardinality_mismatch' },
  { field: 'intended_backend', how: 'null (the string none is permitted)', mutate: (m) => { m.intended_backend = null; }, code: 'intended_backend_absent' },
  { field: 'intended_backend', how: 'empty string', mutate: (m) => { m.intended_backend = ''; }, code: 'intended_backend_absent' },
  { field: 'intended_model', how: 'empty string', mutate: (m) => { m.intended_model = ''; }, code: 'intended_model_absent' },
  { field: 'served_backend', how: 'missing (null is permitted with no batches)', mutate: (m) => del(m, 'served_backend'), code: 'served_backend_field_absent' },
  { field: 'served_backend', how: 'null once a batch record exists', mutate: (m) => { m.served_backend = null; }, code: 'served_backend_absent_with_batches' },
  { field: 'rerank_backend_downgraded', how: 'null', mutate: (m) => { m.rerank_backend_downgraded = null; }, code: 'rerank_backend_downgraded_absent' },
  { field: 'rerank_soft_failed', how: 'a string, not a boolean', mutate: (m) => { m.rerank_soft_failed = 'false'; }, code: 'rerank_soft_failed_absent' },
  { field: 'expected_batch_count', how: 'null', mutate: (m) => { m.expected_batch_count = null; }, code: 'expected_batch_count_absent' },
  { field: 'recorded_rerank_batches', how: 'invalid number: NaN', mutate: (m) => { m.recorded_rerank_batches = Number.NaN; }, code: 'recorded_rerank_batches_absent' },
  { field: 'recorded_rerank_batches', how: 'disagrees with batches.length', mutate: (m) => { m.recorded_rerank_batches = 2; }, code: 'recorded_batch_count_mismatch' },
  { field: 'expected_batch_count', how: 'disagrees with batches.length (§7, never waived)', mutate: (m) => { m.expected_batch_count = 2; }, code: 'batch_count_mismatch' },
  { field: 'batches', how: 'null ([] is permitted)', mutate: (m) => { m.batches = null; }, code: 'batches_absent' },
  { field: 'batch.batch_index', how: 'missing', mutate: (m) => del(batch0(m), 'batch_index'), code: 'batch_index_absent' },
  { field: 'batch.batch_index', how: 'duplicated', mutate: (m) => { const b = batch0(m); m.batches = [b, { ...b, candidate_start: 3, candidate_end: 6 }]; m.expected_batch_count = 2; m.recorded_rerank_batches = 2; }, code: 'duplicate_batch_index' },
  // v26 §3.3: candidate_start gets its OWN absent-and-invalid rows, independent of candidate_end.
  { field: 'batch.candidate_start', how: 'missing (v26 §3.3, its own row)', mutate: (m) => del(batch0(m), 'candidate_start'), code: 'batch_boundaries_absent' },
  { field: 'batch.candidate_start', how: 'null (v26 §3.3, its own row)', mutate: (m) => { batch0(m).candidate_start = null; }, code: 'batch_boundaries_absent' },
  { field: 'batch.candidate_start', how: 'invalid: a numeric STRING (v26 §3.3, its own row)', mutate: (m) => { batch0(m).candidate_start = '0'; }, code: 'batch_boundaries_absent' },
  { field: 'batch.candidate_end', how: 'missing', mutate: (m) => del(batch0(m), 'candidate_end'), code: 'batch_boundaries_absent' },
  { field: 'batch.candidate_end', how: 'null', mutate: (m) => { batch0(m).candidate_end = null; }, code: 'batch_boundaries_absent' },
  { field: 'batch.candidate_start/end', how: 'end <= start (the relation, after both fields validate)', mutate: (m) => { batch0(m).candidate_end = 0; }, code: 'bad_candidate_boundaries' },
  { field: 'batch (member)', how: 'a null member — reported, never dereferenced (v26 §3.2)', mutate: (m) => { m.batches = [null]; }, code: 'batch_member_invalid' },
  { field: 'batch (member)', how: 'a numeric member', mutate: (m) => { m.batches = [42]; }, code: 'batch_member_invalid' },
  { field: 'batch.missing_score_keys', how: 'missing (D15 count)', mutate: (m) => del(batch0(m), 'missing_score_keys'), code: 'missing_score_keys_absent' },
  { field: 'batch.nonnumeric_score_keys', how: 'invalid: negative (D15 count)', mutate: (m) => { batch0(m).nonnumeric_score_keys = -1; }, code: 'nonnumeric_score_keys_absent' },
  { field: 'telemetry_error', how: 'missing (D8 — the licence declaration must be a present field)', mutate: (m) => del(m, 'telemetry_error'), code: 'telemetry_error_field_absent' },
  { field: 'telemetry_error', how: 'invalid: an unknown error string', mutate: (m) => { m.telemetry_error = 'something_else'; }, code: 'telemetry_error_invalid' },
  { field: 'batch.intended_provider', how: 'empty string', mutate: (m) => { batch0(m).intended_provider = ''; }, code: 'batch_intended_provider_absent' },
  { field: 'batch.intended_model', how: 'null', mutate: (m) => { batch0(m).intended_model = null; }, code: 'batch_intended_model_absent' },
  { field: 'batch.served_route_class', how: 'missing', mutate: (m) => del(batch0(m), 'served_route_class'), code: 'batch_served_route_class_absent' },
  { field: 'batch.served_route_class', how: 'null — the type permits it, the contract does not (A6)', mutate: (m) => { batch0(m).served_route_class = null; }, code: 'batch_served_route_class_absent' },
  { field: 'batch.served_route_class', how: 'invalid', mutate: (m) => { batch0(m).served_route_class = 'cohere'; }, code: 'batch_served_route_class_invalid' },
  { field: 'batch.served_model', how: 'missing (null is permitted)', mutate: (m) => del(batch0(m), 'served_model'), code: 'batch_served_model_field_absent' },
  { field: 'batch.served_model', how: 'non-null on an unattributed batch (§10)', mutate: (m) => { batch0(m).served_route_class = 'unattributed'; }, code: 'unattributed_with_model' },
  { field: 'batch.served_model', how: 'non-null on a not_served batch (§10)', mutate: (m) => { batch0(m).served_route_class = 'not_served'; }, code: 'not_served_with_model' },
  { field: 'batch.attempts', how: 'missing (null is permitted)', mutate: (m) => del(batch0(m), 'attempts'), code: 'batch_attempts_field_absent' },
  { field: 'batch.attempts', how: 'a member with an outcome outside the six', mutate: (m) => { batch0(m).attempts = [{ provider: 'vertex', attempt: 1, outcome: 'ok', status: 200 }]; }, code: 'attempt_outcome_absent_or_invalid' },
  { field: 'batch.prompt_tokens', how: 'missing (null is permitted) — v25 §3.2, unvalidated until the pass 3 repair', mutate: (m) => del(batch0(m), 'prompt_tokens'), code: 'batch_prompt_tokens_field_absent' },
  { field: 'batch.prompt_tokens', how: 'invalid: a numeric STRING', mutate: (m) => { batch0(m).prompt_tokens = '90'; }, code: 'batch_prompt_tokens_invalid' },
  { field: 'batch.prompt_tokens', how: 'invalid number: negative', mutate: (m) => { batch0(m).prompt_tokens = -1; }, code: 'batch_prompt_tokens_invalid' },
  { field: 'batch.prompt_tokens', how: 'invalid number: NaN', mutate: (m) => { batch0(m).prompt_tokens = Number.NaN; }, code: 'batch_prompt_tokens_invalid' },
  { field: 'batch.completion_tokens', how: 'missing (null is permitted) — v25 §3.2, unvalidated until the pass 3 repair', mutate: (m) => del(batch0(m), 'completion_tokens'), code: 'batch_completion_tokens_field_absent' },
  { field: 'batch.completion_tokens', how: 'invalid: a numeric STRING', mutate: (m) => { batch0(m).completion_tokens = '12'; }, code: 'batch_completion_tokens_invalid' },
  { field: 'batch.completion_tokens', how: 'invalid number: Infinity', mutate: (m) => { batch0(m).completion_tokens = Number.POSITIVE_INFINITY; }, code: 'batch_completion_tokens_invalid' },
  { field: 'batch.completion_tokens', how: 'invalid: an object', mutate: (m) => { batch0(m).completion_tokens = { n: 12 }; }, code: 'batch_completion_tokens_invalid' },
  { field: 'batch.outcome', how: 'invalid', mutate: (m) => { batch0(m).outcome = 'failed'; }, code: 'batch_outcome_absent_or_invalid' },
  { field: 'batch.expected_score_keys', how: 'null', mutate: (m) => { batch0(m).expected_score_keys = null; }, code: 'expected_score_keys_absent' },
  { field: 'batch.finite_score_keys', how: 'invalid number: negative', mutate: (m) => { batch0(m).finite_score_keys = -1; }, code: 'finite_score_keys_absent' },
  { field: 'batch.finite_score_keys', how: 'more finite keys than expected', mutate: (m) => { batch0(m).finite_score_keys = 4; }, code: 'score_keys_exceed_expected' },
  { field: 'ordered_final_candidate_ids', how: 'null ([] is permitted)', mutate: (m) => { m.ordered_final_candidate_ids = null; }, code: 'ordered_final_candidate_ids_absent' },
  { field: 'retrieval_config', how: 'null', mutate: (m) => { m.retrieval_config = null; }, code: 'retrieval_config_absent' },
  { field: 'retrieval_config', how: 'an array is not a config object', mutate: (m) => { m.retrieval_config = []; }, code: 'retrieval_config_absent' },
  { field: 'retrieval_config.rerank_temperature', how: 'missing (v7 §10: required as of manifest v3; null is permitted)', mutate: (m) => del(nested(m, 'retrieval_config'), 'rerank_temperature'), code: 'rerank_temperature_field_absent' },
  { field: 'retrieval_config.rerank_temperature', how: 'invalid number: NaN', mutate: (m) => { nested(m, 'retrieval_config').rerank_temperature = Number.NaN; }, code: 'rerank_temperature_invalid' },
  { field: 'retrieval_config.rerank_seed_status', how: 'missing (v7 §10)', mutate: (m) => del(nested(m, 'retrieval_config'), 'rerank_seed_status'), code: 'rerank_seed_status_field_absent' },
  { field: 'retrieval_config.rerank_seed_status', how: 'null — never null, not_applicable is the value for no decode', mutate: (m) => { nested(m, 'retrieval_config').rerank_seed_status = null; }, code: 'rerank_seed_status_invalid' },
  { field: 'corpus_version', how: 'missing (null is permitted)', mutate: (m) => del(m, 'corpus_version'), code: 'corpus_version_field_absent' },
  { field: 'index_version', how: 'null', mutate: (m) => { m.index_version = null; }, code: 'index_version_absent' },
  { field: 'index_version', how: 'empty string', mutate: (m) => { m.index_version = ''; }, code: 'index_version_absent' },
  { field: 'scorer_context_hmac', how: 'missing', mutate: (m) => del(m, 'scorer_context_hmac'), code: 'scorer_context_hmac_field_absent' },
  { field: 'scorer_context_hmac', how: 'null on role primary WITHOUT hmac_key_absent', mutate: (m) => { m.scorer_context_hmac = null; }, code: 'scorer_context_hmac_absent' },
  { field: 'multi_query', how: 'present on a role that is not lab_multi_query', mutate: (m) => { m.multi_query = { variant_generation: {}, variants: [] }; }, code: 'multi_query_on_non_multi_query_role' },
];

let n = 1;
for (const row of ROWS) {
  n += 1;
  test(`45.${n} — ${row.field}: ${row.how} → ${row.code}`, () => {
    const m = asObj(validManifest());
    row.mutate(m);
    const out = codes(m);
    assert.ok(out.includes(row.code), `${row.field} (${row.how}) must yield ${row.code}; got [${out.join(', ')}]`);
  });
}

// The multi-query block, on the one role that requires it.
const MQ_ROWS: Row[] = [
  { field: 'multi_query', how: 'missing on lab_multi_query', mutate: (m) => del(m, 'multi_query'), code: 'multi_query_absent' },
  { field: 'multi_query.variant_generation', how: 'null', mutate: (m) => { nested(m, 'multi_query').variant_generation = null; }, code: 'variant_generation_absent' },
  { field: 'multi_query.variant_generation.status', how: 'invalid', mutate: (m) => { nested(nested(m, 'multi_query'), 'variant_generation').status = 'ok'; }, code: 'variant_generation_status_absent_or_invalid' },
  { field: 'multi_query.variant_generation.served_route_class', how: 'missing (null is permitted for a stage that did not run)', mutate: (m) => del(nested(nested(m, 'multi_query'), 'variant_generation'), 'served_route_class'), code: 'variant_generation_served_route_class_field_absent' },
  { field: 'multi_query.variant_generation.generated_variant_count', how: 'null', mutate: (m) => { nested(nested(m, 'multi_query'), 'variant_generation').generated_variant_count = null; }, code: 'generated_variant_count_absent' },
  { field: 'multi_query.variant_generation.attempts', how: 'a member with an outcome outside the six', mutate: (m) => { nested(nested(m, 'multi_query'), 'variant_generation').attempts = [{ provider: 'vertex', attempt: 1, outcome: 'nope', status: null }]; }, code: 'attempt_outcome_absent_or_invalid' },
  { field: 'multi_query.variant_generation.prompt_tokens', how: 'missing (v26 §3.5, null is permitted)', mutate: (m) => del(nested(nested(m, 'multi_query'), 'variant_generation'), 'prompt_tokens'), code: 'variant_generation_prompt_tokens_field_absent' },
  { field: 'multi_query.variant_generation.prompt_tokens', how: 'invalid: a numeric STRING (v26 §3.5)', mutate: (m) => { nested(nested(m, 'multi_query'), 'variant_generation').prompt_tokens = '150'; }, code: 'variant_generation_prompt_tokens_invalid' },
  { field: 'multi_query.variant_generation.completion_tokens', how: 'missing (v26 §3.5, null is permitted)', mutate: (m) => del(nested(nested(m, 'multi_query'), 'variant_generation'), 'completion_tokens'), code: 'variant_generation_completion_tokens_field_absent' },
  { field: 'multi_query.variant_generation.completion_tokens', how: 'invalid: negative (v26 §3.5)', mutate: (m) => { nested(nested(m, 'multi_query'), 'variant_generation').completion_tokens = -3; }, code: 'variant_generation_completion_tokens_invalid' },
  { field: 'multi_query.variant_generation.served_model', how: 'missing (null is permitted)', mutate: (m) => del(nested(nested(m, 'multi_query'), 'variant_generation'), 'served_model'), code: 'variant_generation_served_model_field_absent' },
  { field: 'multi_query.variants (member)', how: 'a null member (v26 §3.2)', mutate: (m) => { nested(m, 'multi_query').variants = [null, { index: 1, outcome: 'success', candidate_count: 2 }, { index: 2, outcome: 'zero_hits', candidate_count: 0 }]; }, code: 'variant_member_invalid' },
  { field: 'multi_query.variants[].outcome', how: 'invalid', mutate: (m) => { const vs = nested(m, 'multi_query').variants; assert.ok(isObjArray(vs)); vs[0].outcome = 'ok'; }, code: 'variant_outcome_absent_or_invalid' },
  { field: 'multi_query.variants[].candidate_count', how: 'missing', mutate: (m) => { const vs = nested(m, 'multi_query').variants; assert.ok(isObjArray(vs)); del(vs[1], 'candidate_count'); }, code: 'variant_candidate_count_absent_or_invalid' },
  { field: 'multi_query.variants', how: 'null', mutate: (m) => { nested(m, 'multi_query').variants = null; }, code: 'variants_absent' },
  { field: 'multi_query.variants', how: 'length ≠ generated_variant_count + 1', mutate: (m) => { nested(m, 'multi_query').variants = []; }, code: 'variant_arity_mismatch' },
];
function validMultiQueryManifest(): Obj {
  const m = asObj(validManifest('lab_multi_query'));
  m.multi_query = {
    variant_generation: {
      status: 'generated', served_route_class: 'vertex', served_model: 'gemini-2.5-flash',
      attempts: [{ provider: 'vertex', attempt: 1, outcome: 'success', status: 200 }],
      prompt_tokens: 150, completion_tokens: 30, generated_variant_count: 2,
    },
    variants: [
      { index: 0, outcome: 'success', candidate_count: 3 },
      { index: 1, outcome: 'success', candidate_count: 2 },
      { index: 2, outcome: 'zero_hits', candidate_count: 0 },
    ],
  };
  return m;
}
test(`45.${n + 1} — the lab_multi_query fixture is CLEAN before its rows run`, () => {
  assert.deepEqual(codes(validMultiQueryManifest()), []);
});
n += 1;
for (const row of MQ_ROWS) {
  n += 1;
  test(`45.${n} — ${row.field}: ${row.how} → ${row.code}`, () => {
    const m = validMultiQueryManifest();
    row.mutate(m);
    const out = codes(m);
    assert.ok(out.includes(row.code), `${row.field} (${row.how}) must yield ${row.code}; got [${out.join(', ')}]`);
  });
}

test('45.1 — OWN-PROPERTY CHECKS: missing, explicit null, empty array, empty string and invalid number are FIVE different answers, and the validator tells them apart', () => {
  // missing ≠ null: trace_id present-and-null is clean; trace_id absent is a defect.
  const nullTrace = asObj(validManifest()); nested(nullTrace, 'operational').trace_id = null;
  assert.equal(codes(nullTrace).includes('trace_id_field_absent'), false, 'present-and-null is a declaration');
  const noTrace = asObj(validManifest()); del(nested(noTrace, 'operational'), 'trace_id');
  assert.ok(codes(noTrace).includes('trace_id_field_absent'), 'an absent field is not a declaration');
  // null ≠ empty array: fused_candidate_ids [] is permitted (with count 0 and the rest coherent); null is not.
  const emptyIds = asObj(validManifest());
  emptyIds.fused_candidate_ids = []; emptyIds.hydrated_candidate_ids = []; emptyIds.fused_candidate_count = 0; emptyIds.hydrated_candidate_count = 0;
  emptyIds.pre_rerank_passage_hmacs = []; emptyIds.batches = []; emptyIds.expected_batch_count = 0; emptyIds.recorded_rerank_batches = 0;
  emptyIds.ordered_final_candidate_ids = []; emptyIds.served_backend = null; emptyIds.intended_backend = 'none'; emptyIds.intended_model = 'none';
  assert.deepEqual(codes(emptyIds), [], '[] is a value: an empty pool validates clean');
  const nullIds = asObj(validManifest()); nullIds.fused_candidate_ids = null;
  assert.ok(codes(nullIds).includes('fused_candidate_ids_absent'), 'null is not []');
  // empty string ≠ a string: invocation_id '' is absent; 'inv-45' is present.
  const emptyInv = asObj(validManifest()); nested(emptyInv, 'operational').invocation_id = '';
  assert.ok(codes(emptyInv).includes('invocation_id_absent'));
  // invalid number ≠ zero: fused_candidate_count 0 is valid, -1 / NaN / '0' are not.
  for (const bad of [-1, Number.NaN, '0', null]) {
    const m = asObj(validManifest()); m.fused_candidate_count = bad;
    assert.ok(codes(m).includes('fused_candidate_count_absent'), `${String(bad)} is an invalid count`);
  }
  const zero = asObj(validManifest()); zero.fused_candidate_count = 0;
  assert.equal(codes(zero).includes('fused_candidate_count_absent'), false, 'zero is a finite, non-negative number');
  // The two usage fields (v25 §3.2): present-and-null is "usage not reported" and is clean; zero is
  // a value and is clean; absent, a string, or a negative number is a defect.
  const nullUsage = asObj(validManifest()); batch0(nullUsage).prompt_tokens = null; batch0(nullUsage).completion_tokens = null;
  assert.deepEqual(codes(nullUsage), [], 'null usage on both fields is a declaration, not a defect');
  const zeroUsage = asObj(validManifest()); batch0(zeroUsage).prompt_tokens = 0; batch0(zeroUsage).completion_tokens = 0;
  assert.deepEqual(codes(zeroUsage), [], 'zero usage is a value');
  const noUsage = asObj(validManifest()); del(batch0(noUsage), 'prompt_tokens'); del(batch0(noUsage), 'completion_tokens');
  const out = codes(noUsage);
  assert.ok(out.includes('batch_prompt_tokens_field_absent') && out.includes('batch_completion_tokens_field_absent'), 'absent usage fields are defects — a manifest without them is NOT complete');
});

n += 1;
test(`45.${n} — the HMAC-absent licence covers EXACTLY the four D8 fields, and only when telemetry_error declares it`, () => {
  const licensed = asObj(validManifest());
  licensed.telemetry_error = 'hmac_key_absent';
  licensed.hmac_key_version = null; nested(licensed, 'expansion').input_hmac = null;
  licensed.pre_rerank_passage_hmacs = null; licensed.scorer_context_hmac = null;
  assert.deepEqual(codes(licensed), [], 'four explicit nulls under the declared error are clean');
  const unlicensed = asObj(validManifest());
  unlicensed.hmac_key_version = null; nested(unlicensed, 'expansion').input_hmac = null;
  unlicensed.pre_rerank_passage_hmacs = null; unlicensed.scorer_context_hmac = null;
  const out = codes(unlicensed);
  for (const c of ['hmac_key_version_absent', 'expansion_input_hmac_absent', 'pre_rerank_passage_hmacs_absent', 'scorer_context_hmac_absent']) {
    assert.ok(out.includes(c), `${c} without the licence`);
  }
});

// ── 45.2xx — THE MATRIX, ENUMERATED (v26 §3.1). Generated: one absent, one null, one wrong-type case
// per entry of D17_FIELD_MATRIX. The number this file states is the matrix length, printed below. ──

/** Walk a dotted path (a `[]` segment = member 0 of that array) to the parent object of the last key. */
function parentAt(m: Obj, path: string): Obj {
  const segments = path.split('.');
  let cur: Obj = m;
  for (const seg of segments.slice(0, -1)) {
    if (seg.endsWith('[]')) {
      const arr = cur[seg.slice(0, -2)];
      assert.ok(isObjArray(arr) && arr.length > 0, `${path}: fixture has array ${seg}`);
      cur = arr[0];
    } else {
      cur = nested(cur, seg);
    }
  }
  return cur;
}
const lastKey = (path: string): string => path.split('.').pop() ?? path;
/** A present, non-null value of the WRONG type for the rule. */
function wrongTyped(rule: D17FieldRule): unknown {
  switch (rule.type) {
    case 'string': case 'nonempty_string': return 4242;
    case 'boolean': return 'false';
    case 'finite_number': case 'nonneg_number': return 'not-a-number';
    case 'object': return ['not', 'an', 'object'];
    case 'array': case 'id_array': case 'string_array': return 'not-an-array';
    case 'attempts': return 'not-an-attempt-list';
    case 'enum': return 'not-a-member-of-this-enum';
  }
}
/** The fixture a rule is exercised against: the lab_multi_query manifest for the multi_query section. */
const fixtureFor = (rule: D17FieldRule): Obj => rule.path.startsWith('multi_query.') ? validMultiQueryManifest() : asObj(validManifest());
/** Whether, against that fixture, null is PERMITTED for the rule (the fixture is keyed, expanded,
 *  batched, successful, and primary or lab_multi_query — so every conditional resolves). */
function nullPermittedInFixture(rule: D17FieldRule): boolean {
  switch (rule.nullable) {
    case 'always': return true;
    case 'unless_failure': return true;                 // the fixture's outcome is success
    case 'primary_hmac': return rule.path.startsWith('multi_query.') ? true : false;   // primary keyed → required
    default: return false;                              // never / licence / skipped / no_batches: the fixture makes each 'must_not'
  }
}

let matrixCases = 0;
const MATRIX_BASE = 200;
D17_FIELD_MATRIX.forEach((rule, i) => {
  const base = MATRIX_BASE + i * 3;
  const key = lastKey(rule.path);
  if (key.endsWith('[]')) {
    // A MEMBER rule: [null] and [42] members are reported by name and never dereferenced.
    matrixCases += 3;
    test(`45.${base} — matrix ${rule.path} (${rule.origin}): a null member → ${rule.invalid}, without throwing`, () => {
      const m = fixtureFor(rule); parentAt(m, rule.path)[key.slice(0, -2)] = [null];
      let out: string[] = [];
      assert.doesNotThrow(() => { out = codes(m); });
      assert.ok(out.includes(rule.invalid), `got [${out.join(', ')}]`);
    });
    test(`45.${base + 1} — matrix ${rule.path} (${rule.origin}): a numeric member → ${rule.invalid}`, () => {
      const m = fixtureFor(rule); parentAt(m, rule.path)[key.slice(0, -2)] = [42];
      assert.ok(codes(m).includes(rule.invalid));
    });
    test(`45.${base + 2} — matrix ${rule.path} (${rule.origin}): an array member → ${rule.invalid}`, () => {
      const m = fixtureFor(rule); parentAt(m, rule.path)[key.slice(0, -2)] = [[]];
      assert.ok(codes(m).includes(rule.invalid));
    });
    return;
  }
  matrixCases += 3;
  test(`45.${base} — matrix ${rule.path} (${rule.origin}): ABSENT → ${rule.absent}`, () => {
    const m = fixtureFor(rule); del(parentAt(m, rule.path), key);
    const out = codes(m);
    assert.ok(out.includes(rule.absent), `got [${out.join(', ')}]`);
  });
  const nullOk = nullPermittedInFixture(rule);
  test(`45.${base + 1} — matrix ${rule.path} (${rule.origin}): NULL → ${nullOk ? 'permitted here, no code' : rule.nullCode}`, () => {
    const m = fixtureFor(rule); parentAt(m, rule.path)[key] = null;
    const out = codes(m);
    if (nullOk) assert.equal(out.includes(rule.nullCode), false, `null is a declaration for ${rule.path}; got [${out.join(', ')}]`);
    else assert.ok(out.includes(rule.nullCode), `got [${out.join(', ')}]`);
  });
  test(`45.${base + 2} — matrix ${rule.path} (${rule.origin}): WRONG TYPE (${JSON.stringify(wrongTyped(rule))}) → ${rule.invalid}`, () => {
    const m = fixtureFor(rule); parentAt(m, rule.path)[key] = wrongTyped(rule);
    const out = codes(m);
    assert.ok(out.includes(rule.invalid), `got [${out.join(', ')}]`);
  });
});

test('45.199 — THE COUNT, computed not recalled: the matrix length, the generated cases, unique paths, and D17\'s transcribed field list all resolved into the matrix', () => {
  // How the number is counted: `D17_FIELD_MATRIX.length` — the enumeration above generated three
  // cases per entry, so `matrixCases === 3 * D17_FIELD_MATRIX.length` by construction.
  const n = D17_FIELD_MATRIX.length;
  assert.equal(matrixCases, 3 * n, 'three generated cases per matrix entry');
  assert.equal(new Set(D17_FIELD_MATRIX.map((r) => r.path)).size, n, 'every path is unique');
  console.log(`# proof 45: D17_FIELD_MATRIX has ${n} entries; ${matrixCases} generated cases`);
  // D17's required-field list, TRANSCRIBED from kickoff v11 D17 (the block that begins "Required
  // fields, and whether explicit null is permitted"), one entry per field named there. This is the
  // enumeration; the assertion is that every one resolves to a matrix path.
  const D17_LIST: string[] = [
    'manifest_schema_version', 'hmac_key_version',
    'operational.route', 'operational.route_class', 'operational.retrieval_role',
    'operational.started_at', 'operational.completed_at', 'operational.invocation_id',
    'operational.trace_id', 'operational.deployment_sha', 'operational.routing_flags',
    'operational.active_backfill_run_id', 'operational.active_backfill_target', 'operational.active_backfill_state',
    'operational.active_lab_experiment_id',
    'retrieval_outcome', 'retrieval_error_class',
    'expansion.status', 'expansion.input_hmac', 'expansion.served_route_class', 'expansion.served_model', 'expansion.attempts',
    'intended_backend', 'intended_model', 'served_backend', 'rerank_backend_downgraded',
    'retrieval_config', 'corpus_version', 'index_version',
    'fused_candidate_ids', 'hydrated_candidate_ids', 'pre_rerank_passage_hmacs',
    'fused_candidate_count', 'hydrated_candidate_count', 'expected_batch_count', 'recorded_rerank_batches',
    'rerank_soft_failed', 'ordered_final_candidate_ids', 'scorer_context_hmac', 'batches',
    'batches[].batch_index', 'batches[].candidate_start', 'batches[].candidate_end',
    'batches[].intended_provider', 'batches[].intended_model', 'batches[].served_route_class', 'batches[].outcome',
    'batches[].expected_score_keys', 'batches[].finite_score_keys',
    'batches[].served_model', 'batches[].attempts', 'batches[].prompt_tokens', 'batches[].completion_tokens',
    'multi_query',
  ];
  const paths = new Set(D17_FIELD_MATRIX.map((r) => r.path));
  // `multi_query` itself is a role-conditional presence rule (required on lab_multi_query, forbidden
  // elsewhere) that lives in validateManifest's relation pass, so it is checked by 45.94/45.92 rather
  // than by a matrix row; every other D17 field must be a matrix path.
  const missing = D17_LIST.filter((f) => f !== 'multi_query' && !paths.has(f));
  assert.deepEqual(missing, [], `D17 fields with no matrix row: ${missing.join(', ')}`);
  console.log(`# proof 45: D17's list transcribes to ${D17_LIST.length} fields; ${D17_LIST.length - 1} are matrix rows and 1 (multi_query) is the role-conditional presence rule`);
  // And the matrix carries what D17's list does not name but the manifest holds — stated as counts
  // by origin, from the table itself.
  const byOrigin = new Map<string, number>();
  for (const r of D17_FIELD_MATRIX) byOrigin.set(r.origin, (byOrigin.get(r.origin) ?? 0) + 1);
  console.log(`# proof 45: matrix rows by origin: ${[...byOrigin.entries()].map(([k, c]) => `${k}=${c}`).join(', ')}`);
  assert.equal([...byOrigin.values()].reduce((a, b) => a + b, 0), n);
});

// ── 45.198 / 45.197 — NEVER THROWS (v26 §3.2) ─────────────────────────────────────────────────────

test('45.198 — batches: [null] returns CODES, it does not throw; and every other malformed member shape is classified the same way', () => {
  const m = asObj(validManifest());
  m.batches = [null];
  let out: string[] = [];
  assert.doesNotThrow(() => { out = validateManifest(m); }, 'a null batch member must not throw');
  assert.ok(out.includes('batch_member_invalid'), `the null member is reported by name; got [${out.join(', ')}]`);
  assert.ok(out.every((c) => typeof c === 'string'), 'codes only');
  for (const members of [[undefined], [42], ['x'], [[]], [true], [null, null], [{ batch_index: 0 }, null]]) {
    const w = asObj(validManifest()); w.batches = members;
    assert.doesNotThrow(() => { validateManifest(w); }, `batches ${JSON.stringify(members)} must not throw`);
    assert.ok(validateManifest(w).includes('batch_member_invalid'), `batches ${JSON.stringify(members)} reports the member`);
  }
});

test('45.197 — validateManifest is STABLE on unknown input: hostile top-level values and a hostile value at every matrix path return string codes and never throw', () => {
  const HOSTILE: unknown[] = [undefined, null, 'x', 42, true, [], [null], {}, () => 1, Symbol('s'), Number.NaN, new Date(0)];
  for (const top of HOSTILE) {
    let out: string[] = [];
    assert.doesNotThrow(() => { out = validateManifest(top); }, `top-level ${String(typeof top)} must not throw`);
    assert.ok(Array.isArray(out) && out.length > 0 && out.every((c) => typeof c === 'string'), 'a non-manifest yields codes');
  }
  const VALUES: unknown[] = [null, undefined, [], {}, 'x', 0, -1, Number.NaN, Number.POSITIVE_INFINITY, [null], [42], [[]], true, { a: [null] }];
  let tried = 0;
  for (const rule of D17_FIELD_MATRIX) {
    const key = lastKey(rule.path);
    for (const value of VALUES) {
      const m = fixtureFor(rule);
      const parent = parentAt(m, rule.path);
      parent[key.endsWith('[]') ? key.slice(0, -2) : key] = value;
      tried += 1;
      assert.doesNotThrow(() => { validateManifest(m); }, `${rule.path} = ${String(value)} must not throw`);
    }
    // and the WHOLE container replaced by a hostile value, when the path has one
    const segs = rule.path.split('.');
    if (segs.length > 1) {
      for (const value of VALUES) {
        const m = fixtureFor(rule);
        const container = segs[0].endsWith('[]') ? segs[0].slice(0, -2) : segs[0];
        m[container] = value;
        tried += 1;
        assert.doesNotThrow(() => { validateManifest(m); }, `${container} = ${String(value)} must not throw`);
      }
    }
  }
  console.log(`# proof 45: ${tried} hostile placements, none threw`);
  assert.ok(tried > 500);
});

test('45.196 — THE LICENCE\'S FIELDS (v26 §3.4): under hmac_key_absent the four HMAC fields may be NULL but must be PRESENT and correctly TYPED — a missing hmac_key_version no longer validates clean', () => {
  const licensed = (): Obj => {
    const m = asObj(validManifest());
    m.telemetry_error = 'hmac_key_absent';
    m.hmac_key_version = null; nested(m, 'expansion').input_hmac = null;
    m.pre_rerank_passage_hmacs = null; m.scorer_context_hmac = null;
    return m;
  };
  assert.deepEqual(codes(licensed()), [], 'present-and-null under the licence is clean');
  // ABSENT under the licence: each is a defect — the licence covers the value, not the field.
  const a = licensed(); del(a, 'hmac_key_version');
  assert.ok(codes(a).includes('hmac_key_version_field_absent'), 'a MISSING hmac_key_version under the licence is a defect (it validated clean before v26)');
  const b = licensed(); del(nested(b, 'expansion'), 'input_hmac');
  assert.ok(codes(b).includes('expansion_input_hmac_field_absent'));
  const c = licensed(); del(c, 'pre_rerank_passage_hmacs');
  assert.ok(codes(c).includes('pre_rerank_passage_hmacs_field_absent'));
  const d = licensed(); del(d, 'scorer_context_hmac');
  assert.ok(codes(d).includes('scorer_context_hmac_field_absent'));
  // WRONGLY TYPED under the licence: each is a defect.
  const e = licensed(); e.hmac_key_version = 1;
  assert.ok(codes(e).includes('hmac_key_version_absent'), 'a numeric hmac_key_version is not a key version');
  const f = licensed(); nested(f, 'expansion').input_hmac = 7;
  assert.ok(codes(f).includes('expansion_input_hmac_invalid'));
  const g = licensed(); g.pre_rerank_passage_hmacs = 'k1:aa';
  assert.ok(codes(g).includes('pre_rerank_passage_hmacs_absent'));
  const h = licensed(); h.scorer_context_hmac = 99;
  assert.ok(codes(h).includes('scorer_context_hmac_invalid'));
  // The declaration itself is a field with a type: absent, or any other string, is a defect.
  const i = licensed(); del(i, 'telemetry_error');
  assert.ok(codes(i).includes('telemetry_error_field_absent'));
  const j = licensed(); j.telemetry_error = 'hmac_key_missing';
  const out = codes(j);
  assert.ok(out.includes('telemetry_error_invalid'), 'an unrecognised error string is not a licence');
  assert.ok(out.includes('hmac_key_version_absent'), 'and without the licence the null key version is a defect again');
});

// ── 46. expansion.served_route_class null with status skipped is VALID ──────────────────────────

test('46.1 — expansion.served_route_class null with status skipped is valid: no expansion code, so a normative_channel row is not partial by construction', () => {
  const m = asObj(validManifest('normative_channel'));
  m.expansion = { status: 'skipped', input_hmac: null, served_route_class: null, served_model: null, attempts: [] };
  const out = codes(m);
  assert.deepEqual(out, [], `a skipped stage with a null class carries no defect; got [${out.join(', ')}]`);
  // The SAME null on an EXPANDED stage is the defect — the acceptance is conditional on `skipped`,
  // not a blanket tolerance of null.
  const expanded = asObj(validManifest('normative_channel'));
  nested(expanded, 'expansion').served_route_class = null;
  assert.ok(codes(expanded).includes('expansion_served_route_class_absent'), 'null on an expanded stage IS a defect');
  // And absence of the field is never a declaration, skipped or not.
  const missing = asObj(validManifest('normative_channel'));
  missing.expansion = { status: 'skipped', input_hmac: null, served_model: null, attempts: [] };
  assert.ok(codes(missing).includes('expansion_served_route_class_field_absent'));
});

test('46.2 — through the REAL builder: a normative_channel capture (expansion never set — the leg sets skipExpand unconditionally) produces a payload that validates clean', () => {
  const capture = createTelemetryCapture('normative_channel');
  capture.indexVersion = 'embedding|nomic-embed-text';
  const payload = buildRetrievalPayload(capture, { hmacKey: 'proof-46-key', scorerContext: null });
  assert.equal(payload.expansion.status, 'skipped');
  assert.equal(payload.expansion.served_route_class, null);
  assert.deepEqual(payload.expansion.attempts, [], 'and its attempts are [] (v11 §6.1)');
  const stamped = { ...payload, operational: operational('normative_channel') };
  assert.deepEqual(codes(stamped), [], 'the row is NOT partial');
});

// ── 47. The scorer-context HMAC by role ─────────────────────────────────────────────────────────

const KEY = 'proof-47-key';
const payloadFor = (role: RetrievalRole, scorerContext: string | null) => {
  const capture = createTelemetryCapture(role);
  capture.indexVersion = 'embedding|nomic-embed-text';
  // A multi-query run always has its ORIGINAL arm at index 0 (`variants.length` is the generated
  // count + 1), so the one role that carries the section gets that literal arm.
  if (role === 'lab_multi_query') capture.variants = [{ index: 0, outcome: 'success', candidateCount: 3 }];
  return buildRetrievalPayload(capture, { hmacKey: KEY, scorerContext });
};

test('47.1 — on role primary the scorer-context HMAC is REQUIRED: computed over the EXACT citedContext bytes, and it changes when one byte does', () => {
  // The rendered context as assembleAuditContext would hand it over — with its trailing newline
  // kept, so a builder that TRIMMED or normalised before keying is caught here by name.
  const ctx = 'Cited context:\n  [1] passage one.\n  [2] passage two.\n';
  const p = payloadFor('primary', ctx);
  assert.equal(p.scorer_context_hmac, telemetryHmac(KEY, ctx), 'the keyed HMAC of the EXACT rendered context, trailing newline included');
  assert.notEqual(p.scorer_context_hmac, telemetryHmac(KEY, ctx.trim()), 'a trimmed rendering is a different context');
  assert.notEqual(p.scorer_context_hmac, telemetryHmac(KEY, ctx + ' '), 'one appended byte changes it');
  assert.notEqual(p.scorer_context_hmac, telemetryHmac(KEY, ctx.replace(/\n/g, ' ')), 'a whitespace-normalised rendering is a different context');
  assert.match(p.scorer_context_hmac ?? '', /^k1:[0-9a-f]{64}$/, 'versioned, hex digest');
  // Required: a primary row whose HMAC is null (and no hmac_key_absent) is partial.
  const nulled = { ...payloadFor('primary', ctx), scorer_context_hmac: null, operational: operational('primary') };
  assert.ok(codes(nulled).includes('scorer_context_hmac_absent'), 'null on primary is a defect');
});

test('47.2 — the EMPTY-STRING case: zero candidates render an empty citedContext, and the HMAC of the empty string is a DEFINED value — never null because reranking was skipped', () => {
  const p = payloadFor('primary', '');
  assert.equal(typeof p.scorer_context_hmac, 'string');
  assert.equal(p.scorer_context_hmac, telemetryHmac(KEY, ''), 'HMAC("") is a defined value');
  assert.notEqual(p.scorer_context_hmac, telemetryHmac(KEY, ' '), 'and it is not the HMAC of a single space');
  const stamped = { ...p, operational: operational('primary') };
  assert.deepEqual(codes(stamped), [], 'a zero-candidate primary row with the empty-string HMAC is not partial');
});

test('47.3 — on the other FOUR roles the HMAC is null, and those nulls are NOT partial', () => {
  const others: RetrievalRole[] = ['normative_channel', 'lvc_recall', 'lab_direct', 'lab_multi_query'];
  for (const role of others) {
    const p = payloadFor(role, null);
    assert.equal(p.scorer_context_hmac, null, `${role}: null`);
    const stamped = { ...p, operational: operational(role) };
    if (role === 'lab_multi_query') {
      // the multi-query section is required on this role and is present from the builder
      assert.ok(stamped.multi_query, 'lab_multi_query carries its section');
    }
    const out = codes(stamped);
    assert.equal(out.includes('scorer_context_hmac_absent'), false, `${role}: a null HMAC is not a defect`);
    assert.deepEqual(out, [], `${role}: the row is not partial; got [${out.join(', ')}]`);
  }
  // And a context handed to a non-primary role is NOT keyed — the combined-context HMAC lives on the
  // primary row only.
  assert.equal(payloadFor('normative_channel', 'a context the caller should not have supplied').scorer_context_hmac, null);
});

test('47.4 — a NON-NULL scorer-context HMAC on any of the four non-primary roles is REJECTED (v25 §3.3): scorer_context_hmac_on_non_primary_role — and primary is untouched', () => {
  // ⚠️ REPAIRED IN THE PASS 3 REPAIR (Saul review 36 finding 2). Until v25 a non-null HMAC on a
  // normative_channel / lvc_recall / lab_direct / lab_multi_query row validated clean, so a row that
  // claimed a scorer context its leg never rendered was "complete".
  const others: RetrievalRole[] = ['normative_channel', 'lvc_recall', 'lab_direct', 'lab_multi_query'];
  for (const role of others) {
    const m = role === 'lab_multi_query' ? validMultiQueryManifest() : asObj(validManifest(role));
    assert.deepEqual(codes(m), [], `${role}: null HMAC is clean`);
    m.scorer_context_hmac = 'k1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const out = codes(m);
    assert.ok(out.includes('scorer_context_hmac_on_non_primary_role'), `${role}: a non-null HMAC is a defect; got [${out.join(', ')}]`);
    assert.equal(out.includes('scorer_context_hmac_absent'), false, `${role}: and it is not the primary code`);
  }
  // primary: a non-null HMAC is exactly what is required — no code.
  assert.deepEqual(codes(validManifest('primary')), []);
  // and an ABSENT field on a non-primary role stays the field-absent code, not this one.
  const missing = asObj(validManifest('lvc_recall')); del(missing, 'scorer_context_hmac');
  assert.ok(codes(missing).includes('scorer_context_hmac_field_absent'));
});

// ── 47.5 / 47.6: the REAL assembleAuditContext output, and the production caller's handoff ──────
/** Literature and normative hits shaped as `retrieve()` returns them (the same fixtures
 *  opd-normative-channel.test.ts uses); assembleAuditContext renders them into the exact bytes the
 *  scorer sees. */
const lit = (id: number): CiteHit => ({
  id, source: 'statpearls', book: 'StatPearls', chapter: `ch${id}`, section: null,
  page_start: null, page_end: null, item_number: null, chunk_type: 'narrative',
  similarity: 0.5, text: `literature excerpt ${id} about antihistamine montelukast evidence`,
});
const cw = (id: number): CiteHit => ({
  id, source: 'choosing-wisely', book: 'CW-AAFP', chapter: null, section: null,
  page_start: null, page_end: null, item_number: `cwus-${id}`, chunk_type: 'recommendation',
  similarity: 0.6, text: `Avoid prescribing antihistamine+montelukast for viral URTI (statement ${id})`,
});

test('47.5 — through the REAL assembleAuditContext: the primary HMAC is the keyed HMAC of the EXACT rendered citedContext (literature only, and literature plus the normative block), and with zero hits the rendered context is the EMPTY STRING whose HMAC is a defined value', () => {
  // Literature only — the production shape when the normative channel is off.
  const hits = [lit(1), lit(2), lit(3)];
  const a = assembleAuditContext(hits, []);
  assert.ok(a.citedContext.length > 0, 'a non-empty rendered context');
  const pa = payloadFor('primary', a.citedContext);
  assert.equal(pa.scorer_context_hmac, telemetryHmac(KEY, a.citedContext), 'HMAC of exactly what assembleAuditContext rendered');
  assert.notEqual(pa.scorer_context_hmac, telemetryHmac(KEY, hits.map((h) => h.text).join('\n')), 'not the HMAC of the raw passages — the RENDERED context is what the scorer sees');
  // Literature plus the normative block — the channel shape; a different rendering, a different HMAC.
  const b = assembleAuditContext(hits, [cw(101)]);
  assert.notEqual(b.citedContext, a.citedContext);
  const pb = payloadFor('primary', b.citedContext);
  assert.equal(pb.scorer_context_hmac, telemetryHmac(KEY, b.citedContext));
  assert.notEqual(pb.scorer_context_hmac, pa.scorer_context_hmac, 'the normative block changes the keyed bytes');
  // ZERO hits — the case proof 47 names: assembleAuditContext renders the EMPTY STRING and the HMAC
  // of the empty string is a defined value, never null because reranking was skipped.
  const z = assembleAuditContext([], []);
  assert.equal(z.citedContext, '', 'zero candidates render an empty citedContext');
  const pz = payloadFor('primary', z.citedContext);
  assert.equal(pz.scorer_context_hmac, telemetryHmac(KEY, ''), 'HMAC("") is defined and is what the primary row carries');
  assert.equal(typeof pz.scorer_context_hmac, 'string');
  const stamped = { ...pz, operational: operational('primary') };
  assert.deepEqual(codes(stamped), [], 'and that zero-candidate primary row is not partial');
});

test('47.6 — the PRODUCTION CALLER handoff, pinned in comment-stripped source: lib/opd-note-audit.ts destructures citedContext from assembleAuditContext(hits, normHits), passes it into writeRetrievalTerminals, keys the PRIMARY payload with scorerContext: citedContext, the NORMATIVE payload with scorerContext: null, and validates the stamped primary manifest', () => {
  // ⚠️ WHY A SOURCE PIN, AND WHAT IT PROVES. `writeRetrievalTerminals` is module-private and nothing
  // in this repository can drive `auditOpdNote` in-process (it needs a note row, retrieval,
  // embeddings, a live LLM leg and the audit store — recorded in defect-map-delivery.test.ts). This
  // pins that the caller is WRITTEN to hand exactly assembleAuditContext's output to the payload
  // builder; it does not prove the function executes. Comments are stripped first so prose about the
  // handoff cannot satisfy the pin.
  const src = readFileSync('lib/opd-note-audit.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const destructure = src.indexOf('const { sources, citedContext } = assembleAuditContext(hits, normHits);');
  assert.ok(destructure > 0, 'the caller destructures citedContext from assembleAuditContext(hits, normHits)');
  const handoff = src.indexOf('manifestDefectsByRole = await writeRetrievalTerminals({');
  assert.ok(handoff > destructure, 'and hands it to writeRetrievalTerminals AFTER assembling it');
  const handoffBlock = src.slice(handoff, src.indexOf('});', handoff));
  assert.match(handoffBlock, /\bcitedContext,/, 'citedContext is passed by that name — the same bytes, no rendering in between');
  const fn = src.slice(src.indexOf('async function writeRetrievalTerminals('), src.indexOf('export const NORMATIVE_CHANNEL_HEADER'));
  assert.ok(fn.includes("const { tele, publishHandle, traceId, startedAt, citedContext } = args;"), 'writeRetrievalTerminals reads citedContext off its args');
  assert.ok(fn.includes('buildRetrievalPayload(args.primaryCapture, { hmacKey, scorerContext: citedContext })'), 'PRIMARY: scorerContext is exactly citedContext');
  assert.ok(fn.includes('buildRetrievalPayload(args.normativeCapture, { hmacKey, scorerContext: null })'), 'NORMATIVE: scorerContext is null');
  assert.ok(fn.includes('validateManifest({ ...primaryPayload, operational: primaryOperational })'), 'and the stamped primary manifest is validated by the real validator');
  assert.equal((fn.match(/scorerContext:/g) ?? []).length, 2, 'exactly two handoffs — one per role');
});

// ── 47.7 / 47.8 — EXECUTION through the production terminal-payload path (v26 §3.6) ────────────────
/** The production terminal-payload path, driven: real assembleAuditContext output → the SAME
 *  writeRetrievalTerminals production calls (via retrievalTerminalsSeam) → buildRetrievalPayload,
 *  validateManifest and the two terminal UPDATEs, captured at the database transport by the stub. */
async function driveTerminals(hits: CiteHit[], normHits: CiteHit[]) {
  const KEY_ENV = 'CDMSS_TELEMETRY_HMAC_KEY';
  const before = process.env[KEY_ENV];
  process.env[KEY_ENV] = 'proof-47-seam-key';
  try {
    const db = installDbStub();
    db.on(/SET persistence_state = 'retrieval_complete'/, [{ row_revision: 1 }]);
    const { citedContext } = assembleAuditContext(hits, normHits);
    const primaryCapture = createTelemetryCapture('primary');
    primaryCapture.indexVersion = 'embedding|nomic-embed-text';
    const normativeCapture = createTelemetryCapture('normative_channel');
    normativeCapture.indexVersion = 'embedding|nomic-embed-text';
    const handle: LifecycleHandle = {
      invocationId: 'inv-47-seam',
      runs: [lifecycleRun('primary', 'run-47-primary'), lifecycleRun('normative_channel', 'run-47-normative')],
      persistenceIntent: 'will_persist',
    };
    const tele: NonNullable<AuditOpdOpts['telemetry']> = {
      ctx: {
        invocationId: 'inv-47-seam', route: 'opd_audit_worker', routeClass: 'worker', deploymentSha: null,
        vercelRequestId: null, startedAt: '2026-08-18T00:00:00.000Z', routingFlags: {}, labExperimentId: null,
      },
      route: 'opd_audit_worker',
      persistenceIntent: 'will_persist',
    };
    const published: Array<{ handle: LifecycleHandle; defects: ManifestDefectsByRole | undefined }> = [];
    const defects = await retrievalTerminalsSeam.writeRetrievalTerminals({
      tele, handle, publishHandle: (h, d) => { published.push({ handle: h, defects: d }); },
      traceId: null, startedAt: '2026-08-18T00:00:00.000Z', citedContext, primaryCapture, normativeCapture,
    });
    const updates = db.matching(/SET persistence_state = 'retrieval_complete'/);
    return { citedContext, defects, published, updates, key: 'proof-47-seam-key' };
  } finally {
    if (before === undefined) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = before;
  }
}
/** The bound parameters of a captured terminal UPDATE that matter here: $1 run id, $20 context_hmac,
 *  $21 the canonical manifest JSON. */
function terminalParams(u: { params: unknown[] }): { runId: unknown; contextHmac: unknown; manifest: unknown } {
  const manifestText = u.params[20];
  return { runId: u.params[0], contextHmac: u.params[19], manifest: typeof manifestText === 'string' ? JSON.parse(manifestText) : undefined };
}

test('47.7 — EXECUTED through the production terminal-payload path: real assembleAuditContext output → writeRetrievalTerminals (the seam) → the PRIMARY terminal write carries the keyed HMAC of exactly those bytes, the NORMATIVE write carries null, both manifests validate clean, and the handle is published after each', async () => {
  const hits = [lit(1), lit(2), lit(3)];
  const r = await driveTerminals(hits, [cw(101)]);
  assert.ok(r.citedContext.includes('literature excerpt 1') && r.citedContext.includes('statement 101'), 'the real rendered context — literature and the normative block');
  assert.equal(r.updates.length, 2, 'two terminal writes reached the database transport — primary then normative');
  const primary = terminalParams(r.updates[0]);
  const normative = terminalParams(r.updates[1]);
  assert.equal(primary.runId, 'run-47-primary');
  assert.equal(normative.runId, 'run-47-normative');
  assert.equal(primary.contextHmac, telemetryHmac(r.key, r.citedContext), 'PRIMARY: context_hmac is the keyed HMAC of the EXACT assembleAuditContext bytes');
  assert.notEqual(primary.contextHmac, telemetryHmac(r.key, r.citedContext + '\n'), 'one appended byte would be a different context');
  assert.notEqual(primary.contextHmac, telemetryHmac(r.key, hits.map((h) => h.text).join('\n')), 'not the raw passages — the RENDERED context is what the scorer sees');
  assert.equal(normative.contextHmac, null, 'NORMATIVE: null — the combined-context HMAC lives on the primary row');
  assert.ok(isObj(primary.manifest) && isObj(normative.manifest), 'both persisted manifests are objects');
  assert.equal(primary.manifest.scorer_context_hmac, primary.contextHmac, 'the persisted manifest carries the same HMAC as the column');
  assert.equal(normative.manifest.scorer_context_hmac, null);
  assert.deepEqual(validateManifest(primary.manifest), [], 'the persisted primary manifest validates clean');
  assert.deepEqual(validateManifest(normative.manifest), [], 'the persisted normative manifest validates clean');
  assert.deepEqual(r.defects, { primary: [], normative_channel: [] }, 'the caller\'s own verdicts, keyed by role');
  assert.equal(r.published.length, 2, 'the handle was published after each terminal write');
  assert.deepEqual(r.published[0].defects, { primary: [] }, 'the first snapshot holds only the primary verdict');
  assert.deepEqual(r.published[1].defects, { primary: [], normative_channel: [] });
  assert.equal(r.published[1].handle.runs.find((x) => x.role === 'primary')?.expectedRevision, 1, 'the primary run advanced');
});

test('47.8 — EXECUTED, the EMPTY-STRING case: zero hits render an empty citedContext through the production path, and the primary write carries HMAC(""), a defined value — never null', async () => {
  const r = await driveTerminals([], []);
  assert.equal(r.citedContext, '');
  const primary = terminalParams(r.updates[0]);
  assert.equal(primary.contextHmac, telemetryHmac(r.key, ''), 'HMAC of the empty string, from the production path');
  assert.equal(typeof primary.contextHmac, 'string');
  assert.deepEqual(r.defects, { primary: [], normative_channel: [] }, 'a zero-candidate primary row is not partial');
});

// ── 49. The four D17 edge cases ─────────────────────────────────────────────────────────────────

/** Every edge case shares this shape: expected 0, recorded 0, no batch, backend and model 'none',
 *  served backend null, no soft failure, no rerank attribution anywhere, and validates clean. */
function assertEdgeShape(role: RetrievalRole, payload: ReturnType<typeof buildRetrievalPayload>, label: string) {
  assert.equal(payload.expected_batch_count, 0, `${label}: expected 0`);
  assert.equal(payload.recorded_rerank_batches, 0, `${label}: recorded 0`);
  assert.deepEqual(payload.batches, [], `${label}: batches []`);
  assert.equal(payload.intended_backend, 'none', `${label}: intended backend none`);
  assert.equal(payload.intended_model, 'none', `${label}: intended model none`);
  assert.equal(payload.served_backend, null, `${label}: no rerank request was made`);
  assert.equal(payload.rerank_backend_downgraded, false);
  assert.equal(payload.rerank_soft_failed, false);
  const c = batchCounters(payload);
  assert.equal(c.unattributed + c.not_served + c.vertex + c.openrouter + c.local, 0, `${label}: none is unattributed — nothing is attributed at all`);
  const stamped = { ...payload, operational: operational(role) };
  assert.deepEqual(codes(stamped), [], `${label}: validates clean; got [${codes(stamped).join(', ')}]`);
}

test('49.1 — EMPTY FUSION: retrieve() returns before the rerank block exists — fused 0, hydrated 0, expected 0, recorded 0, batches [], backend and model none', () => {
  const capture = createTelemetryCapture('primary');
  capture.indexVersion = 'embedding|nomic-embed-text';
  const p = buildRetrievalPayload(capture, { hmacKey: KEY, scorerContext: '' });
  assert.equal(p.fused_candidate_count, 0);
  assert.equal(p.hydrated_candidate_count, 0);
  assert.deepEqual(p.fused_candidate_ids, []);
  assert.deepEqual(p.hydrated_candidate_ids, []);
  assert.deepEqual(p.pre_rerank_passage_hmacs, [], 'zero hydrated rows, zero passage HMACs');
  assertEdgeShape('primary', p, 'empty fusion');
});

test('49.2 — HYDRATE EMPTIED: fused > 0, hydrated 0 — the same shape, and the TWO COUNTS DIFFER, which is the point', () => {
  const capture = createTelemetryCapture('primary');
  capture.indexVersion = 'embedding|nomic-embed-text';
  capture.fusedCandidateIds = [41, 42, 43];
  capture.hydratedCandidateIds = [];
  capture.passageTexts = [];
  const p = buildRetrievalPayload(capture, { hmacKey: KEY, scorerContext: '' });
  assert.equal(p.fused_candidate_count, 3, 'the pool after the cap');
  assert.equal(p.hydrated_candidate_count, 0, 'what the re-read returned');
  assert.notEqual(p.fused_candidate_count, p.hydrated_candidate_count, 'a dropped row is OBSERVABLE');
  assert.deepEqual(p.fused_candidate_ids, [41, 42, 43]);
  assert.deepEqual(p.hydrated_candidate_ids, []);
  assert.deepEqual(p.pre_rerank_passage_hmacs, [], 'one per HYDRATED row — none');
  assertEdgeShape('primary', p, 'hydrate emptied');
});

test('49.3 — the two zero-candidate shapes are DISTINGUISHABLE: empty fusion (0/0) and hydrate emptied (3/0) differ in fused_candidate_count and agree in hydrated_candidate_count', () => {
  const emptied = createTelemetryCapture('primary');
  emptied.indexVersion = 'embedding|nomic-embed-text';
  emptied.fusedCandidateIds = [41, 42, 43];
  const a = buildRetrievalPayload(createTelemetryCapture('primary'), { hmacKey: KEY, scorerContext: '' });
  const b = buildRetrievalPayload(emptied, { hmacKey: KEY, scorerContext: '' });
  assert.equal(a.hydrated_candidate_count, b.hydrated_candidate_count, 'both hydrated 0');
  assert.notEqual(a.fused_candidate_count, b.fused_candidate_count, 'but the fused counts differ — 0 and 3');
  assert.equal(a.fused_candidate_count, 0);
  assert.equal(b.fused_candidate_count, 3);
});

test('49.4 — ONE HYDRATED CANDIDATE: rerank() is never entered — hydrated 1, expected 0, recorded 0, batches [], backend and model none', () => {
  const capture = createTelemetryCapture('primary');
  capture.indexVersion = 'embedding|nomic-embed-text';
  capture.fusedCandidateIds = [7];
  capture.hydratedCandidateIds = [7];
  capture.passageTexts = ['the one passage'];
  capture.orderedFinalCandidateIds = [7];
  const p = buildRetrievalPayload(capture, { hmacKey: KEY, scorerContext: 'Cited context: the one passage' });
  assert.equal(p.hydrated_candidate_count, 1);
  assert.equal(p.fused_candidate_count, 1);
  assert.equal(p.pre_rerank_passage_hmacs?.length, 1, 'one passage HMAC for the one hydrated row');
  assert.deepEqual(p.ordered_final_candidate_ids, [7]);
  assert.notEqual(p.scorer_context_hmac, null, 'with one candidate the context is non-empty and keyed');
  assertEdgeShape('primary', p, 'one hydrated candidate');
});

test('49.5 — RERANKER DISABLED (normative_channel always; lab_direct when the caller sets it): several hydrated candidates, the same shape as the one-candidate case', () => {
  const disabledRoles: RetrievalRole[] = ['normative_channel', 'lab_direct'];
  for (const role of disabledRoles) {
    const capture = createTelemetryCapture(role);
    capture.indexVersion = 'embedding|nomic-embed-text';
    capture.fusedCandidateIds = [21, 22, 23, 24];
    capture.hydratedCandidateIds = [21, 22, 23, 24];
    capture.passageTexts = ['p1', 'p2', 'p3', 'p4'];
    capture.orderedFinalCandidateIds = [21, 22, 23, 24];
    const p = buildRetrievalPayload(capture, { hmacKey: KEY, scorerContext: null });
    assert.equal(p.hydrated_candidate_count, 4, `${role}: four hydrated`);
    assert.equal(p.pre_rerank_passage_hmacs?.length, 4);
    assert.equal(p.scorer_context_hmac, null, `${role}: no scorer HMAC off primary`);
    assertEdgeShape(role, p, `reranker disabled on ${role}`);
  }
});
