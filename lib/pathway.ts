/**
 * lib/pathway.ts — Pathway & Decision passes (PW.2), wired.
 *
 * Two-stage, per V's latency choice:
 *   traceSkeleton()  — Gemini-FLASH, fast: classify the input's stage + return the
 *                      ordered care-path spine (first paint in seconds).
 *   enrichPathway()  — Gemini-PRO: retrieve() guideline excerpts over the GENERAL
 *                      corpus, enrich each node (detail / decision-criteria / grounded
 *                      evidence vs labeled estimates / alternatives), then inject the
 *                      real EHRC tariff DETERMINISTICALLY for any orderable node.
 *
 * Both traced ('pathway' / 'pathway_enrich') and both soft-fail (skeleton → null,
 * enrich → null) so a slow/unavailable Vertex never breaks the /appropriateness
 * surface. No CW-seed dependency — works now. See CDMSS-PATHWAY-DECISION-PRD-v1.0.md.
 */

import { retrieve } from './retrieve';
import { chatWithFallback, geminiModelFor, geminiUtilityModel, TEXT_MODEL } from './llm';
import { startTrace, logEvent, finishTrace, tracedChat } from './trace';
import { matchAnyTariffs } from './charge-master';
import * as core from './pathway-core';
import type { PathwaySkeleton, PathwayEnrichment, SkeletonStage } from './pathway-core';

export interface PathwayInput {
  scenario: string;
  proposedActions?: string[];
  patient?: { age?: number; sex?: string };
  trace?: boolean;
}
export interface EnrichInput extends PathwayInput {
  stages: SkeletonStage[];
  workingDiagnosis?: string | null;
}

export interface SkeletonResult { skeleton: PathwaySkeleton | null; traceId?: string }
export interface EnrichResult { enrichment: PathwayEnrichment | null; excerptCount: number; traceId?: string }

