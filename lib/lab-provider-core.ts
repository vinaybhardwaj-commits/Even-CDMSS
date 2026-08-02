/**
 * lib/lab-provider-core.ts — PURE provider resolution for F11 (three-provider model routing).
 * No db, no Next, no model clients — this decides WHICH provider a `model` string names and whether
 * a paid run is still inside its ceiling. The impure runner dispatches.
 *
 * D16 / decision 9: all three providers, plus a per-experiment paid ceiling defaulting to 250.
 *
 * ERRORS LOUD, NEVER FALLS BACK. This deliberately matches rerankBackend='cohere': an unresolvable
 * or unavailable model is a typed error, not a silent downgrade to the mini. A silent fallback would
 * make a lab result unattributable — the row would say one thing and the run would have been another
 * — and unattributable rows are exactly what F11 exists to stop (87.8% of stored lab volume turned
 * out to be paid Gemini while the tools advertised "₹0, never Gemini").
 */

// 'bedrock' added 2 Aug 2026 (PROVIDER-SWITCH PRD §4.1). ONE ARRAY ENTRY is the whole of "add a
// provider": resolveProvider's prefix parsing is already generic, so `bedrock:anthropic.claude-x`
// resolves the moment the name is here. Reachability is separate and still false until credentials
// exist (probeReachable in lib/lab-override.ts) — a provider that resolves but cannot be reached
// errors loudly rather than falling back, which is the property this module exists to hold.
export const LAB_PROVIDERS = ['ollama', 'openrouter', 'vertex', 'bedrock'] as const;
export type LabProvider = (typeof LAB_PROVIDERS)[number];

/**
 * What KIND of call this is. The three classes have genuinely different shapes, and conflating them
 * is what caused both of 2 August's outages:
 *   · 'audit'    — one full note/document audit. Minutes, not seconds.
 *   · 'utility'  — a short bounded call (critic, classifier, expansion). Seconds.
 *   · 'doc_read' — a multimodal document read. Bounded separately from the analyze that follows it.
 */
export type CallClass = 'audit' | 'utility' | 'doc_read';

/** A per-attempt ceiling and how many attempts the transport may make. */
export interface ProviderBudget { perAttemptMs: number; maxTries: number }

/**
 * THESE NUMBERS ARE MEASURED, NOT PREFERRED.
 *
 * The OPD audit runs p50 267 s / p75 425 s per note. A 110 s per-attempt constant sat in front of
 * it — `openrouterCreateWithRetry` overrode the caller's 600 s with its own — so from 30 July, when
 * the OpenRouter bridge went live, THE MEDIAN AUDIT COULD NEVER COMPLETE. It aborted three times
 * and fell through to the local model: 126 notes graded by qwen2.5:14b overnight, zero by Gemini,
 * every row still labelled `gemini-2.5-pro`. It took three days to notice because the fast tail
 * still succeeded. The same day, the IPD worker's batch was sized against no budget at all and
 * 504'd on every run.
 *
 * Both failures were the same missing fact: nobody could state, as a number, how long a call of a
 * given class on a given provider is allowed to take. This table is that fact, per provider and per
 * class, in one place a route can be checked against.
 *
 * A `null` means the provider does not serve that class at all — see the ollama/doc_read note.
 */
export const PROVIDER_BUDGETS: Record<LabProvider, Record<CallClass, ProviderBudget | null>> = {
  // Local mini: one try, never retried. A local box that did not answer in the budget will not
  // answer on a second ask, and there is no spend to amortise. doc_read is NULL, not a number:
  // the mini is not multimodal, so a document read on ollama is not slow — it is IMPOSSIBLE.
  // Encoding a duration here would let a caller compute a budget for a call that cannot be made.
  ollama:     { audit: { perAttemptMs: 600_000, maxTries: 1 }, utility: { perAttemptMs: 90_000, maxTries: 1 }, doc_read: null },
  openrouter: { audit: { perAttemptMs: 600_000, maxTries: 3 }, utility: { perAttemptMs: 110_000, maxTries: 3 }, doc_read: { perAttemptMs: 180_000, maxTries: 1 } },
  vertex:     { audit: { perAttemptMs: 600_000, maxTries: 3 }, utility: { perAttemptMs: 110_000, maxTries: 3 }, doc_read: { perAttemptMs: 180_000, maxTries: 1 } },
  bedrock:    { audit: { perAttemptMs: 600_000, maxTries: 3 }, utility: { perAttemptMs: 110_000, maxTries: 3 }, doc_read: { perAttemptMs: 180_000, maxTries: 1 } },
};

