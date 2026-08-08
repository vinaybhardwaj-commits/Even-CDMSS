/**
 * lib/backfill-runs-core.ts — PURE run-state decisions for the backfill experiment runner
 * (Bedrock PRD §4.3, S2, 7 Aug 2026). No db, no Next, no clients.
 *
 * WHAT REPLACED WHAT. The autopilot this supersedes kept its state in `app_settings` strings —
 * enabled/window/cursor/floor/tag/n — and made its decisions inline in the route. That worked while
 * there was exactly one sweep, on one model, forever. A RUN is a different object: it is bounded
 * (a day range), attributed (one model), accounted (tokens, cost), and there may be a history of
 * them. Its decisions are worth stating once, purely, where they can be tested against a table of
 * cases instead of against a cron.
 *
 * THE CONTRACT is PRD §4.3.1–§4.3.9. The pieces that live here are the ones with a decision in
 * them: which run a tick works, where the cursor goes next, when a run is done, and what may be
 * started. Everything requiring a database lives in lib/backfill-runs.ts.
 */

export type BackfillWorker = 'opd' | 'ipd';
export type RunStatus = 'active' | 'paused' | 'done' | 'stopped' | 'error';

/** One row of `backfill_runs`, as the runner reads it. Mirrors the PRD's DDL. */
export interface BackfillRun {
  id: number;
  worker: BackfillWorker;
  /** The full `bedrock:<modelId>` string, as requested. Attribution lives here, not in the label. */
  model: string;
  /** Oldest day, inclusive. The run is done when the cursor passes BELOW this. */
  day_from: string;
  /** Newest day, inclusive. The cursor STARTS here and marches backwards. */
  day_to: string;
  cursor: string | null;
  n_per_tick: number;
  status: RunStatus;
  source: 'admin' | 'mcp';
  notes_done: number;
  notes_failed: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  last_error: string | null;
}

// ── day arithmetic ──────────────────────────────────────────────────────────────────────────────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(s: unknown): s is string {
  const v = String(s ?? '');
  if (!DAY_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
}

/** The previous calendar day. UTC arithmetic on a date-only string — no timezone drift. */
export function prevDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── run creation ────────────────────────────────────────────────────────────────────────────────

/** ⚠️ 1..8 (PRD §4.3), default 4. Junk degrades to the default, never to 0 — a run that quietly
 *  processes no notes per tick looks identical to a stuck one. */
export function clampNPerTick(n: unknown): number {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v) || v < 1) return 4;
  return Math.min(8, v);
}

export interface RunCreateInput {
  worker?: unknown;
  model?: unknown;
  dayFrom?: unknown;
  dayTo?: unknown;
  nPerTick?: unknown;
  source?: unknown;
}

export type RunCreatePlan =
  | { ok: true; worker: BackfillWorker; model: string; dayFrom: string; dayTo: string; nPerTick: number; source: 'admin' | 'mcp'; cursor: string }
  | { ok: false; error: string };

/**
 * Validate a run request. ERRORS LOUD, NEVER NORMALISES A MISTAKE AWAY.
 *
 * ⚠️ `bedrock:` ONLY (PRD decision 2). Qwen is retired from backfill and ollama is not a valid run
 * model; vertex/openrouter runs are out of scope for v1. This is checked here rather than at the
 * call site so the reason travels with the refusal: a run is an EXPERIMENT, and an experiment whose
 * model was silently substituted is worthless. Reachability is a separate, impure check the caller
 * makes before insert — a resolvable model that cannot be reached must not become an active run.
 *
 * THE CURSOR STARTS AT day_to and marches BACKWARDS (§4.3.2), so a run always begins with the most
 * recent day in its range — the days most likely to matter if the run is stopped early.
 */
