// lib/member-state/present-core.ts — MemberState Stage 2 (Phase 1) presentation mapper.
// PURE, deterministic, DB-free, LLM-free: MemberStateSnapshot → MemberStateView (type-only import
// of the frozen schema). The components stay dumb; the honest labelling is unit-tested here.
// presentMemberState twice → deep-equal. RENDERS the frozen snapshot; changes NO core behaviour.

import type { MemberStateSnapshot } from './schema';

export const MEMBER_STATE_PRESENT_VERSION = 'member-state-present/0.1' as const;

export interface StateTone { label: string; tone: 'ok' | 'active' | 'uncertain' | 'stopped' | 'warn' | 'critical' | 'muted' }
export interface ProblemView { concept: string; relation: string; course: StateTone; status: StateTone; confidencePct: number; first: string; last: string; occurrences: number }
export interface MedicationView { concept: string; currentness: StateTone; caption: string | null; first: string; last: string; latestDose: string | null; occurrences: number }
export interface AllergyView { substance: string; status: StateTone; conflicted: boolean; occurrences: number }
export interface SeriesView { analyte: string; unit: string | null; points: { date: string; value: string; abnormal: boolean }[]; latest: string | null; direction: 'up' | 'down' | 'flat' | null; mixedUnits: boolean }
export interface ConflictView { domain: string; type: string; severity: 'informational' | 'review' | 'safety_critical'; detail: string }
export interface MemberStateView {
  asOf: string; computedAt: string; versions: { state: string; normalization: string; reconciliation: string };
  problems: ProblemView[]; medications: MedicationView[]; allergies: AllergyView[]; investigations: SeriesView[]; conflicts: ConflictView[];
  counts: { problems: number; medications: number; allergies: number; investigations: number; conflicts: number; safetyCritical: number };
}

// ── deterministic label maps ──
const COURSE: Record<string, StateTone> = {
  persistent: { label: 'Persistent', tone: 'warn' },
  recurrent: { label: 'Recurrent', tone: 'active' },
  single_episode: { label: 'Single episode', tone: 'muted' },
  uncertain: { label: 'Uncertain', tone: 'uncertain' },
};
const MED_CURRENTNESS: Record<string, StateTone> = {
  prescribed: { label: 'Prescribed', tone: 'active' },
  reported_taking: { label: 'Taking', tone: 'active' },
  stopped: { label: 'Stopped', tone: 'stopped' },
  not_taking: { label: 'Not taking', tone: 'stopped' },
  administered: { label: 'Administered', tone: 'active' },
  unknown: { label: 'Currentness unknown', tone: 'muted' },
};
const ALLERGY: Record<string, StateTone> = {
  reported_allergy: { label: 'Allergy', tone: 'critical' },
  denied: { label: 'Denied', tone: 'ok' },
  historical: { label: 'Historical', tone: 'muted' },
  entered_in_error: { label: 'Entered in error', tone: 'muted' },
  unknown: { label: 'Unknown', tone: 'muted' },
};
const SEVERITY_RANK: Record<string, number> = { safety_critical: 0, review: 1, informational: 2 };

/** Problem status → honest label. NEVER "Active" for a silent/uncertain problem (north-star §4.1). */
function statusTone(status: string, latestStatusAt: string): StateTone {
  switch (status) {
    case 'documented_active': return { label: 'Active', tone: 'active' };
    case 'documented_resolved': return { label: 'Resolved', tone: 'ok' };
    case 'historical': return { label: 'Historical', tone: 'muted' };
    default: return { label: `Uncertain — last documented ${dayOnly(latestStatusAt)}`, tone: 'uncertain' };
  }
}
function toNum(v: string): number | null { const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; }
function isAbnormal(v: string | null | undefined): boolean { return /^(true|t|1|yes|y|abnormal|high|low|h|l)$/i.test(String(v ?? '').trim()); }
/** Render a date-only YYYY-MM-DD (db13 test_date is a timestamp). Idempotent for already-day strings.
 *  Presentation-only — the snapshot value stays raw. */
const dayOnly = (s: string): string => (typeof s === 'string' ? s.slice(0, 10) : s);

export function presentMemberState(snap: MemberStateSnapshot): MemberStateView {
  const problems: ProblemView[] = snap.problems.map((p) => ({
    concept: p.normalizedConcept.raw,
    relation: p.normalizedConcept.relation,
    course: COURSE[p.course] ?? { label: p.course, tone: 'muted' },
    status: statusTone(p.latestDocumentedStatus, p.latestStatusAt),
    confidencePct: Math.round((p.currentStatusConfidence ?? 0) * 100),
    first: dayOnly(p.firstDocumentedAt), last: dayOnly(p.lastDocumentedAt), occurrences: p.occurrences.length,
  }));

  const medications: MedicationView[] = snap.medications.map((m) => {
    const latest = m.occurrences[m.occurrences.length - 1];
    return {
      concept: m.normalizedConcept.raw,
      currentness: MED_CURRENTNESS[m.status] ?? { label: m.status, tone: 'muted' },
      caption: m.status === 'prescribed' ? 'prescribed — not confirmed taken' : null,
      first: dayOnly(m.firstSeen), last: dayOnly(m.lastSeen), latestDose: latest?.dose ?? null, occurrences: m.occurrences.length,
    };
  });

  // conflicted = the substance appears in a domain:'allergy' Discrepancy (its detail carries the raw).
  const allergyConflictDetails = snap.conflicts.filter((c) => c.domain === 'allergy').flatMap((c) => c.assertions.map((a) => a.detail.toLowerCase()));
  const allergies: AllergyView[] = snap.allergies.map((a) => ({
    substance: a.substance.raw,
    status: ALLERGY[a.status] ?? { label: a.status, tone: 'muted' },
    conflicted: allergyConflictDetails.some((d) => d.includes(a.substance.raw.toLowerCase())),
    occurrences: a.occurrences.length,
  }));

  const investigations: SeriesView[] = snap.investigations.map((iv) => {
    const points = iv.series.map((pt) => ({ date: dayOnly(pt.date), value: pt.value, abnormal: isAbnormal(pt.abnormal) }));
    let direction: SeriesView['direction'] = null;
    if (iv.series.length >= 2) {
      const a = toNum(iv.series[iv.series.length - 2].value), b = toNum(iv.series[iv.series.length - 1].value);
      if (a != null && b != null) direction = b > a ? 'up' : b < a ? 'down' : 'flat';
    }
    return { analyte: iv.normalizedAnalyte.raw, unit: iv.unit ?? null, points, latest: iv.series[iv.series.length - 1]?.value ?? null, direction, mixedUnits: iv.unit === null };
  });

  const conflicts: ConflictView[] = snap.conflicts
    .map((c): ConflictView => ({ domain: c.domain, type: c.type, severity: c.severity, detail: c.assertions.map((a) => a.detail).join(' · ') || `${c.domain} ${c.type}` }))
    .sort((x, y) => (SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity]) || (x.domain < y.domain ? -1 : x.domain > y.domain ? 1 : 0) || (x.type < y.type ? -1 : x.type > y.type ? 1 : 0));

  return {
    asOf: snap.asOf, computedAt: snap.computedAt,
    versions: { state: snap.version, normalization: snap.normalizationVersion, reconciliation: snap.reconciliationVersion },
    problems, medications, allergies, investigations, conflicts,
    counts: {
      problems: problems.length, medications: medications.length, allergies: allergies.length,
      investigations: investigations.length, conflicts: conflicts.length,
      safetyCritical: conflicts.filter((c) => c.severity === 'safety_critical').length,
    },
  };
}
