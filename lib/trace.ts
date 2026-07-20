import { randomUUID } from 'crypto';
import { sql } from './db';
import { llm, geminiConfigured, getGeminiChatClient, vertexModelName, chatWithFallback, openrouterConfigured, openrouterChatClient } from './llm';
import { promptFingerprint } from './reasoning/registry-core';
import { billableOutputTokens } from './llm-cost-core';

const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// Invocation envelope (Reasoning Observability Stage 1) — the per-call reasoning
// fingerprint promoted from payload JSONB into queryable trace_events columns.
// Stamped from the Stage-0 registry via promptFingerprint (the single source —
// a hash is never hardcoded at a call site). Every write degrades to a no-op if
// the 0012 migration hasn't run: the base event INSERT is unchanged and the
// envelope lands in a separate guarded UPDATE.
// ─────────────────────────────────────────────────────────────────────────────

export interface TraceEnvelope {
  prompt_id: string | null;
  prompt_version: string | null;
  prompt_hash: string | null;
  rubric_versions: Record<string, string> | null;
  output_schema_version: string | null;
  call_model: string | null;
  call_provider: string | null;
  gen_params: Record<string, unknown> | null;
  tokens_in: number | null;
  tokens_out: number | null;
}

/** Build the envelope columns for one LLM call. promptRef unset (or unknown to the
 *  registry) ⇒ fingerprint columns stay null and only the call facts are written. */
export function buildEnvelope(
  promptRef: string | undefined,
  call: { model?: string | null; provider?: string | null; genParams?: Record<string, unknown> | null; tokensIn?: number | null; tokensOut?: number | null },
): TraceEnvelope {
  const fp = promptRef ? promptFingerprint(promptRef) : null;
  return {
    prompt_id: fp?.id ?? null,
    prompt_version: fp?.version ?? null,
    prompt_hash: fp?.hash ?? null,
    rubric_versions: fp && Object.keys(fp.rubricVersions).length ? fp.rubricVersions : null,
    output_schema_version: fp?.schemaId ?? null,
    call_model: call.model ?? null,
    call_provider: call.provider ?? null,
    gen_params: call.genParams ?? null,
    tokens_in: call.tokensIn ?? null,
    tokens_out: call.tokensOut ?? null,
  };
}

// Exported so the envelope test can pin the exact column set to the 0012 migration.
export const ENVELOPE_UPDATE_SQL =
  `UPDATE trace_events SET prompt_id = $1, prompt_version = $2, prompt_hash = $3,
   rubric_versions = $4::jsonb, output_schema_version = $5, call_model = $6,
   call_provider = $7, gen_params = $8::jsonb, tokens_in = $9, tokens_out = $10
   WHERE trace_id = $11 AND seq = $12`;

export async function startTrace(feature: string, input: unknown, userId: number = 1, meta?: unknown): Promise<string> {
  const traceId = randomUUID();
  try {
    await sqlFn(
      `INSERT INTO traces (trace_id, user_id, feature, input, status, meta) VALUES ($1, $2, $3, $4::jsonb, 'running', $5::jsonb)`,
      [traceId, userId, feature, JSON.stringify(input ?? null), meta ? JSON.stringify(meta) : null]
    );
  } catch {
    // Tracing must never break the actual request
  }
  return traceId;
}

export async function logEvent(
  traceId: string,
  kind: string,
  stage: string | null,
  payload: unknown,
  latencyMs?: number,
  envelope?: TraceEnvelope
): Promise<void> {
  try {
    // app_source is set explicitly here: the lib/db stamper cannot safely inject
    // into this INSERT because the seq subquery in VALUES contains parentheses.
    const rows = (await sqlFn(
      `INSERT INTO trace_events (trace_id, seq, kind, stage, payload, latency_ms, app_source)
       VALUES ($1, COALESCE((SELECT MAX(seq) + 1 FROM trace_events WHERE trace_id = $1), 1), $2, $3, $4::jsonb, $5, $6)
       RETURNING seq`,
      [traceId, kind, stage, JSON.stringify(payload ?? null), latencyMs ?? null, process.env.APP_SOURCE || 'standalone']
    )) as Array<{ seq?: number }>;
    // Envelope columns ride a SEPARATE guarded UPDATE (never the INSERT): before the 0012
    // migration this update fails and is swallowed while the base event row stays intact.
    if (envelope) {
      const seq = rows?.[0]?.seq;
      if (seq != null) {
        try {
          await sqlFn(ENVELOPE_UPDATE_SQL, [
            envelope.prompt_id, envelope.prompt_version, envelope.prompt_hash,
            envelope.rubric_versions ? JSON.stringify(envelope.rubric_versions) : null,
            envelope.output_schema_version, envelope.call_model, envelope.call_provider,
            envelope.gen_params ? JSON.stringify(envelope.gen_params) : null,
            envelope.tokens_in, envelope.tokens_out, traceId, seq,
          ]);
        } catch {}
      }
    }
  } catch {}
}