export function planRunCreate(i: RunCreateInput): RunCreatePlan {
  const worker = String(i.worker ?? 'opd').trim().toLowerCase();
  if (worker !== 'opd' && worker !== 'ipd') return { ok: false, error: `unknown worker '${worker}' — expected 'opd' or 'ipd'` };

  const model = String(i.model ?? '').trim();
  if (!model) return { ok: false, error: 'model is required — a run must name the model it attributes its rows to' };
  if (!model.toLowerCase().startsWith('bedrock:')) {
    return { ok: false, error: `run model '${model}' is not a bedrock model — backfill runs accept 'bedrock:<modelId>' only (qwen is retired from backfill; ollama/vertex/openrouter runs are out of scope). Never falls back.` };
  }
  if (!model.slice('bedrock:'.length).trim()) return { ok: false, error: "model id missing after 'bedrock:'" };

  const dayFrom = String(i.dayFrom ?? '').trim();
  const dayTo = String(i.dayTo ?? '').trim();
  if (!isDay(dayFrom)) return { ok: false, error: `dayFrom '${dayFrom}' is not a YYYY-MM-DD calendar day` };
  if (!isDay(dayTo)) return { ok: false, error: `dayTo '${dayTo}' is not a YYYY-MM-DD calendar day` };
  if (dayFrom > dayTo) return { ok: false, error: `dayFrom ${dayFrom} is after dayTo ${dayTo} — the range marches backwards from dayTo to dayFrom` };

  const source = String(i.source ?? 'admin').trim().toLowerCase() === 'mcp' ? 'mcp' : 'admin';
  return { ok: true, worker: worker as BackfillWorker, model, dayFrom, dayTo, nPerTick: clampNPerTick(i.nPerTick), source, cursor: dayTo };
}

/**
 * §4.3.1 — ONE ACTIVE RUN PER WORKER. Starting while one is active is a typed error, never a
 * queue-jump: serial runs are what keep attribution and the console graph readable, and two runs
 * writing prod-line rows over overlapping days would make "which model graded this day" unanswerable
 * from the run table.
 */
export function canStartRun(active: Pick<BackfillRun, 'id' | 'model' | 'status'> | null | undefined): { ok: true } | { ok: false; error: string } {
  if (!active) return { ok: true };
  return {
    ok: false,
    error: `a run is already ${active.status} for this worker (run ${active.id}, model ${active.model}) — stop or pause it first. Runs are serial by design; this is not a queue.`,
  };
}

// ── the tick ────────────────────────────────────────────────────────────────────────────────────

export type TickPlan =
  /** No run to work. The tick logs and exits — NOT an error: an idle worker is the normal state. */
  | { action: 'idle'; reason: string }
  /** The run exists but must not be worked now. */
  | { action: 'skip'; reason: string; status: RunStatus }
  /** Work `day` with `n` notes. */
  | { action: 'work'; day: string; n: number };

/**
 * What should this tick do? Decided from the run row alone.
 *
 * A run with a null cursor is seeded at `day_to` rather than treated as broken — the insert sets it,
 * but a row that lost it (a manual edit, a partial migration) resumes at the top of its range
 * instead of stalling forever.
 */
export function planTick(run: BackfillRun | null | undefined): TickPlan {
  if (!run) return { action: 'idle', reason: 'no active run for this worker' };
  if (run.status !== 'active') return { action: 'skip', reason: `run ${run.id} is ${run.status}`, status: run.status };
  const day = isDay(run.cursor) ? (run.cursor as string) : run.day_to;
  if (day < run.day_from) return { action: 'skip', reason: `cursor ${day} passed day_from ${run.day_from}`, status: 'done' };
  return { action: 'work', day, n: clampNPerTick(run.n_per_tick) };
}

export interface TickOutcome {
  /** Notes actually graded and stored this tick. */
  processed: number;
  /** Notes attempted that threw. They advance `notes_failed`, never stop the run (§4.3). */
  failed: number;
  /** True when the day has no further un-audited notes — the cursor may march. */
  dayComplete: boolean;
}

