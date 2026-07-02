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
import { geminiModelFor, geminiUtilityModel, TEXT_MODEL, MINI_MODEL } from './llm';
import { rowToOpdCase, opdCaseText, type OpdKeys, type OpdMed } from './opd-ingest-core';
import {
  opdCompleteness, prescribingChecks, parseOpdAnalysis,
  OPD_AUDIT_SYSTEM, buildOpdAuditUser, OPD_ENGINE_VERSION,
  type OpdFinding, type OpdCompleteness, type OpdSuggestion,
} from './opd-note-audit-core';
import { computeOpdScore, type OpdScorecard, type NetValue, type Pdqi9Attr } from './opd-note-score-core';
import { enrichOpdMeds } from './formulary';
import { tagInteractions } from './ddi-tags';
import { curatedInteractions, mergeRank, type DrugClass } from './ddi';
import type { DdiPair } from './rxlabelguard';

// Formulary match types reliable enough to drive a deterministic safety alert (an approximate
// brand-prefix match can drop a molecule from a combination, so it informs display only).
const CONFIDENT_MATCH = new Set(['source-generic', 'brand-exact', 'embedded-generic', 'brand-token']);

function ddiToFinding(p: DdiPair): OpdFinding {
  const sev = p.severity;
  const verdict: NetValue = sev === 'contraindicated' || sev === 'major' ? 'low-value' : 'context-dependent';
  const confidence = sev === 'contraindicated' ? 0.9 : sev === 'major' ? 0.8 : sev === 'moderate' ? 0.6 : 0.4;
  return {
    subject: `Interaction (${sev}): ${p.drug_a} + ${p.drug_b}`,
    verdict, confidence, domain: 'prescribing_safety',
    rationale: `${p.mechanism} ${p.recommendation}`.trim(),
    evidence: [], estimates: [], citation_ids: [], source: 'deterministic',
  };
}

/** Formulary-scoped, deterministic DDIs over the CONFIDENTLY-resolved drugs on the script. */
function ddiFindings(meds: OpdMed[]): OpdFinding[] {
  const items: DrugClass[] = meds
    .filter((m) => m.resolvedGeneric && m.formularyMatch && CONFIDENT_MATCH.has(m.formularyMatch))
    .map((m) => ({ name: m.resolvedGeneric as string, major: m.therapeuticClass || '', minor: m.subClass || '' }));
  if (items.length < 2) return [];
  const pairs = mergeRank([...tagInteractions(items), ...curatedInteractions(items.map((i) => i.name))]);
  return pairs.map(ddiToFinding);
}

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

