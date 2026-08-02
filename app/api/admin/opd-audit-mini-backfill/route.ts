export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * MINI-PIPELINE OPD BACKFILL (2 Jul 2026, V) — audits historical db13 OPD notes on the
 * Mac-mini Ollama bridge (MINI_MODEL, default qwen2.5:14b), ₹0 marginal, ZERO Gemini.
 *
 * Isolation (cardinal): rows are written with engine `opd-note-audit/0.5-mini`
 * (uid+engine_version PK ⇒ they COEXIST with prod rows and are INVISIBLE to every prod
 * surface — dashboard, stewardship, governance API — which all filter the exact prod
 * engine). Individual mini rows ARE viewable at /admin/opd-audit/<id> (the case screen
 * fetches by id without an engine filter).
 *
 * Modes:
 *  • ?day=YYYY-MM-DD → work that IST day.
 *  • default         → NEWEST-FIRST sweep: walk back from yesterday IST (up to ?scan days,
 *                      default 30, ≤365) to the first day with un-mini-audited notes.
 * Resumable + idempotent (ON CONFLICT DO NOTHING); safe to hammer repeatedly / cron later.
 *
 * Throughput probe: sequential (the mini is one box — conc is intentionally NOT offered),
 * n default 1 (≤3 — a 14B pass can take minutes; maxDuration is 300s). The response
 * self-times every note and projects notes/day so the backfill window can be chosen
 * from measured data. NOT in vercel.json — manual trigger only for now.
 *
 * Auth: Vercel cron header / Bearer|?secret=CRON_SECRET / admin session.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auditOpdNote, OPD_MINI_ENGINE_VERSION, opdMiniEngine } from '@/lib/opd-note-audit';
import { MINI_MODEL } from '@/lib/llm';
import { countOpdNotesForDay, fetchOpdNotesForDay, istYesterday } from '@/lib/metabase';
import { saveOpdAudit, auditedUidsForDay, cloudAuditedUidsForDay, earliestAuditedDay } from '@/lib/opd-audit-store';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { readState, setSetting, windowOpen, lockHeld, prevDay, MB_KEYS, logTick } from '@/lib/mini-backfill';
import { getSettings } from '@/lib/mini-backfill';
import { LB_KEYS } from '@/lib/lab-batch-core';

async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

function addDays(day: string, delta: number): string {
  const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10);
}

/** Audit up to `n` un-audited notes (engine `engineStr`) for `day`; sequential; self-timed.
 *  D4 (GRADER-PROVENANCE PRD): a note the CLOUD has already graded at the current engine version is
 *  skipped — the mini must not spend compute re-grading it, and the two workers must not race. This
 *  is the efficiency guard; the safety guard is the grader tier in lib/audit-canonical.ts. */
async function processBatch(day: string, n: number, engineStr: string, tag: string | undefined) {
  const total = await countOpdNotesForDay(day);
  const already = await auditedUidsForDay(day, engineStr);
  const cloudDone = await cloudAuditedUidsForDay(day);
  const skip = [...new Set([...already, ...cloudDone])];
  const rows = total > already.length ? await fetchOpdNotesForDay(day, skip, n) : [];
  const results: Record<string, unknown>[] = [];
  for (const row of rows) {
    const started = Date.now();
    try {
      const audit = await auditOpdNote(row, { pipeline: 'mini', engineTag: tag });
      const status = await saveOpdAudit(audit, { model: MINI_MODEL, latencyMs: Date.now() - started });
      results.push({ uid: audit.keys.uid, index: audit.scorecard.headline, band: audit.scorecard.band, status, ms: Date.now() - started, traceId: audit.traceId ?? null });
    } catch (e) {
      results.push({ uid: String((row as Record<string, unknown>).uid || ''), error: String((e as Error).message), ms: Date.now() - started });
    }
  }
  const audited = already.length + results.filter((r) => r.status === 'inserted').length;
  const skippedCloud = cloudDone.filter((u) => !already.includes(u)).length;
  return { day, total, audited, processed: results.length, skippedCloud,
           remaining: Math.max(0, total - audited - skippedCloud),
           done: total > 0 && audited + skippedCloud >= total, results };
}

