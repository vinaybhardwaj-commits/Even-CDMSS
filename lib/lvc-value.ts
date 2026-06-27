/**
 * lib/lvc-value.ts — Value Analysis pass (CW-VA), wired.
 *
 * Reasons about the value of a proposed intervention for THIS patient, grounded by
 * retrieve() over the GENERAL corpus (NOT the choosing-wisely subset) — so it works
 * independently of the CW seed and covers interventions that are on no curated list.
 * Gemini-Pro reasoning; traced ('appropriateness_value'); soft-fails to null so it can
 * never break the parent /appropriateness response.
 * See CDMSS-CHOOSING-WISELY-LOW-VALUE-CARE-PRD-v1.2.md §14.
 */

import { retrieve } from './retrieve';
import { chatWithFallback, geminiModelFor, geminiUtilityModel, TEXT_MODEL } from './llm';
import { startTrace, logEvent, finishTrace, tracedChat } from './trace';
import * as vcore from './lvc-value-core';
import type { ValueAnalysis } from './lvc-value-core';
import { matchTariffs, formatTariffForPrompt } from './charge-master';

export interface ValueInput {
  scenario: string;
  proposedActions?: string[];
  patient?: { age?: number; sex?: string };
  trace?: boolean;
}

export interface ValueResult {
  valueAnalysis: ValueAnalysis | null;
  excerptCount: number;
  traceId?: string;
}

/** Injection seam for tests. */
export interface ValueDeps {
  retrieveExcerpts: (q: string) => Promise<string[]>;
  generate: (system: string, user: string, traceId?: string) => Promise<string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function llmCall(traceId: string | undefined, label: string, params: any, geminiModel?: string): Promise<any> {
  if (traceId) return tracedChat(traceId, label, params, { gemini: geminiModel });
  return chatWithFallback(params, geminiModel);
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
    console.warn('[lvc-value] retrieve failed', (e as Error).message);
    return [];
  }
}

async function defaultGenerate(system: string, user: string, traceId?: string): Promise<string> {
  // Pro reasoning for the value pass (honours GEMINI_ALL); soft-falls to local Ollama.
  const geminiModel = geminiModelFor('appropriateness') ?? geminiUtilityModel();
  const r = await llmCall(traceId, 'lvc_value', {
    model: TEXT_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    max_tokens: 1500,
    ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
  }, geminiModel);
  return r.choices?.[0]?.message?.content || '';
}

export async function analyzeValue(input: ValueInput, deps: Partial<ValueDeps> = {}): Promise<ValueResult> {
  const doTrace = input.trace !== false;
  const traceId = doTrace
    ? await startTrace('appropriateness_value', {
        scenario: input.scenario.slice(0, 500), proposedActions: input.proposedActions, patient: input.patient,
      })
    : undefined;

  const retrieveExcerpts = deps.retrieveExcerpts ?? defaultRetrieveExcerpts;
  const generate = deps.generate ?? ((s: string, u: string) => defaultGenerate(s, u, traceId));

  try {
    const query = [input.scenario, ...(input.proposedActions ?? []), 'benefits harms outcomes complications cost long-term care alternatives']
      .filter(Boolean).join('. ');
    const excerpts = await retrieveExcerpts(query);
    if (traceId) await logEvent(traceId, 'lvc_value_excerpts', null, { count: excerpts.length });

    // Ground the upfront cost in the EHRC charge master (real local price, not an estimate).
    const tariffs = input.proposedActions?.length ? matchTariffs(input.proposedActions) : [];
    if (traceId) await logEvent(traceId, 'lvc_value_tariffs', null, { matched: tariffs.map((t) => ({ code: t.code, item: t.item, general: t.general })) });

    let user = vcore.buildValueUser(input, excerpts);
    if (tariffs.length) {
      user += `\n\nEHRC TARIFF (authoritative local upfront cost — use this, do NOT estimate the upfront cost):\n${tariffs.map(formatTariffForPrompt).join('\n')}`;
    }

    const raw = await generate(vcore.VALUE_SYSTEM, user, traceId);
    const valueAnalysis = vcore.parseValueResponse(raw);
    if (valueAnalysis && tariffs.length) valueAnalysis.tariffs = tariffs;

    if (traceId) {
      await logEvent(traceId, 'lvc_value_result', null, {
        ok: !!valueAnalysis,
        interventions: valueAnalysis?.interventions.map((i) => ({ name: i.intervention, net_value: i.net_value, confidence: i.confidence })) ?? [],
      });
      await finishTrace(traceId, 'success');
    }
    return { valueAnalysis, excerptCount: excerpts.length, traceId };
  } catch (e) {
    if (traceId) await finishTrace(traceId, 'error', String((e as Error).message));
    console.warn('[lvc-value] analyzeValue failed', (e as Error).message);
    return { valueAnalysis: null, excerptCount: 0, traceId };
  }
}

export type { ValueAnalysis, ValueIntervention } from './lvc-value-core';
