/**
 * GET /api/care/readmissions/case?dedup_key=… — the read behind the `Download case
 * brief · .md` button (CDMSS-READMISSIONS-R1-PRD v1.1 §6, decision 14).
 *
 * READ-ONLY, same env gates and unlock as the list route. Reads ONE finding row PINNED to
 * READMIT_ENGINE_VERSION — never "pick latest" — and the two extract subsets the brief
 * needs (index + readmit document, by the ids stored on the finding's provenance).
 * Unknown key → 404 { ok: false }. An extract-store fault → the extracts are null and the
 * brief is thinner; a finding-store fault reads as "no row" → 404. Never a 500.
 *
 * Identity is NOT re-joined here: the board already resolved it for the card (decision 13,
 * KX-first) and overlays it on this row before composing. The `row` this returns is the
 * pinned finding — the facts the brief must not get from anywhere else. No model call.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { isCareUnlocked } from '@/lib/care-cookie';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { fetchFindingForSurface, READMIT_ENGINE_VERSION } from '@/lib/readmission/store';
import { fetchExtractedCases } from '@/lib/discharge-extract-store';
import { asJson, indexDocumentIdOf, readmitDocumentIdOf, toFinding, toIndexCaseSummary } from '@/lib/readmission/surface-row';
import { toExtractSubset } from '@/lib/readmission/brief';
import type { FindingBlob } from '@/lib/readmission-surface-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function enabled(): boolean {
  return process.env.CCB_ENABLED === '1' && process.env.READMISSIONS_SURFACE_ENABLED === '1';
}
async function authed(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

/** The dedup key shape (readmission-detect-core: `<index>|<readmit>` or `<index>|form:<uid>`). */
const isDedupKey = (s: string) => s.length >= 3 && s.length <= 200 && /^[A-Za-z0-9/_:|.-]+$/.test(s);

export async function GET(req: NextRequest) {
  if (!enabled()) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 });
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const key = (req.nextUrl.searchParams.get('dedup_key') ?? '').trim();
  if (!key || !isDedupKey(key)) return NextResponse.json({ ok: false, error: 'bad key' }, { status: 400 });

  // Decision 14: pinned to the engine version. Absent row and unreachable store both 404 —
  // the board keeps the card and downloads the thinner brief.
  const r = await fetchFindingForSurface(key, READMIT_ENGINE_VERSION);
  if (!r) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

  const blob = asJson<FindingBlob>(r.finding);
  const indexDocId = indexDocumentIdOf(blob);
  const readmitDocId = readmitDocumentIdOf(blob);
  const extracts = await fetchExtractedCases([indexDocId, readmitDocId].filter((d): d is string => d != null));
  const indexExtracted = indexDocId ? extracts.get(indexDocId)?.extracted ?? null : null;
  const readmitExtracted = readmitDocId ? extracts.get(readmitDocId)?.extracted ?? null : null;

  return NextResponse.json({
    ok: true,
    engineVersion: READMIT_ENGINE_VERSION,
    row: toFinding(r, undefined, toIndexCaseSummary(indexExtracted)),
    indexExtract: toExtractSubset(indexExtracted),
    readmitExtract: toExtractSubset(readmitExtracted),
  });
}
