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
import { auditOpdNote, OPD_MINI_ENGINE_VERSION } from '@/lib/opd-note-audit';
import { MINI_MODEL } from '@/lib/llm';
import { countOpdNotesForDay, fetchOpdNotesForDay, istYesterday } from '@/lib/metabase';
import { saveOpdAudit, auditedUidsForDay } from '@/lib/opd-audit-store';
import { isAdminUnlocked } from '@/lib/admin-cookie';

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

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const p = req.nextUrl.searchParams;
  const n = Math.max(1, Math.min(3, Number(p.get('n') || 1)));
  const scan = Math.max(1, Math.min(365, Number(p.get('scan') || 30)));
  const dayParam = p.get('day');

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
          const done = await auditedUidsForDay(d, OPD_MINI_ENGINE_VERSION);
          if (done.length < total) { day = d; break; }
        }
        d = addDays(d, -1);
      }
      if (!day) {
        return NextResponse.json({ ok: true, engine: OPD_MINI_ENGINE_VERSION, model: MINI_MODEL, scanned, done: true, note: `no un-mini-audited notes in the last ${scan} day(s) — raise ?scan= to reach further back` });
      }
    }

    const total = await countOpdNotesForDay(day);
    const already = await auditedUidsForDay(day, OPD_MINI_ENGINE_VERSION);
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
      engine: OPD_MINI_ENGINE_VERSION,
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