export async function finishTrace(
  traceId: string,
  status: 'success' | 'error' | 'partial',
  errorMessage?: string
): Promise<void> {
  try {
    await sqlFn(
      `UPDATE traces SET finished_at = NOW(), status = $1, error_message = $2,
       total_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000 WHERE trace_id = $3`,
      [status, errorMessage ?? null, traceId]
    );
  } catch {}
}

/**
 * STUDY FLAG — DEFAULT-OFF. `LLM_THINKING_BUDGET=<n>` caps the reasoning ("thinking") tokens
 * Gemini 2.5 spends per call, for the thinkingBudget cost study (17 Jul 2026). Unset / 0 / junk
 * ⇒ returns undefined and tracedChat is BYTE-IDENTICAL to the uncapped shipped path. The shipped
 * production default is UNCAPPED; this exists so an arm can be driven per-process (the same
 * pattern the Flash study used for GEMINI_MODEL) without touching the engine or any prompt.
 *
 * Mechanism (SL0-verified against Vertex's OpenAI-compat endpoint, 17 Jul 2026): the ONLY form
 * this endpoint honors is a top-level `google.thinking_config.thinking_budget`. Both
 * `generationConfig.thinkingConfig` and `extra_body.generationConfig.thinkingConfig` are
 * SILENTLY IGNORED — the request succeeds and reasoning is unchanged, which is precisely how a
 * cap that does nothing would look. Verified by dose-response, not by the call not erroring:
 * budget 128/512/1024/2048 → 75/431/678/1509 actual reasoning tokens.
 *
 * NB gemini-2.5-pro REJECTS thinking_budget=0 (HTTP 400) — Pro cannot have thinking disabled;
 * 128 is its floor. -1 means "dynamic" (i.e. uncapped), so it is deliberately not accepted here.
 */
