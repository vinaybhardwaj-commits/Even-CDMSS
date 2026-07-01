export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { searchMembers } from '@/lib/ccb-search';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { ccbApiKeyValid } from '@/lib/ccb-apikey';

// Same guard as the worklist: CCB_API_KEY (Pulse), care-manager session, admin session, or CRON_SECRET.
async function authed(req: NextRequest): Promise<boolean> {
  if (ccbApiKeyValid(req)) return true;
  const secret = req.nextUrl.searchParams.get('secret');
  if (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true;
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

/**
 * CCB member SEARCH (Pulse parity). DARK behind CCB_ENABLED.
 *   GET /api/ccb/search?q=<member id | phone | name | uid | uhid>[&limit=12]
 *     → { ok, count, members: MemberHit[] } ranked (has-episodes first, then most-recent visit).
 *   Powers the /care surface's member picker. Auth: care/admin session or x-api-key CCB_API_KEY.
 */
export async function GET(req: NextRequest) {
  if (process.env.CCB_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const p = req.nextUrl.searchParams;
  const q = (p.get('q') || '').trim();
  const limit = Math.max(1, Math.min(25, Number(p.get('limit') || 12)));
  if (q.length < 2) return NextResponse.json({ ok: true, count: 0, members: [] });

  try {
    const members = await searchMembers(q, { limit });
    return NextResponse.json({ ok: true, count: members.length, members });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
