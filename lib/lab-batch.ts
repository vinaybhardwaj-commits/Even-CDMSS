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
import { auditOpdNote } from './opd-note-audit';
import { MINI_MODEL } from './llm';
import { fetchOpdNoteByUid } from './metabase';
import { saveLabAnalysis } from './lab';
import { getSettings, setSetting, windowOpen, lockHeld, readState as readMiniState } from './mini-backfill';
import { LB_KEYS, type LabBatchState, parseBatchState, remainingUids, batchGate } from './lab-batch-core';

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

/** The shared per-note primitive: audit one db13 uid on the FREE mini → lab_analyses. */
export async function runMiniOpdToLab(uid: string, experiment: string): Promise<{ id: string; band: string; index: number; findings: number; engine: string }> {
  const row = await fetchOpdNoteByUid(uid);
  if (!row) throw new Error(`no db13 OPD note for uid ${uid}`);
  const started = Date.now();
  const audit = await auditOpdNote(row, { pipeline: 'mini', engineTag: 'lab', trace: false });
  const output = {
    index: audit.scorecard.headline, band: audit.scorecard.band, scorecard: audit.scorecard,
    completeness: audit.completeness, findings: audit.findings, suggestions: audit.suggestions,
  };
  const id = await saveLabAnalysis({
    experiment, kind: 'opd_note', engine: audit.engineVersion, inputRef: uid,
    inputPreview: `uid ${uid}`, output, model: MINI_MODEL, latencyMs: Date.now() - started,
  });
  return { id, band: audit.scorecard.band, index: audit.scorecard.headline, findings: audit.findings.length, engine: audit.engineVersion };
}

/** One tick: drain up to n un-done cohort uids into lab_analyses. Idempotent + resumable.
 *  ignoreWindow=true is the manual-nudge path (lab_batch_tick) — the cron respects the window. */
export async function batchTick(opts: { ignoreWindow?: boolean } = {}): Promise<Record<string, unknown>> {
  const st = await readBatchState();
  const base = { enabled: st.enabled, experiment: st.experiment, window: st.window, total: st.uids.length };
  let miniBusy = false;
  try { miniBusy = lockHeld((await readMiniState()).lock); } catch { miniBusy = false; }
  const skip = batchGate({
    enabled: st.enabled,
    hasJob: !!st.experiment && st.uids.length > 0,
    windowOpen: opts.ignoreWindow ? true : windowOpen(st.window),
    lockHeld: lockHeld(st.lock),
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
      const summary = { ...base, done: st.uids.length, remaining: 0, finished: true, at: new Date().toISOString() };
      await setSetting(LB_KEYS.last, JSON.stringify(summary));
      return summary;
    }
    const priorDone = st.uids.length - todo.length;
    const slice = todo.slice(0, st.n);
    const results: Record<string, unknown>[] = [];
    for (const uid of slice) {
      const t0 = Date.now();
      try {
        const r = await runMiniOpdToLab(uid, experiment);
        results.push({ uid, band: r.band, index: r.index, findings: r.findings, ms: Date.now() - t0 });
      } catch (e) {
        const msg = String((e as Error).message);
        results.push({ uid, error: msg, ms: Date.now() - t0 });
        await setSetting(LB_KEYS.error, `${uid}: ${msg}`.slice(0, 300)).catch(() => {});
      }
    }
    const okNow = results.filter((r) => !('error' in r)).length;
    const doneNow = priorDone + okNow;
    const summary = {
      ...base, experiment, model: MINI_MODEL, processed: results.length,
      done: doneNow, remaining: Math.max(0, st.uids.length - doneNow), results, at: new Date().toISOString(),
    };
    await setSetting(LB_KEYS.last, JSON.stringify(summary));
    return summary;
  } finally {
    await setSetting(LB_KEYS.lock, '').catch(() => {});
  }
}
