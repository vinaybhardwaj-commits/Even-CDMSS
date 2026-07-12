export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { metabaseQuery } from '@/lib/metabase';
import { prescriptionSql } from '@/lib/ccb-fetch-core';
import { rowToOpdCase } from '@/lib/opd-ingest-core';
import { buildAskSet } from '@/lib/care-call-core';
import { nextAttempt, priorAttempts } from '@/lib/care-call-store';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { ccbApiKeyValid } from '@/lib/ccb-apikey';

async function authed(req: NextRequest): Promise<boolean> {
  if (ccbApiKeyValid(req)) return true;
  const secret = req.nextUrl.searchParams.get('secret');
  if (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true;
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}
const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u);

/**
 * Care-Call ask-set (DARK behind CARE_CALL_ENABLED). GET ?uid=<presc_uid> → the per-episode ask
 * generator. Reuses the exported prescriptionSql + rowToOpdCase (the hybrid path assembleEpisode
 * uses internally; assembleEpisode does not surface the DeidOpdCase the generator needs). FAIL-SAFE:
 * any fetch/parse error → { asks:[], degraded:true } at HTTP 200 (the panel logs disposition-only).
 */
export async function GET(req: NextRequest) {
  if (process.env.CARE_CALL_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const uid = (req.nextUrl.searchParams.get('uid') || '').trim();
  if (!isUid(uid)) return NextResponse.json({ error: 'pass ?uid=<presc_uid>' }, { status: 400 });

  const [attempt_next, prior] = await Promise.all([nextAttempt(uid), priorAttempts(uid)]);
  try {
    const rows = await metabaseQuery(prescriptionSql(uid)).catch(() => [] as Record<string, unknown>[]);
    if (!rows.length) return NextResponse.json({ asks: [], overflow: [], degraded: true, attempt_next, prior });
    const { case: oc, keys } = rowToOpdCase(rows[0]);
    const askKeys = { presc_uid: uid, individual_uid: String(rows[0].individual_uid ?? ''), uhid: null, note_date: keys.noteDate ?? null };
    const { asks, overflow } = buildAskSet(oc, askKeys);
    return NextResponse.json({ asks, overflow, degraded: false, attempt_next, prior, keys: askKeys });
  } catch {
    return NextResponse.json({ asks: [], overflow: [], degraded: true, attempt_next, prior });
  }
}
