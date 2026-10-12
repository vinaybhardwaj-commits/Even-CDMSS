/**
 * lib/lab-v2/paired-audit-core.ts — pure decisions for a paired signed/override OPD audit.
 *
 * No database, no Metabase, no model. The runner and the tests both import this so the
 * join, the note-body swap, the flag diff and the log allow-list cannot drift apart.
 */
import { createHash } from 'node:crypto';
import { OPD_AUDIT_SYSTEM, OPD_ENGINE_VERSION } from '../opd-note-audit-core';

/** Same shape `lib/metabase.ts` uses for a db13 uid. Not exported there; duplicated on purpose. */
export const PAIRED_UID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export const PAIRED_MAX_PAIRS = 40;
export const PAIRED_MAX_LLM_CALLS = 400;
export const PAIRED_MAX_SIGNED_REPEATS = 3;
/** Production scorer when Vertex is configured (`lib/llm.ts` GEMINI_MODEL). */
export const PAIRED_DEFAULT_MODEL = 'vertex:gemini-2.5-pro';

/**
 * Columns `rowToOpdCase` treats as the prescription itself. Cleared on the override arm
 * so the signed Rx cannot leak into that arm. Identity, consult metadata, allergies and
 * nurse vitals stay — those are the encounter, not the prescription text being compared.
 */
const NOTE_BODY_KEYS = [
  'general_practitioner_prescription__presenting_complaints',
  'general_practitioner_prescription__plan_of_management',
  'general_practitioner_prescription__examination',
  'dpipe_dx', 'dpipe_pom', 'dpipe_pc', 'dpipe_inv',
  'general_advice', 'refer_to', 'num_referrals',
  'followup__followup_type', 'follow_up_type',
  'next_follow_up_date', 'followup__followup_date', 'expected_resolution_date',
  'presenting_complaints', 'diagnosis_icd_codes', 'impression_icd_codes',
  'relevant_medical_history', 'comorbidities', 'medications',
  'further_investigation', 'reason_for_consultation',
  'diagnosis', 'impression', 'examination', 'plan_of_management',
  'gynae_patient_history__menstrual_history__last_menstrual_period',
  'gynae_patient_history__menstrual_history__notes',
  'prescription_url',
] as const;

export function opdAuditPromptHash(): string {
  return createHash('sha256').update(OPD_AUDIT_SYSTEM).digest('hex');
}

export function pairedEngineVersion(): string {
  return OPD_ENGINE_VERSION;
}

/**
 * Copy of the signed row with the prescription body replaced by `overrideText`.
 * `dpipe_pc` is the channel `rowToOpdCase` prefers for presenting complaints, so the
 * engine's own case text is the override and not a second, hand-built prompt.
 */
export function applyNoteBodyOverride(row: Record<string, unknown>, overrideText: string): Record<string, unknown> {
  const next: Record<string, unknown> = { ...row };
  for (const key of NOTE_BODY_KEYS) next[key] = null;
  next.dpipe_pc = overrideText;
  return next;
}

export interface ProjectedFinding {
  subject: string | null;
  rationale: string | null;
  verdict: string | null;
  confidence: number | null;
  domain: string | null;
  informational: boolean;
  signal_type: string | null;
  rule_ref: string | null;
  lvc_category: string | null;
  direction: string | null;
  severity: string | null;
}

export interface ProjectedAudit {
  arm: string;
  engine_version: string | null;
  band: string | null;
  note_quality_index: number | null;
  llm_leg_failed: boolean;
  findings: ProjectedFinding[];
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  return s.length ? s : null;
}

