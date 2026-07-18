/**
 * lib/doc-audit.ts — Case Audit orchestrator (DA.3), wired.
 *
 *   extractCase()  — Gemini multimodal reads the uploaded document → a structured,
 *                    DE-IDENTIFIED ExtractedCase (the actual course).
 *   analyzeCase()  — from an ExtractedCase: retrieve() guideline excerpts →
 *                    ANALYZE (Pro) for completeness (NABH+clinical) + low-value
 *                    findings + idealised summary + diff + suggestions, IN PARALLEL
 *                    with the pathway engine's idealised spine → deterministic EHRC
 *                    tariff injection on findings → assemble AuditReport.
 *
 * PHI posture (cardinal): the document is processed in-memory and never persisted.
 * We deliberately use the UNtraced LLM path (chatWithFallback / direct multimodal)
 * and log only REDACTED trace events (doc type, counts, verdicts, coverage) — never
 * the document text, the extracted case, or any identifier. Both passes soft-fail.
 * See CDMSS-CASE-AUDIT-PRD-v1.0.md §6.
 */

import RUBRIC_DOC from '@/data/nabh-rubric.json';
import { retrieve } from './retrieve';
import { geminiModelFor, geminiUtilityModel, TEXT_MODEL, GEMINI_MODEL } from './llm';
import { startTrace, logEvent, finishTrace, tracedChat, governedChat, withTrace, buildEnvelope, setTracePromptIds } from './trace';
import { matchAnyTariffs, packageDaysFor, episodeRoomInflation } from './charge-master';
import { generateFromDocument } from './gemini-multimodal';
import { traceSkeleton } from './pathway';
import { parseCritique } from './lvc-value-core';
import { hitsToSources, buildCitedContext, type CiteHit } from './citations-core';
import { computeScorecard } from './value-score-core';
import { estimateBedDayCost } from './room-rent';
import { parseMemberLink, type MemberLink } from './record-audit-link-store';
import * as core from './doc-audit-core';
import * as px from './prognosis-core';
import type { PrognosisReport } from './prognosis-core';
import type { DocType, ExtractedCase, AuditReport, RubricField, TariffRef } from './doc-audit-core';

/** Representative ₹ for a finding's tariffs (sum of the general/private/opd/suite price each names). */
function repTariff(tariffs?: TariffRef[]): number | null {
  if (!tariffs || !tariffs.length) return null;
  let sum = 0; let any = false;
  for (const t of tariffs) {
    const v = t.general ?? t.private ?? t.opd ?? t.suite;
    if (typeof v === 'number' && v > 0) { sum += v; any = true; }
  }
  return any ? sum : null;
}

type RubricEntry = { label: string; standard: string; fields: RubricField[] };
function getRubric(dt: DocType): RubricEntry {
  const d = (RUBRIC_DOC as unknown as Record<string, RubricEntry>)[dt];
  return { label: d?.label ?? dt, standard: d?.standard ?? '', fields: (d?.fields ?? []) as RubricField[] };
}

