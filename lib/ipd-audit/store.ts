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

// 0.2 (IPD citation fix, PRD CDMSS-IPD-CITATION-FIX-18-JUL-2026): per-finding evidence
// enrichment + re-cite against the enriched pool. Distinguishes fixed rows from the 0.1
// baseline the PR0 benchmark measured (citation-support 0.05). Engine behaviour change.
export const IPD_ENGINE_VERSION = 'ipd-discharge-audit/0.2';
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
  report?: unknown;                  // FULL de-identified AuditReport (0014) — powers the report page render
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
       findings, suggestions, report, billed_total, engine_version, model, trace_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7, $8,$9, $10,$11,$12,$13,$14,$15,
       $16,$17,$18,$19, $20::jsonb,$21::jsonb,$22::jsonb,$23,$24,$25,$26)
     ON CONFLICT (document_id, engine_version) DO UPDATE SET
       ip_uid = EXCLUDED.ip_uid, member_id = EXCLUDED.member_id, speciality = EXCLUDED.speciality,
       discharge_type = EXCLUDED.discharge_type, los_days = EXCLUDED.los_days, discharged_at = EXCLUDED.discharged_at,
       care_value_index = EXCLUDED.care_value_index, band = EXCLUDED.band,
       score_appropriateness = EXCLUDED.score_appropriateness, score_efficiency = EXCLUDED.score_efficiency,
       score_safety = EXCLUDED.score_safety, score_cost = EXCLUDED.score_cost,
       score_documentation = EXCLUDED.score_documentation, score_patient_centred = EXCLUDED.score_patient_centred,
       completeness_pct = EXCLUDED.completeness_pct, n_findings = EXCLUDED.n_findings,
       n_low_value = EXCLUDED.n_low_value, n_context_dependent = EXCLUDED.n_context_dependent,
       findings = EXCLUDED.findings, suggestions = EXCLUDED.suggestions, report = EXCLUDED.report,
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
      row.report != null ? JSON.stringify(row.report) : null,
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

// ── recompute-on-read (Scoring policy Phase A, decision §1.1) ────────────────────────────────────
//
// Historical scores are RECOMPUTED, never rewritten. `completeness_pct` becomes derived: the stored
// per-field statuses in `report.completeness.items` are re-scored under the ACTIVE weights version,
// and the Care-Value Index + band are rebuilt from the stored domain scores with the new
// documentation value substituted. Nothing is mutated; this is a pure read-side transform.
//
// FAIL-SAFE (PRD §8.1): if the policy layer cannot be read — table missing, migration not yet run,
// DB error — getActivePolicy returns the equal-weights fallback, which reproduces legacy scoring
// EXACTLY (PRD §2.5). A weighting failure therefore degrades to today's system, invisibly. This
// function additionally wraps the whole transform so a malformed `report` returns the row UNCHANGED
// rather than throwing into a page render.

/** The row plus its derived fields. The original stored values are preserved under `stored_*` so a
 *  surface can show both (PRD §6.5 shows the weighted and unweighted numbers side by side). */
export interface RecomputedIpdRow extends Record<string, unknown> {
  completeness_pct: number | null;
  care_value_index: number | null;
  band: string | null;
  stored_completeness_pct: number | null;
  stored_care_value_index: number | null;
  stored_band: string | null;
  weights_version: string | null;
  /** applicable-field count and the unweighted NABH gap list, for the detail panel. */
  nabh_applicable: number | null;
  nabh_missing: string[] | null;
}

/**
 * Apply the active weights to a batch of already-fetched rows. ONE policy read for the whole batch
 * (module-cached, 60s TTL) and then pure arithmetic — no extra DB round-trip per row (PRD §4).
 *
 * Rows whose `report` carries no completeness items are returned untouched apart from the
 * `stored_*` mirrors, because there is nothing to re-weight.
 */
