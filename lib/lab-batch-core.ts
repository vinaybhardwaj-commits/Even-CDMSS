/**
 * lib/lab-batch-core.ts — PURE helpers for the cohort-scoped Lab eval batch runner.
 * No db / no audit imports, so this stays unit-testable under --experimental-strip-types.
 * See lib/lab-batch.ts for the runtime (db + mini audit + tick).
 */

export const LB_KEYS = {
  enabled: 'lab_batch_enabled',
  experiment: 'lab_batch_experiment',
  kind: 'lab_batch_kind',
  uids: 'lab_batch_uids',            // JSON array of the cohort uids
  n: 'lab_batch_n',                  // notes per tick (clamped 1..LB_MAX_N)
  window: 'lab_batch_window',        // 'night' | 'always'
  lock: 'lab_batch_lock',            // soft-lock ISO ts
  last: 'lab_batch_last',            // last tick summary json
  error: 'lab_batch_last_error',     // last per-note error string
  evalNormativeLeg: 'lab_batch_eval_normative_leg',  // '1' ⇒ force the R-11 leg on for this eval batch
  evalModel: 'lab_batch_eval_model',                 // OpenRouter model id for eval generation ('' ⇒ mini)
} as const;

export const LB_LOCK_TTL_MS = 210 * 1000;   // matches the mini-backfill soft-lock TTL (< 300s Vercel cap)
export const LB_MAX_COHORT = 2000;
export const LB_MAX_N = 2;                   // ~72s/note on the mini × 2 ≈ 150s < 300s cap

export interface LabBatchState {
  enabled: boolean;
  experiment: string | null;
  kind: string;
  uids: string[];
  n: number;
  window: 'night' | 'always';
  lock: string | null;
  last: Record<string, unknown> | null;
  lastError: string | null;
  evalNormativeLeg: boolean;     // lab eval: force the R-11 normative leg on
  evalModel: string | null;      // lab eval: OpenRouter model id (null ⇒ mini generation, today's path)
}

export function clampN(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(LB_MAX_N, n);
}

/** Accept only short id-safe tokens (db13 Firestore-style uids); de-dupe; cap at LB_MAX_COHORT. */
export function sanitizeUids(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of arr) {
    const s = String(v ?? '').trim();
    if (!s || seen.has(s)) continue;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= LB_MAX_COHORT) break;
  }
  return out;
}

/** Cohort minus the already-done set, order preserved. */
export function remainingUids(cohort: string[], done: Iterable<string>): string[] {
  const d = done instanceof Set ? done : new Set(done);
  return cohort.filter((u) => !d.has(u));
}

/** Pure parse of the app_settings key/value map into typed state. */
export function parseBatchState(s: Record<string, string>): LabBatchState {
  let uids: string[] = [];
  try { uids = sanitizeUids(JSON.parse(s[LB_KEYS.uids] || '[]')); } catch { uids = []; }
  let last: Record<string, unknown> | null = null;
  try { last = s[LB_KEYS.last] ? JSON.parse(s[LB_KEYS.last]) : null; } catch { last = null; }
  return {
    enabled: s[LB_KEYS.enabled] === '1',
    experiment: s[LB_KEYS.experiment] ? s[LB_KEYS.experiment] : null,
    kind: s[LB_KEYS.kind] || 'opd',
    uids,
    n: clampN(s[LB_KEYS.n] || '2'),
    window: s[LB_KEYS.window] === 'always' ? 'always' : 'night',
    lock: s[LB_KEYS.lock] || null,
    last,
    lastError: s[LB_KEYS.error] || null,
    evalNormativeLeg: s[LB_KEYS.evalNormativeLeg] === '1',   // absent ⇒ false ⇒ today's behaviour
    evalModel: s[LB_KEYS.evalModel] ? s[LB_KEYS.evalModel] : null,
  };
}

export type BatchSkip = 'disabled' | 'no_job' | 'outside_window' | 'locked' | 'mini_busy' | null;

/** Pure gate: given state + external conditions, return the skip reason (null = run). */
export function batchGate(o: { enabled: boolean; hasJob: boolean; windowOpen: boolean; lockHeld: boolean; miniBusy: boolean }): BatchSkip {
  if (!o.enabled) return 'disabled';
  if (!o.hasJob) return 'no_job';
  if (!o.windowOpen) return 'outside_window';
  if (o.lockHeld) return 'locked';
  if (o.miniBusy) return 'mini_busy';
  return null;
}
