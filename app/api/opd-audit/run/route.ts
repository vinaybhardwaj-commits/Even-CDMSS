import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { auditOpdNote } from '@/lib/opd-note-audit';
import { saveOpdAudit } from '@/lib/opd-audit-store';
import { GEMINI_MODEL } from '@/lib/llm';

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
    // &save=1 persists the audit (golden-A/B tool): writes the current-engine row so a before/after
    // comparison can be read from opd_note_audits by engine_version. Admin-gated; manual use only.
    // &force=1 (only with save=1) overwrites an existing (uid, engine_version) row — finishes the
    // obstetric re-score backfill where a pre-fix zero row already occupies the slot. Fail-safe:
    // a forced-save error degrades to saved:'save_failed', never a 500.
    const save = req.nextUrl.searchParams.get('save') === '1';
    const force = save && req.nextUrl.searchParams.get('force') === '1';
    const saved = save
      ? (force
          ? await saveOpdAudit(audit, { model: GEMINI_MODEL }, { force: true }).catch(() => 'save_failed' as const)
          : await saveOpdAudit(audit, { model: GEMINI_MODEL }))
      : undefined;
    return NextResponse.json({ ok: true, saved, engineVersion: audit.engineVersion, audit });
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
