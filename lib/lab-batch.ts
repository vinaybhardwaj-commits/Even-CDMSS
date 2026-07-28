/**
 * lib/lab-batch.ts — cohort-scoped, cron-drained qwen eval batches into the Lab store.
 *
 * Wraps the per-note mini→lab primitive (runMiniOpdToLab) in the mini-backfill lock/tick
 * pattern, pointed at a UID COHORT instead of a date cursor. Writes ONLY to lab_analyses
 * (experiment-namespaced) — NEVER opd_note_audits. Free mini only (qwen, ₹0).
 *
 * Three front doors share this core: the cron (/api/admin/lab-batch?auto=1), the admin
 * status endpoint, and the Lab MCP tools (lab_batch_start/status/stop/tick). It YIELDS to
 * the prod mini-backfill (both hit the single Mac-mini) via that worker's soft lock.
 */
import { sql } from './db';
import { auditOpdNote, isDeadlineErrorMessage, type LlmEnvelope } from './opd-note-audit';
import { MINI_MODEL } from './llm';
import { fetchOpdNoteByUid } from './metabase';
import { saveLabAnalysis } from './lab';
import { getSettings, setSetting, windowOpen, lockHeld, readState as readMiniState } from './mini-backfill';
import { LB_KEYS, LB_LOCK_TTL_MS, EVAL_TICK_DEADLINE_MS, type LabBatchState, parseBatchState, remainingUids, batchGate, drainPlan, boundedPool, labLockHeld, ttlBreach, ttlBreachMessage } from './lab-batch-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export async function readBatchState(): Promise<LabBatchState> {
  const s = await getSettings(Object.values(LB_KEYS));
  return parseBatchState(s);
}

/** DISTINCT input_ref already stored for this experiment (the done-set). */
export async function doneUids(experiment: string): Promise<Set<string>> {
  const rows = await run(
    `SELECT DISTINCT input_ref FROM lab_analyses WHERE experiment = $1 AND input_ref IS NOT NULL`, [experiment],
  ).catch(() => [] as Record<string, unknown>[]);
  return new Set(rows.map((r) => String(r.input_ref)));
}

export async function batchProgress(experiment: string, cohort: string[]): Promise<{ total: number; done: number; remaining: number }> {
  const done = await doneUids(experiment);
  const doneInCohort = cohort.filter((u) => done.has(u)).length;
  return { total: cohort.length, done: doneInCohort, remaining: Math.max(0, cohort.length - doneInCohort) };
}

/** Lab eval config for a batch (R-11 Stage 2 Phase 2). Absent ⇒ today's mini/leg-off behaviour.
 *  `deadlineAt` (Eval-tick-deadline PRD D1) is absolute epoch ms, set by `batchTick`'s EVAL branch
 *  only — the mini branch leaves it undefined and is byte-identical. */
export interface LabEvalConfig { evalNormativeLeg?: boolean; evalModel?: string; evalNormativeChannel?: boolean; deadlineAt?: number }

/** The shared per-note primitive: audit one db13 uid → lab_analyses. Writes ONLY lab_analyses (via
 *  saveLabAnalysis); auditOpdNote is pure compute and never writes opd_note_audits. `evalCfg` (Phase 2)
 *  forces the R-11 normative leg on and/or routes generation to an OpenRouter model — absent ⇒ mini. */