/**
 * The BACKOFF ALLOWANCE: the worst-case time spent sleeping BETWEEN attempts, not calling.
 *
 * Derived from the shipped curve rather than guessed. `openRouterBackoffMs` (lib/openrouter-retry.ts)
 * is `round(500 × 2^(attempt-1) × (0.5 + rand()))` with `rand()` in [0,1), so one sleep is at most
 * `750 × 2^(attempt-1)`. N tries means N−1 sleeps, and summing the geometric series gives
 * `750 × (2^(N−1) − 1)` — 0 ms at one try, 2,250 ms at three.
 *
 * It is deliberately the exact UPPER BOUND of the real curve, not a round number: a budget a route
 * is checked against must never be optimistic, and 2.25 s is small enough that being exact costs
 * nothing. If the backoff curve changes, this must change with it — they are one fact in two files.
 */
export function backoffAllowanceMs(maxTries: number): number {
  const n = Math.max(1, Math.trunc(Number(maxTries) || 1));
  return 750 * (2 ** (n - 1) - 1);
}

/**
 * THE NUMBER A ROUTE MUST FIT: worst-case wall time for one call of this class on this provider,
 * including the sleeps between retries. Null when the provider does not serve the class.
 *
 * Its ABSENCE is what caused both of today's outages — no caller could compare a call's ceiling
 * against the box it runs in, so a 110 s ceiling sat in front of a 267 s call and a ~1,530 s batch
 * sat in an 800 s route, and both were invisible until they were measured from the outside.
 */
export function totalBudgetMs(provider: LabProvider, callClass: CallClass): number | null {
  const b = PROVIDER_BUDGETS[provider]?.[callClass];
  if (!b) return null;
  return b.perAttemptMs * b.maxTries + backoffAllowanceMs(b.maxTries);
}

/** Decision 9 — raised only by passing it explicitly on the call. */
export const DEFAULT_PAID_CEILING = 250;

export type ProviderResolution =
  | { ok: true; provider: LabProvider; model: string; paid: boolean; raw: string }
  | { ok: false; error: string };

/**
 * Resolve a `model` argument.
 *   ollama:<name>     → local mini, free
 *   openrouter:<id>   → PAID
 *   vertex:<id>       → PAID (generation only; the Lab never writes a production audit row)
 *   unprefixed / omitted → the local mini, i.e. today's behaviour unchanged
 *
 * An unknown prefix is an ERROR rather than a fallback: "gpt5:foo" must not quietly run on Qwen and
 * be recorded as if it had run on gpt5.
 */
export function resolveProvider(model: unknown, miniModel: string): ProviderResolution {
  const raw = model === null || model === undefined ? '' : String(model).trim();
  if (!raw) return { ok: true, provider: 'ollama', model: miniModel, paid: false, raw: '' };

  const colon = raw.indexOf(':');
  if (colon < 0) {
    // Unprefixed is the documented "just use the mini" path — but a bare string that LOOKS like a
    // vendor id is far more likely a forgotten prefix than a deliberate mini run, so say so.
    if (/\//.test(raw)) {
      return { ok: false, error: `model '${raw}' has no provider prefix but looks like a vendor id — prefix it with ${LAB_PROVIDERS.map((p) => `${p}:`).join(' / ')}` };
    }
    return { ok: true, provider: 'ollama', model: raw, paid: false, raw };
  }

  const prefix = raw.slice(0, colon).toLowerCase();
  const rest = raw.slice(colon + 1).trim();
  if (!(LAB_PROVIDERS as readonly string[]).includes(prefix)) {
    return { ok: false, error: `unknown provider prefix '${prefix}' — expected one of ${LAB_PROVIDERS.join(', ')}. Never falls back to the mini.` };
  }
  if (!rest) return { ok: false, error: `model id missing after '${prefix}:'` };
  const provider = prefix as LabProvider;
  return { ok: true, provider, model: rest, paid: provider !== 'ollama', raw };
}

export type CeilingCheck =
  | { ok: true; used: number; ceiling: number; remaining: number }
  | { ok: false; error: string; used: number; ceiling: number };

/**
 * Per-experiment ceiling on NON-OLLAMA runs. Free local runs are never counted — the ceiling exists
 * to bound spend, not throughput. Exceeding it STOPS and REPORTS rather than trimming silently, so a
 * half-finished experiment is visible as half-finished.
 */
export function checkPaidCeiling(paidRunsSoFar: number, ceiling: unknown = DEFAULT_PAID_CEILING): CeilingCheck {
  const used = Math.max(0, Math.trunc(Number(paidRunsSoFar) || 0));
  const nRaw = Number(ceiling);
  const cap = Number.isFinite(nRaw) && nRaw > 0 ? Math.trunc(nRaw) : DEFAULT_PAID_CEILING;
  if (used >= cap) {
    return {
      ok: false, used, ceiling: cap,
      error: `paid-run ceiling reached for this experiment: ${used}/${cap}. STOPPED — pass a higher ceiling explicitly to continue (default ${DEFAULT_PAID_CEILING}).`,
    };
  }
  return { ok: true, used, ceiling: cap, remaining: cap - used };
}
