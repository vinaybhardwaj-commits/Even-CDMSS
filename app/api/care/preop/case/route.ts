/**
 * GET /api/care/preop/case?key=<episode_key> — the read behind /care/preop/case/[key].
 *
 * READ-ONLY and NO MODEL — including after B5/B6. Both rails are written by the SWEEP;
 * this route returns what they stored and never generates anything. A page that could
 * write prose on load would show two readers a different paragraph for the same reading.
 *
 * Returns the live row's card shape, the full stored snapshot
 * (factor tables with per-input provenance — everything the board asserts, proven), and
 * the append-only version timeline oldest-first, which is the module's core demo.
 *
 * Gated identically to the board and to the list route, each independently.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getFinding, listVersionsForEpisode, PREOP_ENGINE_VERSION } from '@/lib/preop/store';
import { caseDetail } from '@/lib/preop/surface-row';
import { isEpisodeKeyShape } from '@/lib/preop-versions-core';
import { preopAuthed, preopFlagState, preopSurfaceEnabled } from '@/lib/preop/gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!preopSurfaceEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!(await preopAuthed())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const key = (req.nextUrl.searchParams.get('key') || '').trim();
  if (!key || !isEpisodeKeyShape(key)) return NextResponse.json({ error: 'bad_key' }, { status: 400 });

  const [found, versions] = await Promise.all([getFinding(key), listVersionsForEpisode(key)]);
  if (!found.row) {
    return NextResponse.json({ ok: false, error: found.error ?? 'no such episode at this engine version' }, { status: 404 });
  }
  const { row, snapshot, extraction, narrative, narrativeState } = caseDetail(found.row);
  return NextResponse.json({
    ok: true,
    engine: PREOP_ENGINE_VERSION,
    row,
    snapshot,
    versions: versions.rows,
    // B5/B6. `extraction` is returned whether or not the flag is on — a reader who has
    // just had the rail turned off is owed the reading it left behind, and the page
    // labels it as inert. `narrative` is returned ONLY when it is renderable; the state
    // token says why when it is not.
    extractionRecord: extraction,
    narrativeText: narrative,
    narrativeState,
    ...preopFlagState(),
    error: versions.error,
  });
}
