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
 * one tick and record its envelope.
 *
 * ⚠️ THE SECOND SENTENCE OF THIS NOTE USED TO CLAIM the same value kept a worst-case production
 * leg "(2 leg attempts × 3 transport tries, S0 composition) inside the worker's 800s box". THAT
 * WAS NEVER TRUE and it is withdrawn (3 Aug 2026): 2 × 3 × 110,000 is 660,000 ms of transport
 * alone, before retrieval or scoring, and it assumed a ceiling this module was in fact discarding.
 * The production budget is NOT this constant — it is PROVIDER_BUDGETS in lib/lab-provider-core.ts,
 * which is per class and per provider and is checked against each route's maxDuration by
 * lib/__tests__/route-budget-guard.test.ts. This constant is the default for callers that pass
 * nothing, i.e. the short utility calls it was written for.
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
     * for. The OPD audit passes LLM_AUDIT_TIMEOUT_MS of 600 s through governedChat, and this
     * helper replaced it with 110 s — so every audit slower than 110 s aborted, retried, aborted,
     * retried, aborted, and fell through to the local model.
     *
     * ⚠️ CORRECTION (3 Aug 2026): this note used to say the OPD audit "runs p50 267 s / p75 425 s".
     * That figure was carried between documents and never re-measured. MEASURED on v_trace_summary,
     * `opd_note_audit` successes, 30 Jul–2 Aug: p50 52–93 s, p75 90–209 s, p95 309–393 s, max
     * 908,045 ms (31 Jul — which outran its own 800 s box and is still unexplained). The real p50
     * being well UNDER 110 s is precisely why this defect read as intermittent: most notes finished
     * inside the wrong ceiling and only the slow tail fell through.
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
    /**
     * THE CALLER'S retry count. Absent ⇒ OPENROUTER_MAX_TRIES, byte-identical to before.
     *
     * ⚠️ WHY THIS EXISTS (3 Aug 2026). Same lesson as `timeoutMs` above, one variable across:
     * A RETRY COUNT IS A PROPERTY OF THE CALL, NOT OF THIS MODULE. Three tries is right for the
     * short utility calls this loop was written for. It is wrong for an audit leg, because the
     * ladder is multiplicative against a route's box: an audit that may take 380 s, tried three
     * times, is 1,140 s of worst case inside an 800 s `maxDuration` — the route cannot hold its
     * own retry policy, so it dies mid-batch and writes nothing for the notes it was still
     * holding. A route whose box cannot contain the full ladder must be able to shorten it.
     *
     * Cutting a caller to one try does not remove retrying, it MOVES it: both audit workers sweep
     * for un-audited work every tick, so the sweep is the retry and it has a whole window of
     * budget rather than the tail of one invocation. See lib/lab-provider-core.ts's PROVIDER_BUDGETS.
     */
    maxTries?: number;
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
  // The applied try budget, resolved with the SAME discipline as the ceiling above: junk degrades
  // to the module default rather than to zero. A budget that could be switched off by a bad number
  // would turn "retry fewer times" into "never call at all", which is strictly worse than no knob.
  const maxTries = Number.isFinite(cfg.maxTries) && (cfg.maxTries as number) >= 1
    ? Math.trunc(cfg.maxTries as number)
    : OPENROUTER_MAX_TRIES;
  const sleep = cfg.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const report = (f: OpenrouterAttemptFailure) => { try { cfg.onAttemptFailure?.(f); } catch { /* instrumentation is never fatal */ } };
  let lastErr: unknown = new Error('openrouter: no attempt made');
  for (let attempt = 1; attempt <= maxTries; attempt++) {
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
      const willRetry = retryable && attempt < maxTries;
      report({
        attempt, maxTries, willRetry,
        kind: timedOut ? 'timeout' : status === null ? 'transport' : 'http',
        status, message: String((e as Error)?.message ?? e).slice(0, 300),
      });
      lastErr = timedOut
        ? new Error(`openrouter TIMEOUT after ${timeoutMs}ms (attempt ${attempt}/${maxTries})`)
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
    const willRetry = attempt < maxTries;
    report({
      attempt, maxTries, willRetry,
      kind: 'bad_response', status: null, message: err.message.slice(0, 300),
    });
    lastErr = err;
    if (!willRetry) throw err;
    await sleep(openRouterBackoffMs(attempt, cfg.rand));
  }
  throw lastErr;
}
