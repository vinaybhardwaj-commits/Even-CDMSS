/**
 * lib/ccb-dossier.ts — Care Conversation Brief: MEMBER DOSSIER (WIRED).
 *
 * Assembles a member's whole-person care record from db13 (via the Metabase reader) using the
 * pure, validated builders in ccb-dossier-core.ts. Deterministic — no LLM, no PDF reads. The
 * result feeds the /care member view so a care manager sees the full person before a call
 * (all OPD visits + diagnostics + radiology + IPD/discharge), not just one OPD episode.
 *
 * Read-only. Identifiers stay on the returned bundle for the CM; they are NOT sent to any model.
 */

import { metabaseQuery, OPD_MEDICAL_TYPES } from './metabase';
import { membershipByMobilesSql, isMobile } from './ccb-search-core';
import {
  individualSql, episodesSql, dpipeByUidsSql, reportsSql, dischargeSql,
  mapEpisodeRow, opdTimeline, reportTimeline, ipdTimeline, mergeTimeline, computeSnapshot, buildMember,
  isUid, isUhidLike,
  type DossierBundle, type EpisodeRowLite,
} from './ccb-dossier-core';

/** Assemble a member's dossier from an individual_uid. Null if the member isn't found.
 *  Every secondary read soft-fails to empty so a single flaky source never sinks the dossier. */
export async function assembleDossier(individualUid: string): Promise<DossierBundle | null> {
  if (!isUid(individualUid)) return null;
  const safe = async (sqlText: string): Promise<Record<string, unknown>[]> => metabaseQuery(sqlText).catch(() => []);

  const indRows = await metabaseQuery(individualSql(individualUid)).catch(() => []);
  if (!indRows.length) return null;
  const ind = indRows[0];
  const kxUhid = ind.kx_uhid ? String(ind.kx_uhid) : '';
  const mobiles = Array.isArray(ind.mobiles) ? ind.mobiles.map((m) => String(m)).filter(isMobile) : [];

  // Parallel reads: OPD episodes, diagnostics, radiology, IPD (if the member has a uhid), member label.
  const [epRows, dxRows, radRows, ipdRows, memberLabelRows] = await Promise.all([
    safe(episodesSql(individualUid)),
    safe(reportsSql('diagnostic', individualUid)),
    safe(reportsSql('radiology', individualUid)),
    isUhidLike(kxUhid) ? safe(dischargeSql(kxUhid)) : Promise.resolve([] as Record<string, unknown>[]),
    mobiles.length ? safe(membershipByMobilesSql(mobiles)) : Promise.resolve([] as Record<string, unknown>[]),
  ]);

  const episodes: EpisodeRowLite[] = epRows.map(mapEpisodeRow).filter((e): e is EpisodeRowLite => !!e);

  // Clean complaint/dx for the episodes (bounded by their uids).
  const dpipeByUid: Record<string, { pc: string | null; dx: string | null }> = {};
  const uids = episodes.map((e) => e.uid);
  if (uids.length) {
    const dpRows = await safe(dpipeByUidsSql(uids));
    for (const r of dpRows) {
      const u = String(r.presc_uid || '');
      if (u) dpipeByUid[u] = { pc: r.presenting_complaint ? String(r.presenting_complaint) : null, dx: r.diagnosis ? String(r.diagnosis) : null };
    }
  }

  const opd = opdTimeline(episodes, dpipeByUid);
  const dx = reportTimeline(dxRows, 'diagnostic');
  const rad = reportTimeline(radRows, 'radiology');
  const ipd = ipdTimeline(ipdRows);
  const timeline = mergeTimeline(opd, dx, rad, ipd);

  let membershipId: string | null = null;
  for (const r of memberLabelRows) {
    const mob = String(r.mobile || ''); const mid = r.membership_id ? String(r.membership_id) : '';
    if (mid && mobiles.includes(mob)) { membershipId = mid; break; }
  }

  const member = buildMember(ind, membershipId);
  const snapshot = computeSnapshot(episodes, dx, rad, ipd, timeline);
  // The conversation brief is built for MEDICAL OPD notes → point it at the latest medical episode
  // (not e.g. a dietary/physio touchpoint), falling back to the latest episode of any type.
  const latestMedical = episodes.find((e) => e.type && OPD_MEDICAL_TYPES.includes(e.type));
  const latestEpisodeUid = latestMedical?.uid ?? episodes[0]?.uid ?? null;

  return { member, snapshot, timeline, latestEpisodeUid };
}
