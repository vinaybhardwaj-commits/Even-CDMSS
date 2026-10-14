export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

import { NextRequest, NextResponse } from 'next/server';
import { hasEngineBearer } from '@/lib/engine-auth';
import { isUid } from '@/lib/ccb-dossier-core';
import { getMemberSnapshotAsOf } from '@/lib/member-state/member-state';

const isRealDay = (d: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};

/**
 * newcat engine endpoint: member state as of a visit date (N4a, GET only). Machine-to-machine.
 * Dark unless ENGINE_MEMBER_STATE=1 (404). Bearer NEWCAT_ENGINE_TOKEN only (401 otherwise).
 *   GET ?individual_uid=<uid>&as_of=YYYY-MM-DD[&audited_ref=<uid>]
 * Logs status and duration only, never the uid or snapshot content.
 */
export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const done = (status: number, tag: string, body: unknown) => {
    console.log(`engine.member-state status=${status} ${tag} ms=${Date.now() - t0}`);
    return NextResponse.json(body, { status });
  };
  if (process.env.ENGINE_MEMBER_STATE !== '1') return done(404, 'flag_off', { error: 'not found' });
  if (!hasEngineBearer(req)) return done(401, 'unauthorized', { error: 'unauthorized' });

  const p = req.nextUrl.searchParams;
  const uid = p.get('individual_uid') || '';
  const asOf = p.get('as_of') || '';
  const auditedRaw = p.get('audited_ref');
  if (!isUid(uid) || !isRealDay(asOf) || (auditedRaw !== null && !isUid(auditedRaw))) {
    return done(400, 'bad_request', { ok: false, error: 'invalid parameters' });
  }

  const computedAt = new Date().toISOString();   // the route stamps the clock; the core never reads it
  try {
    const snapshot = await getMemberSnapshotAsOf(uid, asOf, computedAt, auditedRaw);
    if (!snapshot) return done(200, 'no_prior_history', { ok: true, status: 'no_prior_history' });
    return done(200, 'ok', { ok: true, schema: 'member-state/1.2', snapshot });
  } catch {
    return done(503, 'context_fetch_failed', { ok: false, status: 'context_fetch_failed' });
  }
}
