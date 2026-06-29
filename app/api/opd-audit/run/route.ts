import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { auditOpdNote } from '@/lib/opd-note-audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

// Convenience spot-check: GET ?uid=<prescription uid> fetches that note from db13 via the
// Metabase API and audits it (admin-gated) — no need to hand-assemble a row. The daily
// worker (app/api/opd-audit/worker) audits the full day; this is for one-off inspection.
export async function GET(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const uid = req.nextUrl.searchParams.get('uid');
  if (!uid) return NextResponse.json({ ok: false, error: 'pass ?uid=<prescription uid>' }, { status: 400 });
  try {
    const { fetchOpdNoteByUid } = await import('@/lib/metabase');
    const row = await fetchOpdNoteByUid(uid);
    if (!row) return NextResponse.json({ ok: false, error: 'note not found for that uid' }, { status: 404 });
    const audit = await auditOpdNote(row);
    return NextResponse.json({ ok: true, audit });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}

// M1 proof route: POST a single de-identified `individuals-prescriptions` row and get
// back its OPD note-quality audit. Admin-token-gated. In M2 the daily worker calls
// auditOpdNote() directly over rows pulled from db13 via the Metabase API — this route
// is for proving + spot-checking one note (feed it a row you fetched from Metabase).
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;

  let body: { row?: Record<string, unknown> };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const row = body?.row;
  if (!row || typeof row !== 'object') {
    return NextResponse.json({ ok: false, error: 'body must be { row: <prescriptions row object> }' }, { status: 400 });
  }

  try {
    const audit = await auditOpdNote(row);
    return NextResponse.json({ ok: true, audit });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
