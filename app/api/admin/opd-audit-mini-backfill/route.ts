export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * OPD BACKFILL EXPERIMENT RUNNER (Bedrock PRD §4.3, S2, 7 Aug 2026).
 *
 * ══ WHAT THIS REPLACED ═══════════════════════════════════════════════════════════════════════
 * Until this build the route was the MINI AUTOPILOT: an unbounded sweep backwards through db13
 * history on the Mac-mini (qwen2.5:14b), gated by a night window, writing rows under an isolated
 * `-<tag>` engine label so a local 14B model's grades could never be mistaken for production.
 *
 * It is now a RUN QUEUE. One run = one Bedrock model over a chosen day range, writing PROD-LINE
 * rows, accounted per run, failing loudly. Qwen does no more backfill (PRD decision 2).
 *
 * ⚠️ THE ISOLATION RULE DID NOT DISAPPEAR — IT WAS SUPERSEDED BY A DIFFERENT MECHANISM, and the
 * distinction matters because the old one was written in blood. D1 (2 Aug) isolated mini rows
 * because a local model was writing PROD labels and displacing Gemini audits on doctors'
 * dashboards. Prod-line labels are safe here for a reason that did not exist then: the FILL-ONLY
 * rule (§4.3.3). A note with ANY current-line audit — mini or cloud — is skipped before it is
 * fetched, and the insert is ON CONFLICT DO NOTHING on (uid, engine_version). A Bedrock row can
 * therefore only ever land where NO row exists. It cannot displace a Gemini row, because it can
 * never be written next to one. V accepted the residual (un-bridged grader mix in the prod line)
 * in PRD decision 5 / §4.3.8; the `model` column is what keeps it attributable.
 *
 * ⚠️ THE OLD `mini_backfill_*` app_settings KEYS ARE LEFT ON DISK AND NOTHING READS THEM AFTER THIS
 * SLICE (enabled / window / cursor / floor / tag / n / lock / last). That is deliberate: reverting
 * this commit restores the qwen autopilot exactly, with its cursor where it stopped. Do not "tidy"
 * them away — they are the rollback. The soft LOCK key is the one exception: the runner still takes
 * it, because it guards overlapping ticks and that hazard is unchanged.
 *
 * Scheduling (§4.3.6): no night window — Bedrock has no single-box constraint. The soft lock stays.
 * The yield-to-lab-batch check is GONE from this path: it existed to protect the one Mac-mini, which
 * a Bedrock run does not touch.
 *
 * Auth: Vercel cron header / Bearer|?secret=CRON_SECRET / admin session — unchanged.
 *   GET  ?auto=1        → work the active run (the cron tick)
 *   GET  (no args)      → status
 *   POST {action:…}     → start_run | pause | resume | stop | status   (§C3)
 */
import { NextRequest, NextResponse } from 'next/server';
import { auditOpdNote } from '@/lib/opd-note-audit';
import { OPD_ENGINE_VERSION } from '@/lib/opd-note-audit-core';
import { countOpdNotesForDay, fetchOpdNotesForDay } from '@/lib/metabase';
import { saveOpdAudit, auditedUidsForDayInLine, cloudAuditedUidsForDay } from '@/lib/opd-audit-store';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { setSetting, lockHeld, MB_KEYS, logTick, getSettings } from '@/lib/mini-backfill';
import { resolveProvider } from '@/lib/lab-provider-core';
import { probeReachable } from '@/lib/lab-override';
import { MINI_MODEL } from '@/lib/llm';
import { PRICING } from '@/lib/llm-cost';
import { costUsd } from '@/lib/llm-cost-core';
import {
  planRunCreate, planTick, canStartRun, advanceAfterTick, planStatusChange,
  type BackfillRun,
} from '@/lib/backfill-runs-core';
import {
  activeRun, currentRun, createRun, recentRuns, setRunCursor, setRunStatus, addRunProgress,
  usageForTrace,
} from '@/lib/backfill-runs';

const WORKER = 'opd' as const;

async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

/**
 * Resolve a run's model string to the Bedrock modelId the audit leg will be given.
 * ERRORS LOUD: an unresolvable or non-bedrock model is a typed error, never a substitution.
 */
function resolveRunModel(model: string): { ok: true; modelId: string } | { ok: false; error: string } {
  const r = resolveProvider(model, MINI_MODEL);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.provider !== 'bedrock') {
    return { ok: false, error: `run model '${model}' resolves to ${r.provider}, and backfill runs are bedrock-only (PRD decision 2). Never falls back.` };
  }
  return { ok: true, modelId: r.model };
}

/**
 * Grade up to `n` un-audited notes for `day` on the run's model.
 *
 * ⚠️ THE FILL-ONLY GUARANTEE (§4.3.3) IS THIS FUNCTION'S FIRST THREE STATEMENTS, and it is
 * UNCHANGED from the autopilot it replaces: `auditedUidsForDayInLine` (anything in the current
 * engine LINE, not the exact version — an exact match reset the whole day on every bump) plus
 * `cloudAuditedUidsForDay`, both fed to the fetch as a skip list, and `ON CONFLICT DO NOTHING`
 * inside saveOpdAudit as the last line of defence. This is what makes a prod-line label safe.
 */
