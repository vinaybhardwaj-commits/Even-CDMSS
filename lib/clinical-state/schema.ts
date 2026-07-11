// lib/clinical-state/schema.ts — ClinicalState v1.0: the canonical, universal CDMSS
// patient representation (shared core + per-surface extensions). PURE: no ./db, no
// ./llm, no I/O — zod for runtime validation only. Phase 1a builds and proves this
// schema (DDx trace + document-audit-family adapters); nothing consumes it live yet.
//
// Design rule: surfaces extend via `ext` (an open discriminated union) — they never
// fork the core. Cross-surface types (TimelineItem, InvestigationFinding, AdminFacts)
// are imported TYPE-ONLY from their owning modules; zod mirrors them permissively so
// this schema never breaks when an owning module adds a field.

import { z } from 'zod';
import type { TimelineItem } from '../ccb-dossier-core';
import type { InvestigationFinding } from '../investigations';
import type { AdminFacts } from '../doc-audit-core';

export const CLINICAL_STATE_VERSION = 'clinical-state/1.0' as const;

export type Surface = 'ddx' | 'note_audit' | 'doc_audit' | 'concordance' | 'appropriateness' | 'ask' | 'other';
export type FindingStatus = 'present' | 'absent' | 'unknown' | 'historical' | 'resolved';
export type ExtractionMethod = 'deterministic' | 'llm' | 'reported';

export interface Temporality {
  onset?: string;      // "2 hours ago", "since Tuesday" — as stated
  duration?: string;   // "for 2 hours", "x 3 days"
  sequence?: number;   // ordinal within the narrative when derivable
  course?: string;     // "worsening", "intermittent"
}

/** Every finding knows where it came from — the span, the method, the confidence. */
export interface Provenance {
  sourceField: string;              // e.g. 'history', 'exam', 'opd_note_audits.findings'
  rawText: string;                  // the literal source text this finding rests on
  startOffset?: number;
  endOffset?: number;
  extractionMethod: ExtractionMethod;
  confidence: number;               // 0..1
}

/** Audit extension — carries BOTH audit engines' vocabularies verbatim (never collapsed):
 *  OPD note-audit uses verdict/domain/source/informational/signalType/findingRef;
 *  Case Audit (doc-audit) uses netValue (its `verdict: NetValue`) + its own domain.
 *  `extra` preserves any engine fields the typed slots don't model (lossless round-trip). */
export interface AuditExtension {
  kind: 'audit';
  verdict?: string;
  domain?: string;
  netValue?: string;
  signalType?: string;
  findingRef?: string;
  citationIds?: number[];
  source?: string;
  informational?: boolean;
  extra?: Record<string, unknown>;
}

/** Reserved: DDx uses the shared core only in 1a. */
export interface DdxExtension { kind: 'ddx' }

/** Open union — future surfaces add members ({kind:'concordance'…}), never fork the core. */
export type SurfaceExtension = AuditExtension | DdxExtension;

export interface ClinicalFinding {
  id: string;
  concept: string;
  normalizedConcept?: string;
  status: FindingStatus;
  value?: string;
  unit?: string | null;
  temporality?: Temporality;
  provenance: Provenance;
  ext?: SurfaceExtension;
}

export interface Demographics {
  age?: number | null;
  ageBand?: string | null;   // coarse decade band, mirrors concordance-core extractDemographics
  sex?: 'F' | 'M' | null;
  sexRaw?: string | null;    // as stated ("male", "f", …) — never lose the source form
}

export interface Instability {
  unstable: boolean;                 // retained; === (assessment === 'unstable')
  reasons: string[];                 // e.g. "SBP 82 < 90"; unchanged semantics
  assessment: 'unstable' | 'no_instability_detected' | 'not_assessable';
  assessedInputs: string[];          // display channels present, e.g. ['BP','HR','SpO₂','RR','T']
  missingInputs: string[];           // display channels absent
}

export interface ClinicalState {
  version: typeof CLINICAL_STATE_VERSION;
  surface: Surface;
  demographics: Demographics;
  timeline: TimelineItem[];
  positives: ClinicalFinding[];
  negatives: ClinicalFinding[];
  unknowns: ClinicalFinding[];
  riskFactors: string[];
  exposures: string[];
  medications: string[];
  investigations: InvestigationFinding[];
  procedures?: string[];
  disposition?: string | null;
  instability: Instability;
  missingCriticalData: string[];
  adminFacts?: AdminFacts;
  /** Per-surface passthrough for narrative/administrative fields the clinical core
   *  deliberately doesn't model (e.g. doc-audit's courseSummary/completeness/aftercare).
   *  Exists so a discharge/OT case round-trips LOSSLESSLY without polluting the core. */
  surfaceExtras?: Record<string, unknown>;
}

// ── zod runtime validators (permissive where they mirror foreign types) ──

const zTemporality = z.object({
  onset: z.string().optional(),
  duration: z.string().optional(),
  sequence: z.number().optional(),
  course: z.string().optional(),
}).strict();

