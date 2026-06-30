/**
 * POST /api/opd-audit/feedback — capture an auditor / care-manager's reaction to an OPD audit,
 * shown back on the comparison screen. Anonymous by default (author optional). Each call is one
 * comment row. Auth: ADMIN_TOKEN (Bearer/?token=) OR a logged-in admin session cookie (the
 * dashboard is admin-gated, so the in-page form posts with the cookie — no token handling).
 *
 * This is the human-label signal the learning loop (#3) will calibrate against, so we keep the
 * verdict structured (agree | disagree | needs_action) alongside the free text.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VERDICTS = new Set(['agree', 'disagree', 'needs_action']);
const APP = process.env.APP_SOURCE || 'standalone';

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* ignore */ }

  const auditId = String(body.auditId ?? '').trim();
  const uid = body.uid ? String(body.uid).trim().slice(0, 64) : null;
  const verdict = VERDICTS.has(String(body.verdict)) ? String(body.verdict) : null;
  const comment = body.comment ? String(body.comment).trim().slice(0, 4000) : null;
  const author = body.author ? String(body.author).trim().slice(0, 120) : null;

  if (!/^[0-9a-f-]{36}$/i.test(auditId)) return NextResponse.json({ error: 'bad auditId' }, { status: 400 });
  if (!verdict && !comment) return NextResponse.json({ error: 'provide a verdict or a comment' }, { status: 400 });

  try {
    const rows = (await sql`
      INSERT INTO opd_audit_feedback (app_source, audit_id, uid, verdict, comment, author)
      VALUES (${APP}, ${auditId}, ${uid}, ${verdict}, ${comment}, ${author})
      RETURNING id, created_at`) as Array<{ id: string; created_at: string }>;
    return NextResponse.json({ ok: true, id: rows[0]?.id, created_at: rows[0]?.created_at });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
