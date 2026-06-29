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
import { chatWithFallback, geminiModelFor, geminiUtilityModel, TEXT_MODEL } from './llm';
import { startTrace, logEvent, finishTrace } from './trace';
import { matchAnyTariffs } from './charge-master';
import { generateFromDocument } from './gemini-multimodal';
import { traceSkeleton } from './pathway';
import { parseCritique } from './lvc-value-core';
import { hitsToSources, buildCitedContext, type CiteHit } from './citations-core';
import { computeScorecard } from './value-score-core';
import { estimateBedDayCost } from './room-rent';
import * as core from './doc-audit-core';
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
  // REDACTED trace input — no document, no identifiers.
  const traceId = doTrace
    ? await startTrace('doc_audit_extract', { docTypeHint: input.docTypeHint, mime: input.mime, bytes: input.bytes ?? null })
    : undefined;
  try {
    const userPrompt = core.buildExtractUser(input.docTypeHint, rubricFieldsForHint(input.docTypeHint), input.context);
    const raw = await generateFromDocument(core.EXTRACT_SYSTEM, userPrompt, input.base64, input.mime, { maxOutputTokens: 8192 });
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
}

// ─────────────────────────────────────────────────────────────────────────────
// ANALYZE (Pro) + idealised pathway spine
// ─────────────────────────────────────────────────────────────────────────────

export interface AnalyzeResult { report: AuditReport | null; excerptCount: number; traceId?: string }

async function analyzeGenerate(system: string, user: string): Promise<string> {
  const geminiModel = geminiModelFor('doc_audit') ?? geminiUtilityModel();
  const r = await chatWithFallback({
    model: TEXT_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0.2,
    max_tokens: 2800,
    ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
  }, geminiModel);
  return r.choices?.[0]?.message?.content || '';
}

async function defaultRetrieveHits(q: string): Promise<CiteHit[]> {
  try {
    // Reranker ON (matches Ask/DDx) — stronger retrieval than the old no-rerank pass.
    const r = await retrieve(q, { topK: 8, useReranker: true, useSourceWeights: true, hybrid: true });
    return r.hits.map((h) => ({
      id: h.id, source: h.source, book: h.book, chapter: h.chapter, section: h.section,
      page_start: h.page_start, page_end: h.page_end, item_number: h.item_number,
      chunk_type: h.chunk_type, similarity: h.similarity, text: h.text,
    }));
  } catch (e) {
    console.warn('[doc-audit] retrieve failed', (e as Error).message);
    return [];
  }
}

export interface AnalyzeDeps {
  retrieveHits: (q: string) => Promise<CiteHit[]>;
  generate: (system: string, user: string) => Promise<string>;
}

function caseSummaryFor(extracted: ExtractedCase): string {
  const parts: string[] = [];
  if (extracted.diagnosis) parts.push(`Dx: ${extracted.diagnosis}`);
  if (extracted.indication) parts.push(`Indication: ${extracted.indication}`);
  if (extracted.procedure) parts.push(`Procedure: ${extracted.procedure}`);
  if (extracted.investigations.length) parts.push(`Ix: ${extracted.investigations.join('; ')}`);
  if (extracted.treatments.length) parts.push(`Tx: ${extracted.treatments.join('; ')}`);
  if (extracted.medications.length) parts.push(`Meds: ${extracted.medications.join('; ')}`);
  const sf = core.adminFactsLine(extracted.adminFacts);
  if (sf) parts.push(sf);
  parts.push(`Course: ${extracted.courseSummary}`);
  return parts.join('\n');
}

export async function analyzeCase(extracted: ExtractedCase, deps: Partial<AnalyzeDeps> = {}, opts: { trace?: boolean; onProgress?: (stage: string, msg: string) => void } = {}): Promise<AnalyzeResult> {
  const doTrace = opts.trace !== false;
  const doAudit = process.env.DOC_AUDIT_AUDIT !== '0';
  const prog = opts.onProgress ?? (() => {});
  const traceId = doTrace
    ? await startTrace('doc_audit', { docType: extracted.docType })
    : undefined;

  const retrieveHits = deps.retrieveHits ?? defaultRetrieveHits;
  const generate = deps.generate ?? analyzeGenerate;
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
    prog('analyzing', 'Auditing the case…');
    const draftRaw = await generate(core.ANALYZE_SYSTEM, core.buildAnalyzeUser(extracted, citedContext, rubric.standard));
    let parsed = core.parseAnalysis(draftRaw, sources.length);
    if (!parsed) {
      if (traceId) { await logEvent(traceId, 'doc_audit_result', null, { ok: false }); await finishTrace(traceId, 'partial'); }
      return { report: null, excerptCount: hits.length, traceId };
    }

    // ── Citation self-critique + revise ──────────────────────────────────────
    if (doAudit) {
      try {
        prog('reviewing', 'Auditing citations…');
        const critiqueRaw = await generate(core.AUDIT_CRITIQUE_SYSTEM, core.buildAuditCritiqueUser(caseSummary, citedContext, draftRaw));
        const critique = parseCritique(critiqueRaw);
        if (traceId) await logEvent(traceId, 'doc_audit_critique', null, {
          severity: critique.severity, needs_revision: critique.needs_revision,
          issues: critique.unsupported_evidence.length + critique.wrong_or_missing_citations.length + critique.misfiled_estimates.length + critique.missing_caveats.length,
        });
        if (critique.needs_revision) {
          prog('revising', 'Revising to fix citations…');
          const revRaw = await generate(core.AUDIT_REVISE_SYSTEM, core.buildAuditReviseUser(caseSummary, citedContext, draftRaw, JSON.stringify(critique)));
          const revised = core.parseAnalysis(revRaw, sources.length);
          if (revised) parsed = revised;
        }
      } catch (e) {
        console.warn('[doc-audit] audit loop failed (keeping draft)', (e as Error).message);
      }
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
    const bedDay = estimateBedDayCost(extracted.adminFacts, overStayFlagged);
    const valueScore = computeScorecard({
      findings: parsed.findings.map((f) => ({ verdict: f.verdict, confidence: f.confidence, domain: f.domain, tariff: repTariff(f.tariffs) })),
      completenessCoverage: completeness.coverage,
      patientCentred: { present: pcPresent, total: pcItems.length },
      adminFacts: extracted.adminFacts,
      bedDayCost: bedDay.cost, bedDayDetail: bedDay.detail || undefined,
    });

    const report: AuditReport = {
      completeness,
      findings: parsed.findings,
      idealisedSummary: parsed.idealisedSummary,
      idealisedStages,
      diff: parsed.diff,
      suggestions: parsed.suggestions,
      sources,
      adminFacts: extracted.adminFacts,
      valueScore,
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
        valueIndex: valueScore.headline, valueBand: valueScore.band,
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
