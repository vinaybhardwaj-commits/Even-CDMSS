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
import { geminiUtilityModel, geminiModelFor, TEXT_MODEL, AUDIT_LLM_SEED, modelsAgree } from './llm';
import { logEvent, finishTrace, governedChat, withTrace } from './trace';
import * as core from './lvc-core';
import { labPackageContext } from './scoring-policy/lab-packages';
import type { Candidate, JudgedRec, LvcFlag, LvcRecommendation, Region, Surface } from './lvc-core';

export interface MatchInput {
  scenario: string;
  /** If given, used directly as the candidate orders (skips the Flash extraction pass). */
  proposedActions?: string[];
  patient?: { age?: number; sex?: string };
  /** Slice 2 (Right Care × ClinicalState): the pre-composed PATIENT PICTURE block, threaded
   *  into the applicability judge's prompt. OPTIONAL — omitted (the default, and always when
   *  RIGHT_CARE_CLINICAL_STATE_GROUND is off) → every prompt is byte-identical to Slice 1. */
  clinicalStateText?: string;
  /** 'surface' = opt-in /appropriateness (default); 'autoflag' = unsolicited DDx/Ask advisory. */
  surface?: Surface;
  preferRegion?: Region;
  /** Restrict recall to these regions (e.g. ['IN','CA','US']). Omit = all. */
  regionFilter?: Region[];
  trace?: boolean; // default true
  /** Lab probe: force the FREE local mini (no Gemini) for ₹0 pipeline testing. Default false. */
  forceOllama?: boolean;
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
    ctx: { scenario: string; patient?: { age?: number; sex?: string }; clinicalStateText?: string; orderedActions?: string[] },
    recs: LvcRecommendation[],
    surface: Surface,
  ) => Promise<JudgedRec[]>;
}

/** Fix-3 flag (RIGHT_CARE_JUDGE_SEES_ACTION): surface the ordered action to the appropriateness
 *  judge so it can honour precondition carve-outs (the dormant NAMED EXCLUSIONS rule). Mirrors the
 *  RIGHT_CARE_CLINICAL_STATE_GROUND opt-in shape. Unset / '' / '0' → OFF (byte-identical to today);
 *  any other value → ON. Ships default-OFF; the flip is gated on a credentialed bench, not the merge. */
function judgeSeesActionEnabled(): boolean {
  const v = process.env.RIGHT_CARE_JUDGE_SEES_ACTION;
  return !!v && v !== '0';
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
// promptRef (Stage 1): the Stage-0 registry id of the system prompt this call runs —
// an additive tag stamped onto the trace envelope; never alters the prompt itself.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function llmCall(traceId: string | undefined, label: string, params: any, geminiModel?: string, promptRef?: string): Promise<any> {
  return governedChat(traceId, label, params, { gemini: geminiModel, promptRef });
}

/**
 * STAGE 1 — CANDIDATE EXTRACTION (label `lvc_extract`, prompt `lvc-core/CANDIDATE_SYSTEM`).
 *
 * ⚠️ THIS IS THE "second temperature-0.1 call near lib/lvc.ts:115" the pinning PRD (§2.4) asked the
 * builder to identify. It is NOT the judge, and it is DELIBERATELY LEFT UNPINNED — flagged for V,
 * not decided here. The reasoning, so the next reader does not have to redo it:
 *
 *   · It answers a different question. This pass turns free text into the CANDIDATE ORDER LIST;
 *     the judge decides applicability. Its variance moves which recommendations are RECALLED, not
 *     which verdict a recalled rec receives.
 *   · The A/A measurement that ordered the pin never observed it. The harness sets
 *     `proposedActions`, which SKIPS this call entirely (see matchLowValueCare below), so none of
 *     the 9 discordant cases in the 9 Aug report can be attributed to it, and pinning it would
 *     change nothing the pre-registered r2 re-measurement can see.
 *   · Pinning it is not free. Changing recall changes which recs reach the judge, i.e. LVC flag
 *     composition, on a lever the PRD's stated consequences (§3 wording, §6 hazards) do not cover.
 *     §2.4's own instruction is "do not pin unrelated calls silently".
 *   · It runs on Flash utility routing and, unlike the judge, KEEPS its Ollama soft-fall: D-2
 *     forbids a non-Gemini VERDICT, and this pass returns no verdict. Its failure mode is already
 *     fail-safe — a caught error returns [], which ends the pipeline with zero flags.
 *
 * If V wants extraction pinned too, it is the same three lines as the judge and its own decision.
 */
async function defaultExtract(scenario: string, traceId?: string, forceOllama = false): Promise<Candidate[]> {
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
    }, forceOllama ? undefined : geminiUtilityModel(), 'lvc-core/CANDIDATE_SYSTEM');
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

