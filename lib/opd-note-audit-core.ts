/**
 * lib/opd-note-audit-core.ts — OPD note-quality audit CORE (pure).
 *
 * Deterministic completeness + prescribing checks, the grounded LLM analyze prompt,
 * and the response parser. PURE: type-only cross-imports (so it loads under
 * `node --experimental-strip-types` for unit tests); the score assembly that needs
 * computeOpdScore lives in the server orchestrator (lib/opd-note-audit.ts).
 */

import type { DeidOpdCase } from './opd-ingest-core';
import type { NetValue, OpdFindingDomain, Pdqi9Attr } from './opd-note-score-core';

export const OPD_ENGINE_VERSION = 'opd-note-audit/0.2';

// Local copy of the PDQI-9 keys (kept in sync with opd-note-score-core) so this core has
// no runtime cross-import and stays loadable under `node --experimental-strip-types`.
const PDQI9_KEYS: Pdqi9Attr[] = [
  'up_to_date', 'accurate', 'thorough', 'useful', 'organized',
  'comprehensible', 'succinct', 'synthesized', 'internally_consistent',
];

export interface OpdFinding {
  subject: string;
  verdict: NetValue;
  confidence: number;
  domain: OpdFindingDomain;        // 'appropriateness' | 'prescribing_safety'
  rationale: string;
  evidence: string[];
  estimates: string[];
  citation_ids: number[];
  source: 'llm' | 'deterministic';
}
export interface OpdCompletenessItem { key: string; label: string; present: boolean; mandatory: boolean }
export interface OpdCompleteness {
  items: OpdCompletenessItem[];
  coverage: number;                          // 0..1 over applicable items
  missing: string[];
  patientCentred: { present: number; total: number };
}
export interface OpdSuggestion { priority: number; text: string }

// ── Deterministic NABH-OPD completeness (from the structured row) ─────────────
export function opdCompleteness(c: DeidOpdCase): OpdCompleteness {
  const hasMeds = c.medications.length > 0;
  const dosingComplete = hasMeds && c.medications.every((m) => m.dose && m.frequency && m.route);
  // NABH-OPD items we can actually observe in this EMR's structured data. Allergy is never
  // stored at the prescription level (always empty) and history is folded into the presenting
  // complaint / HPI, so both were removed (they were false-flagging ~100% of notes).
  const items: OpdCompletenessItem[] = [
    { key: 'presenting_complaint', label: 'Presenting complaint', present: c.presentingComplaints.length > 0 || !!c.reasonForConsult, mandatory: true },
    { key: 'diagnosis', label: 'Diagnosis / impression', present: c.diagnosisCodes.length > 0 || c.impressionCodes.length > 0 || c.impressions.length > 0, mandatory: true },
    { key: 'medication_dosing', label: 'Complete medication dosing', present: hasMeds ? dosingComplete : true, mandatory: true },
    { key: 'advice_given', label: 'Advice / plan', present: c.advice.length > 0, mandatory: true },
    { key: 'follow_up', label: 'Follow-up specified', present: !!c.followUpType, mandatory: true },
  ];
  const present = items.filter((i) => i.present).length;
  const coverage = items.length ? present / items.length : 1;
  const missing = items.filter((i) => !i.present).map((i) => i.label);
  // Continuity / patient-centred subset (advice + follow-up).
  const pc = ['advice_given', 'follow_up'];
  const pcItems = items.filter((i) => pc.includes(i.key));
  return {
    items,
    coverage,
    missing,
    patientCentred: { present: pcItems.filter((i) => i.present).length, total: pcItems.length },
  };
}

