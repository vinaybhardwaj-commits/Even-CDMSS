/**
 * POST /api/opd-audit/feedback — capture an auditor / care-manager's reaction to an OPD audit,
 * shown back on the case screen. Anonymous by default (author optional). Each call is one row
 * (append-only); current state = latest row per (audit_id, finding_ref). Auth: ADMIN_TOKEN
 * (Bearer/?token=) OR a logged-in admin session cookie (the case view is admin-gated, so the
 * in-page form posts with the cookie — no token handling).
 *
 * Body validation + normalisation lives in the pure lib/opd-feedback-core.ts. Three scopes
 * (PRD §4.1): 'audit' (legacy whole-audit reaction + general comment), 'finding' (per-finding
 * triage — true_positive|nitpick|false|contested, keyed to a finding_ref), 'missed' (a
 * finding that should have fired). This is the clinician-gold label signal the model project harvests.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { parseFeedbackBody } from '@/lib/opd-feedback-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const APP = process.env.APP_SOURCE || 'standalone';

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;

  let body: unknown = {};
  try { body = await req.json(); } catch { /* ignore */ }

  const parsed = parseFeedbackBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { auditId, scope, uid, verdict, comment, author, finding_ref, signal_type } = parsed.value;

  try {
    const rows = (await sql`
      INSERT INTO opd_audit_feedback (app_source, audit_id, scope, uid, verdict, comment, author, finding_ref, signal_type)
      VALUES (${APP}, ${auditId}, ${scope}, ${uid}, ${verdict}, ${comment}, ${author}, ${finding_ref}, ${signal_type})
      RETURNING id, created_at`) as Array<{ id: string; created_at: string }>;
    return NextResponse.json({ ok: true, id: rows[0]?.id, created_at: rows[0]?.created_at });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
