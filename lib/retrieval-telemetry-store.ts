/**
 * lib/retrieval-telemetry-store.ts — the durable retrieval lifecycle.
 * On-path kickoff D10, D11, D12. PRD v2.1 §4.5.
 *
 * ⚠️ THE AUDIT WRITE AND THE FINAL TELEMETRY LINK ARE NOT TRANSACTIONAL, AND CANNOT BE HERE.
 * lib/db.ts exports `sql` as a Proxy with only an `apply` trap over a bare function target, so the
 * driver's own `transaction` method is not reachable — and even if it were, it could not span the
 * application logic between the audit insert and the telemetry link. What replaces atomicity is
 * stated rather than assumed: idempotent updates, an explicit revision guard, and a reconciler.
 * Nothing in this module claims atomicity, and the build report declares this as a declaration.
 *
 * ⚠️ NOTHING MUTATES IN PLACE. Every write returns an UPDATED handle. A caller holding a stale
 * handle is rejected by the revision guard rather than silently overwriting a newer result.
 */

import { sql } from './db';
import {
  TELEMETRY_SCHEMA_VERSION, canonicalJson, isAllowedTransition, isTerminalState,
  COLUMN_CLASSIFICATION,
  type RetrievalRole, type RetrievalPersistenceState, type TelemetryRequestContext,
  type StampedRetrievalManifest, type RetrievalPayload, type OperationalTelemetry,
} from './retrieval-telemetry-core';
import { counterColumns, errorClassOf } from './retrieval-capture';
import { recordTelemetryFailure } from './retrieval-telemetry-failure-store';
import { bumpTelemetryWriteFailure, addDeclaredRetrievals } from './retrieval-invocation-store';

const appSource = () => process.env.APP_SOURCE || 'standalone';

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE HANDLE (D12)
// ════════════════════════════════════════════════════════════════════════════════════════════════

export interface LifecycleRun {
  role: RetrievalRole;
  runId: string;
  expectedRevision: number;
}

export interface LifecycleHandle {
  invocationId: string;
  runs: LifecycleRun[];
  /** Declared UP FRONT by the caller, not inferred from the role: the run route's POST arm audits
   *  and never saves, and no property of `primary` could have told us that. */
  persistenceIntent: 'will_persist' | 'never_persists';
}

export interface PerRunSettlementResult {
  role: RetrievalRole;
  runId: string;
  status: 'settled' | 'failed';
  errorClass?: string;
}

/** Run ids allocated by the WORKER before `auditOpdNote` is entered (D10). Threaded in and
 *  ADOPTED — never reallocated, never a second `started` row. */
export interface PredeclaredTelemetryRuns {
  primary: { runId: string; expectedRevision: 0 };
  normativeChannel?: { runId: string; expectedRevision: 0 };
}

/** Thrown by the worker's fail-closed declaration. Its own class so the route-level catch can
 *  return 503 rather than the generic 500 (D10). */