export type TickAdvance = {
  /** Where the cursor goes. Unchanged when the day still has work. */
  cursor: string;
  /** The run's status after this tick. */
  status: RunStatus;
  /** True when this tick finished the run. */
  finished: boolean;
};

/**
 * §4.3.2 — the cursor march. The run is `done` when the cursor passes BELOW `day_from`.
 *
 * ⚠️ THE CURSOR ONLY MOVES ON A COMPLETE DAY. A tick that graded some-but-not-all of a day leaves
 * the cursor where it is, so the next tick finishes it. Marching on a partial day would silently
 * skip the remainder — the note is never revisited, because the cursor never comes back.
 */
export function advanceAfterTick(run: BackfillRun, day: string, outcome: TickOutcome): TickAdvance {
  if (!outcome.dayComplete) return { cursor: day, status: 'active', finished: false };
  const next = prevDay(day);
  if (next < run.day_from) return { cursor: next, status: 'done', finished: true };
  return { cursor: next, status: 'active', finished: false };
}

/**
 * Per-run accounting deltas (§4.3.7). Pure so the arithmetic is testable and so a NaN from a
 * missing usage row can never poison a running total: every input degrades to 0.
 */
export function accumulate(
  run: Pick<BackfillRun, 'notes_done' | 'notes_failed' | 'tokens_in' | 'tokens_out' | 'cost_usd'>,
  d: { processed?: number; failed?: number; tokensIn?: number; tokensOut?: number; costUsd?: number },
): Pick<BackfillRun, 'notes_done' | 'notes_failed' | 'tokens_in' | 'tokens_out' | 'cost_usd'> {
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    notes_done: n(run.notes_done) + Math.max(0, n(d.processed)),
    notes_failed: n(run.notes_failed) + Math.max(0, n(d.failed)),
    tokens_in: n(run.tokens_in) + Math.max(0, n(d.tokensIn)),
    tokens_out: n(run.tokens_out) + Math.max(0, n(d.tokensOut)),
    cost_usd: n(run.cost_usd) + Math.max(0, n(d.costUsd)),
  };
}

/**
 * §4.3 — WHICH FAILURES STOP A RUN.
 *
 * A NOTE that fails is data: one note, counted, recorded in `last_error`, and the run continues.
 * Half the point of a bounded sweep is that a bad note does not cost the other 400.
 *
 * A TICK that fails is infrastructure — the provider is unreachable, the budget is exhausted, the
 * model was withdrawn. Every note in this run would fail the same way, so the run goes to `error`:
 * loud, visible on the console, and resumable once the cause is fixed. Continuing would burn the
 * whole range against a broken provider and fill `notes_failed` with the same message.
 */
export function statusAfterTickFailure(): RunStatus { return 'error'; }

/** A run's terminal states — nothing further will be worked without an operator action. */
export const TERMINAL_STATUSES: readonly RunStatus[] = ['done', 'stopped'] as const;

export function isTerminal(status: RunStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Which status transitions an operator may request. `error` is resumable BY DESIGN — the run is
 * paused at the point of failure, not discarded, so fixing the provider and pressing resume picks
 * up at the same cursor with the counters intact.
 */
export function planStatusChange(current: RunStatus, action: 'pause' | 'resume' | 'stop'): { ok: true; status: RunStatus } | { ok: false; error: string } {
  if (action === 'stop') {
    if (isTerminal(current)) return { ok: false, error: `run is already ${current}` };
    return { ok: true, status: 'stopped' };
  }
  if (action === 'pause') {
    if (current !== 'active') return { ok: false, error: `only an active run can be paused (this one is ${current})` };
    return { ok: true, status: 'paused' };
  }
  // resume
  if (current === 'paused' || current === 'error') return { ok: true, status: 'active' };
  return { ok: false, error: `only a paused or errored run can be resumed (this one is ${current})` };
}