/** Structured audit output. No note body, no keys, no doctor uid. */
export function projectAudit(audit: unknown, arm: string): ProjectedAudit {
  const a = (audit ?? {}) as Record<string, unknown>;
  const scorecard = (a.scorecard ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(a.findings) ? a.findings : [];
  const findings: ProjectedFinding[] = raw.map((item) => {
    const f = (item ?? {}) as Record<string, unknown>;
    const verdict = strOrNull(f.verdict);
    const confidence = typeof f.confidence === 'number' && Number.isFinite(f.confidence) ? f.confidence : null;
    return {
      subject: strOrNull(f.subject),
      rationale: strOrNull(f.rationale),
      verdict,
      confidence,
      domain: strOrNull(f.domain),
      informational: f.informational === true,
      signal_type: strOrNull(f.signal_type),
      rule_ref: strOrNull(f.rule_ref),
      lvc_category: strOrNull(f.lvc_category),
      direction: strOrNull(f.direction),
      severity: strOrNull(f.severity) ?? verdict,
    };
  });
  const headline = scorecard.headline;
  return {
    arm,
    engine_version: strOrNull(a.engineVersion),
    band: strOrNull(scorecard.band),
    note_quality_index: typeof headline === 'number' && Number.isFinite(headline) ? headline : null,
    llm_leg_failed: a.llmLegFailed === true,
    findings,
  };
}

export interface FlagRef {
  key: string;
  subject: string | null;
  verdict: string | null;
  signal_type: string | null;
  domain: string | null;
  severity: string | null;
}

export function flagKey(f: { signal_type: string | null; subject: string | null; verdict: string | null }): string {
  return [f.signal_type ?? '', f.subject ?? '', f.verdict ?? ''].join('\u001f');
}

export function flagRef(f: ProjectedFinding): FlagRef {
  return {
    key: flagKey(f),
    subject: f.subject,
    verdict: f.verdict,
    signal_type: f.signal_type,
    domain: f.domain,
    severity: f.severity,
  };
}

export interface FlagDiff {
  only_a: FlagRef[];
  only_b: FlagRef[];
  both: FlagRef[];
}

/** Set difference on flag identity. Order follows arm A, then flags that exist only on B. */
export function diffFlags(a: ProjectedFinding[], b: ProjectedFinding[]): FlagDiff {
  const aRefs = new Map<string, FlagRef>();
  const bRefs = new Map<string, FlagRef>();
  for (const f of a) aRefs.set(flagKey(f), flagRef(f));
  for (const f of b) bRefs.set(flagKey(f), flagRef(f));
  const only_a: FlagRef[] = [];
  const both: FlagRef[] = [];
  for (const [key, ref] of aRefs) {
    if (bRefs.has(key)) both.push(ref);
    else only_a.push(ref);
  }
  const only_b: FlagRef[] = [];
  for (const [key, ref] of bRefs) {
    if (!aRefs.has(key)) only_b.push(ref);
  }
  return { only_a, only_b, both };
}

export function sameFlagSet(groups: ProjectedFinding[][]): boolean {
  if (groups.length <= 1) return true;
  const first = groups[0].map(flagKey).sort().join('\n');
  return groups.every((g) => g.map(flagKey).sort().join('\n') === first);
}

/**
 * Log records are an allow-list. Anything else — override text, findings, rationales,
 * note bodies — is dropped, including when a caller passes it by mistake.
 */
export const PAIRED_LOG_KEYS = [
  'run_id', 'uid', 'arm', 'repeat_idx', 'status', 'reason', 'calls', 'path',
  'queued', 'succeeded', 'skipped', 'deduped', 'failed', 'stopped',
] as const;

export function pairedLogRecord(event: string, fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { event };
  for (const key of PAIRED_LOG_KEYS) {
    if (fields[key] !== undefined) out[key] = fields[key];
  }
  return out;
}

export function parsePairedModel(spec: string): { provider: 'bedrock' | 'openrouter' | 'ollama' | 'vertex'; model: string } | null {
  const m = /^(bedrock|openrouter|ollama|vertex):(.+)$/.exec(spec.trim());
  if (!m) return null;
  return { provider: m[1] as 'bedrock' | 'openrouter' | 'ollama' | 'vertex', model: m[2] };
}
