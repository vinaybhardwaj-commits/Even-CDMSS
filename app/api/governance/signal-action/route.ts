/**
 * POST /api/governance/signal-action  (contract §5.2)
 * A governance ruling / "mark actioned" from the Roster (EPI proxies with GOV_API_KEY). EPI records
 * a gov_intervention on its side, then syncs it here (gov_intervention_ref) to close the CDMSS
 * thread. CDMSS never enacts enforcement — it stores the ruling reference + updates status.
 *
 * Guarded: a repeat of the same action + gov_intervention_ref is a 200 no-op (replayed: true); an
 * illegal status transition (anything on a closed thread, a second ruling on a ruled one) is a 409.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { govKeyValid } from '@/lib/gov-auth';
import { getByReference, getBySignalId, applySignalAction, toSignalRow, SIGNAL_CHANGED } from '@/lib/opd-gov-signal-store';
import {
  validateSignalAction, signalObject, signalActionTransition, isSignalActionReplay, type SignalActionInput,
} from '@/lib/opd-gov-signal-core';
import { resolveInstancesForSignal } from '@/lib/opd-gov-read';

export async function POST(req: NextRequest) {
  if (!govKeyValid(req) && !(await isAdminUnlocked())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  let body: SignalActionInput;
  try { body = (await req.json()) as SignalActionInput; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  const signal = body.signal_id ? await getBySignalId(body.signal_id) : body.reference ? await getByReference(body.reference) : null;
  if (!signal) return NextResponse.json({ ok: false, error: 'unknown reference' }, { status: 404 });

  const v = validateSignalAction(body);
  if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });

  const respond = async (stored: typeof signal, replayed: boolean) => {
    const { count, representative } = await resolveInstancesForSignal(stored);
    return NextResponse.json({
      ok: true, replayed, status: stored.status,
      signal: signalObject(toSignalRow(stored, count), representative, new Date().toISOString()),
    });
  };

  // Idempotency first: the second delivery of a ruling the thread already carries changes nothing.
  if (isSignalActionReplay(signal.ruling, v.value)) return respond(signal, true);

  const guard = signalActionTransition(signal.status, v.value.action);
  if (!guard.ok) return NextResponse.json({ ok: false, error: guard.error }, { status: 409 });

  let updated;
  try {
    updated = await applySignalAction(signal, v.value);
  } catch (e) {
    if ((e as Error).message === SIGNAL_CHANGED) {
      // Lost a race. If the winner carried this same ruling it is a replay; otherwise the thread moved.
      const current = await getBySignalId(signal.signal_id);
      if (current && isSignalActionReplay(current.ruling, v.value)) return respond(current, true);
      return NextResponse.json({ ok: false, error: 'signal changed while the action was applied; reload and retry' }, { status: 409 });
    }
    throw e;
  }
  return respond(updated, false);
}