export function geminiThinkingBudget(): number | undefined {
  const raw = Number(process.env.LLM_THINKING_BUDGET);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

// Wraps llm.chat.completions.create with automatic event logging.
// Logs: model, full prompt (messages), full response content, token usage, finish_reason, latency.
// Returns the original response so callers can use it normally.
// Use 'any' for params/return because the OpenAI SDK's overload-based types conflict with
// Ollama-specific extra fields (options, keep_alive) and our streaming/non-streaming union.
// Callers know their own use case and cast accordingly.
export async function tracedChat(
  traceId: string,
  label: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any,
  // Hybrid backend: when `gemini` names a model AND Vertex is configured, the
  // call runs on Gemini and silently falls back to the local Ollama model in
  // `params.model` on any error/timeout. Omit it (or leave Gemini unconfigured)
  // and behaviour is byte-identical to the original Ollama-only path.
  // promptRef (Stage 1): a Stage-0 registry id — resolves version+hash via
  // promptFingerprint and stamps the envelope columns on this call's events.
  // Unset ⇒ only the call facts (model/provider/gen_params/tokens) are written.
  opts?: { gemini?: string; openrouter?: string; promptRef?: string },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const t0 = Date.now();

  // Provider precedence: OpenRouter (explicit slug) → Vertex Gemini → local Ollama. Each keeps the
  // local Ollama model in params.model as its on-error fallback.
  const useOpenRouter = Boolean(opts?.openrouter) && openrouterConfigured();
  const useGemini = !useOpenRouter && Boolean(opts?.gemini) && geminiConfigured();
  const servedModel = useOpenRouter ? (opts!.openrouter as string) : useGemini ? (opts!.gemini as string) : (params as { model?: string }).model;

  // Log the request before firing (records the model we INTEND to use)
  const requestPayload = {
    model: servedModel,
    provider: useOpenRouter ? 'openrouter' : useGemini ? 'gemini' : 'ollama',
    messages: (params as { messages?: unknown }).messages,
    temperature: (params as { temperature?: number }).temperature,
    max_tokens: (params as { max_tokens?: number }).max_tokens,
    stream: (params as { stream?: boolean }).stream ?? false,
    options: (params as Record<string, unknown>).options,
    keep_alive: (params as Record<string, unknown>).keep_alive,
  };
  // Default-off (see geminiThinkingBudget): undefined unless an arm sets LLM_THINKING_BUDGET.
  const thinkingBudget = useGemini ? geminiThinkingBudget() : undefined;
  const genParams: Record<string, unknown> = {
    temperature: requestPayload.temperature ?? null,
    max_tokens: requestPayload.max_tokens ?? null,
    stream: requestPayload.stream,
    // Only present when capped, so an uncapped call's gen_params is unchanged — and a capped
    // run is never mistakable for a shipped-default one when read back off the trace.
    ...(thinkingBudget ? { thinking_budget: thinkingBudget } : {}),
  };
  const promptRef = opts?.promptRef;
  await logEvent(traceId, 'llm_request', label, requestPayload, undefined,
    buildEnvelope(promptRef, { model: servedModel, provider: requestPayload.provider, genParams }));
  // Roll the registry id into traces.prompt_ids (only ids the registry actually knows).
  if (promptRef && promptFingerprint(promptRef)) await setTracePromptIds(traceId, [promptRef]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any;
  let provider = requestPayload.provider;
  let actualModel = servedModel;

  try {
    if (useOpenRouter) {
      try {
        // Strip Ollama-only params; run NON-THINKING (reasoning off) — the critic wants a bounded
        // JSON verdict, and Qwen3 otherwise spends the token budget on reasoning and returns no
        // content. A caller may override by putting its own `reasoning` in params.
        const { options: _o, keep_alive: _k, ...rest } = params as Record<string, unknown>;
        void _o; void _k;
        const orParams: Record<string, unknown> = {
          ...rest,
          model: opts!.openrouter as string,
          ...(('reasoning' in (rest as Record<string, unknown>)) ? {} : { reasoning: { enabled: false } }),
        };
        const client = openrouterChatClient();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result = await client.chat.completions.create(orParams as any);
      } catch (oe) {
        await logEvent(traceId, 'provider_fallback', label, {
          from: 'openrouter', to: 'ollama',
          intended_model: servedModel,
          fallback_model: (params as { model?: string }).model,
          error: String((oe as Error).message).slice(0, 500),
        }, Date.now() - t0);
        provider = 'ollama';
        actualModel = (params as { model?: string }).model;
        result = await llm.chat.completions.create(params);
      }
    } else if (useGemini) {
      try {
        // Strip Ollama-only params (Vertex rejects unknown fields) + publisher-prefix the model.
        const { options: _o, keep_alive: _k, ...rest } = params as Record<string, unknown>;
        void _o; void _k;
        // Gemini 2.5 Pro is a THINKING model: max_tokens (→ maxOutputTokens) is spent
        // on internal reasoning tokens FIRST, so the tight caps tuned for Ollama
        // (700–1500) leave no budget for the JSON answer and it truncates mid-string.
        // Give the content budget PLUS a generous thinking allowance.
        const baseMax = Number((rest as { max_tokens?: number }).max_tokens) || 1024;
        const gParams: Record<string, unknown> = {
          ...rest,
          model: vertexModelName(opts!.gemini as string),
          max_tokens: baseMax + 8192,
        };
        // Streaming calls otherwise carry NO token usage, so their spend is invisible to the LLM
        // cost tracker (this is why every /ask + /ddx pass was uncounted). Ask Vertex to emit a
        // final usage chunk. Off switch: LLM_STREAM_USAGE=0. Self-healing: if the endpoint rejects
        // the field we retry WITHOUT it (keep Gemini) rather than cascading to the Ollama fallback.
        const wantUsage = Boolean((rest as { stream?: boolean }).stream) && process.env.LLM_STREAM_USAGE !== '0';
        if (wantUsage) gParams.stream_options = { include_usage: true };
        // Study arm only — absent on the shipped uncapped default.
        if (thinkingBudget) gParams.google = { thinking_config: { thinking_budget: thinkingBudget } };
        const gemini = await getGeminiChatClient();
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          result = await gemini.chat.completions.create(gParams as any);
        } catch (soErr) {
          if (wantUsage && gParams.stream_options) {
            delete gParams.stream_options;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            result = await gemini.chat.completions.create(gParams as any);
          } else {
            throw soErr;
          }
        }
      } catch (ge) {
        // Fall back to the local Ollama model — the request must never fail just
        // because Gemini is down/slow. Record the fallback for observability.
        await logEvent(traceId, 'provider_fallback', label, {
          from: 'gemini', to: 'ollama',
          intended_model: servedModel,
          fallback_model: (params as { model?: string }).model,
          error: String((ge as Error).message).slice(0, 500),
        }, Date.now() - t0);
        provider = 'ollama';
        actualModel = (params as { model?: string }).model;
        result = await llm.chat.completions.create(params);
      }
    } else {
      result = await llm.chat.completions.create(params);
    }
  } catch (e) {
    await logEvent(traceId, 'llm_error', label, {
      model: actualModel,
      provider,
      error: String((e as Error).message),
      stack: (e as Error).stack?.slice(0, 2000),
    }, Date.now() - t0,
      buildEnvelope(promptRef, { model: actualModel, provider, genParams }));
    throw e;
  }

  // For non-streaming responses, log the full content + usage
  if (!('controller' in result)) {
    const r = result as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
    await logEvent(traceId, 'llm_response', label, {
      model: actualModel,
      provider,
      content: r.choices?.[0]?.message?.content ?? '',
      finish_reason: r.choices?.[0]?.finish_reason,
      usage: r.usage,          // payload UNCHANGED — the $ dashboard reads this and is already correct
    }, Date.now() - t0,
      buildEnvelope(promptRef, {
        model: actualModel, provider, genParams,
        // tokens_out is REASONING-INCLUSIVE (total − prompt), matching the OUT_TOK the dashboard
        // already prices from the payload. Previously this column recorded completion_tokens
        // alone, so any column-based reader under-counted output ~47% (measured).
        tokensIn: r.usage?.prompt_tokens ?? null, tokensOut: r.usage ? billableOutputTokens(r.usage) : null,
      }));
  } else {
    // For streaming, the caller will collect tokens and should call logStreamComplete after.
    await logEvent(traceId, 'llm_response_stream_started', label, {
      model: actualModel,
      provider,
    }, Date.now() - t0,
      buildEnvelope(promptRef, { model: actualModel, provider, genParams }));
    // The content events carry no usage, so wrap the stream to capture the final usage chunk
    // (from stream_options.include_usage) and log it once the stream drains. Gemini only —
    // this is what makes streamed spend (/ask, /ddx, /topics) visible in the cost tracker.
    if ((params as { stream?: boolean }).stream && provider === 'gemini') {
      result = wrapStreamUsage(result, traceId, label, actualModel, provider, t0, promptRef, genParams);
    }
  }

  return result;
}

// Wraps a streaming chat completion so the final `usage` chunk (requested via
// stream_options.include_usage) is captured and logged as an `llm_stream_usage` event. Yields
// every chunk unchanged so callers iterate exactly as before (the usage chunk has empty choices,
// so per-token consumers skip it). The cost tracker counts this event; without it, streamed calls
// report zero tokens and their spend is invisible.
async function* wrapStreamUsage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stream: AsyncIterable<any>,
  traceId: string,
  label: string,
  model: string | undefined,
  provider: string,
  t0: number,
  promptRef?: string,
  genParams?: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): AsyncGenerator<any> {
  let usage: unknown;
  try {
    for await (const chunk of stream) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const u = (chunk as any)?.usage;
      if (u) usage = u;
      yield chunk;
    }
  } finally {
    if (usage) {
      const u = usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      await logEvent(traceId, 'llm_stream_usage', label, { model, provider, usage, streamed: true }, Date.now() - t0,
        buildEnvelope(promptRef, {
          model: model ?? null, provider, genParams: genParams ?? null,
          // reasoning-inclusive, same rule as the non-streaming path above
          tokensIn: u.prompt_tokens ?? null, tokensOut: billableOutputTokens(u),
        })).catch(() => {});
    }
  }
}

