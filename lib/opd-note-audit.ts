/**
 * lib/opd-note-audit.ts — OPD note-quality audit ORCHESTRATOR (server).
 *
 * One de-identified OPD note → grounded LLM analyze (findings + PDQI-9 + suggestions)
 * + deterministic completeness + prescribing checks → OPD Note-Quality scorecard.
 * Traced ('opd_note_audit') so model/provider/tokens/latency land in observability.
 * Soft-fails. The full PHI record stays in db13; only de-identified content reaches the LLM.
 */

import { retrieve } from './retrieve';
import { hitsToSources, buildCitedContext, type CiteHit, type Source } from './citations-core';
import { startTrace, logEvent, finishTrace, tracedChat, setTraceQuestionPreview } from './trace';
import { geminiModelFor, geminiUtilityModel, TEXT_MODEL } from './llm';
import { rowToOpdCase, opdCaseText, type OpdKeys } from './opd-ingest-core';
import {
  opdCompleteness, prescribingChecks, parseOpdAnalysis,
  OPD_AUDIT_SYSTEM, buildOpdAuditUser, OPD_ENGINE_VERSION,
  type OpdFinding, type OpdCompleteness, type OpdSuggestion,
} from './opd-note-audit-core';
import { computeOpdScore, type OpdScorecard } from './opd-note-score-core';

export interface OpdNoteAudit {
  keys: OpdKeys;
  scorecard: OpdScorecard;
  completeness: OpdCompleteness;
  findings: OpdFinding[];
  suggestions: OpdSuggestion[];
  sources: Source[];
  engineVersion: string;
  traceId?: string;
}

async function defaultRetrieve(q: string): Promise<CiteHit[]> {
  try {
    const r = await retrieve(q, { topK: 8, useReranker: true, useSourceWeights: true, hybrid: true });
    return r.hits.map((h) => ({
      id: h.id, source: h.source, book: h.book, chapter: h.chapter, section: h.section,
      page_start: h.page_start, page_end: h.page_end, item_number: h.item_number,
      chunk_type: h.chunk_type, similarity: h.similarity, text: h.text,
    }));
  } catch (e) {
    console.warn('[opd-audit] retrieve failed', (e as Error).message);
    return [];
  }
}

async function defaultGenerate(traceId: string | undefined, system: string, user: string): Promise<string> {
  const geminiModel = geminiModelFor('doc_audit') ?? geminiUtilityModel();
  const params = {
    model: TEXT_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0.2,
    max_tokens: 2200,
    ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
  };
  if (traceId) {
    const r = await tracedChat(traceId, 'opd_audit_analyze', params, { gemini: geminiModel });
    return r.choices?.[0]?.message?.content || '';
  }
  // untraced fallback
  const { chatWithFallback } = await import('./llm');
  const r = await chatWithFallback(params, geminiModel);
  return r.choices?.[0]?.message?.content || '';
}

export interface AuditOpdOpts { trace?: boolean }

export async function auditOpdNote(row: Record<string, unknown>, opts: AuditOpdOpts = {}): Promise<OpdNoteAudit> {
  const { case: oc, keys } = rowToOpdCase(row);
  const doTrace = opts.trace !== false;

  // Non-identifying trace input (the uid lives only on the returned audit / the audit row).
  const traceId = doTrace
    ? await startTrace('opd_note_audit', {
        consultType: keys.consultType, prescriptionType: keys.prescriptionType,
        nMeds: oc.medications.length, nDx: oc.diagnosisCodes.length, nInvestigations: oc.investigations.length,
      }).catch(() => undefined as string | undefined)
    : undefined;

  const det = prescribingChecks(oc);
  const completeness = opdCompleteness(oc);

  try {
    const query = [
      ...oc.diagnosisCodes, ...oc.presentingComplaints,
      ...oc.medications.map((m) => m.generic || m.brand || '').filter(Boolean),
      'outpatient prescribing appropriateness rational therapy guideline',
    ].filter(Boolean).join('. ');

    const hits = await defaultRetrieve(query);
    const sources = hitsToSources(hits);
    const citedContext = buildCitedContext(hits);
    if (traceId) await logEvent(traceId, 'opd_audit_sources', null, { count: sources.length });

    const raw = await defaultGenerate(traceId, OPD_AUDIT_SYSTEM, buildOpdAuditUser(opdCaseText(oc), citedContext));
    const parsed = parseOpdAnalysis(raw, sources.length);

    const findings: OpdFinding[] = [...det, ...(parsed?.findings ?? [])];
    const scorecard = computeOpdScore({
      findings: findings.map((f) => ({ verdict: f.verdict, confidence: f.confidence, domain: f.domain })),
      completenessCoverage: completeness.coverage,
      pdqi9: parsed?.pdqi9 ?? null,
      patientCentred: completeness.patientCentred,
    });

    if (traceId) {
      const nLow = findings.filter((f) => f.verdict === 'low-value').length;
      await setTraceQuestionPreview(traceId, `OPD audit · index ${scorecard.headline} (Band ${scorecard.band}) · ${findings.length} finding(s)`).catch(() => {});
      await logEvent(traceId, 'opd_audit_result', null, {
        index: scorecard.headline, band: scorecard.band, coverage: Math.round(completeness.coverage * 100),
        n_findings: findings.length, n_low_value: nLow, pdqi9_assessed: !!parsed?.pdqi9,
      });
      await finishTrace(traceId, 'success');
    }

    return {
      keys, scorecard, completeness,
      findings, suggestions: parsed?.suggestions ?? [],
      sources, engineVersion: OPD_ENGINE_VERSION, traceId,
    };
  } catch (e) {
    if (traceId) await finishTrace(traceId, 'error', String((e as Error).message)).catch(() => {});
    // Even on LLM failure, return the deterministic-only audit (completeness + prescribing).
    const scorecard = computeOpdScore({
      findings: det.map((f) => ({ verdict: f.verdict, confidence: f.confidence, domain: f.domain })),
      completenessCoverage: completeness.coverage,
      pdqi9: null,
      patientCentred: completeness.patientCentred,
    });
    return { keys, scorecard, completeness, findings: det, suggestions: [], sources: [], engineVersion: OPD_ENGINE_VERSION, traceId };
  }
}
