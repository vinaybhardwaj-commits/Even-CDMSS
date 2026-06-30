/**
 * lib/opd-audit-store.ts — persist + read OPD note-quality audits (Neon `opd_note_audits`).
 *
 * Maps the in-memory OpdNoteAudit → one de-identified, uid-keyed row. Idempotent insert
 * (ON CONFLICT (uid, engine_version) DO NOTHING), so the worker re-runs safely — the audit
 * table itself is the worker's watermark.
 */

import { sql } from './db';
import type { OpdNoteAudit } from './opd-note-audit';
import type { OpdDomain } from './opd-note-score-core';

function domainScore(audit: OpdNoteAudit, key: OpdDomain): number | null {
  const d = audit.scorecard.domains.find((x) => x.domain === key);
  return d ? Math.round(d.score) : null;
}

export interface SaveOpdAuditMeta { model?: string | null; latencyMs?: number | null }

/** Insert one audit. Returns 'inserted' | 'exists' (already audited at this engine version) | 'skipped' (no uid). */
export async function saveOpdAudit(audit: OpdNoteAudit, meta: SaveOpdAuditMeta = {}): Promise<'inserted' | 'exists' | 'skipped'> {
  const k = audit.keys;
  if (!k.uid) return 'skipped';
  const sc = audit.scorecard;
  const findings = audit.findings || [];
  const nLow = findings.filter((f) => f.verdict === 'low-value').length;
  const nCtx = findings.filter((f) => f.verdict === 'context-dependent').length;
  const nInteraction = findings.filter((f) => /interaction|contraindicat|\bddi\b/i.test(`${f.subject} ${f.rationale}`)).length;
  const missing = audit.completeness?.missing ?? [];

  const rows = (await sql(
    `INSERT INTO opd_note_audits
      (uid, consult_uid, doctor_uid, kx_encounter_id, note_date, prescription_type, consult_type,
       note_quality_index, band,
       score_documentation, score_note_quality, score_appropriateness, score_prescribing_safety, score_patient_centred,
       pdqi9, completeness_pct, n_missing_mandatory,
       n_findings, n_low_value, n_context_dependent, n_interaction_alerts,
       findings, suggestions, engine_version, model, trace_id, latency_ms, missing_fields, sources)
     VALUES ($1,$2,$3,$4,$5,$6,$7, $8,$9, $10,$11,$12,$13,$14,
       $15::jsonb,$16,$17, $18,$19,$20,$21, $22::jsonb,$23::jsonb,$24,$25,$26,$27, $28::jsonb, $29::jsonb)
     ON CONFLICT (uid, engine_version) DO NOTHING
     RETURNING id`,
    [
      k.uid, k.consultUid, k.doctorUid, k.kxEncounterId, k.noteDate, k.prescriptionType, k.consultType,
      sc.headline, sc.band,
      domainScore(audit, 'documentation'), domainScore(audit, 'note_quality'), domainScore(audit, 'appropriateness'),
      domainScore(audit, 'prescribing_safety'), domainScore(audit, 'patient_centred'),
      JSON.stringify(sc.pdqi9 ?? []), Math.round((audit.completeness?.coverage ?? 0) * 100), missing.length,
      findings.length, nLow, nCtx, nInteraction,
      JSON.stringify(findings), JSON.stringify(audit.suggestions ?? []),
      audit.engineVersion, meta.model ?? null, audit.traceId ?? null, meta.latencyMs ?? null,
      JSON.stringify(missing), JSON.stringify(audit.sources ?? []),
    ],
  )) as Array<{ id: string }>;
  return rows.length ? 'inserted' : 'exists';
}

/** uids already audited (at this engine version) for an IST calendar day — the worker's exclude set. */
export async function auditedUidsForDay(day: string, engineVersion: string): Promise<string[]> {
  const rows = (await sql(
    `SELECT uid FROM opd_note_audits
     WHERE engine_version = $1 AND (note_date AT TIME ZONE 'Asia/Kolkata')::date = $2::date`,
    [engineVersion, day],
  )) as Array<{ uid: string }>;
  return rows.map((r) => r.uid).filter(Boolean);
}

/** Count audited (at this engine version) for an IST calendar day. */
export async function auditedCountForDay(day: string, engineVersion: string): Promise<number> {
  const rows = (await sql(
    `SELECT count(*)::int AS n FROM opd_note_audits
     WHERE engine_version = $1 AND (note_date AT TIME ZONE 'Asia/Kolkata')::date = $2::date`,
    [engineVersion, day],
  )) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

/** Earliest IST day that has any audit — the floor for the gap-fill sweep (never audit
 *  days before the system started). Null if nothing audited yet. */
export async function earliestAuditedDay(): Promise<string | null> {
  const rows = (await sql(
    `SELECT to_char(min((note_date AT TIME ZONE 'Asia/Kolkata')::date),'YYYY-MM-DD') AS d FROM opd_note_audits`,
  )) as Array<{ d: string | null }>;
  return rows[0]?.d ?? null;
}
