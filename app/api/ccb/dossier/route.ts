export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

import { NextRequest, NextResponse } from 'next/server';
import { assembleDossier } from '@/lib/ccb-dossier';
import { bridgeMemberIdToIndividuals } from '@/lib/ccb-search';
import { bridgeUhidToIndividual } from '@/lib/ccb-resolve';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { ccbApiKeyValid } from '@/lib/ccb-apikey';

// Same guard as the worklist/search: CCB_API_KEY (Pulse), care-manager session, admin, or CRON_SECRET.
async function authed(req: NextRequest): Promise<boolean> {
  if (ccbApiKeyValid(req)) return true;
  const secret = req.nextUrl.searchParams.get('secret');
  if (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true;
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u);

/**
 * CCB member DOSSIER (whole-person record). DARK behind CCB_ENABLED.
 *   GET /api/ccb/dossier?individual_uid=<uid>   (or ?uhid= / ?member_id=)
 *     → { ok, dossier } — identity + snapshot + a unified care timeline (OPD + diagnostics +
 *       radiology + IPD/discharge). Deterministic; no LLM. Powers the /care member view.
 */
export async function GET(req: NextRequest) {
  if (process.env.CCB_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const p = req.nextUrl.searchParams;
  let individualUid = (p.get('individual_uid') || '').trim();
  const uhid = (p.get('uhid') || '').trim();
  const memberId = (p.get('member_id') || '').trim();

  try {
    if (!isUid(individualUid) && uhid) {
      individualUid = (await bridgeUhidToIndividual(uhid).catch(() => null)) || '';
    }
    if (!isUid(individualUid) && memberId) {
      const inds = await bridgeMemberIdToIndividuals(memberId).catch(() => [] as string[]);
      individualUid = inds[0] || '';
    }
    if (!isUid(individualUid)) return NextResponse.json({ error: 'pass ?individual_uid=, ?uhid=, or ?member_id=' }, { status: 400 });

    const dossier = await assembleDossier(individualUid);
    if (!dossier) return NextResponse.json({ error: 'member not found' }, { status: 404 });
    return NextResponse.json({ ok: true, dossier });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
