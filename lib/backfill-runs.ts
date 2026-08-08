/**
 * lib/backfill-runs.ts — the `backfill_runs` store (Bedrock PRD §4.3, S2).
 *
 * IMPURE HALF. Every decision lives in lib/backfill-runs-core.ts; this file only reads and writes.
 * The table is created idempotently on first use — the `mini_backfill_ticks` pattern, no migration
 * file, no deploy ordering to get wrong.
 */
import { sql } from './db';
import {
  type BackfillRun, type BackfillWorker, type RunStatus, type RunCreatePlan,
} from './backfill-runs-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** Exported for the schema test: the DDL is the PRD's, verbatim in shape. */
export const BACKFILL_RUNS_DDL = `CREATE TABLE IF NOT EXISTS backfill_runs (
  id           BIGSERIAL PRIMARY KEY,
  worker       TEXT NOT NULL,
  model        TEXT NOT NULL,
  day_from     DATE NOT NULL,
  day_to       DATE NOT NULL,
  cursor       DATE,
  n_per_tick   INT NOT NULL DEFAULT 4,
  status       TEXT NOT NULL DEFAULT 'active',
  source       TEXT NOT NULL DEFAULT 'admin',
  notes_done   INT NOT NULL DEFAULT 0,
  notes_failed INT NOT NULL DEFAULT 0,
  tokens_in    BIGINT NOT NULL DEFAULT 0,
  tokens_out   BIGINT NOT NULL DEFAULT 0,
  cost_usd     NUMERIC(12,4) NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

let ensured = false;

export async function ensureRunsTable(): Promise<void> {
  if (ensured) return;
  await run(BACKFILL_RUNS_DDL);
  // One active run per worker is enforced in code (canStartRun) AND here, so a concurrent second
  // start loses at the database rather than producing two runs writing the same day range.
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS backfill_runs_one_active_idx
             ON backfill_runs (worker) WHERE status = 'active'`).catch(() => {});
  await run(`CREATE INDEX IF NOT EXISTS backfill_runs_worker_created_idx ON backfill_runs (worker, created_at DESC)`).catch(() => {});
  ensured = true;
}

const SELECT_COLS = `id, worker, model, to_char(day_from, 'YYYY-MM-DD') AS day_from,
  to_char(day_to, 'YYYY-MM-DD') AS day_to, to_char(cursor, 'YYYY-MM-DD') AS cursor,
  n_per_tick, status, source, notes_done, notes_failed, tokens_in, tokens_out,
  cost_usd, last_error, created_at, updated_at`;

function toRun(r: Record<string, unknown>): BackfillRun {
  return {
    id: Number(r.id),
    worker: String(r.worker) as BackfillWorker,
    model: String(r.model),
    day_from: String(r.day_from),
    day_to: String(r.day_to),
    cursor: r.cursor == null ? null : String(r.cursor),
    n_per_tick: Number(r.n_per_tick ?? 4),
    status: String(r.status) as RunStatus,
    source: String(r.source) === 'mcp' ? 'mcp' : 'admin',
    notes_done: Number(r.notes_done ?? 0),
    notes_failed: Number(r.notes_failed ?? 0),
    tokens_in: Number(r.tokens_in ?? 0),
    tokens_out: Number(r.tokens_out ?? 0),
    cost_usd: Number(r.cost_usd ?? 0),
    last_error: r.last_error == null ? null : String(r.last_error),
  };
}

/** The one active run for a worker, or null. */
export async function activeRun(worker: BackfillWorker): Promise<BackfillRun | null> {
  await ensureRunsTable();
  const rows = await run(
    `SELECT ${SELECT_COLS} FROM backfill_runs WHERE worker = $1 AND status = 'active' ORDER BY id DESC LIMIT 1`,
    [worker],
  );
  return rows?.[0] ? toRun(rows[0]) : null;
}

/** The run a control action targets: the active one, else the most recent non-terminal one. */
export async function currentRun(worker: BackfillWorker): Promise<BackfillRun | null> {
  await ensureRunsTable();
  const rows = await run(
    `SELECT ${SELECT_COLS} FROM backfill_runs WHERE worker = $1
      ORDER BY (status IN ('active','paused','error')) DESC, id DESC LIMIT 1`,
    [worker],
  );
  return rows?.[0] ? toRun(rows[0]) : null;
}

export async function getRun(id: number): Promise<BackfillRun | null> {
  await ensureRunsTable();
  const rows = await run(`SELECT ${SELECT_COLS} FROM backfill_runs WHERE id = $1`, [id]);
  return rows?.[0] ? toRun(rows[0]) : null;
}

