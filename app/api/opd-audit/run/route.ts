import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { auditOpdNote } from '@/lib/opd-note-audit';

export const runtime = 'nodejs';
export const maxDuration = 300;

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