async function processRunBatch(run: BackfillRun, day: string, modelId: string) {
  const total = await countOpdNotesForDay(day);
  const already = await auditedUidsForDayInLine(day);
  const cloudDone = await cloudAuditedUidsForDay(day);
  const skip = [...new Set([...already, ...cloudDone])];
  const rows = total > skip.length ? await fetchOpdNotesForDay(day, skip, run.n_per_tick) : [];

  const results: Record<string, unknown>[] = [];
  let processed = 0, failed = 0, tokensIn = 0, tokensOut = 0, cost = 0;
  let lastError: string | null = null;

  for (const row of rows) {
    const started = Date.now();
    try {
      // No `pipeline: 'mini'`, no `engineTag`: the row carries the PLAIN prod engine version.
      const audit = await auditOpdNote(row, { bedrockModel: modelId });
      // ⚠️ THE MODEL STAMP IS THE RESOLVED BEDROCK MODEL. The autopilot stamped MINI_MODEL here,
      // which was true for it and would be a lie for this runner. A row that names a model which
      // did not grade it is the F11 defect class, and the `model` column is the only thing making
      // a prod-line Bedrock row attributable at all.
      const status = await saveOpdAudit(audit, { model: modelId, latencyMs: Date.now() - started });
      const usage = await usageForTrace(audit.traceId);
      const usd = costUsd(modelId, usage.tokensIn, usage.tokensOut, false, PRICING);
      tokensIn += usage.tokensIn; tokensOut += usage.tokensOut; cost += usd;
      if (status === 'inserted') processed++;
      results.push({ uid: audit.keys.uid, index: audit.scorecard.headline, band: audit.scorecard.band, status, ms: Date.now() - started, tokens_in: usage.tokensIn, tokens_out: usage.tokensOut, usd: Number(usd.toFixed(4)), traceId: audit.traceId ?? null });
    } catch (e) {
      // A NOTE that fails is data, not an outage: count it, record why, keep going. A whole run
      // must not be lost to one unparseable note.
      failed++;
      lastError = String((e as Error).message).slice(0, 500);
      results.push({ uid: String((row as Record<string, unknown>).uid || ''), error: lastError, ms: Date.now() - started });
    }
  }

  const audited = already.length + processed;
  const skippedCloud = cloudDone.filter((u) => !already.includes(u)).length;
  return {
    day, total, audited, processed, failed, skippedCloud,
    remaining: Math.max(0, total - audited - skippedCloud),
    dayComplete: total === 0 || audited + skippedCloud >= total,
    tokensIn, tokensOut, cost, lastError, results,
  };
}

/** The cron tick (?auto=1): work the ACTIVE run for this worker. */
async function autoTick(): Promise<Record<string, unknown>> {
  const run = await activeRun(WORKER);
  const plan = planTick(run);

  if (plan.action === 'idle') {
    await logTick({ status: 'paused', note: plan.reason });
    return { auto: true, idle: true, note: plan.reason };
  }
  if (plan.action === 'skip') {
    await logTick({ status: plan.status === 'done' ? 'finished' : 'paused', note: plan.reason, run_id: run!.id });
    if (plan.status === 'done') await setRunStatus(run!.id, 'done');
    return { auto: true, skipped: plan.reason, run_id: run!.id, status: plan.status };
  }

  const active = run as BackfillRun;
  const lock = (await getSettings([MB_KEYS.lock]))[MB_KEYS.lock] || null;
  if (lockHeld(lock)) {
    await logTick({ status: 'locked', note: 'previous tick still running', run_id: active.id });
    return { auto: true, skipped: 'previous tick still running (soft lock)', run_id: active.id };
  }

  const resolved = resolveRunModel(active.model);
  if (!resolved.ok) {
    await setRunStatus(active.id, 'error', resolved.error);
    await logTick({ status: 'error', note: resolved.error.slice(0, 200), run_id: active.id });
    return { auto: true, run_id: active.id, status: 'error', error: resolved.error };
  }
  // Reachability is re-checked EVERY tick, not only at creation: the rollback for this whole build
  // is unsetting a BEDROCK_* var, and a run that kept grinding against an unreachable provider would
  // turn that rollback into a wall of failed notes instead of one visible errored run.
  if (!probeReachable('bedrock')) {
    const msg = 'bedrock is not reachable (BEDROCK_* / GCP_SA_KEY) — run set to error, resumable once configured';
    await setRunStatus(active.id, 'error', msg);
    await logTick({ status: 'error', note: msg, run_id: active.id });
    return { auto: true, run_id: active.id, status: 'error', error: msg };
  }

  await setSetting(MB_KEYS.lock, new Date().toISOString());
  try {
    const batch = await processRunBatch(active, plan.day, resolved.modelId);
    await addRunProgress(active.id, {
      processed: batch.processed, failed: batch.failed,
      tokensIn: batch.tokensIn, tokensOut: batch.tokensOut, costUsd: batch.cost,
      lastError: batch.lastError,
    });
    const next = advanceAfterTick(active, plan.day, { processed: batch.processed, failed: batch.failed, dayComplete: batch.dayComplete });
    await setRunCursor(active.id, next.cursor, next.status);

    const okRuns = batch.results.filter((r) => !('error' in r));
    const avgMs = okRuns.length ? Math.round(okRuns.reduce((s, r) => s + Number(r.ms), 0) / okRuns.length) : null;
    await logTick({
      status: next.finished ? 'finished' : (batch.failed > 0 && batch.processed === 0 ? 'error' : 'running'),
      processed: batch.processed, day: plan.day, avg_ms: avgMs, run_id: active.id,
      note: batch.failed ? `${batch.failed} note error(s) this tick` : null,
    });
    return {
      auto: true, run_id: active.id, model: active.model, engine: OPD_ENGINE_VERSION,
      day: plan.day, cursor: next.cursor, status: next.status, finished: next.finished,
      total: batch.total, audited: batch.audited, processed: batch.processed, failed: batch.failed,
      remaining: batch.remaining, skippedCloud: batch.skippedCloud,
      tokens_in: batch.tokensIn, tokens_out: batch.tokensOut, cost_usd: Number(batch.cost.toFixed(4)),
      throughput: avgMs ? { avg_ms_per_note: avgMs } : null,
      results: batch.results,
    };
  } catch (e) {
    // A TICK that fails is infrastructure — every note in this run would fail the same way. Error
    // the run: loud, visible, resumable, and it stops burning the range against a broken provider.
    const msg = String((e as Error).message).slice(0, 500);
    await setRunStatus(active.id, 'error', msg);
    await logTick({ status: 'error', note: msg.slice(0, 200), run_id: active.id });
    return { auto: true, run_id: active.id, status: 'error', error: msg };
  } finally {
    await setSetting(MB_KEYS.lock, '').catch(() => {});
  }
}

