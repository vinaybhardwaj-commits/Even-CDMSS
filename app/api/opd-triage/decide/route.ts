/**
 * POST /api/opd-triage/decide — submit one care-manager triage decision (spec v2.0 §3.2).
 *
 * Type-batch (scope='type', the common case) or instance override (scope='instance'). Appends an
 * immutable row to opd_audit_triage; latest row wins. Validation + normalization is the pure core
 * (validateDecision). Minting the governance signal on route (opd_gov_signal) is Build 3 — this
 * endpoint only records the decision.
 * Auth: care-manager session cookie OR admin.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { insertDecision } from '@/lib/opd-triage-store';
import type { DecisionInput } from '@/lib/opd-triage-core';

async function authed(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

export async function POST(req: NextRequest) {
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  let body: DecisionInput;
  try { body = (await req.json()) as DecisionInput; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  try {
    const { id, decision, signal, signal_error } = await insertDecision(body);
    return NextResponse.json({ ok: true, id, decision, signal: signal ?? null, ...(signal_error ? { signal_error } : {}) });
  } catch (e) {
    const msg = String((e as Error).message);
    // Validation errors from the core → 400; anything else (DB) → 500.
    const isValidation = /required|must be|instance scope/.test(msg);
    return NextResponse.json({ ok: false, error: msg }, { status: isValidation ? 400 : 500 });
  }
}
