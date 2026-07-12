export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';
import { fetchOpdNoteByUid, fetchOpdNotesByUids } from '@/lib/metabase';
import { rowToOpdCase, opdCaseText } from '@/lib/opd-ingest-core';
import { enrichOpdMeds } from '@/lib/formulary';
import { buildLongitudinalInput } from '@/lib/opd-longitudinal-core';
import { OPD_ENGINE_VERSION } from '@/lib/opd-note-audit-core';
import { replayLongitudinal } from '@/lib/opd-longitudinal';

// Stage 3 replay (PRD §6, D3 forward-only + paced): recompute + store ONLY the `longitudinal` column for
// already-audited notes — the base audit is NEVER re-run or touched. Two modes:
//   ?uid=<note uid>        → one note (the audited prescription uid).
//   ?doctor_uid=<uid>      → a bounded batch (≤50) of that doctor's most-recent audited notes, run
//                            SEQUENTIALLY with ~1s pacing (db13 contention rule).
// Auth: Vercel Cron / Bearer CRON_SECRET / ?secret= / a logged-in admin session.
//
// SQL honesty: note content is re-fetched via the EXISTING db13 helpers (fetchOpdNoteByUid /
// fetchOpdNotesByUids) — NO new db13 query. The only own-DB read here is the doctor→note-uid lookup
// against opd_note_audits (own table). Member/lab reads stay inside getMemberSnapshotAsOf (frozen SQL).
async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Rebuild the de-identified longitudinal input for a db13 note row (no base LLM — projection only). */
function inputFor(row: Record<string, unknown>) {
  const { case: oc, keys } = rowToOpdCase(row);
  enrichOpdMeds(oc.medications);   // brand→generic parity with the production audit
  return buildLongitudinalInput(oc, keys, OPD_ENGINE_VERSION, opdCaseText(oc, { specialty: null }));
}

export async function POST(req: NextRequest) {
  if (process.env.OPD_LONGITUDINAL_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const p = req.nextUrl.searchParams;
  const uid = (p.get('uid') || '').trim();
  const doctorUid = (p.get('doctor_uid') || '').trim();

  try {
    // Single-note mode.
    if (uid) {
      if (!isUid(uid)) return NextResponse.json({ error: 'bad uid' }, { status: 400 });
      const row = await fetchOpdNoteByUid(uid);
      if (!row) return NextResponse.json({ ok: false, error: 'note not found in db13' }, { status: 404 });
      const input = inputFor(row);
      if (!input) return NextResponse.json({ ok: false, error: 'note missing uid/date — cannot anchor as-of' }, { status: 422 });
      const r = await replayLongitudinal(input);
      return NextResponse.json({ ok: true, mode: 'uid', result: r });
    }

    // Doctor batch mode (bounded ≤50, sequential, paced).
    if (doctorUid) {
      if (!isUid(doctorUid)) return NextResponse.json({ error: 'bad doctor_uid' }, { status: 400 });
      const limit = Math.max(1, Math.min(50, Number(p.get('limit') || 50)));
      const auditRows = (await sql(
        `SELECT uid FROM opd_note_audits WHERE doctor_uid = $1 AND engine_version = $2 AND uid IS NOT NULL
         ORDER BY note_date DESC LIMIT $3`,
        [doctorUid, OPD_ENGINE_VERSION, limit],
      )) as Array<{ uid: string }>;
      const uids = auditRows.map((r) => r.uid).filter(Boolean);
      const noteRows = await fetchOpdNotesByUids(uids);
      const byUid = new Map(noteRows.map((r) => [String((r as Record<string, unknown>).uid || ''), r]));

      const results: unknown[] = [];
      for (const u of uids) {
        const row = byUid.get(u);
        if (!row) { results.push({ uid: u, error: 'note not found in db13' }); continue; }
        try {
          const input = inputFor(row);
          if (!input) { results.push({ uid: u, error: 'missing uid/date' }); continue; }
          results.push(await replayLongitudinal(input));
        } catch (e) {
          results.push({ uid: u, error: String((e as Error).message) });
        }
        await sleep(1000);   // db13 contention rule — pace the batch
      }
      return NextResponse.json({ ok: true, mode: 'doctor', doctor_uid: doctorUid, count: uids.length, results });
    }

    return NextResponse.json({ error: 'pass ?uid=<note uid> or ?doctor_uid=<doctor uid>' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
