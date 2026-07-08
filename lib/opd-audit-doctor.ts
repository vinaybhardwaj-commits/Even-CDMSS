/**
 * Per-doctor Neon aggregates for the OPD-audit by-doctor surface (Navigation & Export PRD §5).
 * Server-only (imports @/lib/db). Reads finished audits from opd_note_audits — no engine/scoring
 * dependency, no migration. Names/specialty are joined in the caller (db13 doctors + doctor_directory).
 *
 * ⚠️ Neon HTTP driver GROUP BY-alias gotcha: `GROUP BY <select-alias>` is rejected. Where a bucket
 * is a computed expression (the weekly trend), compute it in an inner subquery and GROUP BY the
 * column in the outer query (the nested-subquery pattern). Direct-column GROUP BYs (doctor_uid,
 * band) are fine and used as-is.
 */
import { sql } from '@/lib/db';
import { OPD_ENGINE_VERSION } from '@/lib/opd-note-audit-core';

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
async function rowsOf<T>(text: string, params: unknown[]): Promise<T[]> {
  try { return (await run(text, params)) as T[]; } catch { return []; }
}
const IST = "AT TIME ZONE 'Asia/Kolkata'";
const ENG = OPD_ENGINE_VERSION; // code constant, inlined like the overview page

/** Build the optional IST date-range clause + its params, starting at $startIdx. */
function rangeClause(from: string | null, to: string | null, startIdx: number): { clause: string; params: string[] } {
  const params: string[] = [];
  let clause = '';
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) { params.push(from); clause += ` AND (note_date ${IST})::date >= $${startIdx + params.length}`; }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) { params.push(to); clause += ` AND (note_date ${IST})::date <= $${startIdx + params.length}`; }
  return { clause, params };
}

export type DoctorIndexRow = {
  doctor_uid: string; nnotes: number; mean_index: number; low_value_rate: number; last_audited: string;
};
/** Every doctor with ≥1 audit (all-time): volume, mean index, low-value rate, last-audited date. */
export async function fetchDoctorIndex(): Promise<DoctorIndexRow[]> {
  return rowsOf<DoctorIndexRow>(
    `SELECT doctor_uid,
            count(*)::int nnotes,
            round(avg(note_quality_index))::int mean_index,
            round(100.0*avg((n_low_value>0)::int))::int low_value_rate,
            to_char(max((note_date ${IST})::date),'YYYY-MM-DD') last_audited
     FROM opd_note_audits
     WHERE app_source = $1 AND engine_version = '${ENG}' AND doctor_uid IS NOT NULL
     GROUP BY doctor_uid
     ORDER BY nnotes DESC, mean_index ASC`, [APP]);
}

export type DoctorStats = {
  nnotes: number; first_date: string | null; last_date: string | null;
  mean_index: number; low_value_rate: number;
  d_doc: number; d_nq: number; d_appr: number; d_presc: number; d_pc: number;
};
/** All-audit aggregate for one doctor over an optional date range (default all-time). */
export async function fetchDoctorStats(uid: string, from: string | null = null, to: string | null = null): Promise<DoctorStats | null> {
  const r = rangeClause(from, to, 2);
  const rows = await rowsOf<DoctorStats>(
    `SELECT count(*)::int nnotes,
            to_char(min((note_date ${IST})::date),'YYYY-MM-DD') first_date,
            to_char(max((note_date ${IST})::date),'YYYY-MM-DD') last_date,
            round(avg(note_quality_index))::int mean_index,
            round(100.0*avg((n_low_value>0)::int))::int low_value_rate,
            round(avg(score_documentation))::int d_doc, round(avg(score_note_quality))::int d_nq,
            round(avg(score_appropriateness))::int d_appr, round(avg(score_prescribing_safety))::int d_presc,
            round(avg(score_patient_centred))::int d_pc
     FROM opd_note_audits
     WHERE app_source = $1 AND engine_version = '${ENG}' AND doctor_uid = $2${r.clause}`,
    [APP, uid, ...r.params]);
  const row = rows[0];
  return row && Number(row.nnotes) > 0 ? row : null;
}

export type BandRow = { band: string; c: number };
/** Band A–E distribution for one doctor (direct-column GROUP BY — no gotcha). */
export async function fetchDoctorBandDist(uid: string, from: string | null = null, to: string | null = null): Promise<BandRow[]> {
  const r = rangeClause(from, to, 2);
  return rowsOf<BandRow>(
    `SELECT band, count(*)::int c
     FROM opd_note_audits
     WHERE app_source = $1 AND engine_version = '${ENG}' AND doctor_uid = $2${r.clause}
     GROUP BY band`, [APP, uid, ...r.params]);
}

export type WeekRow = { wk: string; idx: number; c: number };
/** Weekly index trend for one doctor. NESTED-SUBQUERY pattern: the week bucket is computed in the
 *  inner query and grouped by the resulting column in the outer query (Neon GROUP BY-alias gotcha). */
export async function fetchDoctorWeeklyTrend(uid: string, from: string | null = null, to: string | null = null): Promise<WeekRow[]> {
  const r = rangeClause(from, to, 2);
  return rowsOf<WeekRow>(
    `SELECT wk, round(avg(idx))::int idx, count(*)::int c
     FROM (
       SELECT to_char(date_trunc('week', (note_date ${IST}))::date,'YYYY-MM-DD') wk,
              note_quality_index idx
       FROM opd_note_audits
       WHERE app_source = $1 AND engine_version = '${ENG}' AND doctor_uid = $2${r.clause}
     ) t
     GROUP BY wk
     ORDER BY wk`, [APP, uid, ...r.params]);
}

export type DoctorAuditRow = {
  id: string; uid: string; note_date: string; doctor_uid: string | null;
  consult_type: string | null; prescription_type: string | null;
  band: string; note_quality_index: number; n_low_value: number; completeness_pct: number;
  score_documentation: number; score_note_quality: number; score_appropriateness: number;
  score_prescribing_safety: number; score_patient_centred: number;
  findings: unknown; suggestions: unknown; missing_fields: unknown; engine_version: string;
};
/** One doctor's audits newest-first (for the list + the bulk-PDF set). `limit` caps the set. */
export async function fetchDoctorAuditRows(uid: string, from: string | null = null, to: string | null = null, limit = 600): Promise<DoctorAuditRow[]> {
  const r = rangeClause(from, to, 2);
  const lim = Math.max(1, Math.min(2000, Math.floor(limit)));
  return rowsOf<DoctorAuditRow>(
    `SELECT id, uid, note_date, doctor_uid, consult_type, prescription_type,
            band, note_quality_index, n_low_value, completeness_pct,
            score_documentation, score_note_quality, score_appropriateness, score_prescribing_safety, score_patient_centred,
            findings, suggestions, missing_fields, engine_version
     FROM opd_note_audits
     WHERE app_source = $1 AND engine_version = '${ENG}' AND doctor_uid = $2${r.clause}
     ORDER BY note_date DESC
     LIMIT ${lim}`, [APP, uid, ...r.params]);
}
