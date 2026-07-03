export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { requireAdmin } from '@/lib/admin-gate';
import { ensureSuppressionTable } from '@/lib/audit-suppression-store';

/** One-click, idempotent: create audit_suppression. Admin or ?token=ADMIN_TOKEN. */
export async function GET(req: NextRequest) {
  if (!(await isAdminUnlocked())) { const denied = requireAdmin(req); if (denied) return denied; }
  try { await ensureSuppressionTable(); return NextResponse.json({ ok: true, migrated: 'audit_suppression' }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
