export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { assembleEpisode } from '@/lib/ccb-fetch';
import { generateBrief } from '@/lib/ccb-brief';
import { saveBrief, getBriefByUid } from '@/lib/ccb-store';
import { CCB_ENGINE_VERSION } from '@/lib/ccb-brief-core';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { GEMINI_MODEL } from '@/lib/llm';

// Execution guard (spends LLM compute): Vercel Cron (un-spoofable x-vercel-cron), a manual
// trigger carrying Bearer CRON_SECRET / ?secret=CRON_SECRET, OR a logged-in admin session
// (so it can be exercised one-click without handling a secret) — same contract as the OPD worker.
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
 * Care Conversation Brief — on-demand (P1). DARK behind CCB_ENABLED (404 until set).
 *
 *   GET ?uid=<presc_uid>            → assemble the episode → grounded two-layer brief → persist → return.
 *       &fresh=1                    → bypass the read-through cache (regenerate).
 *       &dry=1                      → do not persist (debug).
 *
 * Returns the de-identified CcbEnvelope (PRD §12). P2 adds the SSE stage stream + ?individual_uid=&date=.
 */
export async function GET(req: NextRequest) {
  if (process.env.CCB_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const p = req.nextUrl.searchParams;
  const uid = (p.get('uid') || '').trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(uid)) return NextResponse.json({ error: 'bad or missing uid' }, { status: 400 });
  const fresh = p.get('fresh') === '1';
  const dry = p.get('dry') === '1';

  try {
    if (!fresh) {
      const cached = await getBriefByUid(uid, CCB_ENGINE_VERSION).catch(() => null);
      if (cached) return NextResponse.json({ ...cached, cached: true });
    }

    const bundle = await assembleEpisode(uid);
    if (!bundle) return NextResponse.json({ error: 'prescription not found' }, { status: 404 });

    const started = Date.now();
    const envelope = await generateBrief(bundle);
    if (!dry) await saveBrief(envelope, bundle.keys, { model: GEMINI_MODEL, latencyMs: Date.now() - started }).catch(() => {});

    return NextResponse.json(envelope);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
