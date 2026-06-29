/**
 * lib/opd-audit-ui.ts — pure presentation helpers for the OPD Audit dashboard (M3).
 * Server-safe (no 'use client', no deps). Band/score colours + period date math + parse.
 */

export type Period = 'day' | 'week' | 'month';

export function bandColor(band: string): string {
  switch ((band || '').toUpperCase()) {
    case 'A': return '#0d9488';
    case 'B': return '#16a34a';
    case 'C': return '#d97706';
    case 'D': return '#ea580c';
    default:  return '#dc2626'; // E
  }
}

// Score → colour (matches the band thresholds in opd-note-score-core bandFor()).
export function scoreColor(s: number): string {
  if (s >= 70) return '#16a34a';
  if (s >= 55) return '#d97706';
  if (s >= 40) return '#ea580c';
  return '#dc2626';
}

/** Inclusive IST date window [from, to] for a period ending at `day` (YYYY-MM-DD). */
export function istDateRange(day: string, period: Period): { from: string; to: string } {
  const d = new Date(day + 'T00:00:00Z');
  const back = period === 'week' ? 6 : period === 'month' ? 29 : 0;
  d.setUTCDate(d.getUTCDate() - back);
  return { from: d.toISOString().slice(0, 10), to: day };
}

export const DOMAIN_ROWS: { col: string; label: string }[] = [
  { col: 'score_documentation', label: 'Documentation' },
  { col: 'score_note_quality', label: 'Note quality (PDQI-9)' },
  { col: 'score_appropriateness', label: 'Appropriateness' },
  { col: 'score_prescribing_safety', label: 'Prescribing & safety' },
  { col: 'score_patient_centred', label: 'Patient-centredness' },
];

export const PDQI9_LABEL: Record<string, string> = {
  up_to_date: 'Up-to-date', accurate: 'Accurate', thorough: 'Thorough', useful: 'Useful',
  organized: 'Organized', comprehensible: 'Comprehensible', succinct: 'Succinct',
  synthesized: 'Synthesized', internally_consistent: 'Internally consistent',
};

/** Parse a jsonb column that the driver may hand back as an object/array or a JSON string. */
export function parseJson<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v === 'object') return v as T;
  if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return fallback; } }
  return fallback;
}

/** Short, stable label for a doctor_uid until name enrichment lands (PRD open item). */
export function doctorLabel(uid: string | null): string {
  if (!uid) return 'Unknown';
  return 'Dr · ' + uid.slice(0, 6);
}

export function fmtIstTime(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  return new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

export function fmtIstDateLong(day: string): string {
  const t = new Date(day + 'T12:00:00+05:30').getTime();
  if (Number.isNaN(t)) return day;
  return new Date(t).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}