async function statusPayload(): Promise<Record<string, unknown>> {
  const [active, recent] = await Promise.all([activeRun(WORKER), recentRuns(WORKER, 20)]);
  return { worker: WORKER, engine: OPD_ENGINE_VERSION, active_run: active, recent_runs: recent, bedrock_reachable: probeReachable('bedrock') };
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (req.nextUrl.searchParams.get('auto') === '1') {
    try { return NextResponse.json({ ok: true, ...(await autoTick()) }); }
    catch (e) {
      await logTick({ status: 'error', note: String((e as Error).message).slice(0, 200) });
      return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
    }
  }
  try { return NextResponse.json({ ok: true, ...(await statusPayload()) }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}

/**
 * §C3 — run control. On THIS route rather than a sibling, deliberately: the tick, the control
 * actions and the status view are one object's lifecycle, they share an auth function and a worker
 * constant, and a console (S3) fetching one path cannot drift between two. The MCP surface in S3
 * calls the same actions with `source:'mcp'`.
 *
 * Actions: start_run {model, dayFrom, dayTo, nPerTick} · pause · resume · stop · status.
 */
export async function POST(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty body ⇒ status */ }
  const action = String(body.action ?? 'status').trim().toLowerCase();

  try {
    if (action === 'status') return NextResponse.json({ ok: true, ...(await statusPayload()) });

    if (action === 'start_run') {
      const plan = planRunCreate({ ...body, worker: WORKER, source: body.source });
      if (!plan.ok) return NextResponse.json({ ok: false, error: plan.error }, { status: 400 });
      // ONE ACTIVE RUN PER WORKER (§4.3.1) — a typed refusal, not a queue.
      const gate = canStartRun(await activeRun(WORKER));
      if (!gate.ok) return NextResponse.json({ ok: false, error: gate.error }, { status: 409 });
      // Resolve + reachability-check BEFORE the row exists: a run that could never have worked
      // should not appear in the history as one that failed.
      const resolved = resolveRunModel(plan.model);
      if (!resolved.ok) return NextResponse.json({ ok: false, error: resolved.error }, { status: 400 });
      if (!probeReachable('bedrock')) {
        return NextResponse.json({ ok: false, error: 'bedrock is not reachable in this deployment (BEDROCK_REGION / BEDROCK_ROLE_ARN / BEDROCK_OIDC_AUDIENCE / GCP_SA_KEY) — refusing to create a run that cannot run' }, { status: 400 });
      }
      const created = await createRun(plan);
      return NextResponse.json({ ok: true, run: created, engine: OPD_ENGINE_VERSION, model_id: resolved.modelId });
    }

    if (action === 'pause' || action === 'resume' || action === 'stop') {
      const target = await currentRun(WORKER);
      if (!target) return NextResponse.json({ ok: false, error: 'no run to act on for this worker' }, { status: 404 });
      const change = planStatusChange(target.status, action);
      if (!change.ok) return NextResponse.json({ ok: false, error: change.error }, { status: 409 });
      await setRunStatus(target.id, change.status);
      return NextResponse.json({ ok: true, run_id: target.id, status: change.status });
    }

    return NextResponse.json({ ok: false, error: `unknown action '${action}' — expected start_run | pause | resume | stop | status` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
