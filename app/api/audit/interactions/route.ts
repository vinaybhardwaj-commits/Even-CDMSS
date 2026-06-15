import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isPharmacistUnlocked } from '@/lib/pharmacist-cookie';
import { deterministicInteractions } from '@/lib/ddi';

export const runtime = 'nodejs';
export const maxDuration = 30;

// Deterministic DDI for the audit surface: curated EHRC rules + RxLabelGuard.
// Synchronous JSON (no streaming) so the rounds workflow gets an instant answer
// that feeds parameter #12. The richer LLM/RAG explainer lives at
// /api/drugs/interactions (CAT clinician surface).
export async function POST(req: NextRequest) {
  if (!(await isPharmacistUnlocked())) {
    return NextResponse.json({ error: 'pharmacist auth required' }, { status: 401 });
  }
  let body: { drugs?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const drugs = (body.drugs || []).map((s) => (s || '').trim()).filter(Boolean);
  if (drugs.length < 2) return NextResponse.json({ pairs: [] });
  // Charts can carry ~15 drugs; cap defensively to bound pairwise + upstream calls.
  if (drugs.length > 25) return NextResponse.json({ error: 'too many drugs (max 25)' }, { status: 400 });
  try {
    const pairs = await deterministicInteractions(drugs);
    return NextResponse.json({ pairs });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message) }, { status: 500 });
  }
}
