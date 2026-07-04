// Concordance — non-core runner. Imports the LLM client; delegates all pure logic to
// concordance-core. P0 single-shot: a CLEAN direct Mac-mini call (no RAG, no retrieve,
// no critique/revise) — ₹0. This is deliberately NOT the ask-route pipeline, whose
// audit/revise pass hedges concordance verdicts.

import { llm, TEXT_MODEL } from './llm';
import { buildConcordancePrompt, parseConcordance, type ParsedConcordance } from './concordance-core';

export interface SingleShotResult {
  ok: boolean;
  model: string;
  ms: number;
  raw: string;
  parsed: ParsedConcordance;
  error?: string;
}

export async function runConcordanceSingleShot(result: string, context: string, model = TEXT_MODEL): Promise<SingleShotResult> {
  const { system, user } = buildConcordancePrompt(result, context);
  const t0 = Date.now();
  const resp = await llm.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  const raw = resp.choices?.[0]?.message?.content ?? '';
  return {
    ok: true,
    model,
    ms: Date.now() - t0,
    raw,
    parsed: parseConcordance(raw),
  };
}