// ── Deterministic rational-prescribing checks (from the medications array) ─────
export function prescribingChecks(c: DeidOpdCase): OpdFinding[] {
  const out: OpdFinding[] = [];
  const seen = new Map<string, number>();
  for (const m of c.medications) {
    const name = m.generic || m.brand || 'medication';
    if (!m.generic && m.brand) {
      out.push({ subject: `Non-generic prescription: ${m.brand}`, verdict: 'context-dependent', confidence: 0.6, domain: 'prescribing_safety',
        rationale: 'Prescribed by brand without a generic name — NABH / rational-prescribing expects generic naming.', evidence: [], estimates: [], citation_ids: [], source: 'deterministic' });
    }
    const gaps: string[] = [];
    if (!m.dose) gaps.push('dose');
    if (!m.frequency) gaps.push('frequency');
    if (!m.route) gaps.push('route');
    if (!m.duration) gaps.push('duration');
    if (gaps.length) {
      out.push({ subject: `Incomplete dosing: ${name}`, verdict: 'context-dependent', confidence: 0.55, domain: 'prescribing_safety',
        rationale: `Missing ${gaps.join(', ')} — incomplete prescription.`, evidence: [], estimates: [], citation_ids: [], source: 'deterministic' });
    }
    if (m.generic) { const k = m.generic.toLowerCase(); seen.set(k, (seen.get(k) || 0) + 1); }
  }
  for (const [k, n] of seen) {
    if (n > 1) out.push({ subject: `Duplicate prescription: ${k}`, verdict: 'low-value', confidence: 0.7, domain: 'prescribing_safety',
      rationale: `The same generic appears ${n} times on the prescription.`, evidence: [], estimates: [], citation_ids: [], source: 'deterministic' });
  }
  return out;
}

// ── LLM analyze pass (grounded) — findings + PDQI-9 + suggestions ─────────────
export const OPD_AUDIT_SYSTEM = `You are a clinical quality auditor reviewing a SINGLE outpatient (OPD) consultation note, given a DE-IDENTIFIED structured record of the encounter and NUMBERED EVIDENCE EXCERPTS [1], [2], … from a medical corpus. Produce an advisory, NON-DIRECTIVE note-quality audit. Do THREE things.

1) FINDINGS — appropriateness and prescribing-safety issues for THIS encounter:
   - appropriateness: low-value / inappropriate tests, treatments or referrals for the presentation.
   - prescribing_safety: irrational or unsafe prescribing — wrong/unnecessary drug, an antibiotic for a likely-viral illness, drug–drug or drug–allergy interactions, duplications, dosing problems.
   Each finding: "subject", "verdict" (high-value | context-dependent | low-value | uncertain), "confidence" 0–1, "domain" ("appropriateness" | "prescribing_safety"), "rationale", "evidence" (points SUPPORTED by the excerpts), "estimates" (your own/general-knowledge points), "citation_ids" (the [n] that actually support the evidence).
   GUARD AGAINST ANCHORING: weigh PRE-TEST PROBABILITY and the dominant clinical syndrome; treat outside low-utility tests (e.g. Widal) with skepticism; do not reward a low-yield confirmatory test. Do NOT invent a diagnosis the note doesn't support.
   Do NOT penalise the mere absence of a field as a clinical error (documentation gaps are scored separately) — focus findings on the actual clinical decisions taken.

2) PDQI9 — rate the QUALITY OF THE DOCUMENTATION THAT IS PRESENT on the validated 9 attributes, each 1 (poor) to 5 (excellent). ANCHOR: 3 = acceptable/adequate, 5 = excellent, 1 = unacceptable. CRITICAL — completeness is scored SEPARATELY, so do NOT re-penalise missing sections here. A terse but internally-correct note (correct drug names + dosing, a coded diagnosis, a coherent plan) is ACCEPTABLE: rate accurate, comprehensible, succinct and internally_consistent ≈ 3–5 unless what IS written is actually wrong, confusing/unreadable, padded, or self-contradictory — reserve 1–2 for those genuine defects, not for brevity. Only thorough, useful and synthesized may legitimately fall for sparseness. Rate each attribute for what it measures:
   - up_to_date: consistent with current standards · accurate: factually correct, no errors in what is stated · thorough: covers the relevant clinical ground (low if sparse) · useful: gives a downstream reader what they need (low if sparse) · organized: logically structured · comprehensible: clear and readable · succinct: concise without padding (terse is NOT a defect) · synthesized: ties findings into a coherent assessment/plan (low if sparse) · internally_consistent: no contradictions among the documented items.

3) SUGGESTIONS — prioritised, concrete improvements (priority 1 = highest).

Advisory only; never blame the clinician. Separate cited EVIDENCE from ESTIMATES; never present an estimate as cited.

Return ONLY JSON, no prose:
{"findings":[{"subject":"…","verdict":"…","confidence":0.0,"domain":"appropriateness|prescribing_safety","rationale":"…","evidence":["…"],"estimates":["…"],"citation_ids":[1]}],"pdqi9":{"up_to_date":3,"accurate":3,"thorough":3,"useful":3,"organized":3,"comprehensible":3,"succinct":3,"synthesized":3,"internally_consistent":3},"suggestions":[{"priority":1,"text":"…"}]}`;

