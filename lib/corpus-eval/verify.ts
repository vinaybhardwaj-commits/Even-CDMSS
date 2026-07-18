// lib/corpus-eval/verify.ts — Brainstem PR 0: the GOVERNED Pro model call for the verifier.
//
// Routes through the governed layer (lib/trace.ts `tracedChat`) with the registered promptRef
// `verify-core/VERIFY_SYSTEM`, so every verdict is traced, fingerprinted, and costed — never a raw
// chatWithFallback/getGeminiChatClient direct site (which reasoning:governance forbids). Pro-tier
// (P0-D). Fail-safe: any error/timeout ⇒ not_assessable (parseVerdict handles empty), so a single
// bad sample never crashes the run.
//
// Read-only measurement: no production write path, no engine/prompt-default change. It only WRITES
// trace_events for its OWN eval calls (the standard governed-call side effect), never a served output.

import { startTrace, tracedChat } from '../trace';
import { GEMINI_MODEL } from '../llm';
import { VERIFY_SYSTEM, buildVerifyUser, parseVerdict, type SourceMeta, type VerifyResult } from './verify-core';

export interface VerifyUsage { prompt_tokens: number; completion_tokens: number; total_tokens: number; ms: number; provider: string; model: string }
export interface VerifyOutcome extends VerifyResult { usage: VerifyUsage }

const PROMPT_REF = 'verify-core/VERIFY_SYSTEM';

/**
 * Verify one (claim, cited-excerpts) unit on Gemini Pro through the governed layer. Returns the
 * verdict plus the measured token usage (for the SL0 cost probe). Never throws.
 */
export async function verifyClaim(
  claim: string,
  excerpts: Array<{ text: string; meta: SourceMeta }>,
  opts: { model?: string } = {},
): Promise<VerifyOutcome> {
  const t0 = Date.now();
  const emptyUsage = (provider: string, model: string): VerifyUsage => ({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, ms: Date.now() - t0, provider, model });
  const proModel = opts.model || GEMINI_MODEL;   // 'gemini-2.5-pro'
  try {
    const traceId = await startTrace('corpus_eval_verify', { promptRef: PROMPT_REF }, 1, { feature: 'corpus-eval' });
    const res = await tracedChat(
      traceId,
      'corpus_eval_verify',
      {
        model: 'llama3.1:8b',                  // Ollama fallback if Gemini errors (tracedChat contract)
        messages: [
          { role: 'system', content: VERIFY_SYSTEM },
          { role: 'user', content: buildVerifyUser(claim, excerpts) },
        ],
        temperature: 0,
        max_tokens: 700,
        response_format: { type: 'json_object' },
      },
      { gemini: proModel, promptRef: PROMPT_REF },
    );
    const choice = res?.choices?.[0];
    const content: string | null = choice?.message?.content ?? null;
    const u = res?.usage ?? {};
    const parsed = parseVerdict(content);
    return {
      ...parsed,
      usage: {
        prompt_tokens: Number(u.prompt_tokens ?? 0),
        completion_tokens: Number(u.completion_tokens ?? 0),
        total_tokens: Number(u.total_tokens ?? 0),
        ms: Date.now() - t0,
        provider: 'gemini',
        model: proModel,
      },
    };
  } catch (e) {
    // fail-safe — a failed verify is not_assessable, never a crash and never a guessed support
    return { verdict: 'not_assessable', supportingSpan: null, why: `verify error: ${String((e as Error).message).slice(0, 120)}`, usage: emptyUsage('gemini', proModel) };
  }
}