/** The trace event that makes the refusal rate observable (PRD §2.3). One per refused batch. */
export const LVC_JUDGE_REFUSED_EVENT = 'lvc_judge_gemini_refused';

/** Injection seam for unit tests — the judge's ONE provider call. Defaults to the real llmCall. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JudgeCall = (params: any) => Promise<any>;
export interface JudgeDeps { call?: JudgeCall }

/**
 * The applicability judge. LVC JUDGE PINNING PRD v1.0 §2 (D-1, D-2), 10 Aug 2026.
 *
 * ── D-1, THE PIN ────────────────────────────────────────────────────────────────────────────────
 * temperature 0 (was 0.1) + seed AUDIT_LLM_SEED + top_p 1 — the A-8 treatment, exactly, and the
 * same three levers the production OPD scorer runs on. Nothing else in the params moves and the
 * prompt does not move: JUDGE_SYSTEM and buildJudgeUser are untouched, and so is model resolution.
 * The judge serves on the Vertex Gemini path, which IGNORES the seed, so the expected gain is
 * partial — which is why §4/D-4 pre-registers the r2 re-measurement rather than declaring victory.
 * Baseline to beat: 38/47 cases identical (80.9%) against a 95% bar
 * (CDMSS-LVC-JUDGE-AA-REPORT-9-AUG-2026).
 *
 * ── D-2, GEMINI IN THE CLOUD IS THE ONLY GRADER ─────────────────────────────────────────────────
 * V's standing ruling of 10 Aug: the judge path has NO fallback. Something answering as
 * `qwen2.5:14b` through the still-live Ollama bridge served 42 lab calls in 14 days, four of them
 * judge A/A cases and three of those discordant — a fallback that ANSWERS is a defect here, not a
 * feature, because a verdict is what decides whether a clinician sees a flag at all.
 *
 * So, copying lib/even-lvc.ts:176: the SERVED model is checked against the INTENDED Gemini slug
 * with `modelsAgree` (which tolerates the `google/` publisher prefix, so the OpenRouter bridge
 * still passes). A throw, an empty served model, or a disagreement is a FAILURE → one retry
 * against Gemini → on a second failure the whole batch returns the parse default, every rec
 * `insufficient_info`, so no flag can fire and nothing false is asserted. `parseJudgeResponse('')`
 * IS that default — reused rather than re-implemented, so the refuse path can never drift from
 * the doctrine it is meant to apply.
 *
 * NO INTENDED SLUG ⇒ IMMEDIATE REFUSAL, WITHOUT A CALL. If Vertex is unconfigured, or the lab
 * probe's `forceOllama` asked for the free mini, there is no Gemini to retry against and the only
 * model that could answer is the one D-2 forbids. Refusing before the call is the same ruling
 * applied one step earlier. FLAGGED CONSEQUENCE: `providerOverride: 'ollama'` on
 * /api/appropriateness now returns zero flags — its candidate-extraction leg still runs free and
 * local, but its judge stage is dead by ruling.
 */
