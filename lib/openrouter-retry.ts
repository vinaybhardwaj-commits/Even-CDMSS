/**
 * lib/openrouter-retry.ts — the OpenRouter retry POLICY, shared by both transports
 * (bridge-reliability addendum F v2 task 1, 31 Jul 2026).
 *
 * HISTORY. The lab/eval path built this discipline first (PDQI-9 fail-loud PRD D4 +
 * Eval-tick-deadline PRD D2, in opd-note-audit.ts `openRouterGenerate`): a bounded per-attempt
 * AbortController deadline, aborts retryable, bounded tries with jittered backoff, the timer
 * cleared in `finally`. The PRODUCTION bridge path (chatWithFallback / tracedChat →
 * openrouterChatClient) had NONE of it — a bare SDK `create()` whose only bound was the OpenAI
 * SDK's 600s default timeout, which the observed failure class never reaches: the upstream idle
 * timeout (T-11) returns an HTTP 200 whose body is an error, and the SDK counts a 200 as success.
 * So a production note cost its call and was never retried.
 *
 * WHAT IS SHARED vs WHAT IS NOT. The POLICY primitives — how many tries, which statuses retry,
 * the backoff curve, the per-attempt deadline — moved here VERBATIM from opd-note-audit.ts, which
 * imports and re-exports them so every lab call site and test is unchanged. The lab's LOOP
 * (`openRouterGenerate`) deliberately stays its own: its error strings are NORMATIVE
 * instrumentation pinned by test (emptyContentErrorMessage / deadlineErrorMessage), it must read
 * the response envelope off every attempt, and it clamps each attempt to the tick deadline — none
 * of which exists on the SDK transport. `openrouterCreateWithRetry` below is the SAME three
 * properties applied to the SDK transport, with the empty-200 class (classifyProviderResponse)
 * retryable on the same budget. Two loops, one policy — the loops carry different, test-pinned
 * obligations; the policy can never diverge again because there is only one copy of it.
 */

import { classifyProviderResponse, ProviderResponseError } from './provider-error-core';

/** Bounded retry: 3 tries total, retrying ONLY transient statuses (429/5xx) with jittered
 *  exponential backoff (~0.5s/1s/2s × [0.5,1.5)). A non-transient status or the final failure
 *  throws loudly — never a silent extra try. */
export const OPENROUTER_MAX_TRIES = 3;
export function openRouterRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}
export function openRouterBackoffMs(attempt: number, rand: () => number = Math.random): number {
  return Math.round(500 * 2 ** (attempt - 1) * (0.5 + rand()));   // attempt 1 → ~250-750ms, 2 → ~500-1500ms
}

/**
 * Per-attempt fetch deadline (PDQI-9 fail-loud PRD D4). With no timeout a hung request never
 * throws and never returns — fail-loud is UNOBSERVABLE if a call can hang forever, so this is a
 * precondition for retry rather than a request-shape variable: it only converts "hangs" into
 * "throws".
 *
 * ⚠️ 300_000 → 110_000 (Eval-tick-deadline PRD D4). At 110s per attempt, three attempts plus
 * backoff fit inside the lab's 240s tick deadline — so a note can exhaust its retry budget WITHIN
 * one tick and record its envelope. On the production path the same value keeps a worst-case leg
 * (2 leg attempts × 3 transport tries, S0 composition) inside the worker's 800s box.
 */
export const OPENROUTER_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS) || 110_000;

/** Per-attempt request options handed to the SDK call: OUR deadline (signal), the SDK's own
 *  timeout as a belt (same value), and the SDK's internal retries OFF — the retry budget lives in
 *  this module, and the SDK's default 2 silent connection-level retries under a 3-try loop would
 *  otherwise mean up to 9 wire calls per logical attempt budget. */
export interface OpenrouterAttemptOpts { signal: AbortSignal; timeout: number; maxRetries: 0 }

export interface OpenrouterAttemptFailure {
  attempt: number;
  maxTries: number;
  willRetry: boolean;
  kind: 'timeout' | 'transport' | 'http' | 'bad_response';
  /** HTTP status off the SDK error (APIError.status); null for timeouts/transport/bad_response. */
  status: number | null;
  message: string;
}

/**
 * Run one OpenRouter SDK call under the shared policy: per-attempt AbortController deadline
 * (timer cleared in `finally`), aborts and transport errors retryable, 429/5xx retryable,
 * AND a 200-that-is-not-a-completion retryable on the same budget (a captured empty 200 that is
 * not retried still costs the caller — d6efe39 made the class visible; this makes it survivable).
 *
 * The terminal empty-200 failure throws `ProviderResponseError`, so the call site's catch can
 * tell it apart and NOT route it into the local-model fallback (§2.3 stands — the retry budget
 * changes WHEN it throws, never WHAT happens after it throws).
 *
 * NOT for streaming calls: an in-flight stream being consumed by the caller must not be aborted
 * by a wall-clock timer, and classifyProviderResponse has never judged streams. Call sites keep
 * the bare `create()` for `stream: true` params.
 *
 * `doAttempt` is a closure so the actual SDK completions call stays inside the governed files
 * (lib/llm.ts / lib/trace.ts) — scripts/reasoning-governance-check.mjs hard-fails a direct model
 * call anywhere else, this module included. This module never touches a model client.
 */