export async function runMiniOpdToLab(uid: string, experiment: string, evalCfg: LabEvalConfig = {}): Promise<{ id: string; band: string; index: number; findings: number; engine: string }> {
  const row = await fetchOpdNoteByUid(uid);
  if (!row) throw new Error(`no db13 OPD note for uid ${uid}`);
  const started = Date.now();
  // PDQI-9 fail-loud Phase 1 (R2): keep the LAST envelope seen. On the eval path openRouterGenerate
  // emits one per attempt, so after a retry this holds the attempt that actually produced the
  // content. Assignment only — it cannot throw, and it is never read unless the audit SUCCEEDS.
  // If the audit fails, the catch in auditOpdNote rethrows (eval only), drainOne records the error,
  // and no row is written at all — which is the point of the build.
  let lastEnvelope: LlmEnvelope | null = null;
  const audit = await auditOpdNote(row, {
    pipeline: 'mini', engineTag: 'lab', trace: false,
    evalNormativeLeg: evalCfg.evalNormativeLeg, evalModel: evalCfg.evalModel,
    evalNormativeChannel: evalCfg.evalNormativeChannel,
    // Inert unless evalModel is also set — it reaches the LLM only via defaultGenerate's eval branch.
    deadlineAt: evalCfg.deadlineAt,
    onEnvelope: (e) => { lastEnvelope = e; },
  });
  const output = {
    index: audit.scorecard.headline, band: audit.scorecard.band, scorecard: audit.scorecard,
    completeness: audit.completeness, findings: audit.findings, suggestions: audit.suggestions,
    // Phase-2 provenance stamp so band-migration analysis can split arms by (model × leg × channel).
    eval: { model: evalCfg.evalModel ?? null, normativeLeg: evalCfg.evalNormativeLeg === true, normativeChannel: evalCfg.evalNormativeChannel === true },
    // R2 instrumentation. ADDITIVE — a key inside the existing `output` jsonb that saveLabAnalysis
    // already writes whole, so there is NO migration. Absent on the mini path (no evalModel ⇒ no
    // OpenRouter call ⇒ no envelope), which keeps every non-eval lab row byte-identical.
    ...(lastEnvelope ? { llm_envelope: lastEnvelope } : {}),
  };
  const id = await saveLabAnalysis({
    experiment, kind: 'opd_note', engine: audit.engineVersion, inputRef: uid,
    inputPreview: `uid ${uid}`, output, model: evalCfg.evalModel || MINI_MODEL, latencyMs: Date.now() - started,
  });
  return { id, band: audit.scorecard.band, index: audit.scorecard.headline, findings: audit.findings.length, engine: audit.engineVersion };
}

/** One tick: drain up to n un-done cohort uids into lab_analyses. Idempotent + resumable.
 *  ignoreWindow=true is the manual-nudge path (lab_batch_tick) — the cron respects the window. */