async function defaultGenerate(traceId: string | undefined, system: string, user: string, mini = false): Promise<string> {
  // mini=true forces the Mac-mini Ollama bridge (no Gemini) with MINI_MODEL — the
  // scoped mini pipeline (OPD mini backfill). Default path is byte-identical to before.
  const geminiModel = mini ? undefined : (geminiModelFor('doc_audit') ?? geminiUtilityModel());
  const params = {
    model: mini ? MINI_MODEL : TEXT_MODEL,
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

/** Reuse the stored LLM half of an audit so a deterministic-only rule change (e.g. the 0.5 dosing
 *  calibration) can refresh a stored row WITHOUT re-running retrieval/LLM. */
export interface AuditReuse {
  llmFindings: OpdFinding[];
  pdqi9: Partial<Record<Pdqi9Attr, number>> | null;
  suggestions: OpdSuggestion[];
  sources: Source[];
}
export interface AuditOpdOpts {
  trace?: boolean;
  reuse?: AuditReuse;
  /** 'mini' = run the audit LLM pass on the Mac-mini bridge (MINI_MODEL, no Gemini) and tag
   *  the row with the '-mini' engine version — invisible to all prod dashboards/APIs, which
   *  filter on the exact prod engine version. Rows coexist per uid (PK uid+engine_version). */
  pipeline?: 'mini';
}

/** Engine tag for mini-pipeline rows. Single source of truth — the backfill worker imports this. */
export const OPD_MINI_ENGINE_VERSION = `${OPD_ENGINE_VERSION}-mini`;

export async function auditOpdNote(row: Record<string, unknown>, opts: AuditOpdOpts = {}): Promise<OpdNoteAudit> {
  const mini = opts.pipeline === 'mini';
  const engineVersion = mini ? OPD_MINI_ENGINE_VERSION : OPD_ENGINE_VERSION;
  const { case: oc, keys } = rowToOpdCase(row);
  enrichOpdMeds(oc.medications);   // brand→generic + class/schedule/high-alert/LASA/VED from the formulary

  const det = [...prescribingChecks(oc), ...ddiFindings(oc.medications)];
  const completeness = opdCompleteness(oc);

  // Deterministic REUSE path (backfill): recompute the deterministic findings + completeness, KEEP
  // the stored LLM findings + PDQI-9, re-score. No retrieval, no LLM, no trace — so a completeness/
  // prescribing rule change refreshes stored rows at ~zero cost.
  if (opts.reuse) {
    const findings: OpdFinding[] = [...det, ...opts.reuse.llmFindings];
    const scorecard = computeOpdScore({
      findings: findings.filter((f) => !f.informational).map((f) => ({ verdict: f.verdict, confidence: f.confidence, domain: f.domain })),
      completenessCoverage: completeness.coverage,
      pdqi9: opts.reuse.pdqi9,
      patientCentred: completeness.patientCentred,
    });
    return { keys, scorecard, completeness, findings, suggestions: opts.reuse.suggestions, sources: opts.reuse.sources, engineVersion: engineVersion, traceId: undefined };
  }

  const doTrace = opts.trace !== false;
  // Non-identifying trace input (the uid lives only on the returned audit / the audit row).
  const traceId = doTrace
    ? await startTrace('opd_note_audit', {
        consultType: keys.consultType, prescriptionType: keys.prescriptionType,
        nMeds: oc.medications.length, nDx: oc.diagnosisCodes.length, nInvestigations: oc.investigations.length,
        ...(mini ? { pipeline: 'mini' } : {}),
      }).catch(() => undefined as string | undefined)
    : undefined;

  try {
    // Richer retrieval query so the corpus is hit on the actual clinical content (readable dx
    // names + reason + complaints + resolved molecules), not just ICD codes — improves grounding.
    const query = [
      ...oc.impressions,
      ...oc.diagnosisCodes,
      oc.reasonForConsult || '',
      ...oc.presentingComplaints.slice(0, 4),
      ...oc.medications.map((m) => m.resolvedGeneric || m.generic || m.brand || '').filter(Boolean),
      'outpatient appropriateness rational prescribing evidence-based management guideline',
    ].filter(Boolean).join('. ');

    const hits = await defaultRetrieve(query);
    const sources = hitsToSources(hits);
    const citedContext = buildCitedContext(hits);
    if (traceId) await logEvent(traceId, 'opd_audit_sources', null, { count: sources.length });

    const raw = await defaultGenerate(traceId, OPD_AUDIT_SYSTEM, buildOpdAuditUser(opdCaseText(oc), citedContext), mini);
    const parsed = parseOpdAnalysis(raw, sources.length);

    const findings: OpdFinding[] = [...det, ...(parsed?.findings ?? [])];
    const scorecard = computeOpdScore({
      findings: findings.filter((f) => !f.informational).map((f) => ({ verdict: f.verdict, confidence: f.confidence, domain: f.domain })),
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
      sources, engineVersion: engineVersion, traceId,
    };
  } catch (e) {
    if (traceId) await finishTrace(traceId, 'error', String((e as Error).message)).catch(() => {});
    // Even on LLM failure, return the deterministic-only audit (completeness + prescribing).
    const scorecard = computeOpdScore({
      findings: det.filter((f) => !f.informational).map((f) => ({ verdict: f.verdict, confidence: f.confidence, domain: f.domain })),
      completenessCoverage: completeness.coverage,
      pdqi9: null,
      patientCentred: completeness.patientCentred,
    });
    return { keys, scorecard, completeness, findings: det, suggestions: [], sources: [], engineVersion: engineVersion, traceId };
  }
}
