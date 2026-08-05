/**
 * lib/readmission/db13.ts — read-only db13 access for the readmission agent.
 * Server-only; goes through lib/metabase's metabaseQuery — the SAME connection layer
 * lib/ipd-audit/db13.ts uses. No new credential, no direct pg driver.
 *
 * ⚠️ SQL / SCHEMA HONESTY (kickoff hard requirement): this sandbox has no live db13.
 * Every query below is INFERRED except where marked VALIDATED (facts carried from
 * lib/ipd-audit/doctor-lookup.ts and lib/ccb-fetch-core.ts). Consequences drawn:
 *   · Every fetch is fail-safe — a query error degrades to [] / null, NEVER a 500
 *     and never a wrong finding (the caller then reports "not audited").
 *   · Row-shape mapping is TOLERANT: SELECT * + candidate-column resolution, so a
 *     wrongly-guessed column name costs a field, not the whole read. The candidate
 *     lists are enumerated in the build report for live validation.
 *   · kx_discharged_completed_patients.uid is KNOWN NOT to be the encounter id
 *     (doctor-lookup.ts §2.11) — the encounter-id candidates below deliberately
 *     exclude bare `uid`.
 *
 * PHI POSTURE (§8b): patient_name/dob are read here ONLY for the name+dob
 * duplicate-MRN reconcile and the de-identification scrub. They ride the in-memory
 * KxEncounter, are never persisted to a finding row, and never reach Vertex —
 * lib/readmission/assemble.ts is the single choke point that strips them.
 */

import { metabaseQuery } from '../metabase';
import type { KxEncounter, FormReadmission } from '../readmission-detect-core';
import { canonicalAnalyte, labAbnormal } from '../readmission-reconcile-core';

