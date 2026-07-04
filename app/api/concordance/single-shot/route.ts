import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { runConcordanceSingleShot } from '@/lib/concordance';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

// P0 eval route (admin-gated). POST { result, context } → clean single-shot concordance
// verdict on the Mac-mini (qwen2.5:14b direct, no RAG/revise, ₹0). One case per request;
// the P0 harness loops the 26-case bank from outside. NOT the operational surface — no
// store, no history (capture-and-wall comes with P2).
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;

  let body: { result?: string; context?: string; model?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const result = (body?.result ?? '').trim();
  const context = (body?.context ?? '').trim();
  if (!result) return NextResponse.json({ ok: false, error: 'body must include { result, context }' }, { status: 400 });

  try {
    const out = await runConcordanceSingleShot(result, context, body?.model);
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