export async function applyScoringPolicy<T extends Record<string, unknown>>(rows: T[]): Promise<(T & RecomputedIpdRow)[]> {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];
  try {
    const { getActivePolicy, extractItems } = await import('../scoring-policy/store');
    const { weightedCompleteness, DISCHARGE_SUMMARY_COND_KEYS } = await import('../scoring-policy/completeness');
    const { recomputeIpdIndex } = await import('../scoring-policy/recompute');
    const policy = await getActivePolicy('discharge_summary');

    return list.map((r) => {
      const storedCompleteness = r.completeness_pct == null ? null : Number(r.completeness_pct);
      const storedIndex = r.care_value_index == null ? null : Number(r.care_value_index);
      const storedBand = r.band == null ? null : String(r.band);
      const base = {
        ...r,
        stored_completeness_pct: storedCompleteness,
        stored_care_value_index: storedIndex,
        stored_band: storedBand,
        weights_version: policy.fallback ? null : policy.versionString,
        nabh_applicable: null as number | null,
        nabh_missing: null as string[] | null,
      };
      const items = extractItems(r.report);
      if (!items.length) return base as T & RecomputedIpdRow;

      const c = weightedCompleteness(items, policy.vector, { condKeys: DISCHARGE_SUMMARY_COND_KEYS });
      const idx = recomputeIpdIndex(
        {
          appropriateness: numOrNull(r.score_appropriateness),
          efficiency: numOrNull(r.score_efficiency),
          safety: numOrNull(r.score_safety),
          cost: numOrNull(r.score_cost),
          documentation: c.pct,
          patient_centred: numOrNull(r.score_patient_centred),
        },
        c.pct,
      );
      return {
        ...base,
        completeness_pct: c.pct,
        score_documentation: c.pct,
        care_value_index: idx.index,
        band: idx.band,
        nabh_applicable: c.applicable,
        nabh_missing: c.missingMandatory,
      } as T & RecomputedIpdRow;
    });
  } catch {
    // Never let a scoring-policy fault cost a page render. Return the rows as stored.
    return list.map((r) => ({
      ...r,
      stored_completeness_pct: r.completeness_pct == null ? null : Number(r.completeness_pct),
      stored_care_value_index: r.care_value_index == null ? null : Number(r.care_value_index),
      stored_band: r.band == null ? null : String(r.band),
      weights_version: null,
      nabh_applicable: null,
      nabh_missing: null,
    })) as (T & RecomputedIpdRow)[];
  }
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Single-row convenience for the report detail page. Never throws. */
export async function getIpdAuditWeighted(id: string): Promise<(Record<string, unknown> & RecomputedIpdRow) | null> {
  const row = await getIpdAudit(id);
  if (!row) return null;
  const [out] = await applyScoringPolicy([row]);
  return out ?? null;
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

/** document_ids audited at ANY engine version — the "already audited at all" set.
 *  Both S5 and S6 exclude on this: the Gemini worker only ever audits GENUINELY NEW docs, and
 *  the Mini backfill never re-audits what prod already has (the OPD division of labour). */
export async function auditedDocIdsAnyVersion(): Promise<string[]> {
  const rows = (await sql(`SELECT DISTINCT document_id FROM ipd_discharge_audits`)) as Array<{ document_id: string }>;
  return rows.map((r) => r.document_id).filter(Boolean);
}

/** Count audited (any engine version) — the backfill's progress numerator. */
export async function auditedCountAnyVersion(): Promise<number> {
  const rows = (await sql(`SELECT count(DISTINCT document_id)::int AS n FROM ipd_discharge_audits`)) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

/** Earliest IST day (by discharge date) that has any audit — the floor for the gap-fill sweep.
 *  Null if nothing audited yet. */
export async function earliestAuditedDay(): Promise<string | null> {
  const rows = (await sql(
    `SELECT to_char(min((discharged_at AT TIME ZONE 'Asia/Kolkata')::date),'YYYY-MM-DD') AS d FROM ipd_discharge_audits`,
  )) as Array<{ d: string | null }>;
  return rows[0]?.d ?? null;
}