export async function recentRuns(worker: BackfillWorker | null, limit = 20): Promise<BackfillRun[]> {
  await ensureRunsTable();
  const lim = Math.max(1, Math.min(100, limit));
  const rows = worker
    ? await run(`SELECT ${SELECT_COLS} FROM backfill_runs WHERE worker = $1 ORDER BY id DESC LIMIT ${lim}`, [worker])
    : await run(`SELECT ${SELECT_COLS} FROM backfill_runs ORDER BY id DESC LIMIT ${lim}`);
  return rows.map(toRun);
}

/** Insert a validated plan. The partial unique index is the second line of defence against a
 *  concurrent double-start; a violation surfaces as a thrown error the caller reports typed. */
export async function createRun(plan: Extract<RunCreatePlan, { ok: true }>): Promise<BackfillRun> {
  await ensureRunsTable();
  const rows = await run(
    `INSERT INTO backfill_runs (worker, model, day_from, day_to, cursor, n_per_tick, source)
     VALUES ($1,$2,$3::date,$4::date,$5::date,$6,$7) RETURNING ${SELECT_COLS}`,
    [plan.worker, plan.model, plan.dayFrom, plan.dayTo, plan.cursor, plan.nPerTick, plan.source],
  );
  return toRun(rows[0]);
}

export async function setRunStatus(id: number, status: RunStatus, lastError?: string | null): Promise<void> {
  await ensureRunsTable();
  await run(
    `UPDATE backfill_runs SET status = $2, updated_at = NOW(),
            last_error = COALESCE($3, last_error) WHERE id = $1`,
    [id, status, lastError ?? null],
  );
}

/** Advance the cursor and (optionally) the status in one write, so a tick can never leave a run
 *  with a marched cursor but a stale status. */
export async function setRunCursor(id: number, cursor: string, status: RunStatus): Promise<void> {
  await ensureRunsTable();
  await run(
    `UPDATE backfill_runs SET cursor = $2::date, status = $3, updated_at = NOW() WHERE id = $1`,
    [id, cursor, status],
  );
}

/**
 * Per-run accounting (§4.3.7). Written as an in-SQL increment rather than read-modify-write: two
 * ticks that overlap (the soft lock is soft) must not lose each other's counts.
 */
export async function addRunProgress(
  id: number,
  d: { processed?: number; failed?: number; tokensIn?: number; tokensOut?: number; costUsd?: number; lastError?: string | null },
): Promise<void> {
  await ensureRunsTable();
  const n = (v: unknown) => Math.max(0, Number.isFinite(Number(v)) ? Number(v) : 0);
  await run(
    `UPDATE backfill_runs
        SET notes_done   = notes_done   + $2,
            notes_failed = notes_failed + $3,
            tokens_in    = tokens_in    + $4,
            tokens_out   = tokens_out   + $5,
            cost_usd     = cost_usd     + $6,
            last_error   = COALESCE($7, last_error),
            updated_at   = NOW()
      WHERE id = $1`,
    [id, n(d.processed), n(d.failed), n(d.tokensIn), n(d.tokensOut), n(d.costUsd), d.lastError ?? null],
  );
}

/**
 * The per-note usage the run accounting needs, read off the ENVELOPE COLUMNS of this note's own
 * trace (`tokens_in` / `tokens_out`, written by tracedChat's buildEnvelope).
 *
 * ⚠️ COLUMNS, NOT PAYLOAD. `payload` is the PHI-bearing column — it holds the prompt and the model's
 * output — and lib/sql-guard-core.ts blocks it from the lab surfaces for that reason. The envelope
 * columns exist precisely so spend can be counted without reading clinical text.
 *
 * Best-effort: a failure returns zeros, which understates a run's cost rather than failing a note
 * that has already been graded and stored. That asymmetry is deliberate and is noted on the console
 * card in S3.
 */
export async function usageForTrace(traceId: string | null | undefined, stage = 'opd_audit_analyze'): Promise<{ tokensIn: number; tokensOut: number }> {
  if (!traceId) return { tokensIn: 0, tokensOut: 0 };
  try {
    const rows = await run(
      `SELECT COALESCE(SUM(tokens_in), 0)::bigint AS t_in, COALESCE(SUM(tokens_out), 0)::bigint AS t_out
         FROM trace_events
        WHERE trace_id = $1 AND kind IN ('llm_response', 'llm_stream_usage') AND stage = $2`,
      [traceId, stage],
    );
    return { tokensIn: Number(rows?.[0]?.t_in ?? 0) || 0, tokensOut: Number(rows?.[0]?.t_out ?? 0) || 0 };
  } catch { return { tokensIn: 0, tokensOut: 0 }; }
}
