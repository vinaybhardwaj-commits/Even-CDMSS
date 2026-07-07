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
  opdCompleteness, prescribingChecks, parseOpdAnalysis, stampFindingIdentity,
  OPD_AUDIT_SYSTEM, buildOpdAuditUser, OPD_ENGINE_VERSION,
  type OpdFinding, type OpdCompleteness, type OpdSuggestion,
} from './opd-note-audit-core';
import { computeOpdScore, type OpdScorecard, type NetValue, type Pdqi9Attr } from './opd-note-score-core';
import { enrichOpdMeds } from './formulary';
import { doseFindings } from './dose-limits';
import { tagInteractions } from './ddi-tags';
import { curatedInteractions, mergeRank, type DrugClass } from './ddi';
import type { DdiPair } from './rxlabelguard';
import { applySuppressions, type Suppression } from './audit-suppression-core';
import { loadActiveSuppressions } from './audit-suppression-store';
import { sql } from './db';

// Best-effort cache of active suppressions (Tier-1 self-heal) so the per-note audit doesn't re-read
// the table each time. Short TTL; a fresh suppression takes effect within a minute. Empty = no-op.
let _suppCache: { at: number; list: Suppression[] } | null = null;
async function getActiveSuppressions(): Promise<Suppression[]> {
  const now = Date.now();
  if (_suppCache && now - _suppCache.at < 60_000) return _suppCache.list;
  try { const list = await loadActiveSuppressions(); _suppCache = { at: now, list }; return list; }
  catch { return _suppCache?.list ?? []; }
}

// B4 — the treating clinician's real specialty (doctor_directory), so a specialist's note is judged
// against that specialty's standards, not GP defaults. Small table → cache the whole map (60s TTL).
const _dirRun = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
let _specCache: { at: number; map: Record<string, string> } | null = null;
async function doctorSpecialtyFor(doctorUid: string | null): Promise<string | null> {
  if (!doctorUid) return null;
  const now = Date.now();
  if (!_specCache || now - _specCache.at >= 60_000) {
    try {
      const rows = await _dirRun(`SELECT doctor_uid, speciality FROM doctor_directory WHERE speciality IS NOT NULL`, []);
      const map: Record<string, string> = {};
      for (const r of rows) map[String(r.doctor_uid)] = String(r.speciality);
      _specCache = { at: now, map };
    } catch { if (!_specCache) return null; }
  }
  return _specCache.map[doctorUid] || null;
}

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
  // Reasoning-class local models (DeepSeek-R1 / QwQ) emit a long <think> block before the
  // JSON, so they need greedy decoding (eval determinism), a bigger output budget (the JSON
  // must survive the reasoning tokens) and the full context window. Gated on the mini path +
  // model name, so qwen2.5:14b backfill and the Gemini path are byte-for-byte unchanged.
  const isReasoning = mini && /(?:^|[:/_-])(?:r1|qwq|deepseek-r1|reason|think)/i.test(MINI_MODEL);
  const params = {
    model: mini ? MINI_MODEL : TEXT_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: isReasoning ? 0 : 0.2,
    max_tokens: isReasoning ? 8192 : 2200,
    ...({ options: { num_ctx: isReasoning ? 16384 : 8192 }, keep_alive: '15m' } as Record<string, unknown>),
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
   *  the row with the '-<tag>' engine version — invisible to all prod dashboards/APIs, which
   *  filter on the exact prod engine version. Rows coexist per uid (PK uid+engine_version). */
  pipeline?: 'mini';
  /** Engine suffix for mini rows (default 'mini'). A NEW tag (e.g. 'mini2') re-audits the same
   *  notes as a fresh run — the uid+engine PK treats it as a distinct generation. */
  engineTag?: string;
  /** With pipeline:'mini', write the row under the PLAIN prod engine version (OPD_ENGINE_VERSION,
   *  no '-<tag>' suffix) so it is VISIBLE on prod dashboards — the free mini model correcting the
   *  prod scores. (V decision, 2 Jul: re-audit history on the free mini, treat 0.6 as 0.6.) */
  prodTag?: boolean;
  /** Active Tier-1 suppressions to apply (defaults to the cached active set). Pass [] to disable. */
  suppressions?: Suppression[];
}

/** Engine tag for mini-pipeline rows (default run). */
export const OPD_MINI_ENGINE_VERSION = `${OPD_ENGINE_VERSION}-mini`;
/** Engine string for an arbitrary mini run tag. */
export function opdMiniEngine(tag?: string): string {
  const t = (tag || 'mini').replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'mini';
  return `${OPD_ENGINE_VERSION}-${t}`;
}

export async function auditOpdNote(row: Record<string, unknown>, opts: AuditOpdOpts = {}): Promise<OpdNoteAudit> {
  const mini = opts.pipeline === 'mini';
  // prodTag: a mini run that writes the PLAIN prod engine version (visible on dashboards) — the free
  // model correcting prod scores. Otherwise mini stays isolated under '-<tag>'.
  const engineVersion = mini ? (opts.prodTag ? OPD_ENGINE_VERSION : opdMiniEngine(opts.engineTag)) : OPD_ENGINE_VERSION;
  const { case: oc, keys } = rowToOpdCase(row);
  enrichOpdMeds(oc.medications);   // brand→generic + class/schedule/high-alert/LASA/VED from the formulary

  const det = [...prescribingChecks(oc), ...doseFindings(oc.medications), ...ddiFindings(oc.medications)];
  const completeness = opdCompleteness(oc);

  // Tier-1 self-heal: apply human-approved active suppressions to the final (identity-stamped)
  // findings — drop, or downgrade to informational (out of the triage queue + score). No-op when
  // none are active. Applied AFTER stampFindingIdentity so it matches on signal_type + subject.
  const supps = opts.suppressions ?? await getActiveSuppressions();
  const noMeds = oc.medications.length === 0;
  const finalize = (fs: OpdFinding[]): OpdFinding[] => {
    let out = stampFindingIdentity(fs);
    // B1 — nothing was prescribed this encounter → there is no prescription to fault. Deterministic
    // prescribing checks can't fire with 0 meds, so any prescribing_safety finding here is an LLM
    // ghost (typically read out of the patient's history). Drop it. (Interaction/duplication with a
    // history drug is only valid when a CURRENT med exists — which requires meds.length > 0.)
    if (noMeds) out = out.filter((f) => f.domain !== 'prescribing_safety');
    return applySuppressions(out, keys.doctorUid, supps).findings;
  };

  // Deterministic REUSE path (backfill): recompute the deterministic findings + completeness, KEEP
  // the stored LLM findings + PDQI-9, re-score. No retrieval, no LLM, no trace — so a completeness/
  // prescribing rule change refreshes stored rows at ~zero cost.
  if (opts.reuse) {
    // stampFindingIdentity: signal_type + finding_ref on every finding (governance spec v2.0 §2);
    // deterministic, so re-stamping stored LLM findings reproduces their refs.
    const findings: OpdFinding[] = finalize([...det, ...opts.reuse.llmFindings]);
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

    const specialty = await doctorSpecialtyFor(keys.doctorUid);
    const raw = await defaultGenerate(traceId, OPD_AUDIT_SYSTEM, buildOpdAuditUser(opdCaseText(oc, { specialty }), citedContext), mini);
    const parsed = parseOpdAnalysis(raw, sources.length);

    const findings: OpdFinding[] = finalize([...det, ...(parsed?.findings ?? [])]);
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
    return { keys, scorecard, completeness, findings: finalize(det), suggestions: [], sources: [], engineVersion: engineVersion, traceId };
  }
}
