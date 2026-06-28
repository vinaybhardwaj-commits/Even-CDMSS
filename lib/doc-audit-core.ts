/**
 * lib/doc-audit-core.ts — Case Audit CORE (DA.1).
 *
 * PURE, dependency-free (no db/llm/json-import). Importable by BOTH the server
 * passes (lib/doc-audit.ts, lib/gemini-multimodal.ts) and the client renderer
 * (components/CaseAuditReport.tsx), and unit-testable with `node --experimental-strip-types`.
 * See CDMSS-CASE-AUDIT-PRD-v1.0.md.
 *
 * The rubric (data/nabh-rubric.json) is loaded by the WIRED layer and passed IN as
 * RubricField[] so this core never imports JSON (keeps it strip-types testable).
 *
 * Posture: advisory, NON-DIRECTIVE, and NOT a judgment of the clinician. Evidence
 * (cited) is kept separate from estimates (labeled). PHI: the extractor must not
 * echo identifiers; nothing here persists anything.
 */

import type { TariffRef } from './lvc-value-core';
import type { SkeletonStage } from './pathway-core';
import type { Source } from './citations-core';
export type { TariffRef } from './lvc-value-core';
export type { Source } from './citations-core';

// Inlined (mirrors lib/citations-core.validateCitationIds) — see the same note in
// pathway-core: doc-audit-core has an in-repo strip-types test, so a runtime value
// import would need a `.ts` extension the Next build doesn't use. Keep in sync.
function validateCitationIds(ids: unknown, max: number, cap = 8): number[] {
  if (!Array.isArray(ids) || max < 1) return [];
  const out: number[] = [];
  for (const x of ids) {
    const n = Math.round(Number(x));
    if (Number.isFinite(n) && n >= 1 && n <= max && !out.includes(n)) out.push(n);
    if (out.length >= cap) break;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type DocType = 'discharge_summary' | 'ot_note' | 'opd_rx';
export type FieldStatus = 'present' | 'partial' | 'missing' | 'na';
export type NetValue = 'high-value' | 'context-dependent' | 'low-value' | 'uncertain';

export interface RubricField {
  key: string;
  label: string;
  section: string;
  ref: string;        // NABH clause or 'clinical'
  mandatory: boolean;
  na: boolean;        // may be marked N/A with reason
  cond?: string;      // only applicable when this holds (e.g. 'implant_used=true')
}

export interface ExtractedCase {
  docType: DocType;
  detectedDocType: DocType;
  confidence: number;            // 0..1 — extractor's confidence in the doc-type + read
  patient: { age?: number; sex?: string };
  diagnosis: string | null;
  indication: string | null;     // OPD/OT indication when distinct from a diagnosis
  procedure: string | null;      // OT
  investigations: string[];
  treatments: string[];
  medications: string[];
  courseSummary: string;
  disposition: string | null;
  followUp: string | null;
  rawNotes: string;              // DE-IDENTIFIED extractor notes (no name/UHID)
}

export interface CompletenessItem {
  key: string; label: string; section: string; ref: string;
  status: FieldStatus; mandatory: boolean; note?: string;
}
export interface CompletenessReport {
  items: CompletenessItem[];
  coverage: number;          // 0..1 over applicable mandatory fields
  mandatoryTotal: number;
  mandatoryMet: number;      // present=1, na=1, partial=0.5
  missingMandatory: string[];
}

export interface AuditFinding {
  subject: string;
  verdict: NetValue;
  confidence: number;
  rationale: string;
  order?: string;            // concrete orderable → deterministic tariff match
  evidence: string[];
  estimates: string[];
  citation_ids: number[];    // [n] of the surfaced Source[] that back this finding's evidence
  tariffs?: TariffRef[];     // set deterministically by the server, not the LLM
}

export interface DiffItem { kind: 'overuse' | 'gap'; text: string; ref?: string }
export interface Suggestion { priority: number; text: string; ref?: string }

export interface AuditReport {
  completeness: CompletenessReport;
  findings: AuditFinding[];
  idealisedSummary: string;
  idealisedStages?: Pick<SkeletonStage, 'id' | 'kind' | 'title' | 'action' | 'flag'>[];
  diff: DiffItem[];
  suggestions: Suggestion[];
  sources: Source[];         // corpus citations surfaced for this audit (findings cite by [n])
  disclaimer: string;
}

export const CASE_AUDIT_DISCLAIMER =
  'Retrospective, advisory audit grounded in retrieved guidance and NABH standards. Evidence-cited points are kept separate from model estimates. It is not a judgment of the clinician, not a substitute for the medical record or peer review, and never a denial-of-care justification.';

// ─────────────────────────────────────────────────────────────────────────────
// Normalisers + helpers
// ─────────────────────────────────────────────────────────────────────────────

const DOC_TYPES = new Set<DocType>(['discharge_summary', 'ot_note', 'opd_rx']);
const FIELD_STATUS = new Set<FieldStatus>(['present', 'partial', 'missing', 'na']);
const NET_VALUES = new Set<NetValue>(['high-value', 'context-dependent', 'low-value', 'uncertain']);

export function normDocType(v: unknown): DocType {
  const s = String(v ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (s === 'discharge_summary' || s === 'discharge' || s === 'dischargesummary' || s === 'ds') return 'discharge_summary';
  if (s === 'ot_note' || s === 'ot' || s === 'operative_note' || s === 'operativenote' || s === 'operation_note' || s === 'surgery') return 'ot_note';
  if (s === 'opd_rx' || s === 'opd' || s === 'prescription' || s === 'rx' || s === 'opd_prescription') return 'opd_rx';
  return DOC_TYPES.has(s as DocType) ? (s as DocType) : 'discharge_summary';
}

export function normFieldStatus(v: unknown): FieldStatus {
  const s = String(v ?? '').toLowerCase().trim();
  if (s === 'n/a' || s === 'not applicable' || s === 'na') return 'na';
  if (s === 'absent' || s === 'not documented' || s === 'not_documented') return 'missing';
  if (s === 'incomplete') return 'partial';
  return FIELD_STATUS.has(s as FieldStatus) ? (s as FieldStatus) : 'missing';
}

export function normNetValue(v: unknown): NetValue {
  const s = String(v ?? '').toLowerCase().trim().replace(/\s+/g, '-');
  return NET_VALUES.has(s as NetValue) ? (s as NetValue) : 'uncertain';
}

function asStr(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }
function asStrOrNull(v: unknown): string | null { const s = asStr(v); return s ? s : null; }
function asStrArray(v: unknown, cap = 20): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === 'string' ? x.trim() : (x && typeof x === 'object' ? asStr((x as Record<string, unknown>).name ?? (x as Record<string, unknown>).text) : ''))).filter(Boolean).slice(0, cap);
}
function asNum01(v: unknown): number { let n = Number(v); if (!Number.isFinite(n)) n = 0; return Math.max(0, Math.min(1, n)); }