// Used by streaming endpoints to log the assembled response after consuming the stream.
export async function logStreamComplete(
  traceId: string,
  label: string,
  fullContent: string,
  startMs: number,
  meta?: Record<string, unknown>
): Promise<void> {
  await logEvent(traceId, 'llm_response_stream_complete', label, {
    content: fullContent,
    char_count: fullContent.length,
    ...(meta || {}),
  }, Date.now() - startMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// v1.7 Sprint A — denormalized writers used by /ask to populate the new
// columns on `traces` for fast list/search/filter without scanning JSONB.
// All wrapped in try/catch so tracing never breaks the actual request.
// ─────────────────────────────────────────────────────────────────────────────

/** Write the first 160 chars of the question into traces.question_preview. */
export async function setTraceQuestionPreview(traceId: string, question: string): Promise<void> {
  try {
    const preview = (question || '').slice(0, 160);
    await sqlFn(`UPDATE traces SET question_preview = $1 WHERE trace_id = $2`, [preview, traceId]);
  } catch {}
}

/** Write the critique severity (none/minor/moderate/major) into traces.severity. */
export async function setTraceSeverity(traceId: string, severity: string): Promise<void> {
  try {
    await sqlFn(`UPDATE traces SET severity = $1 WHERE trace_id = $2`, [severity, traceId]);
  } catch {}
}

/** Write {draft, critique, revise, ...} → traces.model_summary JSONB. */
export async function setTraceModelSummary(traceId: string, models: Record<string, string>): Promise<void> {
  try {
    await sqlFn(`UPDATE traces SET model_summary = $1::jsonb WHERE trace_id = $2`, [JSON.stringify(models), traceId]);
  } catch {}
}

/** Write the assembled final answer text into traces.final_answer_text.
 *  The search_tsv GENERATED column will recompute automatically. */
export async function setTraceFinalAnswer(traceId: string, finalAnswer: string): Promise<void> {
  try {
    await sqlFn(`UPDATE traces SET final_answer_text = $1 WHERE trace_id = $2`, [finalAnswer, traceId]);
  } catch {}
}

/** Roll registry prompt ids into traces.prompt_ids (deduped append — an id already in the
 *  array is skipped). Stage 1 denormalized writer; degrades to no-op before migration 0012. */
export async function setTracePromptIds(traceId: string, promptIds: string[]): Promise<void> {
  try {
    for (const id of promptIds) {
      await sqlFn(
        `UPDATE traces SET prompt_ids = COALESCE(prompt_ids, '[]'::jsonb) || to_jsonb($1::text)
         WHERE trace_id = $2 AND NOT (COALESCE(prompt_ids, '[]'::jsonb) ? $1)`,
        [id, traceId]
      );
    }
  } catch {}
}

/**
 * The governed model-call entry for feature code (Stage 4). Traced → tracedChat (envelope
 * stamped when promptRef is set); traceless → the plain hybrid fallback, whose ONLY
 * sanctioned call site is here inside the governed layer. Transport is byte-identical to
 * the two paths it unifies (same param handling, same Gemini→Ollama fallback), so routing
 * a call through here never changes its output. scripts/reasoning-governance-check.mjs
 * hard-fails any model call that bypasses this layer.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function governedChat(
  traceId: string | undefined,
  label: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any,
  opts?: { gemini?: string; openrouter?: string; promptRef?: string },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  if (traceId) return tracedChat(traceId, label, params, opts);
  return chatWithFallback(params, opts?.gemini, opts?.openrouter);
}

// ─────────────────────────────────────────────────────────────────────────────
// Guaranteed finalize (Stage 1) — closes the `running`-trace leak.
// ─────────────────────────────────────────────────────────────────────────────

/** finishTrace, but ONLY if the trace is still 'running' — never overwrites a status the
 *  pipeline already set (so withTrace's safety net can't turn a 'partial' into 'success'). */
export async function finishTraceIfRunning(
  traceId: string,
  status: 'success' | 'error' | 'partial',
  errorMessage?: string
): Promise<void> {
  try {
    await sqlFn(
      `UPDATE traces SET finished_at = NOW(), status = $1, error_message = $2,
       total_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000
       WHERE trace_id = $3 AND status = 'running'`,
      [status, errorMessage ?? null, traceId]
    );
  } catch {}
}

/** Injection seam for unit tests (repo idiom — mirrors MatchDeps/SkeletonDeps). */
export interface WithTraceDeps {
  start?: (feature: string, input: unknown) => Promise<string>;
  finish?: (traceId: string, status: 'success' | 'error', errorMessage?: string) => Promise<void>;
}

/**
 * Run fn under a trace with GUARANTEED finalization: the finalizer runs exactly once, in
 * finally, on success AND on throw (rethrown unchanged). The finalizer is status-guarded
 * (finishTraceIfRunning), so a pipeline that already finished its own trace — including
 * with 'error' or 'partial' — is untouched; only a trace left 'running' gets closed.
 */
export async function withTrace<T>(
  feature: string,
  input: unknown,
  fn: (traceId: string) => Promise<T>,
  deps: WithTraceDeps = {},
): Promise<T> {
  const start = deps.start ?? startTrace;
  const finish = deps.finish ?? finishTraceIfRunning;
  const traceId = await start(feature, input);
  let error: unknown = null;
  try {
    return await fn(traceId);
  } catch (e) {
    error = e;
    throw e;
  } finally {
    await finish(traceId, error ? 'error' : 'success', error ? String((error as Error).message) : undefined);
  }
}
