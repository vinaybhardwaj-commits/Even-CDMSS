/**
 * lib/preop/surface-row.ts — one stored finding row → one card row for the surface.
 *
 * The card is built from the STORED SNAPSHOT, not from the scalar columns beside it. The
 * scalars exist so the board can filter and sort in SQL; the snapshot is what the sweep
 * actually computed, and rendering from it means the board cannot drift from the engine.
 * A row whose snapshot is unreadable degrades to its scalars rather than disappearing.
 */

import type { InstrumentScore } from '../preop-instruments-core';
import type { Tier } from '../preop-tier-core';
import type { PreopCardRow } from '../preop-surface-core';
import type { FindingRow } from './store';

function asObject(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') { try { return JSON.parse(v) as Record<string, unknown>; } catch { return null; } }
  return null;
}

function instrument(snap: Record<string, unknown> | null, key: string, lo: number | null, hi: number | null): InstrumentScore | null {
  const v = snap?.[key] as InstrumentScore | undefined;
  if (v && typeof v === 'object' && 'instrument' in v) return v;
  if (lo == null && hi == null) return null;
  // Snapshot unreadable: rebuild just enough for a chip, with an empty factor table so
  // the case page shows nothing it cannot prove rather than inventing rows.
  return {
    instrument: key === 'rcri' ? 'rcri' : key === 'mfi5' ? 'mfi5' : 'charlson',
    kind: lo === hi ? 'point' : 'range', lo, hi, missing: [], factors: [],
  };
}

export function toCardRow(r: FindingRow): PreopCardRow {
  const snap = asObject(r.snapshot);
  const pac = asObject(snap?.pac);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
  return {
    episodeKey: r.episode_key,
    patientName: r.patient_name,
    uhid: r.uhid,
    age: r.age,
    sex: r.sex,
    procedure: r.procedure,
    hospital: r.hospital,
    surgeryDate: r.surgery_date,
    tier: (r.tier as Tier | null) ?? null,
    rcri: instrument(snap, 'rcri', num(r.rcri_lo), num(r.rcri_hi)),
    mfi5: instrument(snap, 'mfi5', num(r.mfi_lo), num(r.mfi_hi)),
    charlson: instrument(snap, 'charlson', num(r.cci_lo), num(r.cci_hi)),
    needsReview: r.needs_review === true,
    bookingOnly: r.booking_only === true,
    whyLine: r.why_line,
    missingLine: r.missing_line,
    situationLine: r.situation_line,
    versionNo: r.version_no,
    reviewedAt: r.reviewed_at,
    reviewedBy: r.reviewed_by,
    reviewedVersion: r.reviewed_version,
    computedAt: r.computed_at,
    pacOnFile: r.pac_on_file === true,
    pacStatus: r.pac_status,
    pacFinalizedAt: str(r.pac_finalized_at) ?? str(pac?.finalizedAt),
    pacVerdict: r.pac_verdict,
    // A1-3's other fact. It lives in its own live-row columns, refreshed by every sweep
    // and deliberately outside the snapshot fingerprint, so a workflow transition never
    // mints a version. The snapshot is the fallback for rows written before B4.
    pacWorkflowStatus: str(r.pac_workflow_status) ?? str(pac?.workflowStatus),
    pacWorkflowLoggedAt: str(r.pac_workflow_logged_at) ?? str(pac?.workflowLoggedAt),
  };
}

/** The case page additionally needs the resolved input list and the factor tables. */
export function caseDetail(r: FindingRow): { row: PreopCardRow; snapshot: Record<string, unknown> | null } {
  return { row: toCardRow(r), snapshot: asObject(r.snapshot) };
}