const esc = (s: string) => s.replace(/'/g, "''");
const isEncounterId = (s: string) => /^[A-Za-z0-9/_-]{2,40}$/.test(s);   // ip_uid shapes: IP-1250, IPNO-229
const isDocId = (s: string) => /^[A-Za-z0-9_-]{6,64}$/.test(s);

// ── tolerant column resolution ──────────────────────────────────────────────────

const pick = (row: Record<string, unknown>, candidates: string[]): unknown => {
  for (const c of candidates) {
    if (c in row && row[c] != null && row[c] !== '') return row[c];
  }
  return null;
};
const s = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

/** Candidate column names per logical field — ALL INFERRED, listed for validation. */
export const ADT_COLUMN_CANDIDATES = {
  encounterId: ['encounter_id', 'ipd_no', 'ip_no', 'encounter_no', 'admission_no', 'ip_number'],
  uhid: ['uhid'],
  encounterType: ['encounter_type'],
  admitAt: ['admission_date_time', 'admission_datetime', 'admit_date_time'],
  dischargeAt: ['discharge_date_time', 'discharge_datetime'],
  admissionType: ['admission_type'],
  department: ['department', 'speciality', 'department_name'],
  doctor: ['treating_doctor', 'treating_doctor_team', 'treating_doctor_name', 'admitting_doctor', 'admitting_doctor_team'],
  payer: ['payer', 'payer_name', 'payer_type', 'payor'],
  patientName: ['patient_name', 'name'],
  dob: ['dob', 'date_of_birth', 'birth_date'],
} as const;

function toEncounter(row: Record<string, unknown>): KxEncounter | null {
  const encounterId = s(pick(row, [...ADT_COLUMN_CANDIDATES.encounterId]));
  const uhid = s(pick(row, [...ADT_COLUMN_CANDIDATES.uhid]));
  const admitAt = s(pick(row, [...ADT_COLUMN_CANDIDATES.admitAt]));
  if (!encounterId || !uhid || !admitAt) return null;   // unusable row — dropped, never guessed
  return {
    encounterId, uhid, admitAt,
    encounterType: s(pick(row, [...ADT_COLUMN_CANDIDATES.encounterType])) ?? 'ip_admission',
    dischargeAt: s(pick(row, [...ADT_COLUMN_CANDIDATES.dischargeAt])),
    admissionType: s(pick(row, [...ADT_COLUMN_CANDIDATES.admissionType])),
    department: s(pick(row, [...ADT_COLUMN_CANDIDATES.department])),
    doctor: s(pick(row, [...ADT_COLUMN_CANDIDATES.doctor])),
    payer: s(pick(row, [...ADT_COLUMN_CANDIDATES.payer])),
    patientName: s(pick(row, [...ADT_COLUMN_CANDIDATES.patientName])),
    dob: s(pick(row, [...ADT_COLUMN_CANDIDATES.dob])),
  };
}

// ── ADT fetch (the detector's raw material) ─────────────────────────────────────

const ADT_PAGE = 500;   // Metabase /api/dataset caps unsaved-query results; page well under it
const ADT_MAX_PAGES = 20;

/**
 * INFERRED SQL (paged; encounter_type per the recon: ER shares the ADT table):
 *   SELECT * FROM kx_discharged_completed_patients
 *    WHERE encounter_type IN ('ip_admission','er_admission')
 *    ORDER BY admission_date_time ASC, uhid ASC
 *    LIMIT 500 OFFSET <n>
 * Fail-safe: any page error returns what was fetched so far; a first-page error → [].
 */
export async function fetchAdtEncounters(): Promise<KxEncounter[]> {
  const out: KxEncounter[] = [];
  for (let page = 0; page < ADT_MAX_PAGES; page++) {
    let rows: Record<string, unknown>[];
    try {
      rows = await metabaseQuery(
        `SELECT * FROM kx_discharged_completed_patients
         WHERE encounter_type IN ('ip_admission', 'er_admission')
         ORDER BY admission_date_time ASC, uhid ASC
         LIMIT ${ADT_PAGE} OFFSET ${page * ADT_PAGE}`);
    } catch {
      return page === 0 ? [] : out;   // degrade, never throw into the worker
    }
    for (const r of rows) {
      const e = toEncounter(r);
      if (e) out.push(e);
    }
    if (rows.length < ADT_PAGE) break;
  }
  return out;
}

// ── Discharge summary text ──────────────────────────────────────────────────────

export interface SummaryRecord {
  encounterId: string;
  patientName: string | null;   // PHI — for the de-identification scrub ONLY
  uhid: string | null;          // PHI — for the de-identification scrub ONLY
  admitAt: string | null;
  dischargeAt: string | null;
  department: string | null;
  /** ALL row fields, for the tolerant summary-text assembly in assemble.ts. */
  raw: Record<string, unknown>;
}

/**
 * VALIDATED keys (doctor-lookup.ts §2.11): kx_discharge_summary_records.ipd_no,
 * status ('Final'), discharge_date_time, treating_doctor_speciality. The summary
 * TEXT column is NOT validated — hence SELECT * and tolerant assembly downstream.
 *
 * INFERRED SQL:
 *   SELECT * FROM kx_discharge_summary_records WHERE ipd_no = '<id>'
 *   ORDER BY (status='Final') DESC, discharge_date_time DESC NULLS LAST LIMIT 1
 */
export async function fetchSummaryRecord(encounterId: string): Promise<SummaryRecord | null> {
  if (!isEncounterId(encounterId)) return null;
  try {
    const rows = await metabaseQuery(
      `SELECT * FROM kx_discharge_summary_records WHERE ipd_no = '${esc(encounterId)}'
       ORDER BY (status='Final') DESC, discharge_date_time DESC NULLS LAST LIMIT 1`);
    const r = rows[0];
    if (!r) return null;
    return {
      encounterId,
      patientName: s(r.patient_name),
      uhid: s(r.uhid),
      admitAt: s(r.admission_date_time),
      dischargeAt: s(r.discharge_date_time),
      department: s(r.treating_doctor_speciality),
      raw: r,
    };
  } catch {
    return null;
  }
}

// ── Labs (the disinterested source) ─────────────────────────────────────────────

export interface LabRow {
  id: string;               // stable evidence id seed (row ordinal within the fetch)
  testName: string | null;
  value: number | null;
  valueText: string | null;
  unit: string | null;
  refRange: string | null;
  at: string | null;
  analyte: string | null;
  abnormal: boolean | null;
}

/** Candidate column names — ALL INFERRED except uhid/service_date (ccb-fetch-core). */
export const LAB_COLUMN_CANDIDATES = {
  testName: ['test_name', 'parameter_name', 'parameter', 'lab_test_name', 'test', 'investigation_name', 'service_name'],
  value: ['result_value', 'result', 'value', 'observed_value', 'test_value'],
  unit: ['unit', 'units', 'uom'],
  refRange: ['reference_range', 'normal_range', 'ref_range', 'biological_reference_interval'],
  flag: ['abnormal_flag', 'result_flag', 'flag'],
  at: ['result_date_time', 'reported_date_time', 'sample_collected_at', 'collected_date_time', 'result_date', 'service_date'],
} as const;

/**
 * Lab join key MEASURED clean (PRD §8c.2): kx_lab_reports.visit_id = encounter id.
 * INFERRED SQL:
 *   SELECT * FROM kx_lab_reports WHERE visit_id = '<encounterId>' LIMIT 500
 */
export async function fetchLabsForEncounter(encounterId: string): Promise<LabRow[]> {
  if (!isEncounterId(encounterId)) return [];
  let rows: Record<string, unknown>[];
  try {
    rows = await metabaseQuery(
      `SELECT * FROM kx_lab_reports WHERE visit_id = '${esc(encounterId)}' LIMIT 500`);
  } catch {
    return [];
  }
  return rows.map((r, i) => {
    const testName = s(pick(r, [...LAB_COLUMN_CANDIDATES.testName]));
    const valueText = s(pick(r, [...LAB_COLUMN_CANDIDATES.value]));
    const num = valueText != null ? Number(String(valueText).replace(/[^\d.eE+-]/g, '')) : NaN;
    const value = Number.isFinite(num) ? num : null;
    const refRange = s(pick(r, [...LAB_COLUMN_CANDIDATES.refRange]));
    const flag = s(pick(r, [...LAB_COLUMN_CANDIDATES.flag]));
    return {
      id: `row${i + 1}`,
      testName, value, valueText,
      unit: s(pick(r, [...LAB_COLUMN_CANDIDATES.unit])),
      refRange,
      at: s(pick(r, [...LAB_COLUMN_CANDIDATES.at])),
      analyte: canonicalAnalyte(testName),
      abnormal: labAbnormal(value, flag, refRange),
    };
  }).filter((l) => l.testName != null);
}

// ── POST_IPD form detector (decision 12) ────────────────────────────────────────

const HF_TABLE = '"individuals-health_forms"';   // quoting per lib/care-tracks-core.ts (validated)

/**
 * INFERRED SQL (the jsonb key's typo `is_readmisstion` is IN the schema — recon §1;
 * tolerant of boolean-vs-string storage):
 *   SELECT * FROM "individuals-health_forms"
 *    WHERE type = 'POST_IPD'
 *      AND lower(coalesce(post_ipd_health__readmission_details->>'is_readmisstion','')) IN ('true','t','1')
 *    LIMIT 500
 * Then: SELECT uid, kx_uhid, old_kx_uhids FROM individuals WHERE uid IN (...)
 * (linkage RESOLVED, decision 12: form._parent_doc_id → individuals.uid →
 *  individuals.kx_uhid ∪ old_kx_uhids → kx_discharged_completed_patients.uhid).
 */
export async function fetchFormReadmissions(): Promise<FormReadmission[]> {
  let rows: Record<string, unknown>[];
  try {
    rows = await metabaseQuery(
      `SELECT * FROM ${HF_TABLE}
       WHERE type = 'POST_IPD'
         AND lower(coalesce(post_ipd_health__readmission_details->>'is_readmisstion', '')) IN ('true', 't', '1')
       LIMIT 500`);
  } catch {
    return [];
  }

  const parsed = rows.map((r) => {
    const formUid = s(r._doc_id);
    const memberUid = s(r._parent_doc_id);
    if (!formUid || !memberUid) return null;
    let d: Record<string, unknown> = {};
    const rawDetails = r.post_ipd_health__readmission_details;
    if (rawDetails != null) {
      if (typeof rawDetails === 'object') d = rawDetails as Record<string, unknown>;
      else if (typeof rawDetails === 'string') { try { d = JSON.parse(rawDetails); } catch { d = {}; } }
    }
    const bool = (v: unknown): boolean | null =>
      v === true || v === 'true' ? true : v === false || v === 'false' ? false : null;
    return {
      formUid, memberUid,
      readmissionDate: s(d.readmission_date),
      eventType: s(d.event_type),
      // recon catch 2: is_planned appears only when true — absence is UNKNOWN, not unplanned
      isPlanned: bool(d.is_planned),
      sameCondition: bool(d.is_related_to_same_condition),
      notes: s(d.notes) ?? s(r.notes),
      uhids: [] as string[],
    };
  }).filter((f): f is NonNullable<typeof f> => f != null);

  // Resolve member → KX UHIDs via the individuals master (authoritative; no fuzzy match).
  const memberUids = Array.from(new Set(parsed.map((f) => f.memberUid).filter(isDocId)));
  if (memberUids.length) {
    try {
      const idRows = await metabaseQuery(
        `SELECT uid, kx_uhid, old_kx_uhids FROM individuals
         WHERE uid IN (${memberUids.map((u) => `'${esc(u)}'`).join(', ')})`);
      const byUid = new Map<string, string[]>();
      for (const r of idRows) {
        const uid = s(r.uid);
        if (!uid) continue;
        const uhids: string[] = [];
        const kx = s(r.kx_uhid);
        if (kx) uhids.push(kx);
        const old = r.old_kx_uhids;
        if (Array.isArray(old)) for (const o of old) { const v = s(o); if (v) uhids.push(v); }
        else if (typeof old === 'string') {
          try { const arr = JSON.parse(old); if (Array.isArray(arr)) for (const o of arr) { const v = s(o); if (v) uhids.push(v); } }
          catch { /* pg array literal like {A,B} */ for (const o of old.replace(/[{}"]/g, '').split(',')) { const v = o.trim(); if (v) uhids.push(v); } }
        }
        byUid.set(uid, Array.from(new Set(uhids)));
      }
      for (const f of parsed) f.uhids = byUid.get(f.memberUid) ?? [];
    } catch { /* identity fetch failed → forms stay unlinked → counted noEvenIpStay, not guessed */ }
  }
  return parsed;
}
