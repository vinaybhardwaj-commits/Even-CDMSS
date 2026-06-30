/**
 * lib/ccb-fetch.ts — Care Conversation Brief: episode bundler (WIRED).
 *
 * Reads db13 through the existing Metabase reader (lib/metabase.ts → `metabaseQuery`),
 * using the pure, validated SQL builders + mappers in ccb-fetch-core.ts. Server-only.
 *
 * `assembleEpisode(prescUid)`:
 *   1. fetch the anchor prescription (individual_uid via `_parent_id`, kx_encounter_id, …)
 *   2. bridge individual_uid → kx_uhid (individuals.kx_uhid)
 *   3. in parallel: kx order ledger (by uhid) + consumer result PDFs (by individual_uid)
 *   4. coverage = reports.length ? 'rich' : 'order_only'  (graceful degradation)
 *
 * Identifiers stay in db13 and on the returned bundle; they are NOT sent to any LLM
 * by this module (the brief generator de-identifies before any model call).
 */

import { metabaseQuery } from './metabase';
import {
  prescriptionSql, bridgeSql, ordersSql, reportsSql,
  mapPrescription, mapOrders, mapReports, buildBundle, bundleWindow,
  isUhid,
  type EpisodeBundle,
} from './ccb-fetch-core';

export interface AssembleOpts {
  /** days before / after the note day to gather orders + result PDFs (reports land late). */
  back?: number;
  fwd?: number;
}

/** Assemble a member's episode bundle from a prescription uid. Returns null if the
 *  prescription isn't found. Order/report reads soft-fail to empty (never throw the bundle away). */
export async function assembleEpisode(prescUid: string, opts: AssembleOpts = {}): Promise<EpisodeBundle | null> {
  const prescRows = await metabaseQuery(prescriptionSql(prescUid));
  if (!prescRows.length) return null;

  const { keys, prescription } = mapPrescription(prescRows[0]);

  // Bridge: individual_uid → EHRC uhid (maintained FK).
  try {
    const b = await metabaseQuery(bridgeSql(keys.individualUid));
    const uhid = b[0]?.kx_uhid;
    keys.kxUhid = isUhid(uhid) ? uhid : null;
  } catch { /* bridge best-effort */ }

  const { d0, d1 } = bundleWindow(keys.noteDate, opts.back, opts.fwd);

  const [orders, reports] = await Promise.all([
    keys.kxUhid
      ? metabaseQuery(ordersSql(keys.kxUhid, d0, d1)).then(mapOrders).catch(() => [])
      : Promise.resolve([]),
    metabaseQuery(reportsSql(keys.individualUid, d0, d1)).then(mapReports).catch(() => []),
  ]);

  return buildBundle(keys, prescription, orders, reports);
}
