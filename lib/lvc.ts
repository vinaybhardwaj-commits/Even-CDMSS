/**
 * lib/lvc.ts — Appropriateness / Low-Value-Care matcher (CW.2), wired.
 *
 * Orchestrates the pure core (lib/lvc-core.ts) over the real backend:
 *   1) candidate extraction (Gemini Flash utility; skipped if proposedActions given)
 *   2) dual recall — deterministic keyword match over active lvc_recommendations
 *      + semantic retrieve() over the source='choosing-wisely' corpus subset
 *   3) applicability judge (Gemini Pro for the opt-in surface; Flash for autoflag)
 *   4) two-tier confidence-floor gate + flag assembly (core.assembleFlags)
 *
 * Every step is traced (startTrace 'appropriateness' + logEvent). The autoflag
 * path soft-fails to empty so it can never break the parent DDx/Ask answer.
 * See CDMSS-CHOOSING-WISELY-LOW-VALUE-CARE-PRD-v1.1.md §6.
 */

import { sql } from './db';
import { retrieve } from './retrieve';
import { chatWithFallback, geminiUtilityModel, geminiModelFor, TEXT_MODEL } from './llm';
import { startTrace, logEvent, finishTrace, tracedChat } from './trace';
import * as core from './lvc-core';
import type { Candidate, JudgedRec, LvcFlag, LvcRecommendation, Region, Surface } from './lvc-core';

export interface MatchInput {
  scenario: string;
  /** If given, used directly as the candidate orders (skips the Flash extraction pass). */
  proposedActions?: string[];
  patient?: { age?: number; sex?: string };
  /** 'surface' = opt-in /appropriateness (default); 'autoflag' = unsolicited DDx/Ask advisory. */
  surface?: Surface;
  preferRegion?: Region;
  /** Restrict recall to these regions (e.g. ['IN','CA','US']). Omit = all. */
  regionFilter?: Region[];
  trace?: boolean; // default true
}

export interface MatchResult {
  flags: LvcFlag[];
  candidates: Candidate[];
  considered: number;
  surface: Surface;
  traceId?: string;
  empty: boolean;
}

/** Injection seam for unit tests — override any stage; defaults hit the real backend. */
export interface MatchDeps {
  extractCandidates: (scenario: string) => Promise<Candidate[]>;
  recall: (input: MatchInput, candidates: Candidate[]) => Promise<LvcRecommendation[]>;
  judge: (
    ctx: { scenario: string; patient?: { age?: number; sex?: string } },
    recs: LvcRecommendation[],
    surface: Surface,
  ) => Promise<JudgedRec[]>;
}

const sql2 = sql as unknown as (q: string, p: unknown[]) => Promise<Record<string, unknown>[]>;

const REC_COLS =
  'id, region, society, specialty, statement, precondition, action_type, consider_instead, ' +
  'rationale, keywords, citation_doi, citation_pmid, citation_url, source_release_year, status';

function rowToRec(r: Record<string, unknown>): LvcRecommendation {
  const kw = r.keywords;
  return {
    id: String(r.id),
    region: String(r.region) as Region,
    society: String(r.society ?? ''),
    specialty: r.specialty == null ? null : String(r.specialty),
    statement: String(r.statement ?? ''),
    precondition: r.precondition == null ? null : String(r.precondition),
    action_type: r.action_type == null ? null : String(r.action_type),
    consider_instead: r.consider_instead == null ? null : String(r.consider_instead),
    rationale: r.rationale == null ? null : String(r.rationale),
    keywords: Array.isArray(kw) ? (kw as unknown[]).map(String) : [],
    citation_doi: r.citation_doi == null ? null : String(r.citation_doi),
    citation_pmid: r.citation_pmid == null ? null : String(r.citation_pmid),
    citation_url: r.citation_url == null ? null : String(r.citation_url),
    source_release_year: r.source_release_year == null ? null : Number(r.source_release_year),
    status: r.status == null ? undefined : String(r.status),
  };
}

// One LLM helper: trace it when we have a traceId, else fall back to the plain wrapper.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function llmCall(traceId: string | undefined, label: string, params: any, geminiModel?: string): Promise<any> {
  if (traceId) return tracedChat(traceId, label, params, { gemini: geminiModel });
  return chatWithFallback(params, geminiModel);
}

async function defaultExtract(scenario: string, traceId?: string): Promise<Candidate[]> {
  try {
    const r = await llmCall(traceId, 'lvc_extract', {
      model: 'llama3.1:8b',
      messages: [
        { role: 'system', content: core.CANDIDATE_SYSTEM },
        { role: 'user', content: core.buildCandidateUser(scenario) },
      ],
      temperature: 0.1,
      max_tokens: 400,
      ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
    }, geminiUtilityModel());
    return core.parseCandidates(r.choices?.[0]?.message?.content || '');
  } catch (e) {
    console.warn('[lvc] candidate extraction failed', (e as Error).message);
    return [];
  }
}