export async function batchTick(opts: { ignoreWindow?: boolean } = {}): Promise<Record<string, unknown>> {
  // D3 — wall clock for the tick. PURE OBSERVATION: read only where the summary is built, never
  // branched on. The old summary could not distinguish "tick completed" from "tick never ran", which
  // is precisely how the killed-invocation defect stayed invisible for a full paid run.
  const tickStart = Date.now();
  const st = await readBatchState();
  const base = { enabled: st.enabled, experiment: st.experiment, window: st.window, total: st.uids.length };
  // Eval batches (evalModel set → OpenRouter, hosted+concurrent) fan out and skip the mini-yield —
  // that lock only protects the single mini GPU, which the eval path never touches. Mini batches
  // (no evalModel) keep the legacy plan EXACTLY: n≤2, serial, mini-yield honoured.
  const plan = drainPlan(st);
  // Prod re-score now yields to us (bounded run has priority), so we only defer to prod's transient
  // in-flight note for ONE tick to avoid a literal concurrent mini call — not a standing yield.
  let miniBusy = false;
  if (plan.useMiniYield) {
    // DELIBERATELY the PROD worker's lockHeld/MB_LOCK_TTL_MS — this reads the mini-backfill's lock
    // to see whether the shared GPU is busy, so it must keep the prod worker's TTL. Do NOT switch
    // this to labLockHeld: the two locks belong to two different workers (D1).
    try { miniBusy = lockHeld((await readMiniState()).lock); } catch { miniBusy = false; }
  }
  const skip = batchGate({
    enabled: st.enabled,
    hasJob: !!st.experiment && st.uids.length > 0,
    windowOpen: opts.ignoreWindow ? true : windowOpen(st.window),
    // The BATCH's own lock, governed by LB_LOCK_TTL_MS (D1). Previously this called the prod
    // worker's lockHeld, so MB_LOCK_TTL_MS=210s governed a batch whose average note takes 212.8s.
    lockHeld: labLockHeld(st.lock),
    miniBusy,
  });
  if (skip) return { ...base, skipped: skip };

  await setSetting(LB_KEYS.lock, new Date().toISOString());
  try {
    const experiment = st.experiment as string;
    const done = await doneUids(experiment);
    const todo = remainingUids(st.uids, done);
    if (todo.length === 0) {
      await setSetting(LB_KEYS.enabled, '0');
      const summary = {
        ...base, done: st.uids.length, remaining: 0, finished: true, at: new Date().toISOString(),
        tick_ms: Date.now() - tickStart, slice_planned: plan.sliceSize, slice_drained: 0,
      };
      await setSetting(LB_KEYS.last, JSON.stringify(summary));
      return summary;
    }
    const priorDone = st.uids.length - todo.length;
    const slice = todo.slice(0, plan.sliceSize);
    // D1 — the tick deadline, computed ONCE, from the tick's own start. EVAL BRANCH ONLY: the mini
    // branch gets `undefined` and is byte-identical, because the mini path is serial on a single GPU
    // and never retries inside the tick, so it has neither the failure mode nor the fan-out.
    const deadlineAt = plan.evalMode ? tickStart + EVAL_TICK_DEADLINE_MS : undefined;
    const evalCfg = { evalNormativeLeg: st.evalNormativeLeg, evalModel: st.evalModel ?? undefined, evalNormativeChannel: st.evalNormativeChannel, ...(deadlineAt != null ? { deadlineAt } : {}) };
    // One note → one result row; errors captured per-note (never thrown out of the drain).
    const drainOne = async (uid: string): Promise<Record<string, unknown>> => {
      const t0 = Date.now();
      try {
        const r = await runMiniOpdToLab(uid, experiment, evalCfg);
        return { uid, band: r.band, index: r.index, findings: r.findings, ms: Date.now() - t0 };
      } catch (e) {
        const msg = String((e as Error).message);
        await setSetting(LB_KEYS.error, `${uid}: ${msg}`.slice(0, 300)).catch(() => {});
        return { uid, error: msg, ms: Date.now() - t0 };
      }
    };
    let results: Record<string, unknown>[];
    if (plan.evalMode) {
      // OpenRouter path: bounded fan-out — never more than plan.concurrency audits in flight.
      results = await boundedPool(slice, plan.concurrency, drainOne);
    } else {
      // Mini path: strictly serial, exactly as before (single GPU).
      results = [];
      for (const uid of slice) results.push(await drainOne(uid));
    }
    const okNow = results.filter((r) => !('error' in r)).length;
    const doneNow = priorDone + okNow;
    // D2 — THE CONTRADICTING FIELD. Assert observed latency against the TTL meant to cover it. Pure
    // observation, wrapped so it can NEVER throw and NEVER block a tick: a failure here must not
    // cost the drain that already succeeded.
    let breach = { breach: false, maxMs: 0 };
    try { breach = ttlBreach(results as { ms?: number }[], LB_LOCK_TTL_MS); } catch { breach = { breach: false, maxMs: 0 }; }
    if (breach.breach) {
      await setSetting(LB_KEYS.error, ttlBreachMessage(breach.maxMs, LB_LOCK_TTL_MS)).catch(() => {});
    }
    const summary = {
      ...base, experiment, model: st.evalModel || MINI_MODEL, processed: results.length,
      // D1 instrumentation, EVAL-ONLY so mini summaries stay byte-identical. `deadline_ms` is the
      // field V watches to confirm the deploy took; `deadline_hits` counts notes abandoned to let
      // the tick report — each stays un-done and is retried next tick, with NO lab_analyses row.
      ...(plan.evalMode ? { evalConcurrency: plan.concurrency, deadline_ms: EVAL_TICK_DEADLINE_MS, deadline_hits: results.filter((r) => isDeadlineErrorMessage(r.error)).length } : {}),
      done: doneNow, remaining: Math.max(0, st.uids.length - doneNow), results, at: new Date().toISOString(),
      ttl_breach: breach.breach, max_ms: breach.maxMs, ttl_ms: LB_LOCK_TTL_MS,
      // D3 — the fields the old summary lacked. `slice_planned` vs `slice_drained` says whether the
      // wave completed; `tick_ms` says how long one wave actually took. All three are derived from
      // values already computed above — no new work, no branch, nothing that can throw.
      tick_ms: Date.now() - tickStart, slice_planned: plan.sliceSize, slice_drained: results.length,
    };
    await setSetting(LB_KEYS.last, JSON.stringify(summary));
    return summary;
  } finally {
    await setSetting(LB_KEYS.lock, '').catch(() => {});
  }
}