/** Injection seams for tests (defaults hit the real backend). */
export interface SkeletonDeps { generate: (system: string, user: string, traceId?: string) => Promise<string> }
export interface EnrichDeps {
  retrieveExcerpts: (q: string) => Promise<string[]>;
  generate: (system: string, user: string, traceId?: string) => Promise<string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function llmCall(traceId: string | undefined, label: string, params: any, geminiModel?: string): Promise<any> {
  if (traceId) return tracedChat(traceId, label, params, { gemini: geminiModel });
  return chatWithFallback(params, geminiModel);
}

// ─────────────────────────────────────────────────────────────────────────────
// SKELETON (Flash)
// ─────────────────────────────────────────────────────────────────────────────

async function defaultSkeletonGenerate(system: string, user: string, traceId?: string): Promise<string> {
  // Flash utility model (honours GEMINI_ALL / GEMINI_UTILITY); soft-falls to local Ollama.
  const geminiModel = geminiUtilityModel();
  const r = await llmCall(traceId, 'pathway_skeleton', {
    model: 'llama3.1:8b',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    max_tokens: 800,
    ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
  }, geminiModel);
  return r.choices?.[0]?.message?.content || '';
}

export async function traceSkeleton(input: PathwayInput, deps: Partial<SkeletonDeps> = {}): Promise<SkeletonResult> {
  const doTrace = input.trace !== false;
  const traceId = doTrace
    ? await startTrace('pathway', { scenario: input.scenario.slice(0, 500), proposedActions: input.proposedActions, patient: input.patient })
    : undefined;
  const generate = deps.generate ?? ((s: string, u: string) => defaultSkeletonGenerate(s, u, traceId));
  try {
    const user = core.buildSkeletonUser(input);
    const raw = await generate(core.SKELETON_SYSTEM, user, traceId);
    const skeleton = core.parseSkeleton(raw);
    if (traceId) {
      await logEvent(traceId, 'pathway_skeleton_result', null, {
        ok: !!skeleton,
        detectedStage: skeleton?.detectedStage,
        needsDdx: skeleton?.needsDdx,
        stages: skeleton?.stages.map((s) => ({ id: s.id, kind: s.kind, flag: s.flag })) ?? [],
      });
      await finishTrace(traceId, skeleton ? 'success' : 'partial');
    }
    return { skeleton, traceId };
  } catch (e) {
    if (traceId) await finishTrace(traceId, 'error', String((e as Error).message));
    console.warn('[pathway] traceSkeleton failed', (e as Error).message);
    return { skeleton: null, traceId };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENRICH (Pro)
// ─────────────────────────────────────────────────────────────────────────────

async function defaultRetrieveExcerpts(q: string): Promise<string[]> {
  try {
    const r = await retrieve(q, { topK: 8, useSourceWeights: true, hybrid: true });
    return r.hits.map((h) => {
      const src = h.book || h.source || 'source';
      const body = (h.text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      return `(${src}) ${body}`;
    }).filter((s) => s.length > 20);
  } catch (e) {
    console.warn('[pathway] retrieve failed', (e as Error).message);
    return [];
  }
}

async function defaultEnrichGenerate(system: string, user: string, traceId?: string): Promise<string> {
  // Pro reasoning for enrichment (honours GEMINI_ALL); soft-falls to local Ollama.
  const geminiModel = geminiModelFor('pathway') ?? geminiUtilityModel();
  const r = await llmCall(traceId, 'pathway_enrich', {
    model: TEXT_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    max_tokens: 2500,
    ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
  }, geminiModel);
  return r.choices?.[0]?.message?.content || '';
}

export async function enrichPathway(input: EnrichInput, deps: Partial<EnrichDeps> = {}): Promise<EnrichResult> {
  const stages = (input.stages ?? []).slice(0, 8);
  if (stages.length === 0) return { enrichment: null, excerptCount: 0 };

  const doTrace = input.trace !== false;
  const traceId = doTrace
    ? await startTrace('pathway_enrich', {
        scenario: input.scenario.slice(0, 500), workingDiagnosis: input.workingDiagnosis,
        stageIds: stages.map((s) => s.id), patient: input.patient,
      })
    : undefined;

  const retrieveExcerpts = deps.retrieveExcerpts ?? defaultRetrieveExcerpts;
  const generate = deps.generate ?? ((s: string, u: string) => defaultEnrichGenerate(s, u, traceId));

  try {
    const query = [
      input.scenario,
      input.workingDiagnosis ?? '',
      ...stages.map((s) => `${s.title} ${s.action}`),
      'management workup treatment indications evidence guideline',
    ].filter(Boolean).join('. ');
    const excerpts = await retrieveExcerpts(query);
    if (traceId) await logEvent(traceId, 'pathway_excerpts', null, { count: excerpts.length });

    const user = core.buildEnrichUser(
      { scenario: input.scenario, proposedActions: input.proposedActions, patient: input.patient, workingDiagnosis: input.workingDiagnosis },
      stages,
      excerpts,
    );
    const raw = await generate(core.ENRICH_SYSTEM, user, traceId);
    const enrichment = core.parseEnrichment(raw, stages.map((s) => s.id));

    // Deterministic EHRC tariff grounding: for each node naming a concrete order,
    // attach the real local price (never let the LLM produce the cost figure).
    if (enrichment) {
      for (const n of enrichment.nodes) {
        if (n.order) {
          const t = matchAnyTariffs([n.order]);
          if (t.length) n.tariffs = t;
        }
      }
      if (traceId) {
        await logEvent(traceId, 'pathway_tariffs', null, {
          matched: enrichment.nodes.filter((n) => n.tariffs?.length).map((n) => ({ id: n.id, order: n.order, codes: n.tariffs!.map((t) => t.code) })),
        });
      }
    }

    if (traceId) {
      await logEvent(traceId, 'pathway_enrich_result', null, {
        ok: !!enrichment,
        nodes: enrichment?.nodes.map((n) => ({ id: n.id, flag: n.flag, hasOrder: !!n.order, tariffs: n.tariffs?.length ?? 0 })) ?? [],
      });
      await finishTrace(traceId, enrichment ? 'success' : 'partial');
    }
    return { enrichment, excerptCount: excerpts.length, traceId };
  } catch (e) {
    if (traceId) await finishTrace(traceId, 'error', String((e as Error).message));
    console.warn('[pathway] enrichPathway failed', (e as Error).message);
    return { enrichment: null, excerptCount: 0, traceId };
  }
}

export type { PathwaySkeleton, PathwayEnrichment, SkeletonStage, EnrichedNode, MergedStage } from './pathway-core';
