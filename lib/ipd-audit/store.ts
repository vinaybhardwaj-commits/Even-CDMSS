/**
 * lib/ipd-audit/store.ts — persist + read IPD discharge-summary audits (Neon
 * `ipd_discharge_audits`, migrations/0013). Mirrors lib/opd-audit-store.ts.
 *
 * Pure DB layer — no LLM calls, no db13 reads. One de-identified row per audited discharge
 * summary, keyed by the db13 miscellaneous_documents doc id. Idempotent UPSERT on
 * (document_id, engine_version): a re-run refreshes the row in place, and the Mini/Qwen
 * backfill coexists with prod rows via its '-mini' engine-version suffix (the proven OPD
 * isolation trick). Link-back keys (document_id/ip_uid/member_id) are re-identification
 * paths into db13 for the admin surface — they are NEVER sent to the LLM.
 */

import { sql } from '../db';

export const IPD_ENGINE_VERSION = 'ipd-discharge-audit/0.1';
/** Mini/Qwen backfill rows — same engine, model-swapped; invisible to prod reads. */
export const IPD_MINI_ENGINE_VERSION = `${IPD_ENGINE_VERSION}-mini`;

export interface IpdAuditRow {
  // link-back keys
  documentId: string;
  ipUid?: string | null;
  memberId?: string | null;
  speciality?: string | null;
  dischargeType?: string | null;
  losDays?: number | null;
  dischargedAt?: string | null;      // ISO timestamp
  // headline
  careValueIndex: number;
  band: string;
  // 6 domain scores (0..100)
  scoreAppropriateness?: number | null;
  scoreEfficiency?: number | null;
  scoreSafety?: number | null;
  scoreCost?: number | null;
  scoreDocumentation?: number | null;
  scorePatientCentred?: number | null;
  // detail
  completenessPct?: number | null;
  nFindings?: number;
  nLowValue?: number;
  nContextDependent?: number;
  findings?: unknown;
  suggestions?: unknown;
  billedTotal?: number | null;       // M3 billing join; null until then
  // provenance
  engineVersion?: string;            // defaults IPD_ENGINE_VERSION
  model?: string | null;
  traceId?: string | null;
}

/** Upsert one audit. Returns 'inserted' | 'updated' (re-run at the same engine version) | 'skipped' (no document id). */
export async function saveIpdAudit(row: IpdAuditRow): Promise<'inserted' | 'updated' | 'skipped'> {
  if (!row.documentId) return 'skipped';
  const engine = row.engineVersion || IPD_ENGINE_VERSION;
  const rows = (await sql(
    `INSERT INTO ipd_discharge_audits
      (document_id, ip_uid, member_id, speciality, discharge_type, los_days, discharged_at,
       care_value_index, band,
       score_appropriateness, score_efficiency, score_safety, score_cost, score_documentation, score_patient_centred,
       completeness_pct, n_findings, n_low_value, n_context_dependent,
       findings, suggestions, billed_total, engine_version, model, trace_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7, $8,$9, $10,$11,$12,$13,$14,$15,
       $16,$17,$18,$19, $20::jsonb,$21::jsonb,$22,$23,$24,$25)
     ON CONFLICT (document_id, engine_version) DO UPDATE SET
       ip_uid = EXCLUDED.ip_uid, member_id = EXCLUDED.member_id, speciality = EXCLUDED.speciality,
       discharge_type = EXCLUDED.discharge_type, los_days = EXCLUDED.los_days, discharged_at = EXCLUDED.discharged_at,
       care_value_index = EXCLUDED.care_value_index, band = EXCLUDED.band,
       score_appropriateness = EXCLUDED.score_appropriateness, score_efficiency = EXCLUDED.score_efficiency,
       score_safety = EXCLUDED.score_safety, score_cost = EXCLUDED.score_cost,
       score_documentation = EXCLUDED.score_documentation, score_patient_centred = EXCLUDED.score_patient_centred,
       completeness_pct = EXCLUDED.completeness_pct, n_findings = EXCLUDED.n_findings,
       n_low_value = EXCLUDED.n_low_value, n_context_dependent = EXCLUDED.n_context_dependent,
       findings = EXCLUDED.findings, suggestions = EXCLUDED.suggestions,
       billed_total = EXCLUDED.billed_total, model = EXCLUDED.model, trace_id = EXCLUDED.trace_id,
       audited_at = NOW()
     RETURNING (xmax = 0) AS inserted`,
    [
      row.documentId, row.ipUid ?? null, row.memberId ?? null, row.speciality ?? null,
      row.dischargeType ?? null, row.losDays ?? null, row.dischargedAt ?? null,
      Math.round(row.careValueIndex), row.band,
      row.scoreAppropriateness ?? null, row.scoreEfficiency ?? null, row.scoreSafety ?? null,
      row.scoreCost ?? null, row.scoreDocumentation ?? null, row.scorePatientCentred ?? null,
      row.completenessPct ?? null, row.nFindings ?? 0, row.nLowValue ?? 0, row.nContextDependent ?? 0,
      JSON.stringify(row.findings ?? []), JSON.stringify(row.suggestions ?? []),
      row.billedTotal ?? null, engine, row.model ?? null, row.traceId ?? null,
    ],
  )) as Array<{ inserted: boolean }>;
  return rows.length ? (rows[0].inserted ? 'inserted' : 'updated') : 'skipped';
}

/** Read one audit by row id. Deliberately NO engine-version filter, so mini rows are
 *  viewable by id exactly like OPD's. Null if not found. */
export async function getIpdAudit(id: string): Promise<Record<string, unknown> | null> {
  if (!id) return null;
  const rows = (await sql(
    `SELECT * FROM ipd_discharge_audits WHERE id = $1 LIMIT 1`, [id],
  )) as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

/** document_ids already audited (at this engine version) for an IST calendar day (by discharge
 *  date) — the daily worker's exclude set. */
export async function auditedDocIdsForDay(day: string, engineVersion: string = IPD_ENGINE_VERSION): Promise<string[]> {
  const rows = (await sql(
    `SELECT document_id FROM ipd_discharge_audits
     WHERE engine_version = $1 AND (discharged_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date`,
    [engineVersion, day],
  )) as Array<{ document_id: string }>;
  return rows.map((r) => r.document_id).filter(Boolean);
}

/** Earliest IST day (by discharge date) that has any audit — the floor for the gap-fill sweep.
 *  Null if nothing audited yet. */
export async function earliestAuditedDay(): Promise<string | null> {
  const rows = (await sql(
    `SELECT to_char(min((discharged_at AT TIME ZONE 'Asia/Kolkata')::date),'YYYY-MM-DD') AS d FROM ipd_discharge_audits`,
  )) as Array<{ d: string | null }>;
  return rows[0]?.d ?? null;
}
