export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { CCB_ENGINE_VERSION } from '@/lib/ccb-brief-core';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { ccbApiKeyValid } from '@/lib/ccb-apikey';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

async function authed(req: NextRequest): Promise<boolean> {
  if (ccbApiKeyValid(req)) return true;
  const secret = req.nextUrl.searchParams.get('secret');
  if (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true;
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

/**
 * CCB worklist API (Pulse). DARK behind CCB_ENABLED.
 *   GET /api/ccb/worklist[?date=YYYY-MM-DD][&pitch=1][&limit=100]
 *     → briefs ranked pitch_allowed → citation_coverage → recency. `pitch=1` returns only flagged
 *       candidates; `date` filters to one IST note day. Auth: x-api-key/Bearer CCB_API_KEY (Pulse).
 */
export async function GET(req: NextRequest) {
  if (process.env.CCB_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const p = req.nextUrl.searchParams;
  const date = (p.get('date') || '').trim();
  const pitchOnly = p.get('pitch') === '1';
  const limit = Math.max(1, Math.min(500, Number(p.get('limit') || 100)));

  const where = ['engine_version = $1'];
  const params: unknown[] = [CCB_ENGINE_VERSION];
  if (pitchOnly) where.push('pitch_allowed = true');
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) { params.push(date); where.push(`(note_date AT TIME ZONE 'Asia/Kolkata')::date = $${params.length}::date`); }

  try {
    const rows = await run(
      `SELECT presc_uid, uhid, individual_uid,
              to_char(note_date AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS note_date,
              coverage, priority, pitch_allowed, citation_coverage_pct, n_findings, doctor_speciality
       FROM ccb_briefs
       WHERE ${where.join(' AND ')}
       ORDER BY pitch_allowed DESC NULLS LAST, citation_coverage_pct DESC NULLS LAST, created_at DESC
       LIMIT ${limit}`,
      params,
    );
    return NextResponse.json({ ok: true, engine_version: CCB_ENGINE_VERSION, count: rows.length, items: rows });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