export function buildOpdAuditUser(caseText: string, citedContext: string): string {
  const ev = citedContext.trim() ? citedContext.trim() : '(no excerpts retrieved — leave citation_ids empty; put clinical reasoning in estimates, not evidence)';
  return `DE-IDENTIFIED OPD ENCOUNTER:\n${caseText}\n\nNUMBERED EVIDENCE EXCERPTS:\n${ev}`;
}

// ── parse ────────────────────────────────────────────────────────────────────
function extractJsonObject(text: string): unknown {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}
function s(v: unknown): string { return v == null ? '' : String(v).trim(); }
function num(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}
function strArr(v: unknown, cap = 12): string[] {
  return Array.isArray(v) ? v.map(s).filter(Boolean).slice(0, cap) : [];
}
const VERDICTS: NetValue[] = ['high-value', 'context-dependent', 'low-value', 'uncertain'];
function normVerdict(v: unknown): NetValue { const x = s(v).toLowerCase().replace(/\s+/g, '-'); return (VERDICTS as string[]).includes(x) ? (x as NetValue) : 'uncertain'; }
function normDomain(v: unknown): OpdFindingDomain { return s(v).toLowerCase().includes('prescrib') ? 'prescribing_safety' : 'appropriateness'; }

export interface OpdAnalysis {
  findings: OpdFinding[];
  pdqi9: Partial<Record<Pdqi9Attr, number>> | null;
  suggestions: OpdSuggestion[];
}

export function parseOpdAnalysis(text: string, sourceCount = 0): OpdAnalysis | null {
  const o = extractJsonObject(text) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;

  const rawF = Array.isArray(o.findings) ? o.findings : [];
  const findings: OpdFinding[] = rawF.map((r) => {
    const f = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const ids = Array.isArray(f.citation_ids)
      ? f.citation_ids.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 1 && n <= sourceCount)
      : [];
    return {
      subject: s(f.subject) || '(unnamed finding)',
      verdict: normVerdict(f.verdict),
      confidence: num(f.confidence, 0, 1, 0.5),
      domain: normDomain(f.domain),
      rationale: s(f.rationale),
      evidence: strArr(f.evidence),
      estimates: strArr(f.estimates),
      citation_ids: ids,
      source: 'llm' as const,
    };
  }).filter((f) => f.subject !== '(unnamed finding)' || f.rationale);

  let pdqi9: Partial<Record<Pdqi9Attr, number>> | null = null;
  const rawP = (o.pdqi9 && typeof o.pdqi9 === 'object') ? o.pdqi9 as Record<string, unknown> : null;
  if (rawP) {
    pdqi9 = {};
    for (const a of PDQI9_KEYS) { const v = rawP[a]; if (v != null && Number.isFinite(Number(v))) pdqi9[a] = num(v, 1, 5, 3); }
    if (Object.keys(pdqi9).length === 0) pdqi9 = null;
  }

  const rawS = Array.isArray(o.suggestions) ? o.suggestions : [];
  const suggestions: OpdSuggestion[] = rawS.map((r, i) => {
    const x = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    return { priority: num(x.priority, 1, 99, i + 1), text: s(x.text) };
  }).filter((x) => x.text).sort((a, b) => a.priority - b.priority);

  return { findings, pdqi9, suggestions };
}
