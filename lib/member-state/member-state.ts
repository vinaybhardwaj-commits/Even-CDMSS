// lib/member-state/member-state.ts — MemberState Stage 2 (Phase 1) WIRED evidence fetch + build.
// The wired sibling to the pure cores (as ccb-dossier.ts is to ccb-dossier-core.ts). Read-only;
// soft-fails to null. It renders THE SAME snapshot the Stage-1 freeze gate validated: the two SQL
// strings are byte-identical to scripts/member-state-shadow.mjs (FROZEN — copied, not refactored).
//
// First VALUE consumer of the frozen core (assembleEvidence + buildMemberState) — the cores stay
// byte-identical. computedAt is PASSED IN (the route stamps it); no Date.now() in the core path.

import { metabaseQuery } from '../metabase';
import { isUid } from '../ccb-dossier-core';
import { assembleEvidence } from './assemble-core';    // FROZEN — value import (first consumer)
import { buildMemberState } from './aggregate-core';    // FROZEN — value import
import { careCallEncountersForMember } from '../care-call-store';   // Amendment B — the write-back loop
import { promEncountersForMember } from '../proms/store';           // PROMs 0.2a-2 — scores → spine fold
import type { MemberStateSnapshot } from './schema';

// ── SQL identical to scripts/member-state-shadow.mjs — KEEP IN SYNC. (shadow.mjs is FROZEN;
//    orchestrator-validated live vs db13. Copied verbatim, never refactored; the SQL-parity test pins it.) ──
const prescriptionsSql = (uid: string): string => {
  if (!isUid(uid)) throw new Error('bad individual uid');
  return `SELECT uid, patient_details__allergies, diagnosis_icd_codes, impression_icd_codes,
                 to_jsonb(medications) AS medications,
                 to_char(timestamp AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS visit_date
            FROM "individuals-prescriptions"
           WHERE _parent_id = '${uid}' AND is_draft = false
           ORDER BY timestamp DESC
           LIMIT 200`;
};
const labsSql = (uid: string): string => {
  if (!isUid(uid)) throw new Error('bad individual uid');
  return `SELECT t.value, t.investigation_name, t.investigation_unit, t.investigation_is_abnormal,
                 t.booking_id, t.test_result_uid, t._parent_id AS individual_uid, d.test_date
            FROM test_values_view t
            JOIN test_digital_values_view d
              ON d.booking_id = t.booking_id AND d.test_result_uid = t.test_result_uid
           WHERE t._parent_id = '${uid}'
           ORDER BY d.test_date DESC
           LIMIT 500`;
};

/** presc_uid → individual_uid (the call surface is keyed by episode). New, tiny, injection-guarded. */
export const individualForPrescSql = (prescUid: string): string => {
  if (!isUid(prescUid)) throw new Error('bad presc uid');
  return `SELECT _parent_id AS individual_uid FROM "individuals-prescriptions" WHERE uid = '${prescUid}' LIMIT 1`;
};

export async function individualUidForPresc(prescUid: string): Promise<string | null> {
  if (!isUid(prescUid)) return null;
  const rows = await metabaseQuery(individualForPrescSql(prescUid)).catch(() => [] as Record<string, unknown>[]);
  const u = rows[0]?.individual_uid ? String(rows[0].individual_uid) : '';
  return isUid(u) ? u : null;
}

/** Build a member's validated MemberStateSnapshot from live db13. Null on bad uid / no evidence.
 *  computedAt is PASSED IN (the route stamps it) — never Date.now() inside the frozen path. */
export async function getMemberSnapshot(individualUid: string, computedAt: string): Promise<MemberStateSnapshot | null> {
  if (!isUid(individualUid)) return null;
  const [presc, labs] = await Promise.all([
    metabaseQuery(prescriptionsSql(individualUid)).catch(() => [] as Record<string, unknown>[]),
    metabaseQuery(labsSql(individualUid)).catch(() => [] as Record<string, unknown>[]),
  ]);
  const base = assembleEvidence({
    memberRef: individualUid, generatedAt: computedAt, sourceWatermarks: { db13: computedAt },
    prescriptionRows: presc, labRows: labs,
  });
  // AMENDMENT B (the write-back loop) — fold the member's care-call outcomes in as `care_call`
  // encounters, ONLY when CARE_CALL_ENABLED=1. Flag off ⇒ byte-identical to Phase 1. The FROZEN
  // buildMemberState then reconciles them by the Stage-1-validated 1.2 rules. Soft-fails to [].
  const careCall = process.env.CARE_CALL_ENABLED === '1'
    ? await careCallEncountersForMember(individualUid).catch(() => [] as typeof base.encounters)
    : [];
  // PROMs 0.2a-2 (Decision E) — fold the member's scored PROM administrations as `care_call`
  // encounters when PROMS_ENABLED. Flag off ⇒ byte-identical to before. Soft-fails to []. The FROZEN
  // buildMemberState then trends the scores as LongitudinalInvestigation series; the core is untouched.
  const proms = process.env.PROMS_ENABLED === '1'
    ? await promEncountersForMember(individualUid).catch(() => [] as typeof base.encounters)
    : [];
  const evidence = { ...base, encounters: [...base.encounters, ...careCall, ...proms] };
  if (!evidence.encounters.length) return null;
  return buildMemberState(evidence, computedAt);
}

// Exported for the SQL-parity guard test (pins these to shadow.mjs's exact strings).
export const __sqlForTest = { prescriptionsSql, labsSql };