export async function openrouterCreateWithRetry(
  doAttempt: (opts: OpenrouterAttemptOpts) => Promise<unknown>,
  cfg: {
    /** Intended model slug — carried into the terminal ProviderResponseError's message. */
    model?: string | null;
    /** Fires on every FAILED attempt, terminal or not. Wrapped: observability is never fatal. */
    onAttemptFailure?: (f: OpenrouterAttemptFailure) => void;
    /**
     * THE CALLER'S per-attempt ceiling. Absent ⇒ OPENROUTER_TIMEOUT_MS, byte-identical to before.
     *
     * ⚠️ WHY THIS EXISTS (root cause, 2 Aug 2026). This helper hard-coded its own 110 s ceiling for
     * BOTH the AbortController deadline and the SDK timeout, discarding whatever the caller asked
     * for. The OPD audit runs p50 267 s / p75 425 s and passes LLM_AUDIT_TIMEOUT_MS of 600 s
     * through governedChat — so on this path THE MEDIAN AUDIT COULD NEVER COMPLETE. It aborted,
     * retried, aborted, retried, aborted, and fell through to the local model.
     *
     * It went unnoticed because it only began when the OpenRouter bridge went live on 30 July:
     * Vertex honoured the 600 s override, the bridge silently replaced it with 110 s. MEASURED
     * overnight 1–2 Aug: 126 notes graded by qwen2.5:14b, ZERO by Gemini, logs wall-to-wall
     * "timeout — The user aborted a request". The fast tail still succeeded (a 79 s manual audit
     * reached Gemini), which is exactly why it looked intermittent rather than broken.
     *
     * THE GENERAL LESSON: a per-attempt ceiling must be sized against the SLOWEST caller, not the
     * fastest. 110 s is right for the short calls this helper was written for; it is not a property
     * of the helper, it is a property of the call. Nothing here relates a timeout to the duration
     * of its slowest caller or to the maxDuration of the route hosting it — see the PRD's §8.
     */
    timeoutMs?: number;
    /** Injection seams for tests (repo idiom — mirrors openRouterGenerate's). */
    sleepFn?: (ms: number) => Promise<void>;
    rand?: () => number;
  } = {},
): Promise<unknown> {
  // The applied ceiling: the caller's when given, else this module's default. A non-finite or
  // non-positive value degrades to the default rather than disabling the deadline — a deadline
  // that can be switched off by a bad number would reintroduce the hang this exists to prevent.
  const timeoutMs = Number.isFinite(cfg.timeoutMs) && (cfg.timeoutMs as number) > 0
    ? (cfg.timeoutMs as number)
    : OPENROUTER_TIMEOUT_MS;
  const sleep = cfg.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const report = (f: OpenrouterAttemptFailure) => { try { cfg.onAttemptFailure?.(f); } catch { /* instrumentation is never fatal */ } };
  let lastErr: unknown = new Error('openrouter: no attempt made');
  for (let attempt = 1; attempt <= OPENROUTER_MAX_TRIES; attempt++) {
    // The per-attempt deadline. Cleared in `finally` so a completed request never leaves a timer.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: unknown;
    try {
      res = await doAttempt({ signal: ctrl.signal, timeout: timeoutMs, maxRetries: 0 });
    } catch (e) {
      // A timeout surfaces as an abort; any transport failure (DNS/socket/reset) carries no HTTP
      // status. Both retry on the SAME bounded budget — an abort that was not retryable would make
      // the deadline strictly worse than no deadline. A non-transient HTTP status (4xx) throws
      // immediately: the call site's existing fallback handling is unchanged for that class.
      const status = typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : null;
      const timedOut = ctrl.signal.aborted;
      const retryable = timedOut || status === null || openRouterRetryable(status);
      const willRetry = retryable && attempt < OPENROUTER_MAX_TRIES;
      report({
        attempt, maxTries: OPENROUTER_MAX_TRIES, willRetry,
        kind: timedOut ? 'timeout' : status === null ? 'transport' : 'http',
        status, message: String((e as Error)?.message ?? e).slice(0, 300),
      });
      lastErr = timedOut
        ? new Error(`openrouter TIMEOUT after ${timeoutMs}ms (attempt ${attempt}/${OPENROUTER_MAX_TRIES})`)
        : e;
      if (!willRetry) throw lastErr;
      await sleep(openRouterBackoffMs(attempt, cfg.rand));
      continue;
    } finally {
      clearTimeout(timer);
    }
    // A 200 IS NOT A SUCCESS (d6efe39): validate the body. A usable completion returns here — the
    // overwhelmingly common case, one classify call more than before. A defect is RETRYABLE on the
    // remaining budget; only the final attempt throws.
    const defect = classifyProviderResponse(res);
    if (!defect) return res;
    const err = new ProviderResponseError(defect, 'openrouter', cfg.model ?? null);
    const willRetry = attempt < OPENROUTER_MAX_TRIES;
    report({
      attempt, maxTries: OPENROUTER_MAX_TRIES, willRetry,
      kind: 'bad_response', status: null, message: err.message.slice(0, 300),
    });
    lastErr = err;
    if (!willRetry) throw err;
    await sleep(openRouterBackoffMs(attempt, cfg.rand));
  }
  throw lastErr;
}