async function defaultRecall(input: MatchInput, candidates: Candidate[]): Promise<LvcRecommendation[]> {
  // The lvc_recommendations table is small (≤ ~900 rows), so load active recs and
  // keyword-match in memory — robust, no fragile SQL array matching.
  const rf = input.regionFilter && input.regionFilter.length ? input.regionFilter : null;
  const rows = rf
    ? await sql2(`SELECT ${REC_COLS} FROM lvc_recommendations WHERE status = 'active' AND region = ANY($1)`, [rf])
    : await sql2(`SELECT ${REC_COLS} FROM lvc_recommendations WHERE status = 'active'`, []);
  const recs = rows.map(rowToRec);
  const kw = core.keywordRecall(input.scenario, candidates, recs);

  // Semantic leg: retrieve over the CW corpus subset, map chunk item_number → rec id.
  let sem: LvcRecommendation[] = [];
  try {
    const q = [input.scenario, ...candidates.map((c) => c.name)].join('. ');
    const r = await retrieve(q, { source: 'choosing-wisely', topK: 12, useSourceWeights: true, hybrid: true });
    const itemNos = new Set(r.hits.map((h) => h.item_number).filter((x): x is string => !!x));
    sem = recs.filter((x) => itemNos.has(x.id));
  } catch (e) {
    console.warn('[lvc] semantic recall failed', (e as Error).message);
  }
  return core.dedupeById(kw, sem);
}

async function defaultJudge(
  ctx: { scenario: string; patient?: { age?: number; sex?: string } },
  recs: LvcRecommendation[],
  surface: Surface,
  traceId?: string,
): Promise<JudgedRec[]> {
  // Opt-in surface → Pro reasoning (geminiModelFor honours GEMINI_ALL); unsolicited
  // autoflag → cheap Flash. Both soft-fall to local Ollama if Vertex is unavailable.
  const geminiModel = surface === 'autoflag'
    ? geminiUtilityModel()
    : (geminiModelFor('appropriateness') ?? geminiUtilityModel());
  const fallbackModel = surface === 'autoflag' ? 'llama3.1:8b' : TEXT_MODEL;
  try {
    const r = await llmCall(traceId, 'lvc_judge', {
      model: fallbackModel,
      messages: [
        { role: 'system', content: core.JUDGE_SYSTEM },
        { role: 'user', content: core.buildJudgeUser(ctx, recs) },
      ],
      temperature: 0.1,
      max_tokens: 900,
      ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
    }, geminiModel);
    return core.parseJudgeResponse(r.choices?.[0]?.message?.content || '', recs);
  } catch (e) {
    console.warn('[lvc] judge failed', (e as Error).message);
    // soft-fail: nothing fires
    return recs.map((rec) => ({ rec, verdict: 'insufficient_info' as const, confidence: 0, why: '', consider_instead: null }));
  }
}

/**
 * Match a clinical scenario (and optional proposed orders) against the
 * Choosing Wisely / low-value-care corpus, returning applicable flags.
 */
export async function matchLowValueCare(input: MatchInput, deps: Partial<MatchDeps> = {}): Promise<MatchResult> {
  const surface: Surface = input.surface ?? 'surface';
  const doTrace = input.trace !== false;
  const traceId = doTrace
    ? await startTrace('appropriateness', {
        scenario: input.scenario.slice(0, 500), surface, patient: input.patient, regionFilter: input.regionFilter,
      })
    : undefined;

  const extract = deps.extractCandidates ?? ((s: string) => defaultExtract(s, traceId));
  const recall = deps.recall ?? defaultRecall;
  const judge = deps.judge ?? ((ctx, recs, surf) => defaultJudge(ctx, recs, surf, traceId));

  try {
    const candidates = input.proposedActions?.length
      ? input.proposedActions.map((a) => ({ name: a }))
      : await extract(input.scenario);
    if (traceId) await logEvent(traceId, 'lvc_candidates', null, { candidates });

    if (candidates.length === 0) {
      if (traceId) await finishTrace(traceId, 'success');
      return { flags: [], candidates: [], considered: 0, surface, traceId, empty: true };
    }

    const recs = await recall(input, candidates);
    if (traceId) await logEvent(traceId, 'lvc_recall', null, { count: recs.length, ids: recs.map((r) => r.id) });

    if (recs.length === 0) {
      if (traceId) await finishTrace(traceId, 'success');
      return { flags: [], candidates, considered: 0, surface, traceId, empty: true };
    }

    const judged = await judge({ scenario: input.scenario, patient: input.patient }, recs, surface);
    if (traceId) {
      await logEvent(traceId, 'lvc_judge_verdicts', null, {
        verdicts: judged.map((j) => ({ id: j.rec.id, verdict: j.verdict, confidence: j.confidence })),
      });
    }

    const flags = core.assembleFlags(judged, surface, { preferRegion: input.preferRegion });
    if (traceId) {
      await logEvent(traceId, 'lvc_flags', null, { count: flags.length, ids: flags.map((f) => f.id) });
      await finishTrace(traceId, 'success');
    }
    return { flags, candidates, considered: recs.length, surface, traceId, empty: flags.length === 0 };
  } catch (e) {
    if (traceId) await finishTrace(traceId, 'error', String((e as Error).message));
    // The autoflag path must never break the parent DDx/Ask answer.
    if (surface === 'autoflag') {
      return { flags: [], candidates: [], considered: 0, surface, traceId, empty: true };
    }
    throw e;
  }
}

export type { LvcFlag, Candidate } from './lvc-core';
