/**
 * lib/transport-attribution-core.ts — dispatch evidence on a returned completion (PURE).
 * CDMSS-RERANK-TELEMETRY-CC-KICKOFF-11-AUG-2026 §4.4, Stage 0a step 2.
 *
 * ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────────────────────────
 * The mechanism below was written on 10 Aug for the LVC judge (GUARD-FIX PRD v3.0 D-8) and lived
 * in lib/trace.ts, because only the TRACED transport needed it. The rerank judge is TRACELESS
 * (lib/rerank.ts:311 passes `undefined` as the trace id, and kickoff constraint 2 forbids changing
 * that), so its transport is `chatWithFallback` in lib/llm.ts — which attaches nothing, and is why
 * §5 of the throttle-rate findings could not say which caller was throttled.
 *
 * lib/trace.ts already imports from lib/llm.ts, so lib/llm.ts cannot import back from lib/trace.ts.
 * The primitive therefore moves DOWN into a module both can depend on. lib/trace.ts re-exports
 * every name it previously declared, so no existing consumer moves — including
 * lib/__tests__/lvc-judge-attribution.test.ts, which imports all four from '../trace' and is one of
 * the four files held uncommitted on main that this build must not touch.
 *
 * ── THE PROPERTY THAT MAKES THIS SAFE TO PUT ON THE PRODUCTION PATH ─────────────────────────────
 * The evidence is a NON-ENUMERABLE property on the object the provider SDK already returned. It is
 * invisible to `JSON.stringify`, to `Object.keys`, to spreads and to every existing consumer of a
 * completion; it allocates no new object; and `attach` never throws, even on a frozen or sealed
 * provider object. Attaching it cannot change a request, a provider choice, a retry, or a byte of
 * a response — which is exactly what §4.4 requires tests to prove before it may ship.
 */

/** The property name carrying dispatch evidence on a returned completion. Namespaced so it can
 *  never collide with an OpenAI/Bedrock/OpenRouter SDK field. */
export const TRANSPORT_ATTRIBUTION_FIELD = 'cdmss_transport_attribution';

/**
 * One provider attempt, in dispatch order. §4.3 requires the ORDERED attempt outcomes per rerank
 * batch — `429`, other HTTP, timeout, success or a declared transport error — and they are
 * distinguished here rather than collapsed, because a 429 and a socket reset call for different
 * remediation and the throttle-rate census could only see the ones that reached a console line.
 *
 * `success` is terminal for its tier. A tier that never reports one either fell through to the
 * next tier or ended the ladder.
 */
export type TransportAttemptOutcome =
  | 'http_429'
  | 'http_other'
  | 'timeout'
  | 'transport_error'
  | 'bad_response'
  | 'success';

export interface TransportAttempt {
  /** Which ladder tier made this attempt. */
  tier: 'vertex' | 'openrouter';
  /** 1-based, in dispatch order within that tier. */
  attempt: number;
  outcome: TransportAttemptOutcome;
  /** HTTP status when the provider supplied one; null for timeouts and transport errors. */
  status: number | null;
}

export type CdmssTransportAttribution = {
  /** Which branch dispatched the request. 'vertex' is the direct Vertex Gemini branch — the
   *  trace's own provider label for it is 'gemini'; this field uses the PRD's name. */
  dispatched_provider: 'vertex' | 'openrouter' | 'ollama' | 'bedrock';
  /** The model slug the transport supplied to that provider (publisher prefix as sent). */
  dispatched_model: string | null;
  /** True when a cloud provider produced this result; false for the local model. */
  cloud_response_received: boolean;
  /**
   * ADDITIVE (rerank telemetry §4.3). The ordered attempt sequence that led to this result, when
   * the transport collected one. OPTIONAL on purpose: `tracedChat` attaches attribution without
   * it, and every existing reader (lib/lvc.ts's `resolveJudgeAttribution`) reads only
   * `dispatched_provider` / `dispatched_model`, so adding the field moves nothing.
   *
   * ABSENT means the transport did not collect attempts — NOT that there were none. §4.4 forbids
   * guessing, so an absent sequence stays absent rather than being reconstructed.
   */
  attempts?: TransportAttempt[];
};

/** Attach dispatch evidence to a completion and return the SAME object. Non-enumerable, so no
 *  existing consumer of the completion can observe it. Never throws. */
export function attachTransportAttribution<T>(result: T, attribution: CdmssTransportAttribution): T {
  if (!result || (typeof result !== 'object' && typeof result !== 'function')) return result;
  try {
    Object.defineProperty(result, TRANSPORT_ATTRIBUTION_FIELD, {
      value: attribution, enumerable: false, configurable: true, writable: true,
    });
  } catch { /* frozen/sealed provider object — evidence is best-effort, never a thrown call */ }
  return result;
}

/** Read dispatch evidence back off a completion. `undefined` means the transport left none —
 *  which is a real state (an untraced call, a stream wrapper), not a failure. */
export function readTransportAttribution(result: unknown): CdmssTransportAttribution | undefined {
  if (!result || (typeof result !== 'object' && typeof result !== 'function')) return undefined;
  const v = (result as Record<string, unknown>)[TRANSPORT_ATTRIBUTION_FIELD];
  return v && typeof v === 'object' ? (v as CdmssTransportAttribution) : undefined;
}

/**
 * Map one `RetryAttemptFailure` (lib/openrouter-retry.ts) onto a declared outcome. Kept pure and
 * here rather than inline at the call site so both ladder tiers classify identically — a 429 that
 * counted as `http_other` on one tier and `http_429` on the other would make the census
 * tier-dependent, which is the class of defect this telemetry exists to remove.
 */
export function classifyAttemptOutcome(kind: string, status: number | null): TransportAttemptOutcome {
  if (kind === 'timeout') return 'timeout';
  if (kind === 'transport') return 'transport_error';
  if (kind === 'bad_response') return 'bad_response';
  return status === 429 ? 'http_429' : 'http_other';
}
