/**
 * lib/ccb-resolve.ts — member → episode resolver for the CCB consumer API (Pulse).
 *
 * Pulse keys on the MEMBER (UHID or individual_uid) + a visit date, not our internal presc_uid.
 * This resolves those to the prescription uid(s) for that member's OPD episode(s) on that day:
 *   • uhid → individual_uid via the maintained FK `individuals.kx_uhid`
 *   • individual_uid + day → presc uid(s) from `individuals-prescriptions` (medical types, non-draft)
 * Validated interpolation (mirrors lib/metabase.ts). Read-only.
 */

import { metabaseQuery, OPD_MEDICAL_TYPES } from './metabase';

const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u);
const isUhid = (u: string) => /^[A-Za-z0-9/_-]{3,40}$/.test(u);
const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);

/** uhid → consumer individual_uid (via individuals.kx_uhid). Null if unmatched. */
export async function bridgeUhidToIndividual(uhid: string): Promise<string | null> {
  if (!isUhid(uhid)) return null;
  const rows = await metabaseQuery(`SELECT uid FROM individuals WHERE kx_uhid = '${uhid}' LIMIT 1`);
  const u = rows[0]?.uid ? String(rows[0].uid) : '';
  return isUid(u) ? u : null;
}

/** All medical OPD prescription uids for a member on an IST day (latest first). */
export async function resolveEpisodeUids(individualUid: string, day: string): Promise<string[]> {
  if (!isUid(individualUid) || !isDay(day)) return [];
  const types = OPD_MEDICAL_TYPES.map((t) => `'${t}'`).join(', ');
  const rows = await metabaseQuery(
    `SELECT uid FROM "individuals-prescriptions"`
    + ` WHERE _parent_id = '${individualUid}' AND is_draft = false AND type_of_prescription IN (${types})`
    + ` AND (timestamp AT TIME ZONE 'Asia/Kolkata')::date = '${day}'`
    + ` ORDER BY timestamp DESC LIMIT 20`,
  );
  return rows.map((r) => String(r.uid)).filter(isUid);
}

export interface ResolveInput { uid?: string; uhid?: string; individualUid?: string; date?: string }

/** Resolve a request to a presc_uid: a direct `uid`, or `{uhid|individual_uid}` + `date`.
 *  Returns the latest episode that day plus the full candidate list. */
export async function resolveBriefUid(p: ResolveInput): Promise<{ uid: string | null; candidates: string[] }> {
  if (p.uid && isUid(p.uid)) return { uid: p.uid, candidates: [p.uid] };
  let iuid = p.individualUid && isUid(p.individualUid) ? p.individualUid : null;
  if (!iuid && p.uhid) iuid = await bridgeUhidToIndividual(p.uhid).catch(() => null);
  if (!iuid || !p.date || !isDay(p.date)) return { uid: null, candidates: [] };
  const eps = await resolveEpisodeUids(iuid, p.date).catch(() => []);
  return { uid: eps[0] ?? null, candidates: eps };
}