const zProvenance = z.object({
  sourceField: z.string().min(1),
  rawText: z.string(),
  startOffset: z.number().int().nonnegative().optional(),
  endOffset: z.number().int().nonnegative().optional(),
  extractionMethod: z.enum(['deterministic', 'llm', 'reported']),
  confidence: z.number().min(0).max(1),
}).strict();

const zAuditExt = z.object({
  kind: z.literal('audit'),
  verdict: z.string().optional(),
  domain: z.string().optional(),
  netValue: z.string().optional(),
  signalType: z.string().optional(),
  findingRef: z.string().optional(),
  citationIds: z.array(z.number().int()).optional(),
  source: z.string().optional(),
  informational: z.boolean().optional(),
  extra: z.record(z.unknown()).optional(),
}).strict();

const zDdxExt = z.object({ kind: z.literal('ddx') }).strict();

export const zSurfaceExtension = z.discriminatedUnion('kind', [zAuditExt, zDdxExt]);

export const zClinicalFinding = z.object({
  id: z.string().min(1),
  concept: z.string().min(1),
  normalizedConcept: z.string().optional(),
  status: z.enum(['present', 'absent', 'unknown', 'historical', 'resolved']),
  value: z.string().optional(),
  unit: z.string().nullable().optional(),
  temporality: zTemporality.optional(),
  provenance: zProvenance,
  ext: zSurfaceExtension.optional(),
}).strict();

// Foreign shapes mirrored permissively (passthrough: owning modules may add fields).
const zTimelineItem = z.object({
  date: z.string().nullable(),
  kind: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  refUid: z.string().nullable(),
  docUrl: z.string().optional(),
}).passthrough();

const zInvestigationFinding = z.object({
  test: z.string(),
  value: z.string(),
  unit: z.string().nullable().optional(),
  flag: z.string(),
  category: z.string(),
  note: z.string().nullable().optional(),
}).passthrough();

const zAdminFacts = z.object({
  lengthOfStayDays: z.number().nullable(),
  admissionType: z.string().nullable(),
  careSetting: z.string().nullable(),
}).passthrough();

export const zClinicalState = z.object({
  version: z.literal(CLINICAL_STATE_VERSION),
  surface: z.enum(['ddx', 'note_audit', 'doc_audit', 'concordance', 'appropriateness', 'ask', 'other']),
  demographics: z.object({
    age: z.number().nullable().optional(),
    ageBand: z.string().nullable().optional(),
    sex: z.enum(['F', 'M']).nullable().optional(),
    sexRaw: z.string().nullable().optional(),
  }).strict(),
  timeline: z.array(zTimelineItem),
  positives: z.array(zClinicalFinding),
  negatives: z.array(zClinicalFinding),
  unknowns: z.array(zClinicalFinding),
  riskFactors: z.array(z.string()),
  exposures: z.array(z.string()),
  medications: z.array(z.string()),
  investigations: z.array(zInvestigationFinding),
  procedures: z.array(z.string()).optional(),
  disposition: z.string().nullable().optional(),
  instability: z.object({
    unstable: z.boolean(),
    reasons: z.array(z.string()),
    assessment: z.enum(['unstable', 'no_instability_detected', 'not_assessable']),
    assessedInputs: z.array(z.string()),
    missingInputs: z.array(z.string()),
  }).strict(),
  missingCriticalData: z.array(z.string()),
  adminFacts: zAdminFacts.optional(),
  surfaceExtras: z.record(z.unknown()).optional(),
}).strict();

/** Validate an unknown value as a ClinicalState (throws ZodError on mismatch). */
export function validateClinicalState(x: unknown): ClinicalState {
  return zClinicalState.parse(x) as ClinicalState;
}

/** An empty state for a surface — every builder starts here. */
export function emptyClinicalState(surface: Surface): ClinicalState {
  return {
    version: CLINICAL_STATE_VERSION,
    surface,
    demographics: {},
    timeline: [],
    positives: [],
    negatives: [],
    unknowns: [],
    riskFactors: [],
    exposures: [],
    medications: [],
    investigations: [],
    instability: { unstable: false, reasons: [], assessment: 'not_assessable', assessedInputs: [], missingInputs: ['BP', 'HR', 'SpO₂', 'RR', 'T'] },
    missingCriticalData: [],
  };
}

/** Deterministic finding id — djb2 over concept|sourceField|status (stable across runs). */
export function mkFindingId(concept: string, sourceField: string, status: FindingStatus): string {
  const s = `${concept.toLowerCase()}|${sourceField}|${status}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `cf-${h.toString(16)}`;
}

/** Counts block for the trace event — never ship the arithmetic twice. */
export function stateCounts(s: ClinicalState): Record<string, number> {
  return {
    positives: s.positives.length,
    negatives: s.negatives.length,
    unknowns: s.unknowns.length,
    investigations: s.investigations.length,
    timeline: s.timeline.length,
    riskFactors: s.riskFactors.length,
    medications: s.medications.length,
    missingCriticalData: s.missingCriticalData.length,
  };
}
