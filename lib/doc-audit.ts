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
import * as core from './doc-audit-core';
import type { DocType, ExtractedCase, AuditReport, RubricField } from './doc-audit-core';

type RubricEntry = { label: string; standard: string; fields: RubricField[] };
function getRubric(dt: DocType): RubricEntry {
  const d = (RUBRIC_DOC as unknown as Record<string, RubricEntry>)[dt];
  return { label: d?.label ?? dt, standard: d?.standard ?? '', fields: (d?.fields ?? []) as RubricField[] };
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
    const userPrompt = core.buildExtractUser(input.docTypeHint, input.context);
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

async function defaultRetrieveExcerpts(q: string): Promise<string[]> {
  try {
    const r = await retrieve(q, { topK: 8, useSourceWeights: true, hybrid: true });
    return r.hits.map((h) => {
      const src = h.book || h.source || 'source';
      const body = (h.text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      return `(${src}) ${body}`;
    }).filter((s) => s.length > 20);
  } catch (e) {
    console.warn('[doc-audit] retrieve failed', (e as Error).message);
    return [];
  }
}

export interface AnalyzeDeps {
  retrieveExcerpts: (q: string) => Promise<string[]>;
  generate: (system: string, user: string) => Promise<string>;
}

export async function analyzeCase(extracted: ExtractedCase, deps: Partial<AnalyzeDeps> = {}, opts: { trace?: boolean } = {}): Promise<AnalyzeResult> {
  const doTrace = opts.trace !== false;
  const traceId = doTrace
    ? await startTrace('doc_audit', { docType: extracted.docType })
    : undefined;

  const retrieveExcerpts = deps.retrieveExcerpts ?? defaultRetrieveExcerpts;
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

    const [excerpts, skel] = await Promise.all([
      retrieveExcerpts(query),
      // Idealised care-path spine (cheap Flash skeleton; untraced to keep this self-contained).
      traceSkeleton({ scenario: idealScenario || extracted.courseSummary, patient: extracted.patient, trace: false }).catch(() => ({ skeleton: null })),
    ]);
    if (traceId) await logEvent(traceId, 'doc_audit_excerpts', null, { count: excerpts.length });

    const raw = await generate(core.ANALYZE_SYSTEM, core.buildAnalyzeUser(extracted, rubric.fields, excerpts, rubric.standard));
    const parsed = core.parseAnalysis(raw);
    if (!parsed) {
      if (traceId) { await logEvent(traceId, 'doc_audit_result', null, { ok: false }); await finishTrace(traceId, 'partial'); }
      return { report: null, excerptCount: excerpts.length, traceId };
    }

    // Deterministic EHRC tariff grounding on any finding that names a concrete order.
    for (const f of parsed.findings) {
      if (f.order) {
        const t = matchAnyTariffs([f.order]);
        if (t.length) f.tariffs = t;
      }
    }

    const completeness = core.assembleCompleteness(parsed.completeness, rubric.fields);
    const idealisedStages = skel.skeleton?.stages.map((s) => ({ id: s.id, kind: s.kind, title: s.title, action: s.action, flag: s.flag }));

    const report: AuditReport = {
      completeness,
      findings: parsed.findings,
      idealisedSummary: parsed.idealisedSummary,
      idealisedStages,
      diff: parsed.diff,
      suggestions: parsed.suggestions,
      disclaimer: core.CASE_AUDIT_DISCLAIMER,
    };

    if (traceId) {
      await logEvent(traceId, 'doc_audit_result', null, {
        ok: true,
        coverage: completeness.coverage,
        missingMandatory: completeness.missingMandatory.length,
        findings: parsed.findings.map((f) => f.verdict),
        diff: parsed.diff.length,
        suggestions: parsed.suggestions.length,
        tariffs: parsed.findings.filter((f) => f.tariffs?.length).length,
      });
      await finishTrace(traceId, 'success');
    }
    return { report, excerptCount: excerpts.length, traceId };
  } catch (e) {
    if (traceId) await finishTrace(traceId, 'error', String((e as Error).message));
    console.warn('[doc-audit] analyzeCase failed', (e as Error).message);
    return { report: null, excerptCount: 0, traceId };
  }
}

export type { ExtractedCase, AuditReport, DocType } from './doc-audit-core';
