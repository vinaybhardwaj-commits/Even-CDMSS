export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { auditOpdNote } from '@/lib/opd-note-audit';
import { OPD_ENGINE_VERSION } from '@/lib/opd-note-audit-core';
import { countOpdNotesForDay, fetchOpdNotesForDay, istYesterday } from '@/lib/metabase';
import { saveOpdAudit, auditedUidsForDay, auditedCountForDay, earliestAuditedDay } from '@/lib/opd-audit-store';
import { isAdminUnlocked } from '@/lib/admin-cookie';

// Execution guard (spends LLM compute): Vercel Cron (un-spoofable x-vercel-cron), a manual
// trigger carrying Bearer CRON_SECRET / ?secret=CRON_SECRET, OR a logged-in admin session
// (so the dashboard's one-click "Re-audit" button works without handling any secret).
async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (it: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

function addDays(day: string, delta: number): string {
  const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10);
}

// Audit one batch of not-yet-audited notes for a single IST day.
async function processDay(day: string, max: number, conc: number) {
  const total = await countOpdNotesForDay(day);
  const already = await auditedUidsForDay(day, OPD_ENGINE_VERSION);
  if (already.length >= total) return { day, total, audited: already.length, processed: 0, remaining: 0, done: true, results: [] as unknown[] };
  const rows = await fetchOpdNotesForDay(day, already, max);
  const results = await mapLimit(rows, conc, async (row) => {
    const started = Date.now();
    try {
      const audit = await auditOpdNote(row);
      const status = await saveOpdAudit(audit, { model: 'gemini-2.5-pro', latencyMs: Date.now() - started });
      return { uid: audit.keys.uid, index: audit.scorecard.headline, band: audit.scorecard.band, status };
    } catch (e) {
      return { uid: String((row as Record<string, unknown>).uid || ''), error: String((e as Error).message) };
    }
  });
  const inserted = results.filter((r) => 'status' in r && (r as { status?: string }).status === 'inserted').length;
  const audited = already.length + inserted;
  const remaining = Math.max(0, total - audited);
  return { day, total, audited, processed: results.length, remaining, done: remaining === 0, results };
}

/**
 * Count-agnostic, resumable, GAP-PROOF OPD note-quality worker.
 *
 * Two modes:
 *  • ?day=YYYY-MM-DD  → audit just that day (manual backfill / spot-fill).
 *  • default (cron)   → SWEEP a lookback window ending yesterday IST, working the OLDEST
 *    un-audited day first. So a missed night (weekend, deploy gap) is caught up automatically
 *    on the next run, oldest-first, until the whole window is complete. The window is floored
 *    at the earliest-ever audited day, so it never reaches back before the system launched,
 *    and it's idempotent (uid+engine_version), so caught-up days are cheap no-ops — no re-charge.
 *
 *  ?max (12→ default 15, ≤30) · ?conc (default 5, ≤8) · ?lookback (default OPD_AUDIT_LOOKBACK or 4, ≤14).
 */
export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const p = req.nextUrl.searchParams;
  const max = Math.max(1, Math.min(30, Number(p.get('max') || 15)));
  const conc = Math.max(1, Math.min(8, Number(p.get('conc') || 5)));
  const dayParam = p.get('day');

  try {
    // Manual single-day mode.
    if (dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam)) {
      const r = await processDay(dayParam, max, conc);
      return NextResponse.json({ ok: true, mode: 'day', ...r });
    }

    // Sweep mode: oldest incomplete day in the lookback window (floored at launch).
    const lookback = Math.max(1, Math.min(14, Number(p.get('lookback') || process.env.OPD_AUDIT_LOOKBACK || 4)));
    const yesterday = istYesterday();
    const floor = (await earliestAuditedDay()) || yesterday;
    const days: string[] = [];
    for (let i = lookback - 1; i >= 0; i--) { const d = addDays(yesterday, -i); if (d >= floor) days.push(d); }
    const window = { from: days[0] ?? yesterday, to: yesterday };

    for (const d of days) {
      const total = await countOpdNotesForDay(d);
      if (total === 0) continue;
      const auditedCount = await auditedCountForDay(d, OPD_ENGINE_VERSION);
      if (auditedCount < total) {
        const r = await processDay(d, max, conc);
        return NextResponse.json({ ok: true, mode: 'sweep', window, ...r });
      }
    }
    return NextResponse.json({ ok: true, mode: 'sweep', window, caughtUp: true, done: true, processed: 0 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