export async function defaultJudge(
  ctx: { scenario: string; patient?: { age?: number; sex?: string }; clinicalStateText?: string; orderedActions?: string[] },
  recs: LvcRecommendation[],
  surface: Surface,
  traceId?: string,
  forceOllama = false,
  deps: JudgeDeps = {},
): Promise<JudgedRec[]> {
  // Phase C §7.2 — factual lab-package composition, so a panel and one of its own analytes are not
  // read as two duplicate orders. FAIL-OPEN and byte-identical when absent: an empty/malformed set
  // renders no prompt block at all (buildLabPackageBlock returns ''), so the judge sees exactly
  // today's context. Never let a context read cost a judgement.
  const labPackages = await labPackageContext().catch(() => []);
  // Opt-in surface → Pro reasoning (geminiModelFor honours GEMINI_ALL); unsolicited
  // autoflag → cheap Flash. UNCHANGED resolution (PRD §2.1) — what changed is that an
  // unresolved slug now refuses instead of soft-falling to the local mini.
  const geminiModel = forceOllama ? undefined : (surface === 'autoflag'
    ? geminiUtilityModel()
    : (geminiModelFor('appropriateness') ?? geminiUtilityModel()));
  const fallbackModel = surface === 'autoflag' ? 'llama3.1:8b' : TEXT_MODEL;

  /** D-2: the whole batch to insufficient_info, plus ONE observable event carrying what served. */
  const refuse = async (served: string, reason: string): Promise<JudgedRec[]> => {
    console.warn(`[lvc] judge REFUSED (${reason}): served '${served || 'none'}' != intended '${geminiModel ?? 'none'}' — every rec insufficient_info, no flag fires`);
    if (traceId) {
      await logEvent(traceId, LVC_JUDGE_REFUSED_EVENT, 'lvc_judge', {
        reason,
        served_model: served || null,
        intended_model: geminiModel ?? null,
        surface,
        n_recs: recs.length,
        rec_ids: recs.map((r) => r.id),
      }).catch(() => { /* observability must never cost a verdict */ });
    }
    // The existing "any rec not returned → insufficient_info" doctrine, applied to the whole batch.
    return core.parseJudgeResponse('', recs);
  };

  if (!geminiModel) return refuse('', forceOllama ? 'force_ollama_requested' : 'no_gemini_model_resolved');

  const params = {
    model: fallbackModel,
    messages: [
      { role: 'system', content: core.JUDGE_SYSTEM },
      { role: 'user', content: core.buildJudgeUser(ctx, recs, ctx.clinicalStateText, ctx.orderedActions, labPackages) },
    ],
    // D-1 — the pin. seed/top_p ride governedChat → tracedChat's `...rest` to the Vertex
    // OpenAI-compat client (and to OpenRouter through the bridge); the guard above guarantees this
    // body is only ever sent to a cloud Gemini, so no Ollama-only path sees them.
    temperature: 0,
    seed: AUDIT_LLM_SEED,
    top_p: 1,
    max_tokens: 900,
    ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
  };
  const call: JudgeCall = deps.call ?? ((p) => llmCall(traceId, 'lvc_judge', p, geminiModel, 'lvc-core/JUDGE_SYSTEM'));

  // ONE retry, then refuse (D-2). Attempt 2 is identical to attempt 1 — same slug, same body.
  let served = '';
  let lastReason = 'unknown';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await call(params);
      served = String(r?.model ?? '');
      if (modelsAgree(served, geminiModel)) {
        return core.parseJudgeResponse(r.choices?.[0]?.message?.content || '', recs);
      }
      lastReason = served ? 'served_model_disagrees' : 'served_model_empty';
      console.warn(`[lvc] judge attempt ${attempt}/2 served '${served || 'none'}' != intended '${geminiModel}'`);
    } catch (e) {
      served = '';
      lastReason = 'call_failed';
      console.warn(`[lvc] judge attempt ${attempt}/2 failed`, (e as Error).message);
    }
  }
  return refuse(served, lastReason);
}

/**
 * Match a clinical scenario (and optional proposed orders) against the
 * Choosing Wisely / low-value-care corpus, returning applicable flags.
 */
export async function matchLowValueCare(input: MatchInput, deps: Partial<MatchDeps> = {}): Promise<MatchResult> {
  const surface: Surface = input.surface ?? 'surface';
  const doTrace = input.trace !== false;

  // Stage 1 (guaranteed finalize): the pipeline runs under withTrace, whose status-guarded
  // finally closes any trace left 'running' — the explicit finishTrace calls below keep
  // setting the real statuses first, so behaviour is unchanged on every existing path.
  const run = async (traceId?: string): Promise<MatchResult> => {

  const fo = input.forceOllama === true;
  const extract = deps.extractCandidates ?? ((s: string) => defaultExtract(s, traceId, fo));
  const recall = deps.recall ?? defaultRecall;
  const judge = deps.judge ?? ((ctx, recs, surf) => defaultJudge(ctx, recs, surf, traceId, fo));

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

    // Fix-3 (gated): when RIGHT_CARE_JUDGE_SEES_ACTION is on, surface the ordered actions — the
    // SAME `candidates` already used to select recs, never a re-extraction — to the judge so it can
    // honour precondition carve-outs. Flag off OR no candidates → pass the exact Slice-1 ctx (three
    // keys), so the judge(...) call and its user message are byte-identical to today. Fail-safe: a
    // problem here degrades to the no-action path, never a wrong verdict.
    const judgeCtx: { scenario: string; patient?: { age?: number; sex?: string }; clinicalStateText?: string; orderedActions?: string[] } =
      { scenario: input.scenario, patient: input.patient, clinicalStateText: input.clinicalStateText };
    if (judgeSeesActionEnabled() && candidates.length) judgeCtx.orderedActions = candidates.map((c) => c.name);
    const judged = await judge(judgeCtx, recs, surface);
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

  };

  if (!doTrace) return run(undefined);
  return withTrace('appropriateness', {
    scenario: input.scenario.slice(0, 500), surface, patient: input.patient, regionFilter: input.regionFilter,
  }, run);
}

export type { LvcFlag, Candidate } from './lvc-core';
