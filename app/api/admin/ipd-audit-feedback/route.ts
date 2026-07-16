import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

const VERDICTS = new Set(['agree', 'disagree', 'needs_action']);

// POST /api/admin/ipd-audit-feedback — per-finding clinician triage (Agree / Disagree /
// Needs action) on an IPD audit. Append-only (latest row per finding wins on read).
// Body: { auditId, findingRef?, verdict, note? }.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  const auditId = typeof body.auditId === 'string' ? body.auditId.trim() : '';
  const verdict = typeof body.verdict === 'string' ? body.verdict.trim() : '';
  const findingRef = typeof body.findingRef === 'string' ? body.findingRef.trim().slice(0, 300) : null;
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : null;
  if (!/^[0-9a-f-]{36}$/i.test(auditId)) return NextResponse.json({ ok: false, error: 'bad auditId' }, { status: 400 });
  if (!VERDICTS.has(verdict)) return NextResponse.json({ ok: false, error: 'verdict must be agree | disagree | needs_action' }, { status: 400 });

  try {
    await sql(
      `INSERT INTO ipd_audit_feedback (audit_id, finding_ref, verdict, note) VALUES ($1,$2,$3,$4)`,
      [auditId, findingRef || null, verdict, note || null],
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