export function extractJsonObject(text: string): unknown {
  let t = (text || '').trim();
  if (!t) return null;
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTRACT pass (Gemini multimodal) — prompt + parse
// ─────────────────────────────────────────────────────────────────────────────

export const EXTRACT_SYSTEM = `You are a careful clinical-records reader. You are given a scanned or digital clinical document (a discharge summary, an OT/operative note, or an OPD prescription) and must return a STRUCTURED, DE-IDENTIFIED extraction of what it says — the actual course of care.

CRITICAL PRIVACY RULE: do NOT include the patient's name, UHID/hospital number, address, phone, or any direct identifier anywhere in your output. Keep age and sex only. If you transcribe notes, redact identifiers.

Read faithfully — extract only what the document actually contains; do not infer or add care that isn't documented (gaps are the point of the downstream audit).

Return ONLY JSON, no prose:
{"detected_doc_type":"discharge_summary|ot_note|opd_rx","confidence":0.0-1.0,"patient":{"age":<number or null>,"sex":"<m/f or null>"},"diagnosis":"… or null","indication":"… or null","procedure":"… or null (OT only)","investigations":["…"],"treatments":["…"],"medications":["…"],"course_summary":"<concise de-identified summary of the documented course>","disposition":"… or null","follow_up":"… or null","raw_notes":"<short de-identified notes on legibility/structure, NO identifiers>"}`;

export function buildExtractUser(docTypeHint: DocType | 'auto', context?: string): string {
  const hint = docTypeHint === 'auto'
    ? 'Document type: auto-detect (set detected_doc_type).'
    : `Document type (clinician-stated): ${docTypeHint}. Confirm or correct it in detected_doc_type.`;
  const ctx = context && context.trim() ? `\nClinician context: ${context.trim()}` : '';
  return `${hint}${ctx}\n\nRead the attached document and return the structured de-identified extraction.`;
}

export function parseExtraction(raw: string, docTypeHint: DocType | 'auto'): ExtractedCase | null {
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const detected = normDocType(o.detected_doc_type ?? o.detectedDocType);
  const docType: DocType = docTypeHint === 'auto' ? detected : docTypeHint;
  const p = (o.patient && typeof o.patient === 'object') ? o.patient as Record<string, unknown> : {};
  const ageN = Number(p.age);
  const sexRaw = asStr(p.sex).toLowerCase();
  const sex = sexRaw.startsWith('m') ? 'male' : sexRaw.startsWith('f') ? 'female' : (sexRaw || undefined);
  const courseSummary = asStr(o.course_summary ?? o.courseSummary);
  // Require at least *some* signal that a document was read.
  if (!courseSummary && !asStr(o.diagnosis) && asStrArray(o.medications).length === 0 && !asStr(o.procedure)) return null;
  return {
    docType,
    detectedDocType: detected,
    confidence: asNum01(o.confidence),
    patient: { age: Number.isFinite(ageN) && ageN > 0 && ageN < 130 ? Math.round(ageN) : undefined, sex },
    diagnosis: asStrOrNull(o.diagnosis),
    indication: asStrOrNull(o.indication),
    procedure: asStrOrNull(o.procedure),
    investigations: asStrArray(o.investigations),
    treatments: asStrArray(o.treatments),
    medications: asStrArray(o.medications),
    courseSummary,
    disposition: asStrOrNull(o.disposition),
    followUp: asStrOrNull(o.follow_up ?? o.followUp),
    rawNotes: asStr(o.raw_notes ?? o.rawNotes),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ANALYZE pass (Pro, grounded) — prompt + parse
// ─────────────────────────────────────────────────────────────────────────────

export const ANALYZE_SYSTEM = `You are a clinical quality + documentation auditor for a NABH-accredited hospital. You are given (1) a DE-IDENTIFIED extracted case from a clinical document, (2) the NABH documentation rubric for that document type, and (3) NUMBERED EVIDENCE EXCERPTS [1], [2], … from a medical corpus. Produce a retrospective, advisory audit. NON-DIRECTIVE and NOT a judgment of the clinician.

Do four things:
1. COMPLETENESS — for EACH rubric field id given, decide its documentation status: "present" | "partial" | "missing" | "na" (na only where the field allows N/A and it genuinely doesn't apply). Add a short note for partial/missing. (Completeness is judged from the document itself — no citations needed here.)
2. APPROPRIATENESS / LOW-VALUE — review the investigations, treatments, drugs, and procedure for over-use / low-value / questionable decisions for this case. Each finding: subject, verdict (high-value | context-dependent | low-value | uncertain), confidence, rationale, the single concrete "order" name if it maps to an orderable test/procedure/drug (so a tariff can be attached), and "citation_ids": the [n] of the excerpts that actually support this finding's evidence. Ground clinical claims in the EXCERPTS — put grounded points (with citations) in "evidence" and your own figures/inferences or general-knowledge claims the excerpts don't cover in "estimates" (every figure marked "est."). Do NOT cite an excerpt that doesn't support the claim.
3. IDEALISED COURSE — a concise narrative of how the idealised hospital course / operation / OPD encounter should have gone for this case, then a DIFF: items "done — not needed" (kind:"overuse") and "ideal — but missing" (kind:"gap").
4. SUGGESTIONS — prioritised, concrete improvements (compliance + safety + value), priority 1 = highest.

Rules: advisory only; never phrase as blocking/denying care or blaming the clinician. Separate cited EVIDENCE from ESTIMATES. Do not invent citations or identifiers.

Return ONLY JSON, no prose:
{"completeness":[{"key":"<rubric field key>","status":"present|partial|missing|na","note":"…"}],"findings":[{"subject":"…","verdict":"…","confidence":0.0-1.0,"rationale":"…","order":"… (optional)","evidence":["…"],"estimates":["…"],"citation_ids":[1,2]}],"idealised_summary":"…","diff":[{"kind":"overuse|gap","text":"…","ref":"… (optional)"}],"suggestions":[{"priority":1,"text":"…","ref":"… (optional)"}]}`;

export function buildAnalyzeUser(ctx: ExtractedCase, fields: RubricField[], citedContext: string, standardLabel: string): string {
  const pt = (ctx.patient.age != null || ctx.patient.sex)
    ? `Patient: ${ctx.patient.age != null ? `${ctx.patient.age}y` : 'age unknown'}${ctx.patient.sex ? `, ${ctx.patient.sex}` : ''}\n`
    : '';
  const lines: string[] = [];
  if (ctx.diagnosis) lines.push(`Diagnosis: ${ctx.diagnosis}`);
  if (ctx.indication) lines.push(`Indication: ${ctx.indication}`);
  if (ctx.procedure) lines.push(`Procedure: ${ctx.procedure}`);
  if (ctx.investigations.length) lines.push(`Investigations: ${ctx.investigations.join('; ')}`);
  if (ctx.treatments.length) lines.push(`Treatments: ${ctx.treatments.join('; ')}`);
  if (ctx.medications.length) lines.push(`Medications: ${ctx.medications.join('; ')}`);
  if (ctx.disposition) lines.push(`Disposition: ${ctx.disposition}`);
  if (ctx.followUp) lines.push(`Follow-up: ${ctx.followUp}`);
  lines.push(`Course: ${ctx.courseSummary}`);
  const rubric = fields.map((f) => `- ${f.key} [${f.ref}${f.cond ? `, only if ${f.cond}` : ''}${f.na ? ', N/A allowed' : ''}] ${f.label}`).join('\n');
  const ev = citedContext.trim() ? citedContext.trim() : '(no excerpts retrieved — leave citation_ids empty; put clinical reasoning in estimates, not evidence)';
  return `Document type: ${ctx.docType} (${standardLabel})\n${pt}EXTRACTED CASE:\n${lines.join('\n')}\n\nNABH RUBRIC FIELDS (judge each by key):\n${rubric}\n\nNUMBERED EVIDENCE EXCERPTS:\n${ev}`;
}

export interface ParsedAnalysis {
  completeness: { key: string; status: FieldStatus; note: string }[];
  findings: AuditFinding[];
  idealisedSummary: string;
  diff: DiffItem[];
  suggestions: Suggestion[];
}

export function parseAnalysis(raw: string, sourceCount = 0): ParsedAnalysis | null {
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

  const completeness = Array.isArray(o.completeness)
    ? (o.completeness as unknown[]).map((c) => {
        const co = (c && typeof c === 'object') ? c as Record<string, unknown> : {};
        const key = asStr(co.key);
        if (!key) return null;
        return { key, status: normFieldStatus(co.status), note: asStr(co.note) };
      }).filter((x): x is { key: string; status: FieldStatus; note: string } => !!x)
    : [];

  const findings: AuditFinding[] = [];
  if (Array.isArray(o.findings)) {
    for (const f of o.findings as unknown[]) {
      const fo = (f && typeof f === 'object') ? f as Record<string, unknown> : {};
      const subject = asStr(fo.subject);
      if (!subject) continue;
      findings.push({
        subject,
        verdict: normNetValue(fo.verdict),
        confidence: asNum01(fo.confidence),
        rationale: asStr(fo.rationale),
        order: asStr(fo.order) || undefined,
        evidence: asStrArray(fo.evidence, 8),
        estimates: asStrArray(fo.estimates, 8),
        citation_ids: validateCitationIds(fo.citation_ids, sourceCount),
      });
      if (findings.length >= 12) break;
    }
  }

  const diff: DiffItem[] = [];
  if (Array.isArray(o.diff)) {
    for (const d of o.diff as unknown[]) {
      const dobj = (d && typeof d === 'object') ? d as Record<string, unknown> : {};
      const text = asStr(dobj.text);
      if (!text) continue;
      const k = String(dobj.kind ?? '').toLowerCase();
      const kind: 'overuse' | 'gap' = (k.includes('gap') || k.includes('miss')) ? 'gap' : 'overuse';
      diff.push({ kind, text, ref: asStr(dobj.ref) || undefined });
      if (diff.length >= 12) break;
    }
  }

  const suggestions: Suggestion[] = [];
  if (Array.isArray(o.suggestions)) {
    let i = 0;
    for (const s of o.suggestions as unknown[]) {
      const so = (s && typeof s === 'object') ? s as Record<string, unknown> : {};
      const text = asStr(so.text);
      i += 1;
      if (!text) continue;
      let pr = Number(so.priority);
      if (!Number.isFinite(pr) || pr < 1) pr = i;
      suggestions.push({ priority: Math.round(pr), text, ref: asStr(so.ref) || undefined });
      if (suggestions.length >= 12) break;
    }
    suggestions.sort((a, b) => a.priority - b.priority);
  }

  if (completeness.length === 0 && findings.length === 0 && suggestions.length === 0) return null;
  return { completeness, findings, idealisedSummary: asStr(o.idealised_summary ?? o.idealisedSummary), diff, suggestions };
}

// ─────────────────────────────────────────────────────────────────────────────
// Citation self-critique + revise (mirrors the Ask surface / value / pathway modes)
// ─────────────────────────────────────────────────────────────────────────────

export const AUDIT_CRITIQUE_SYSTEM = `You are a clinical citation + accuracy auditor reviewing a retrospective case-audit produced by an AI tool. You are given the extracted case, the NUMBERED evidence excerpts [1..n], and the draft audit JSON.

Find problems IN THE FINDINGS and SUGGESTIONS: "evidence" points NOT supported by their citation_ids; citation_ids that don't match the claim; figures/general-knowledge assertions mis-filed as evidence instead of estimates; an important low-value/over-use issue or safety caveat a physician would expect that the audit missed. (Do not critique the completeness list — it is judged from the document, not the corpus.)

Output ONLY JSON:
{"unsupported_evidence":["…"],"wrong_or_missing_citations":["…"],"misfiled_estimates":["…"],"missing_caveats":["…"],"needs_revision":true|false,"severity":"none|minor|moderate|major"}

Empty arrays are fine. needs_revision=true if any array is non-empty.`;

export const AUDIT_REVISE_SYSTEM = `You are revising your own case-audit based on a citation auditor's critique. You receive the extracted case, the NUMBERED excerpts [1..n], your earlier draft JSON, and the critique JSON.

Rewrite to fix every issue: move unsupported claims out of finding "evidence" (into "estimates" if still worth saying, else drop), correct each finding's citation_ids so it cites only excerpts that truly support it, add any missing low-value/safety finding or caveat. Keep the EXACT same JSON schema as the draft (completeness, findings with citation_ids, idealised_summary, diff, suggestions). Output ONLY the corrected JSON, no prose.`;

export function buildAuditCritiqueUser(caseSummary: string, citedContext: string, draftJson: string): string {
  return `Extracted case:\n${caseSummary.trim()}\n\nNUMBERED EVIDENCE EXCERPTS:\n${citedContext.trim() || '(none)'}\n\nDraft audit JSON to audit:\n${draftJson}\n\nOutput the JSON critique now.`;
}

export function buildAuditReviseUser(caseSummary: string, citedContext: string, draftJson: string, critiqueJson: string): string {
  return `Extracted case:\n${caseSummary.trim()}\n\nNUMBERED EVIDENCE EXCERPTS:\n${citedContext.trim() || '(none)'}\n\nEarlier draft JSON:\n${draftJson}\n\nAuditor critique JSON:\n${critiqueJson}\n\nOutput the corrected audit JSON now.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic completeness scoring (merge LLM statuses with the rubric)
// ─────────────────────────────────────────────────────────────────────────────

export function assembleCompleteness(
  rawStatuses: { key: string; status: FieldStatus; note: string }[],
  fields: RubricField[],
): CompletenessReport {
  const byKey = new Map<string, { status: FieldStatus; note: string }>();
  for (const r of rawStatuses) byKey.set(r.key, { status: r.status, note: r.note });

  const items: CompletenessItem[] = fields.map((f) => {
    const r = byKey.get(f.key);
    const status: FieldStatus = r ? r.status : 'missing';
    return { key: f.key, label: f.label, section: f.section, ref: f.ref, status, mandatory: f.mandatory, note: r?.note || undefined };
  });

  // Denominator: mandatory, non-conditional fields. (Conditional fields only count if the
  // model judged them applicable, i.e. present/partial.)
  const counted = fields.filter((f) => f.mandatory && !f.cond);
  const mandatoryTotal = counted.length;
  let mandatoryMet = 0;
  const missingMandatory: string[] = [];
  for (const f of counted) {
    const st = byKey.get(f.key)?.status ?? 'missing';
    if (st === 'present' || st === 'na') mandatoryMet += 1;
    else if (st === 'partial') mandatoryMet += 0.5;
    else missingMandatory.push(f.label);
  }
  // Conditional mandatory fields the model marked present/partial also count (both num + denom).
  let condTotal = 0, condMet = 0;
  for (const f of fields.filter((f) => f.mandatory && f.cond)) {
    const st = byKey.get(f.key)?.status;
    if (st === 'present' || st === 'partial' || st === 'missing') {
      condTotal += 1;
      if (st === 'present') condMet += 1; else if (st === 'partial') condMet += 0.5; else missingMandatory.push(f.label);
    }
  }
  const total = mandatoryTotal + condTotal;
  const met = mandatoryMet + condMet;
  const coverage = total > 0 ? Math.round((met / total) * 100) / 100 : 0;
  return { items, coverage, mandatoryTotal: total, mandatoryMet: Math.round(met * 10) / 10, missingMandatory };
}