// Fields to send into the document-read for the completeness check. For a concrete
// doc-type hint we send that rubric; for 'auto' (type unknown until we read) we send the
// deduped UNION of all three so a single read still covers whatever it turns out to be —
// assembleCompleteness later keeps only the detected type's fields.
const ALL_DOC_TYPES: DocType[] = ['discharge_summary', 'ot_note', 'opd_rx'];
function rubricFieldsForHint(hint: DocType | 'auto'): RubricField[] {
  if (hint !== 'auto') return getRubric(hint).fields;
  const seen = new Set<string>(); const out: RubricField[] = [];
  for (const dt of ALL_DOC_TYPES) for (const f of getRubric(dt).fields) if (!seen.has(f.key)) { seen.add(f.key); out.push(f); }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTRACT (Gemini multimodal)
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractInput {
  base64: string;
  mime: string;
  docTypeHint: DocType | 'auto';
  context?: string;
  bytes?: number;
  trace?: boolean;
}
export interface ExtractResult { extracted: ExtractedCase | null; traceId?: string }

export async function extractCase(input: ExtractInput): Promise<ExtractResult> {
  const doTrace = input.trace !== false;

  // Stage 1 (guaranteed finalize): status-guarded withTrace closes any trace left 'running';
  // the explicit finishTrace calls below still set the real statuses first (behaviour unchanged).
  const run = async (traceId?: string): Promise<ExtractResult> => {
  try {
    const userPrompt = core.buildExtractUser(input.docTypeHint, rubricFieldsForHint(input.docTypeHint), input.context);
    // Capture the multimodal read as an LLM call (metadata only — the document
    // itself and its raw text are NEVER logged, per the cardinal PHI rule).
    // Stage 1: the extract prompt's registry fingerprint rides the envelope columns —
    // the multimodal path doesn't go through tracedChat, so it is stamped here.
    if (traceId) {
      await logEvent(traceId, 'llm_request', 'doc_read',
        { model: GEMINI_MODEL, provider: 'vertex-multimodal', mime: input.mime, bytes: input.bytes ?? null },
        undefined,
        buildEnvelope('doc-audit-core/EXTRACT_SYSTEM', { model: GEMINI_MODEL, provider: 'vertex-multimodal' }));
      await setTracePromptIds(traceId, ['doc-audit-core/EXTRACT_SYSTEM']);
    }
    // generateFromDocument self-logs the `llm_response` (with token usage) when given the traceId —
    // do NOT also log one here, or the cost tracker would double-count this read.
    const raw = await generateFromDocument(core.EXTRACT_SYSTEM, userPrompt, input.base64, input.mime, { maxOutputTokens: 8192, traceId, label: 'doc_read' });
    const extracted = raw ? core.parseExtraction(raw, input.docTypeHint) : null;
    if (traceId) {
      await logEvent(traceId, 'doc_audit_extract_result', null, {
        ok: !!extracted,
        detectedDocType: extracted?.detectedDocType,
        confidence: extracted?.confidence,
        counts: extracted ? {
          investigations: extracted.investigations.length,
          treatments: extracted.treatments.length,
          medications: extracted.medications.length,
          hasDiagnosis: !!extracted.diagnosis,
          hasProcedure: !!extracted.procedure,
          completenessChecked: extracted.completeness?.length ?? 0,
          lengthOfStayDays: extracted.adminFacts?.lengthOfStayDays ?? null,
        } : null,
      });
      await finishTrace(traceId, extracted ? 'success' : 'partial');
    }
    return { extracted, traceId };
  } catch (e) {
    if (traceId) await finishTrace(traceId, 'error', String((e as Error).message));
    console.warn('[doc-audit] extractCase failed', (e as Error).message);
    return { extracted: null, traceId };
  }

  };

  if (!doTrace) return run(undefined);
  // REDACTED trace input — no document, no identifiers.
  return withTrace('doc_audit_extract', { docTypeHint: input.docTypeHint, mime: input.mime, bytes: input.bytes ?? null }, run);
}

// ─────────────────────────────────────────────────────────────────────────────
// IDENTITY-ONLY linkage pass (Right Care × ClinicalState Slice 1, Part C).
// A SEPARATE document read whose sole output is the member linkage key
// {uhid?, mrn?, name?, dob?} — it never writes into ExtractedCase, ClinicalState,
// or the AuditReport, and it is deliberately UNTRACED (identity is never logged;
// the content pass's redacted-trace posture is unchanged). Called by the extract
// route only when RIGHT_CARE_CLINICAL_STATE=1 + RECORD_AUDIT_LINK=1. Soft-fails
// to null — linkage is best-effort and never blocks the audit.
// ─────────────────────────────────────────────────────────────────────────────

const IDENTITY_SYSTEM = `You extract PATIENT IDENTITY FIELDS ONLY from a medical document, for record linkage.
Return ONLY JSON: {"uhid": string|null, "mrn": string|null, "name": string|null, "dob": string|null}
- uhid/mrn: the hospital's patient identifiers exactly as printed (UHID, MRN, IP/OP no., patient ID).
- name: the patient's full name as printed. dob: date of birth as printed.
- null for anything not present. Do NOT return diagnoses, medications, or any clinical content.`;

export async function extractMemberIdentity(input: { base64: string; mime: string }): Promise<MemberLink | null> {
  try {
    const raw = await generateFromDocument(IDENTITY_SYSTEM, 'Extract the patient identity fields.', input.base64, input.mime, { maxOutputTokens: 300 });
    if (!raw) return null;
    let t = raw.trim();
    if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const a = t.indexOf('{'); const b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    return parseMemberLink(JSON.parse(t.slice(a, b + 1)));
  } catch (e) {
    console.warn('[doc-audit] extractMemberIdentity failed (soft)', (e as Error).message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ANALYZE (Pro) + idealised pathway spine
// ─────────────────────────────────────────────────────────────────────────────

export interface AnalyzeResult { report: AuditReport | null; excerptCount: number; traceId?: string }

async function analyzeGenerate(system: string, user: string, forceOllama = false): Promise<string> {
  const geminiModel = forceOllama ? undefined : (geminiModelFor('doc_audit') ?? geminiUtilityModel());
  // Governed envelope (Stage 4): this is the trace-less analyze path (opts.trace === false),
  // so governedChat takes the plain hybrid branch — byte-identical to the old direct call.
  const r = await governedChat(undefined, 'doc_audit_analyze', {
    model: TEXT_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0.2,
    max_tokens: 2800,
    ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
  }, { gemini: geminiModel });
  return r.choices?.[0]?.message?.content || '';
}

// Traced analyze generate — routes through tracedChat so the (de-identified) analyze
// LLM calls are captured in observability with model/provider/tokens/latency + fallback
// detection. The extract is already de-identified (name/UHID stripped) before this runs.
async function tracedAnalyzeGenerate(traceId: string, label: string, system: string, user: string, forceOllama = false, promptRef?: string): Promise<string> {
  const geminiModel = forceOllama ? undefined : (geminiModelFor('doc_audit') ?? geminiUtilityModel());
  const r = await tracedChat(traceId, label, {
    model: TEXT_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0.2,
    max_tokens: 2800,
    ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
  }, { gemini: geminiModel, promptRef });
  return r.choices?.[0]?.message?.content || '';
}

// Stage 1: analyze-family label → Stage-0 registry id (envelope tags only — the prompts
// themselves are untouched). Prognosis labels are deliberately absent (Stage-4 breadth):
// their calls keep writing model/token facts only.
const ANALYZE_PROMPT_REFS: Record<string, string> = {
  doc_audit_analyze: 'doc-audit-core/ANALYZE_SYSTEM',
  doc_audit_critique_llm: 'doc-audit-core/AUDIT_CRITIQUE_SYSTEM',
  doc_audit_revise: 'doc-audit-core/AUDIT_REVISE_SYSTEM',
};

function hitsFrom(r: Awaited<ReturnType<typeof retrieve>>): CiteHit[] {
  return r.hits.map((h) => ({
    id: h.id, source: h.source, book: h.book, chapter: h.chapter, section: h.section,
    page_start: h.page_start, page_end: h.page_end, item_number: h.item_number,
    chunk_type: h.chunk_type, similarity: h.similarity, text: h.text,
  }));
}

async function defaultRetrieveHits(q: string): Promise<CiteHit[]> {
  try {
    // Reranker ON (matches Ask/DDx) — stronger retrieval than the old no-rerank pass.
    return hitsFrom(await retrieve(q, { topK: 8, useReranker: true, useSourceWeights: true, hybrid: true }));
  } catch (e) {
    console.warn('[doc-audit] retrieve failed', (e as Error).message);
    return [];
  }
}

// IPD citation fix (PRD CDMSS-IPD-CITATION-FIX): per-finding enrichment retrieval. Deliberately
// LIGHT and LOCAL — reranker OFF + skip-expand — because under GEMINI_ALL the expand rewrite and
// the rerank judge both route to paid Gemini Flash, whereas embeddings + BM25 + RRF + source
// weights are local/DB. So enriching per finding adds ZERO net-new paid inference (Gate 4) and
// stays sub-second parallelised across findings (Gate 5). Small topK — we want each finding's
// OWN best few chunks, not another broad pool.
async function defaultEnrichHits(q: string): Promise<CiteHit[]> {
  try {
    return hitsFrom(await retrieve(q, { topK: 4, useReranker: false, useSourceWeights: true, hybrid: true, skipExpand: true }));
  } catch (e) {
    console.warn('[doc-audit] enrich retrieve failed', (e as Error).message);
    return [];
  }
}

/** Cap on the unified analyze pool after per-finding enrichment (base 8 kept in full; bounds the
 *  net-new chunks appended). Keeps the revise context — and its token cost — bounded. */
const ENRICH_POOL_CAP = 20;

export interface AnalyzeDeps {
  retrieveHits: (q: string) => Promise<CiteHit[]>;
  enrichHits: (q: string) => Promise<CiteHit[]>;
  generate: (system: string, user: string) => Promise<string>;
}

function caseSummaryFor(extracted: ExtractedCase): string {
  const parts: string[] = [];
  if (extracted.diagnosis) parts.push(`Dx: ${extracted.diagnosis}`);
  if (extracted.indication) parts.push(`Indication: ${extracted.indication}`);
  if (extracted.procedure) parts.push(`Procedure: ${extracted.procedure}`);
  if (extracted.riskFactors?.length) parts.push(`Risk factors/allergies: ${extracted.riskFactors.join('; ')}`);
  if (extracted.investigations.length) parts.push(`Ix: ${extracted.investigations.join('; ')}`);
  if (extracted.treatments.length) parts.push(`Tx: ${extracted.treatments.join('; ')}`);
  if (extracted.medications.length) parts.push(`Meds: ${extracted.medications.join('; ')}`);
  const sf = core.adminFactsLine(extracted.adminFacts);
  if (sf) parts.push(sf);
  parts.push(`Course: ${extracted.courseSummary}`);
  return parts.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// PX — Prognosis & Safety-Netting pass (PRD v1.0). Runs IN PARALLEL with the
// analyze chain (both consume the extract). DARK by default: fires only when
// PROGNOSIS_AUDIT=1 (D5 — default flips to ON only at V sign-off). Soft-fail:
// any error → undefined → the report simply has no prognosis section.
// ─────────────────────────────────────────────────────────────────────────────

function pxCaseInput(extracted: ExtractedCase): px.PxCaseInput {
  const patientLine = [
    extracted.patient.age != null ? `${extracted.patient.age}y` : '',
    extracted.patient.sex || '',
  ].filter(Boolean).join(', ');
  return {
    docType: extracted.docType,
    patientLine,
    diagnosis: extracted.diagnosis,
    indication: extracted.indication,
    procedure: extracted.procedure,
    investigations: extracted.investigations,
    treatments: extracted.treatments,
    medications: extracted.medications,
    riskFactors: extracted.riskFactors ?? [],
    courseSummary: extracted.courseSummary,
    disposition: extracted.disposition,
    followUp: extracted.followUp,
    aftercareInstructions: extracted.aftercare?.instructions ?? [],
    warningSigns: extracted.aftercare?.warning_signs ?? [],
    followUpDetail: extracted.aftercare?.follow_up_detail ?? null,
    adminFactsLine: core.adminFactsLine(extracted.adminFacts),
  };
}

async function runPrognosisPass(
  extracted: ExtractedCase,
  caseSummary: string,
  retrieveHits: (q: string) => Promise<CiteHit[]>,
  generate: (system: string, user: string, label?: string) => Promise<string>,
  traceId: string | undefined,
  prog: (stage: string, msg: string) => void,
): Promise<{ report: PrognosisReport; hits: CiteHit[] } | undefined> {
  try {
    prog('prognosis', 'Modelling foreseeable outcomes…');
    const pxQuery = [
      extracted.diagnosis ?? '', extracted.indication ?? '', extracted.procedure ?? '',
      'complications incidence prognosis recurrence expected recovery postoperative care warning signs follow-up',
    ].filter(Boolean).join('. ');
    const hits = await retrieveHits(pxQuery);
    const citedContext = buildCitedContext(hits);
    const input = pxCaseInput(extracted);

    const draftRaw = await generate(px.PX_SYSTEM, px.buildPxUser(input, citedContext), 'doc_audit_prognosis');
    let parsed = px.parsePrognosis(draftRaw, hits.length);
    if (!parsed) {
      if (traceId) await logEvent(traceId, 'doc_audit_prognosis_result', null, { ok: false });
      return undefined;
    }

    // Citation self-critique + revise — explicitly hunts a MISSED well-known complication.
    try {
      prog('prognosis', 'Auditing the foreseeability report…');
      const critiqueRaw = await generate(px.PX_CRITIQUE_SYSTEM, px.buildPxCritiqueUser(caseSummary, citedContext, draftRaw), 'doc_audit_prognosis_critique');
      const critique = px.parsePxCritique(critiqueRaw);
      const needsRevision = critique.needs_revision;
      if (traceId) await logEvent(traceId, 'doc_audit_prognosis_critique', null, {
        needs_revision: needsRevision, severity: critique.severity,
        missing_complications: critique.missing_complications.length,
        issues: critique.unsupported_evidence.length + critique.unmarked_estimates.length + critique.wrong_net_status.length + critique.vague_failure_signature.length,
      });
      if (needsRevision) {
        prog('prognosis', 'Revising the foreseeability report…');
        const revRaw = await generate(px.PX_REVISE_SYSTEM, px.buildPxReviseUser(caseSummary, citedContext, draftRaw, JSON.stringify(critique)), 'doc_audit_prognosis_revise');
        const revised = px.parsePrognosis(revRaw, hits.length);
        if (revised) parsed = revised;
      }
    } catch (e) {
      console.warn('[doc-audit] prognosis critique failed (keeping draft)', (e as Error).message);
    }

    if (traceId) {
      // REDACTED counts only — never text (cardinal PHI rule).
      await logEvent(traceId, 'doc_audit_prognosis_result', null, {
        ok: true,
        complications: parsed.complications.length,
        safetyNetRows: parsed.safetyNet.length,
        n_unmitigated: parsed.n_unmitigated,
        n_partial: parsed.n_partial,
        benefitAssessed: !!parsed.benefit,
        expectationSetting: parsed.benefit?.documented_expectation_setting ?? null,
        sources: hits.length,
      });
    }
    return { report: parsed, hits };
  } catch (e) {
    console.warn('[doc-audit] prognosis pass failed (soft)', (e as Error).message);
    if (traceId) await logEvent(traceId, 'doc_audit_prognosis_result', null, { ok: false, error: 'soft-fail' }).catch(() => {});
    return undefined;
  }
}

// Slice 2: opts.clinicalStateText threads the optional PATIENT PICTURE block into the
// analyze prompt only (critique/revise unchanged). Omitted → byte-identical to Slice 1.
export async function analyzeCase(extracted: ExtractedCase, deps: Partial<AnalyzeDeps> = {}, opts: { trace?: boolean; onProgress?: (stage: string, msg: string) => void; forceOllama?: boolean; clinicalStateText?: string } = {}): Promise<AnalyzeResult> {
  const doTrace = opts.trace !== false;
  const doAudit = process.env.DOC_AUDIT_AUDIT !== '0';
  const doPrognosis = process.env.PROGNOSIS_AUDIT === '1'; // DARK by default (PRD D5)
  const prog = opts.onProgress ?? (() => {});
  const traceId = doTrace
    ? await startTrace('doc_audit', { docType: extracted.docType })
    : undefined;

  const retrieveHits = deps.retrieveHits ?? defaultRetrieveHits;
  const fo = opts.forceOllama === true;   // lab probe: force the free mini through analyze + prognosis
  const generate: (system: string, user: string, label?: string) => Promise<string> =
    deps.generate ?? (traceId
      ? (s, u, label = 'doc_audit_analyze') => tracedAnalyzeGenerate(traceId, label, s, u, fo, ANALYZE_PROMPT_REFS[label])
      : (s, u) => analyzeGenerate(s, u, fo));
  const rubric = getRubric(extracted.docType);

  try {
    const orders = [...extracted.investigations, ...extracted.treatments, ...extracted.medications];
    const query = [
      extracted.diagnosis ?? '', extracted.indication ?? '', extracted.procedure ?? '',
      ...orders, 'management indications appropriateness completeness guideline',
    ].filter(Boolean).join('. ');

    const idealScenario = [
      extracted.diagnosis || extracted.indication || extracted.courseSummary,
      extracted.procedure ? `planned/${extracted.procedure}` : '',
    ].filter(Boolean).join('. ');

    prog('retrieving', 'Retrieving evidence from the corpus…');
    const [hits, skel] = await Promise.all([
      retrieveHits(query),
      // Idealised care-path spine (cheap Flash skeleton; untraced to keep this self-contained).
      traceSkeleton({ scenario: idealScenario || extracted.courseSummary, patient: extracted.patient, trace: false }).catch(() => ({ skeleton: null })),
    ]);
    const sources = hitsToSources(hits);
    const citedContext = buildCitedContext(hits);
    prog('retrieving', `Retrieved ${sources.length} sources`);
    if (traceId) await logEvent(traceId, 'doc_audit_sources', null, { count: sources.length });

    const caseSummary = caseSummaryFor(extracted);

    // PX (PRD v1.0): kick off the prognosis pass NOW so it runs in parallel with the
    // whole analyze→critique→revise chain (§6.2). Flag off ⇒ resolved undefined ⇒
    // this function is byte-identical to the pre-PX behavior.
    const pxPromise: Promise<{ report: PrognosisReport; hits: CiteHit[] } | undefined> = doPrognosis
      ? runPrognosisPass(extracted, caseSummary, retrieveHits, generate, traceId, prog)
      : Promise.resolve(undefined);

    prog('analyzing', 'Auditing the case…');
    const draftRaw = await generate(core.ANALYZE_SYSTEM, core.buildAnalyzeUser(extracted, citedContext, rubric.standard, opts.clinicalStateText), 'doc_audit_analyze');
    let parsed = core.parseAnalysis(draftRaw, sources.length);
    // A04 instrumentation (DA04=a): COUNT the verdicts the model emitted outside the enum
    // (parseAnalysis launders them to 'uncertain'; the prompt is NOT edited). Accrues in
    // prod logs so V can decide the residual on real data.
    const nonEnumDraft = core.countNonEnumVerdicts(draftRaw);
    let nonEnumRevise = 0;
    if (!parsed) {
      if (traceId) { await logEvent(traceId, 'doc_audit_result', null, { ok: false }); await finishTrace(traceId, 'partial'); }
      return { report: null, excerptCount: hits.length, traceId };
    }

    // ── SL1: per-finding evidence enrichment ─────────────────────────────────
    // The pooled retrieval above is ONE centroid query for the whole audit; on a multi-problem
    // discharge summary its hits can't back every finding. Retrieve per finding (light + local),
    // then fold into ONE numbering space keeping the pooled hits as an identity prefix so the
    // draft's [1..k] survive unchanged. The critique/revise pass below then re-cites against this
    // enriched pool. Best-effort: any failure keeps the pooled sources (byte-identical to before).
    let poolSources = sources;
    let poolContext = citedContext;
    const enrichHits = deps.enrichHits ?? defaultEnrichHits;
    try {
      const enrichGroups = await Promise.all(
        parsed.findings
          .map((f) => core.enrichQueryForFinding(f))
          .filter(Boolean)
          .map((q) => enrichHits(q).catch(() => [] as CiteHit[])),
      );
      const unioned = core.unionEnrichedHits(hits, enrichGroups, ENRICH_POOL_CAP);
      if (unioned.length > hits.length) {
        poolSources = hitsToSources(unioned, unioned.length);
        poolContext = buildCitedContext(unioned, unioned.length);
        prog('retrieving', `Enriched evidence pool to ${poolSources.length} sources`);
        if (traceId) await logEvent(traceId, 'doc_audit_enrichment', null, {
          base: hits.length, enriched: unioned.length, added: unioned.length - hits.length,
        });
      }
    } catch (e) {
      console.warn('[doc-audit] enrichment failed (keeping pooled sources)', (e as Error).message);
    }

    // ── SL2: citation self-critique + RE-CITE against the enriched pool ──────
    // `finalAnalyzeSources` is what `parsed` actually cites against: the draft cites [1..sources];
    // only a successful revise (which sees the enriched pool) promotes it to the enriched set.
    let finalAnalyzeSources = sources;
    if (doAudit) {
      try {
        prog('reviewing', 'Auditing citations…');
        const critiqueRaw = await generate(core.AUDIT_CRITIQUE_SYSTEM, core.buildAuditCritiqueUser(caseSummary, poolContext, draftRaw), 'doc_audit_critique_llm');
        const critique = parseCritique(critiqueRaw);
        if (traceId) await logEvent(traceId, 'doc_audit_critique', null, {
          severity: critique.severity, needs_revision: critique.needs_revision,
          issues: critique.unsupported_evidence.length + critique.wrong_or_missing_citations.length + critique.misfiled_estimates.length + critique.missing_caveats.length,
        });
        // Critique-gated re-cite (PRD SL2): revise only when the critique — which now reads the
        // ENRICHED numbered context — asks for it. The enriched pool still reaches every doc via
        // that critique; forcing a revise on every enriched doc inflated findings without lifting
        // support (paired-60: +122% findings, gold precision 0.92→0.72), so it is not forced.
        if (critique.needs_revision) {
          prog('revising', 'Revising to fix citations…');
          const revRaw = await generate(core.AUDIT_REVISE_SYSTEM, core.buildAuditReviseUser(caseSummary, poolContext, draftRaw, JSON.stringify(critique)), 'doc_audit_revise');
          const revised = core.parseAnalysis(revRaw, poolSources.length);
          if (revised) { parsed = revised; finalAnalyzeSources = poolSources; }
          nonEnumRevise = core.countNonEnumVerdicts(revRaw);
        }
      } catch (e) {
        console.warn('[doc-audit] audit loop failed (keeping draft)', (e as Error).message);
      }
    }

    // A04 (DA04=a): the verdict-discipline counter — logged on EVERY analyze run (zeros
    // included, so the non-enum rate is measurable, not just the incidents).
    if (traceId) {
      await logEvent(traceId, 'doc_audit_verdict_discipline', null, {
        non_enum_draft: nonEnumDraft, non_enum_revise: nonEnumRevise, total: nonEnumDraft + nonEnumRevise,
      });
    }

    prog('finalizing', 'Finalizing…');

    // Deterministic EHRC tariff grounding on any finding that names a concrete order.
    for (const f of parsed.findings) {
      if (f.order) {
        const t = matchAnyTariffs([f.order]);
        if (t.length) f.tariffs = t;
      }
    }

    // Completeness now comes from the pass that actually SAW the document (extract),
    // not from the de-identified analyze pass — so header/sign-off fields aren't guessed.
    const completeness = core.assembleCompleteness(extracted.completeness ?? [], rubric.fields);
    const idealisedStages = skel.skeleton?.stages.map((s) => ({ id: s.id, kind: s.kind, title: s.title, action: s.action, flag: s.flag }));

    // Deterministic Care-Value Scorecard — pure arithmetic over the (LLM-tagged) findings,
    // the completeness coverage, the stay facts and the EHRC tariffs. Continuity = the
    // patient-facing follow-up fields (present/na = 1, partial = 0.5).
    const pcItems = completeness.items.filter((i) => i.section === 'followup');
    const pcPresent = pcItems.reduce((s, i) => s + (i.status === 'present' || i.status === 'na' ? 1 : i.status === 'partial' ? 0.5 : 0), 0);
    // Only cost avoidable bed-days when the auditor itself flagged a length-of-stay / level-of-care
    // over-use (an efficiency finding about the stay) — we never invent an over-stay.
    const STAY_RE = /\b(stay|admission|admitted|inpatient|length of stay|los|day.?care|bed.?day|overnight|hospitali[sz])/i;
    const overStayFlagged = parsed.findings.some((f) =>
      f.domain === 'efficiency' && (f.verdict === 'low-value' || f.verdict === 'context-dependent') &&
      STAY_RE.test(`${f.subject} ${f.rationale} ${f.order ?? ''}`));
    // Precise over-stay: if a package matches the procedure, room rent is included within its
    // period, so charge bed-days only BEYOND that period; else the day-care benchmark applies.
    const packageDays = packageDaysFor(extracted.procedure);
    const bedDay = estimateBedDayCost(extracted.adminFacts, overStayFlagged, packageDays);
    // Room-category inflation across the whole episode's orders (informational cost signal).
    const allOrders = [extracted.procedure ?? '', ...extracted.investigations, ...extracted.treatments, ...extracted.medications].filter(Boolean);
    const inflation = extracted.adminFacts?.careSetting ? episodeRoomInflation(allOrders, extracted.adminFacts.careSetting) : null;
    const valueScore = computeScorecard({
      findings: parsed.findings.map((f) => ({ verdict: f.verdict, confidence: f.confidence, domain: f.domain, tariff: repTariff(f.tariffs) })),
      completenessCoverage: completeness.coverage,
      patientCentred: { present: pcPresent, total: pcItems.length },
      adminFacts: extracted.adminFacts,
      bedDayCost: bedDay.cost, bedDayDetail: bedDay.detail || undefined,
      roomCategoryInflation: inflation && inflation.n > 0 ? inflation.delta : null,
      roomTier: inflation && inflation.delta > 0 ? inflation.tier : undefined,
    });

    // PX join (R5): PX sources are appended AFTER the analyze sources into ONE shared
    // numbering space, and every PX citation id shifts by the analyze-source count.
    const pxResult = await pxPromise;
    const pxSources = pxResult ? hitsToSources(pxResult.hits) : [];
    const allSources = pxResult ? [...finalAnalyzeSources, ...pxSources] : finalAnalyzeSources;
    const prognosis = pxResult ? px.offsetPrognosisCitations(pxResult.report, finalAnalyzeSources.length) : undefined;

    const report: AuditReport = {
      completeness,
      findings: parsed.findings,
      idealisedSummary: parsed.idealisedSummary,
      idealisedStages,
      diff: parsed.diff,
      suggestions: parsed.suggestions,
      sources: allSources,
      adminFacts: extracted.adminFacts,
      valueScore,
      ...(prognosis ? { prognosis } : {}),
      disclaimer: core.CASE_AUDIT_DISCLAIMER,
    };

    if (traceId) {
      await logEvent(traceId, 'doc_audit_result', null, {
        ok: true,
        coverage: completeness.coverage,
        missingMandatory: completeness.missingMandatory.length,
        findings: parsed.findings.map((f) => ({ verdict: f.verdict, cites: f.citation_ids })),
        diff: parsed.diff.length,
        suggestions: parsed.suggestions.length,
        tariffs: parsed.findings.filter((f) => f.tariffs?.length).length,
        non_enum_verdicts: nonEnumDraft + nonEnumRevise,
        valueIndex: valueScore.headline, valueBand: valueScore.band,
        ...(prognosis ? { prognosis: { complications: prognosis.complications.length, n_unmitigated: prognosis.n_unmitigated } } : {}),
      });
      await finishTrace(traceId, 'success');
    }
    return { report, excerptCount: hits.length, traceId };
  } catch (e) {
    if (traceId) await finishTrace(traceId, 'error', String((e as Error).message));
    console.warn('[doc-audit] analyzeCase failed', (e as Error).message);
    return { report: null, excerptCount: 0, traceId };
  }
}

export type { ExtractedCase, AuditReport, DocType } from './doc-audit-core';