export class TelemetryDeclarationError extends Error {
  constructor(message: string) { super(message); this.name = 'TelemetryDeclarationError'; }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// DECLARE (§4.5 step 1)
// ════════════════════════════════════════════════════════════════════════════════════════════════

export interface DeclareInput {
  role: RetrievalRole;
  runId: string;
  uid: string | null;
  engineVersion: string | null;
  experimentRunId?: string | null;
  pairId?: string | null;
  replicate?: string | null;
}

/**
 * Insert every run as `started`, in ONE statement, before any provider work.
 *
 * ⚠️ THE MULTI-ROW SHAPE IS DELIBERATE. A per-note insert inside `mapLimit` would put a round trip
 * before every note's retrieval and would make a partial declaration possible — half the day's
 * notes durable and half not, with nothing recording which half.
 *
 * ⚠️ `retrieval_outcome` IS OMITTED, NOT NULLED-AND-SET. The outcome CHECK requires it to be NULL
 * in state `started`, which is exactly right: the worker declares before retrieval begins and has
 * nothing to report yet.
 */
export async function declareRetrievals(
  ctx: TelemetryRequestContext,
  runs: DeclareInput[],
  persistenceIntent: LifecycleHandle['persistenceIntent'],
): Promise<LifecycleHandle> {
  if (runs.length === 0) {
    return { invocationId: ctx.invocationId, runs: [], persistenceIntent };
  }
  const cols = 12;
  const values = runs.map((_, i) => {
    const b = i * cols;
    return `(${Array.from({ length: cols }, (_, k) => `$${b + k + 1}`).join(', ')})`;
  }).join(', ');
  const params: unknown[] = [];
  for (const r of runs) {
    params.push(
      r.runId, r.role, ctx.route, ctx.invocationId, appSource(), ctx.deploymentSha,
      TELEMETRY_SCHEMA_VERSION, 'started', ctx.startedAt, r.uid, r.engineVersion,
      r.experimentRunId ?? null,
    );
  }
  await sql(
    `INSERT INTO opd_audit_retrieval_telemetry
       (retrieval_run_id, retrieval_role, route, invocation_id, app_source, deployment_sha,
        telemetry_schema_version, persistence_state, started_at, uid, engine_version, experiment_run_id)
     VALUES ${values}
     ON CONFLICT (retrieval_run_id) DO NOTHING`,
    params,
  );
  await addDeclaredRetrievals(ctx.invocationId, runs.length);
  return {
    invocationId: ctx.invocationId,
    runs: runs.map((r) => ({ role: r.role, runId: r.runId, expectedRevision: 0 })),
    persistenceIntent,
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// TERMINAL WRITE (§4.5 step 3)
// ════════════════════════════════════════════════════════════════════════════════════════════════

export interface TerminalWriteInput {
  payload: RetrievalPayload;
  operational: OperationalTelemetry;
  /** Written HERE, not at declaration: the worker declares before `startTrace` runs, and two
   *  retrieving callers pass `trace: false` and carry null for the whole of their life (D10). */
  traceId: string | null;
  completedAt: string;
}

/**
 * Write one role's terminal manifest and move it to `retrieval_complete`. Returns an updated
 * handle whose revision has advanced for that role alone — revisions advance PER ROLE, so a
 * normative-channel write cannot invalidate the primary caller's handle.
 */
export async function writeRetrievalTerminal(
  handle: LifecycleHandle,
  role: RetrievalRole,
  input: TerminalWriteInput,
): Promise<LifecycleHandle> {
  const run = handle.runs.find((r) => r.role === role);
  if (!run) throw new Error(`writeRetrievalTerminal: no declared run for role ${role}`);

  const manifest: StampedRetrievalManifest = { ...input.payload, operational: input.operational };
  const counters = counterColumns(input.payload);

  try {
    const updated = (await sql(
      `UPDATE opd_audit_retrieval_telemetry
          SET persistence_state = 'retrieval_complete',
              retrieval_outcome = $3,
              retrieval_error_class = $4,
              completed_at = $5,
              trace_id = $6,
              expansion_status = $7,
              expansion_route_class = $8,
              expansion_served_model = $9,
              expansion_attempts = $10::jsonb,
              rerank_route_class = $11,
              expected_rerank_batches = $12,
              recorded_rerank_batches = $13,
              served_backend = $14,
              rerank_backend_downgraded = $15,
              rerank_soft_failed = $16,
              fused_candidate_count = $17,
              hydrated_candidate_count = $18,
              index_version = $19,
              context_hmac = $20,
              retrieval_manifest = $21::jsonb,
              telemetry_error = $22,
              active_backfill_run_id = $23,
              active_backfill_target = $24,
              active_backfill_state = $25,
              rerank_vertex_batches = $26,
              rerank_openrouter_batches = $27,
              rerank_local_batches = $28,
              rerank_failed_batches = $29,
              rerank_unattributed_batches = $30,
              rerank_not_served_batches = $31,
              rerank_429_attempts = $32,
              row_revision = row_revision + 1
        WHERE retrieval_run_id = $1
          AND row_revision = $2
          AND persistence_state = 'started'
        RETURNING row_revision`,
      [
        run.runId, run.expectedRevision,
        input.payload.retrieval_outcome, input.payload.retrieval_error_class,
        input.completedAt, input.traceId,
        input.payload.expansion.status, input.payload.expansion.served_route_class,
        input.payload.expansion.served_model,
        input.payload.expansion.attempts === null ? null : JSON.stringify(input.payload.expansion.attempts),
        rerankRouteClassOf(input.payload),
        input.payload.expected_batch_count, input.payload.recorded_rerank_batches,
        input.payload.served_backend, input.payload.rerank_backend_downgraded,
        input.payload.rerank_soft_failed,
        input.payload.fused_candidate_count, input.payload.hydrated_candidate_count,
        input.payload.index_version, input.payload.scorer_context_hmac,
        canonicalJson(manifest), input.payload.telemetry_error,
        input.operational.active_backfill_run_id, input.operational.active_backfill_target,
        input.operational.active_backfill_state,
        counters.rerank_vertex_batches, counters.rerank_openrouter_batches,
        counters.rerank_local_batches, counters.rerank_failed_batches,
        counters.rerank_unattributed_batches, counters.rerank_not_served_batches,
        counters.rerank_429_attempts,
      ],
    )) as Array<{ row_revision: number }>;

    if (updated.length === 0) {
      // Revision mismatch, or the row is no longer `started`. NEVER RETRIED BLINDLY (D12): a blind
      // retry is how an old invocation overwrites a newer terminal result.
      console.warn('[retrieval-telemetry] terminal write rejected (revision or state moved)', role);
      return handle;
    }
    return advance(handle, role, updated[0].row_revision);
  } catch (e) {
    await failEvidence(handle.invocationId, run, 'retrieval_terminal', 'retrieval_complete', e, input.completedAt);
    return handle;
  }
}

/** The single served class the ROW carries for reranking. The per-batch detail lives in the
 *  manifest; this is the row-level summary a census groups by. */
function rerankRouteClassOf(p: RetrievalPayload): string | null {
  if (p.batches.length === 0) return null;
  const classes = new Set(p.batches.map((b) => b.served_route_class ?? 'unattributed'));
  return classes.size === 1 ? [...classes][0] : 'mixed';
}

function advance(handle: LifecycleHandle, role: RetrievalRole, revision: number): LifecycleHandle {
  return {
    ...handle,
    runs: handle.runs.map((r) => (r.role === role ? { ...r, expectedRevision: revision } : r)),
  };
}

/** Write failure evidence, and fall back to the invocation counter when even that fails (D12). */
async function failEvidence(
  invocationId: string,
  run: LifecycleRun,
  phase: 'retrieval_terminal' | 'persistence_link' | 'work_declaration',
  intended: RetrievalPersistenceState | null,
  e: unknown,
  observedAt: string,
): Promise<void> {
  const ok = await recordTelemetryFailure({
    invocationId, retrievalRunId: run.runId, retrievalRole: run.role,
    failedPhase: phase, intendedState: intended, errorClass: errorClassOf(e), observedAt,
  });
  if (!ok) await bumpTelemetryWriteFailure(invocationId);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE UPDATE PRECEDENCE (D12) — no-op, then revision, then transition, then apply
// ════════════════════════════════════════════════════════════════════════════════════════════════

export interface SettleWriteInput {
  state: RetrievalPersistenceState;
  auditId: string | null;
  settledAt: string;
}

/**
 * Apply a terminal state to one run, in D12's EXACT precedence order.
 *
 *   1. identical-content no-op  — does NOT increment row_revision
 *   2. expected-revision check  — rejected and logged on mismatch, never retried blindly
 *   3. transition check         — terminal states never transition
 *   4. apply, and increment
 *
 * The order matters. Checking the revision first would burn a revision on a write that changed
 * nothing, and a retry that changed nothing would then look like a conflict to the next caller.
 */
export async function applyTerminalState(
  handle: LifecycleHandle,
  run: LifecycleRun,
  input: SettleWriteInput,
): Promise<{ handle: LifecycleHandle; status: 'settled' | 'noop' | 'rejected' | 'failed'; errorClass?: string }> {
  try {
    const current = (await sql(
      `SELECT persistence_state, row_revision, audit_id
         FROM opd_audit_retrieval_telemetry
        WHERE retrieval_run_id = $1`,
      [run.runId],
    )) as Array<{ persistence_state: string; row_revision: number; audit_id: string | null }>;

    if (current.length === 0) {
      console.warn('[retrieval-telemetry] settlement found no row', run.runId);
      return { handle, status: 'rejected' };
    }
    const row = current[0];

    // 1. IDENTICAL CONTENT — a retry of a write that already landed. No revision is burned.
    if (row.persistence_state === input.state && row.audit_id === input.auditId) {
      return { handle, status: 'noop' };
    }
    // 2. REVISION
    if (row.row_revision !== run.expectedRevision) {
      console.warn('[retrieval-telemetry] settlement rejected: stale handle',
        run.role, `expected ${run.expectedRevision}, found ${row.row_revision}`);
      return { handle, status: 'rejected' };
    }
    // 3. TRANSITION — terminal states never transition, and the table is the only authority.
    if (isTerminalState(row.persistence_state)) {
      console.warn('[retrieval-telemetry] settlement rejected: already terminal', row.persistence_state);
      return { handle, status: 'rejected' };
    }
    if (!isAllowedTransition(row.persistence_state, input.state)) {
      console.warn('[retrieval-telemetry] settlement rejected: disallowed transition',
        `${row.persistence_state} -> ${input.state}`);
      return { handle, status: 'rejected' };
    }
    // 4. APPLY
    const updated = (await sql(
      `UPDATE opd_audit_retrieval_telemetry
          SET persistence_state = $3, audit_id = $4, persistence_settled_at = $5,
              row_revision = row_revision + 1
        WHERE retrieval_run_id = $1 AND row_revision = $2
        RETURNING row_revision`,
      [run.runId, run.expectedRevision, input.state, input.auditId, input.settledAt],
    )) as Array<{ row_revision: number }>;
    if (updated.length === 0) return { handle, status: 'rejected' };
    return { handle: advance(handle, run.role, updated[0].row_revision), status: 'settled' };
  } catch (e) {
    await failEvidence(handle.invocationId, run, 'persistence_link', input.state, e, input.settledAt);
    return { handle, status: 'failed', errorClass: errorClassOf(e) };
  }
}

/** The projection the identical-content check compares, derived from the DDL and classified in
 *  COLUMN_CLASSIFICATION. Exported so the test can assert the classification is total rather than
 *  a list somebody remembered to keep up to date. */
export const EQUALITY_PROJECTION = COLUMN_CLASSIFICATION.mutable_terminal;
