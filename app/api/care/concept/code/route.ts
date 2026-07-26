/**
 * POST|GET /api/care/concept/code?auto=1 — the Concept Coder worker tick (CDMSS-CONCEPT-CODER-PRD v1.0
 * §3). Stamps concept_id + concept_context onto stored low-value findings: exact cache lookup first
 * (zero cost), one extraction call per unseen string, bounded per tick, resumable, pausable.
 * Additive + score-invariant + fail-safe. Always returns 200 with the tick result.
 *
 * FLAGGED OFF: needs CCB_ENABLED=1 AND LVC_CONCEPT_ENABLED=1. Auth: Vercel Cron (x-vercel-cron) /
 * Bearer CRON_SECRET / ?secret= / care-unlock / admin — identical shape to the ground route.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isCareUnlocked } from '@/lib/care-cookie';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { runConceptTick } from '@/lib/even-concept';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function enabled(): boolean { return process.env.CCB_ENABLED === '1' && process.env.LVC_CONCEPT_ENABLED === '1'; }

async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

export async function POST(req: NextRequest) {
  if (!enabled()) return NextResponse.json({ ok: false, status: 'disabled', error: 'disabled' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const auto = req.nextUrl.searchParams.get('auto') === '1';
  const result = await runConceptTick({ trigger: auto ? 'cron' : 'manual' });
  return NextResponse.json({ ok: true, ...result });   // always 200; status ∈ ok|idle|paused|locked|error
}

export async function GET(req: NextRequest) { return POST(req); }   // Vercel cron issues GET