/**
 * AUTOPILOT tick (?auto=1 — the every-5-min cron): gated by the admin module's switches.
 * enabled? → compute window open (night 00:00–05:00 IST, or 'always')? → soft lock free?
 * → work the cursor day; when it completes (or has 0 notes), march the cursor BACKWARDS
 * (bounded scan per tick) until the floor. Every tick stores a summary for the module.
 */
async function autoTick(): Promise<Record<string, unknown>> {
  const st = await readState();
  // The engine-upgrade pivot was DELETED with prod mode (D1, 2 Aug 2026): it restarted the sweep at
  // istYesterday on every bump so the mini would re-score recent history under the new PROD label —
  // the mechanism that put qwen rows on the dashboard. The mini now only ever writes '-<tag>'.
  const base = { auto: true, enabled: st.enabled, window: st.window, tag: st.tag, cursor: st.cursor, floor: st.floor };
  // PRIORITY: a bounded lab eval batch preempts the unbounded history re-score. Yield the single
  // Mac-mini while a lab batch is active (window 'always' recommended; it self-disables at remaining 0),
  // then auto-resume the re-score on the next tick once it clears.
  if ((await getSettings([LB_KEYS.enabled]))[LB_KEYS.enabled] === '1') {
    await logTick({ status: 'paused', note: 'yielding to active lab eval batch (bounded run has priority)' });
    return { ...base, skipped: 'yielding to lab eval batch' };
  }
  if (!st.enabled) { await logTick({ status: 'paused', note: 'autopilot paused' }); return { ...base, skipped: 'paused' }; }
  if (!windowOpen(st.window)) { await logTick({ status: 'closed_window', note: 'outside night window' }); return { ...base, skipped: 'outside compute window (night = 00:00–05:00 IST)' }; }
  if (lockHeld(st.lock)) { await logTick({ status: 'locked', note: 'previous tick still running' }); return { ...base, skipped: 'previous tick still running (soft lock)' }; }
  await setSetting(MB_KEYS.lock, new Date().toISOString());
  try {

  // ALWAYS the isolated '-<tag>' engine (D1). There is no prod branch: a mini row can never again
  // carry the plain production label, so it can never again be mistaken for a Gemini audit.
  const engineStr = opdMiniEngine(st.tag);
  let day = st.cursor;
  if (!day) {
    const earliest = await earliestAuditedDay();
    day = earliest ? prevDay(earliest) : istYesterday();
    await setSetting(MB_KEYS.cursor, day);
  }

  // March backwards over complete/empty days (bounded per tick to keep Metabase calls sane).
  let hops = 0;
  let batch: Awaited<ReturnType<typeof processBatch>> | null = null;
  while (hops < 10) {
    if (day < st.floor) {
      await setSetting(MB_KEYS.enabled, '0');
      const doneSummary = { ...base, cursor: day, finished: true, note: 'cursor passed the floor — backfill complete; autopilot paused itself' };
      await setSetting(MB_KEYS.last, JSON.stringify({ ...doneSummary, at: new Date().toISOString() }));
      await logTick({ status: 'finished', note: 'cursor passed floor — backfill complete' });
      return doneSummary;
    }
    batch = await processBatch(day, st.n, engineStr, st.tag);
    if (batch.total > 0 && !batch.done) break;              // worked (or partial) — stay on this day
    day = prevDay(day); hops++;                              // empty or completed day — step back
    await setSetting(MB_KEYS.cursor, day);
    if (batch.processed > 0) break;                          // we did work AND finished the day — enough for this tick
  }

  const okRuns = (batch?.results ?? []).filter((r) => !('error' in r));
  const avgMs = okRuns.length ? Math.round(okRuns.reduce((s, r) => s + Number(r.ms), 0) / okRuns.length) : null;
  const summary = {
    ...base, cursor: day, engine: engineStr, model: MINI_MODEL,
    day: batch?.day ?? day, total: batch?.total ?? 0, audited: batch?.audited ?? 0,
    processed: batch?.processed ?? 0, remaining: batch?.remaining ?? 0,
    skippedCloud: batch?.skippedCloud ?? 0,
    throughput: avgMs ? { avg_ms_per_note: avgMs, est_notes_per_24h: Math.round(86_400_000 / avgMs) } : null,
    at: new Date().toISOString(),
  };
  await setSetting(MB_KEYS.last, JSON.stringify(summary));
  const nErr = (batch?.results ?? []).filter((r) => 'error' in r).length;
  await logTick({
    status: (batch?.processed ?? 0) > 0 ? 'running' : (nErr > 0 ? 'error' : 'running'),
    processed: batch?.processed ?? 0, day: batch?.day ?? day, avg_ms: avgMs,
    note: nErr ? `${nErr} note error(s) this tick` : null,
  });
  return summary;
  } finally {
    // Release the lock at tick END so a fast (every-1–2-min) cron runs back-to-back. The lock now
    // only guards against a genuinely-overlapping tick (still running), not the next scheduled one.
    await setSetting(MB_KEYS.lock, '').catch(() => {});
  }
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const p = req.nextUrl.searchParams;

  // Autopilot mode (cron) — everything else below is the original manual probe mode.
  if (p.get('auto') === '1') {
    try { return NextResponse.json({ ok: true, ...(await autoTick()) }); }
    catch (e) {
      await logTick({ status: 'error', note: String((e as Error).message).slice(0, 200) });
      return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
    }
  }

  const n = Math.max(1, Math.min(3, Number(p.get('n') || 1)));
  const scan = Math.max(1, Math.min(365, Number(p.get('scan') || 30)));
  const dayParam = p.get('day');
  // D1: no ?prod= switch. The manual probe writes the isolated mini engine, like the autopilot.
  const engineStr = OPD_MINI_ENGINE_VERSION;

  try {
    // Pick the working day: explicit, or newest-first sweep.
    let day = dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : null;
    let scanned = 0;
    if (!day) {
      let d = istYesterday();
      for (let i = 0; i < scan; i++) {
        scanned++;
        const total = await countOpdNotesForDay(d);
        if (total > 0) {
          const done = await auditedUidsForDay(d, engineStr);
          if (done.length < total) { day = d; break; }
        }
        d = addDays(d, -1);
      }
      if (!day) {
        return NextResponse.json({ ok: true, engine: engineStr, model: MINI_MODEL, scanned, done: true, note: `no un-audited notes at ${engineStr} in the last ${scan} day(s) — raise ?scan= to reach further back` });
      }
    }

    const total = await countOpdNotesForDay(day);
    const already = await auditedUidsForDay(day, engineStr);
    const rows = await fetchOpdNotesForDay(day, already, n);

    // Sequential on purpose: one mini, one stream — and per-note wall time IS the probe.
    const results: Record<string, unknown>[] = [];
    for (const row of rows) {
      const started = Date.now();
      try {
        const audit = await auditOpdNote(row, { pipeline: 'mini' });
        const status = await saveOpdAudit(audit, { model: MINI_MODEL, latencyMs: Date.now() - started });
        results.push({ uid: audit.keys.uid, index: audit.scorecard.headline, band: audit.scorecard.band, status, ms: Date.now() - started, traceId: audit.traceId ?? null });
      } catch (e) {
        results.push({ uid: String((row as Record<string, unknown>).uid || ''), error: String((e as Error).message), ms: Date.now() - started });
      }
    }

    const okRuns = results.filter((r) => !('error' in r));
    const avgMs = okRuns.length ? Math.round(okRuns.reduce((s, r) => s + Number(r.ms), 0) / okRuns.length) : null;
    const audited = already.length + results.filter((r) => r.status === 'inserted').length;
    return NextResponse.json({
      ok: true,
      engine: engineStr,
      model: MINI_MODEL,
      day, total, audited, processed: results.length,
      remaining: Math.max(0, total - audited),
      done: audited >= total,
      results,
      throughput: avgMs ? { avg_ms_per_note: avgMs, est_notes_per_24h: Math.round(86_400_000 / avgMs) } : null,
      advisory: 'Mini-pipeline rows (engine -mini) are research artifacts — invisible to prod dashboards/APIs by engine filter; individual rows viewable at /admin/opd-audit/<id>.',
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
