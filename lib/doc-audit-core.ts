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

/** Raw per-field documentation status, judged against the DOCUMENT (status-only, no values). */
export interface RawStatus { key: string; status: FieldStatus; note: string }

/**
 * Non-identifying administrative / temporal facts, used for value reasoning
 * (over-stay, level-of-care, antibiotic duration). DELIBERATELY contains NO dates —
 * a stay LENGTH (a duration) is not a HIPAA identifier; admission/discharge DATES are,
 * so the extractor reports the day-count only, never the calendar dates.
 */
export interface AdminFacts {
  lengthOfStayDays: number | null;
  admissionType: string | null;   // elective | emergency | …
  careSetting: string | null;     // day_care | ward | room | icu | …
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
  // Completeness is judged HERE, in the pass that actually sees the document, so the
  // downstream (de-identified) analyze pass never has to guess whether a header/sign-off
  // field is present. Status-only — never carries the field's value (PHI-safe).
  completeness?: RawStatus[];
  adminFacts?: AdminFacts;
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
  adminFacts?: AdminFacts;   // non-identifying stay facts (LOS/level-of-care) — context for the value findings
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

/** Parse a `[{key,status,note}]` documentation-status list (used by both extract + analyze). */
export function parseStatusList(v: unknown): RawStatus[] {
  if (!Array.isArray(v)) return [];
  const out: RawStatus[] = [];
  for (const c of v) {
    const co = (c && typeof c === 'object') ? c as Record<string, unknown> : {};
    const key = asStr(co.key);
    if (!key) continue;
    out.push({ key, status: normFieldStatus(co.status), note: asStr(co.note) });
  }
  return out;
}

/** Parse non-identifying admin facts. Discards anything date-shaped; keeps only a day-count + labels. */
export function normAdminFacts(v: unknown): AdminFacts | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const losN = Math.round(Number(o.length_of_stay_days ?? o.lengthOfStayDays));
  const los = Number.isFinite(losN) && losN >= 0 && losN < 3650 ? losN : null;
  const at = asStr(o.admission_type ?? o.admissionType);
  const cs = asStr(o.care_setting ?? o.careSetting);
  if (los === null && !at && !cs) return undefined;
  return { lengthOfStayDays: los, admissionType: at || null, careSetting: cs || null };
}

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

export const EXTRACT_SYSTEM = `You are a careful clinical-records reader. You are given a scanned or digital clinical document (a discharge summary, an OT/operative note, or an OPD prescription) and must return a STRUCTURED, DE-IDENTIFIED extraction of what it says — the actual course of care — PLUS a documentation-completeness check.

CRITICAL PRIVACY RULE: do NOT include the patient's name, UHID/hospital number, address, phone, or any direct identifier anywhere in your output. Keep age and sex only. If you transcribe notes, redact identifiers. EXCEPTION: in the "completeness" check you may mark an identifier field "present" — that reports only WHETHER it is documented, never its value (e.g. mark patient_name "present" but never write the name).

Read faithfully — extract only what the document actually contains; do not infer or add care that isn't documented (gaps are the point of the downstream audit). When a treatment has a duration (e.g. IV antibiotics given across several days), capture it (e.g. "IV Augmentin ~7 days") — durations matter for the value audit.

COMPLETENESS CHECK: you are given a list of documentation FIELDS to check (key + where it belongs). For EACH field key decide, by reading the WHOLE document (header/letterhead, body tables, and the sign-off/footer), one status: "present" (clearly documented) | "partial" (present but incomplete, e.g. a drug with no dose/route/duration) | "missing" (not documented) | "na" (genuinely not applicable, only where allowed). Judge presence from the document itself — a header field like the admission/discharge date or treating-doctor name counts as "present" even though it is an identifier. For a signature/sign-off field, "present" means a clinician name + signature/credential actually appears. Add a SHORT note for partial/missing — and never put an identifier value in the note.

ADMIN FACTS (non-identifying): set length_of_stay_days = whole days between admission and discharge when BOTH are documented, else null — output ONLY the day count, NEVER the actual dates. Set admission_type (elective/emergency/…) and care_setting (day_care/ward/room/icu/…) when stated.

Return ONLY JSON, no prose:
{"detected_doc_type":"discharge_summary|ot_note|opd_rx","confidence":0.0-1.0,"patient":{"age":<number or null>,"sex":"<m/f or null>"},"diagnosis":"… or null","indication":"… or null","procedure":"… or null (OT only)","investigations":["…"],"treatments":["…"],"medications":["…"],"course_summary":"<concise de-identified summary of the documented course>","disposition":"… or null","follow_up":"… or null","admin_facts":{"length_of_stay_days":<integer or null>,"admission_type":"… or null","care_setting":"… or null"},"completeness":[{"key":"<field key>","status":"present|partial|missing|na","note":"<short, NO identifier values>"}],"raw_notes":"<short de-identified notes on legibility/structure, NO identifiers>"}`;

