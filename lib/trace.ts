import { randomUUID } from 'crypto';
import { sql } from './db';
import { llm } from './llm';

const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;

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
  latencyMs?: number
): Promise<void> {
  try {
    await sqlFn(
      `INSERT INTO trace_events (trace_id, seq, kind, stage, payload, latency_ms)
       VALUES ($1, COALESCE((SELECT MAX(seq) + 1 FROM trace_events WHERE trace_id = $1), 1), $2, $3, $4::jsonb, $5)`,
      [traceId, kind, stage, JSON.stringify(payload ?? null), latencyMs ?? null]
    );
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
  params: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const t0 = Date.now();
  // Log the request before firing
  const requestPayload = {
    model: (params as { model?: string }).model,
    messages: (params as { messages?: unknown }).messages,
    temperature: (params as { temperature?: number }).temperature,
    max_tokens: (params as { max_tokens?: number }).max_tokens,
    stream: (params as { stream?: boolean }).stream ?? false,
    options: (params as Record<string, unknown>).options,
    keep_alive: (params as Record<string, unknown>).keep_alive,
  };
  await logEvent(traceId, 'llm_request', label, requestPayload);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any;
  try {
    result = await llm.chat.completions.create(params);
  } catch (e) {
    await logEvent(traceId, 'llm_error', label, {
      model: requestPayload.model,
      error: String((e as Error).message),
      stack: (e as Error).stack?.slice(0, 2000),
    }, Date.now() - t0);
    throw e;
  }

  // For non-streaming responses, log the full content + usage
  if (!('controller' in result)) {
    const r = result as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: unknown };
    await logEvent(traceId, 'llm_response', label, {
      model: requestPayload.model,
      content: r.choices?.[0]?.message?.content ?? '',
      finish_reason: r.choices?.[0]?.finish_reason,
      usage: r.usage,
    }, Date.now() - t0);
  } else {
    // For streaming, the caller will collect tokens and should call logStreamComplete after
    await logEvent(traceId, 'llm_response_stream_started', label, {
      model: requestPayload.model,
    }, Date.now() - t0);
  }

  return result;
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
