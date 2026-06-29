export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { auditOpdNote } from '@/lib/opd-note-audit';
import { OPD_ENGINE_VERSION } from '@/lib/opd-note-audit-core';
import { countOpdNotesForDay, fetchOpdNotesForDay, istYesterday } from '@/lib/metabase';
import { saveOpdAudit, auditedUidsForDay } from '@/lib/opd-audit-store';

// Execution guard (this spends LLM compute): Vercel Cron (un-spoofable x-vercel-cron) or a
// manual trigger carrying Bearer CRON_SECRET / ?secret=CRON_SECRET. Not a view gate.
function authed(req: NextRequest): boolean {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  return isCron || bearerOk || secretOk;
}

// Bounded-concurrency map (no dependency).
async function mapLimit<T, R>(items: T[], limit: number, fn: (it: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
    }),
  );
  return out;
}

/**
 * Count-agnostic, resumable OPD note-quality worker.
 *
 * Each invocation: count the day's non-draft medical notes → read the uids already audited
 * (at this engine version) → fetch the next un-audited page (≤ `max`) → audit them with
 * bounded concurrency (`conc`) → persist each. The audit table is the watermark, so it
 * needs no count up front, is idempotent, and resumes after any crash. A windowed backstop
 * cron re-invokes until the day is drained; runs after done are cheap no-ops.
 *
 * Query: ?day=YYYY-MM-DD (default = yesterday IST) · ?max (default 12, ≤30) · ?conc (default 4, ≤8).
 */
export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const p = req.nextUrl.searchParams;
  const day = p.get('day') || istYesterday();
  const max = Math.max(1, Math.min(30, Number(p.get('max') || 12)));
  const conc = Math.max(1, Math.min(8, Number(p.get('conc') || 4)));

  try {
    const total = await countOpdNotesForDay(day);
    const already = await auditedUidsForDay(day, OPD_ENGINE_VERSION);
    if (already.length >= total) {
      return NextResponse.json({ ok: true, day, total, audited: already.length, processed: 0, remaining: 0, done: true });
    }

    const rows = await fetchOpdNotesForDay(day, already, max);
    const t0 = Date.now();
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

    const inserted = results.filter((r) => 'status' in r && r.status === 'inserted').length;
    const audited = already.length + inserted;
    const remaining = Math.max(0, total - audited);
    return NextResponse.json({
      ok: true, day, total, audited, processed: results.length, remaining, done: remaining === 0,
      took_ms: Date.now() - t0, results,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, day, error: String((e as Error).message) }, { status: 500 });
  }
}
