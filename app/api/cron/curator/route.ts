export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

import { safeEqual } from '@/lib/safe-equal';
import { hasCronBearer } from '@/lib/cron-auth';
import { NextRequest, NextResponse } from 'next/server';
import { runCurator } from '@/lib/curator';

// Weekly Curator: discovers new harvest topics from real clinician demand.
// Same operational guard as the harvester (Bearer CRON_SECRET or ?secret=CRON_SECRET).
export async function GET(req: NextRequest) {
  const isCron = hasCronBearer(req);
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && safeEqual(auth, `Bearer ${process.env.CRON_SECRET}`);
  const secret = req.nextUrl.searchParams.get('secret');
  const ok = isCron || bearerOk || (!!process.env.CRON_SECRET && safeEqual(secret, process.env.CRON_SECRET));
  if (!ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const days = req.nextUrl.searchParams.get('days');
  const cap = req.nextUrl.searchParams.get('cap');
  const result = await runCurator({ days: days ? Number(days) : undefined, cap: cap ? Number(cap) : undefined });
  return NextResponse.json({ ok: !result.error, ...result });
}