export function buildExtractUser(docTypeHint: DocType | 'auto', rubricFields: RubricField[], context?: string): string {
  const hint = docTypeHint === 'auto'
    ? 'Document type: auto-detect (set detected_doc_type).'
    : `Document type (clinician-stated): ${docTypeHint}. Confirm or correct it in detected_doc_type.`;
  const ctx = context && context.trim() ? `\nClinician context: ${context.trim()}` : '';
  const rubric = rubricFields.length
    ? `\n\nDOCUMENTATION FIELDS TO CHECK (status only — never echo a field's value):\n${rubricFields.map((f) => `- ${f.key} [${f.ref}${f.cond ? `, only if ${f.cond}` : ''}${f.na ? ', N/A allowed' : ''}] ${f.label}`).join('\n')}`
    : '';
  return `${hint}${ctx}${rubric}\n\nRead the attached document and return the structured de-identified extraction, the admin facts, and the completeness check.`;
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
    completeness: parseStatusList(o.completeness),
    adminFacts: normAdminFacts(o.admin_facts ?? o.adminFacts),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ANALYZE pass (Pro, grounded) — prompt + parse
// ─────────────────────────────────────────────────────────────────────────────

export const ANALYZE_SYSTEM = `You are a clinical quality auditor for a NABH-accredited hospital. You are given (1) a DE-IDENTIFIED extracted case from a clinical document (including non-identifying STAY FACTS — length of stay in days, admission type, care setting) and (2) NUMBERED EVIDENCE EXCERPTS [1], [2], … from a medical corpus. Produce a retrospective, advisory audit. NON-DIRECTIVE and NOT a judgment of the clinician. (Documentation completeness is checked separately — do NOT assess it here.)

Do three things:
1. APPROPRIATENESS / LOW-VALUE — review the investigations, treatments, drugs, and procedure for over-use / low-value / questionable decisions for this case. Consider the VALUE OF CARE INTENSITY too, using the stay facts: an inpatient admission or a multi-day length of stay for a procedure usually done as day-care, or a prolonged course of IV antibiotics for a clean/low-risk procedure, are over-use signals worth a finding. Each finding: subject, verdict (high-value | context-dependent | low-value | uncertain), confidence, rationale, the single concrete "order" name if it maps to an orderable test/procedure/drug (so a tariff can be attached), and "citation_ids": the [n] of the excerpts that actually support this finding's evidence. Ground clinical claims in the EXCERPTS — put grounded points (with citations) in "evidence" and your own figures/inferences or general-knowledge claims the excerpts don't cover in "estimates" (every figure marked "est."). Do NOT cite an excerpt that doesn't support the claim. Do NOT flag the absence of a step the document may simply not mention as if it were a care failure — frame uncertain reads as documentation gaps, not errors.
2. IDEALISED COURSE — a concise narrative of how the idealised hospital course / operation / OPD encounter should have gone for this case, then a DIFF: items "done — not needed" (kind:"overuse") and "ideal — but missing" (kind:"gap").
3. SUGGESTIONS — prioritised, concrete improvements (compliance + safety + value), priority 1 = highest.

Rules: advisory only; never phrase as blocking/denying care or blaming the clinician. Separate cited EVIDENCE from ESTIMATES. Do not invent citations or identifiers.

Return ONLY JSON, no prose:
{"findings":[{"subject":"…","verdict":"…","confidence":0.0-1.0,"rationale":"…","order":"… (optional)","evidence":["…"],"estimates":["…"],"citation_ids":[1,2]}],"idealised_summary":"…","diff":[{"kind":"overuse|gap","text":"…","ref":"… (optional)"}],"suggestions":[{"priority":1,"text":"…","ref":"… (optional)"}]}`;

export function buildAnalyzeUser(ctx: ExtractedCase, citedContext: string, standardLabel: string): string {
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
  const sf = adminFactsLine(ctx.adminFacts);
  if (sf) lines.push(sf);
  lines.push(`Course: ${ctx.courseSummary}`);
  const ev = citedContext.trim() ? citedContext.trim() : '(no excerpts retrieved — leave citation_ids empty; put clinical reasoning in estimates, not evidence)';
  return `Document type: ${ctx.docType} (${standardLabel})\n${pt}EXTRACTED CASE:\n${lines.join('\n')}\n\nNUMBERED EVIDENCE EXCERPTS:\n${ev}`;
}

/** One-line render of the non-identifying stay facts (or '' if none). Shared by analyze + critique. */
export function adminFactsLine(a?: AdminFacts): string {
  if (!a) return '';
  const parts: string[] = [];
  if (a.lengthOfStayDays != null) parts.push(`length of stay ${a.lengthOfStayDays} day${a.lengthOfStayDays === 1 ? '' : 's'}`);
  if (a.admissionType) parts.push(a.admissionType);
  if (a.careSetting) parts.push(a.careSetting);
  return parts.length ? `Stay: ${parts.join('; ')}` : '';
}

export interface ParsedAnalysis {
  findings: AuditFinding[];
  idealisedSummary: string;
  diff: DiffItem[];
  suggestions: Suggestion[];
}

export function parseAnalysis(raw: string, sourceCount = 0): ParsedAnalysis | null {
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

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

  const idealisedSummary = asStr(o.idealised_summary ?? o.idealisedSummary);
  if (findings.length === 0 && suggestions.length === 0 && !idealisedSummary) return null;
  return { findings, idealisedSummary, diff, suggestions };
}

// ─────────────────────────────────────────────────────────────────────────────
// Citation self-critique + revise (mirrors the Ask surface / value / pathway modes)
// ─────────────────────────────────────────────────────────────────────────────

export const AUDIT_CRITIQUE_SYSTEM = `You are a clinical citation + accuracy auditor reviewing a retrospective case-audit produced by an AI tool. You are given the extracted case, the NUMBERED evidence excerpts [1..n], and the draft audit JSON.

Find problems IN THE FINDINGS and SUGGESTIONS: "evidence" points NOT supported by their citation_ids; citation_ids that don't match the claim; figures/general-knowledge assertions mis-filed as evidence instead of estimates; an important low-value/over-use issue or safety caveat a physician would expect that the audit missed (e.g. a multi-day stay or prolonged IV antibiotics for a day-care-eligible procedure). The draft has no completeness list — documentation completeness is checked elsewhere, so do not look for it.

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
