/**
 * GET/POST /api/admin/complexity-backfill — populate opd_note_audits.complexity_band on rows the
 * audit-time computation left NULL (db13 unreachable at the time) or that predate 0.81.3
 * (RIGHT-CARE-INDICATOR-PRD §6 / §2.7). Auth: ADMIN_TOKEN (Bearer/?token) or an admin session cookie.
 *
 * GET  = status (banded / unbanded / distribution / cursor).
 * POST = run one batch of ≤50 NULL-band notes, OLDEST-first, resuming from the app_settings cursor
 *        `complexity_backfill_cursor` (a note_date watermark). Rows that still fail (bad/absent db13
 *        history) stay NULL and are retried on a `?reset=1` re-sweep. Idempotent (UPDATE sets the
 *        same band); read-only against db13; never touches scoring.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';
import { fetchOpdNoteByUid, fetchPatientHistoryBundle } from '@/lib/metabase';
import { bandFor } from '@/lib/opd-complexity-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const CURSOR_KEY = 'complexity_backfill_cursor';
const EPOCH = '1970-01-01T00:00:00.000Z';
const BATCH = 50;

async function getCursor(): Promise<string> {
  const r = await run(`SELECT value FROM app_settings WHERE key = $1`, [CURSOR_KEY]).catch(() => []);
  const v = r[0]?.value ? String(r[0].value) : '';
  return v && !Number.isNaN(new Date(v).getTime()) ? v : EPOCH;
}
async function setCursor(v: string): Promise<void> {
  await run(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [CURSOR_KEY, v]).catch(() => {});
}

async function status(): Promise<Record<string, unknown>> {
  const agg = await run(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE complexity_band IS NOT NULL)::int AS banded,
            count(*) FILTER (WHERE complexity_band IS NULL)::int AS unbanded
     FROM opd_note_audits`).catch(() => []);
  const dist = await run(
    `SELECT coalesce(complexity_band, '(null)') AS band, count(*)::int AS n FROM opd_note_audits GROUP BY 1 ORDER BY n DESC`).catch(() => []);
  return { ...(agg[0] || { total: 0, banded: 0, unbanded: 0 }), cursor: await getCursor(), distribution: dist };
}

function authed(req: NextRequest) {
  const denied = requireAdmin(req);
  return denied ? isAdminUnlocked().catch(() => false).then((ok) => (ok ? null : denied)) : Promise.resolve(null);
}

export async function GET(req: NextRequest) {
  const denied = await authed(req);
  if (denied) return denied;
  return NextResponse.json({ ok: true, ...(await status()) });
}

export async function POST(req: NextRequest) {
  const denied = await authed(req);
  if (denied) return denied;

  if (req.nextUrl.searchParams.get('reset') === '1') {
    await setCursor(EPOCH);
    return NextResponse.json({ ok: true, reset: true, ...(await status()) });
  }

  const cursor = await getCursor();
  const rows = await run(
    `SELECT id, uid, note_date FROM opd_note_audits
     WHERE complexity_band IS NULL AND note_date IS NOT NULL AND note_date > $1::timestamptz
     ORDER BY note_date ASC, id ASC LIMIT ${BATCH}`, [cursor]).catch(() => []) as Array<{ id: string; uid: string; note_date: string }>;

  let processed = 0, banded = 0, failed = 0, lastDate = cursor;
  for (const r of rows) {
    processed++;
    lastDate = r.note_date ? new Date(r.note_date).toISOString() : lastDate;
    const uid = String(r.uid || '');
    try {
      const note = uid ? await fetchOpdNoteByUid(uid).catch(() => null) : null;
      const iuid = note?.individual_uid ? String(note.individual_uid) : '';
      const asOf = note?.timestamp ? String(note.timestamp) : (r.note_date ? String(r.note_date) : '');
      const inputs = iuid && asOf ? await fetchPatientHistoryBundle(iuid, asOf) : null;
      if (inputs) {
        await run(`UPDATE opd_note_audits SET complexity_band = $1, complexity_inputs = $2::jsonb WHERE id = $3`,
          [bandFor(inputs), JSON.stringify(inputs), r.id]).catch(() => {});
        banded++;
      } else {
        failed++; // stays NULL — retried on a ?reset=1 sweep
      }
    } catch {
      failed++;
    }
  }

  // Advance the cursor past this batch so the sweep makes forward progress even when some rows stay NULL.
  if (processed > 0) await setCursor(lastDate);
  const done = processed < BATCH;
  return NextResponse.json({ ok: true, processed, banded, failed, done, cursor: lastDate, note: done ? 'sweep drained; POST ?reset=1 to retry any rows still NULL' : 'more remain — POST again' });
}
