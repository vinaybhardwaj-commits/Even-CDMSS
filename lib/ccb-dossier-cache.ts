/**
 * lib/ccb-dossier-cache.ts — CCB v2 P1: member-snapshot cache, WIRED half.
 *
 * `assembleDossier()` fires ~7 live db13 reads per member open. This wraps it in a Neon-backed
 * snapshot so a repeat open costs one indexed PK lookup and zero db13 queries.
 *
 * `lib/ccb-dossier.ts` is reused VERBATIM — not edited, not re-implemented. The cache is a wrapper.
 *
 * FAIL-SAFE, everywhere: a cache read error is a MISS (fall through to live), a cache write error
 * is a skipped persist (still serve the fresh bundle). Neither ever surfaces as a 500, and a
 * corrupt row is a miss rather than a stale-wrong serve (see `mapSnapshotRow`).
 */

import { sql } from './db';
import { assembleDossier } from './ccb-dossier';
import { boundedRace } from './ccb-worklist-core';
import type { DossierBundle } from './ccb-dossier-core';
import { mapSnapshotRow, SNAPSHOT_SCHEMA_VERSION, type CachedSnapshot, type SnapshotRow } from './ccb-dossier-cache-core';

/** Whole-assemble budget. db13 pathology must not hold a member open past this. */
export const REFRESH_BUDGET_MS = 12_000;

/**
 * Read the cached snapshot. Returns it EVEN IF STALE — freshness is the caller's decision, and a
 * stale bundle is the fallback when a refresh times out. Null on miss, corrupt row, or read error.
 */
export async function getMemberSnapshot(individualUid: string): Promise<CachedSnapshot | null> {
  try {
    const rows = (await sql(
      `SELECT snapshot, refreshed_at FROM ccb_member_snapshot WHERE individual_uid = $1`,
      [individualUid],
    )) as SnapshotRow[];
    return mapSnapshotRow(rows[0]);
  } catch {
    return null; // treat any cache-read failure as a miss
  }
}

/**
 * Re-assemble from db13 and persist. Bounded by `REFRESH_BUDGET_MS` via the house `boundedRace`
 * (which also swallows a rejection into the fallback), so this resolves null rather than hanging
 * or throwing. A null return means "no fresh bundle" — the caller decides whether to serve a
 * stale one or 404.
 *
 * The upsert failing does NOT sink the serve: we return the bundle we just built.
 */
export async function refreshMemberSnapshot(individualUid: string): Promise<DossierBundle | null> {
  const bundle = await boundedRace<DossierBundle | null>(
    assembleDossier(individualUid),
    REFRESH_BUDGET_MS,
    null,
  );
  if (!bundle) return null;

  try {
    // Stamp the shape version into the stored JSON. The extra key rides harmlessly in the jsonb;
    // consumers ignore it, and `mapSnapshotRow` uses it to reject bundles from another build.
    const stored = JSON.stringify({ ...bundle, _schemaVersion: SNAPSHOT_SCHEMA_VERSION });
    await sql(
      `INSERT INTO ccb_member_snapshot (individual_uid, snapshot, source, refreshed_at)
       VALUES ($1, $2::jsonb, 'live', NOW())
       ON CONFLICT (individual_uid) DO UPDATE
         SET snapshot = EXCLUDED.snapshot, source = EXCLUDED.source, refreshed_at = NOW()`,
      [individualUid, stored],
    );
  } catch {
    // Persist is best-effort. A cache we could not write is not a reason to fail the open.
  }
  return bundle;
}
