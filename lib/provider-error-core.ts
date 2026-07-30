/**
 *   node --experimental-strip-types lib/provider-error-core.ts
 *
 * Provider-error observability (403-diagnosis kickoff, 30 Jul 2026) — PURE core.
 *
 * WHY: the only record of a Vertex failure was `String(e.message).slice(0, 200)` into a
 * console.warn nothing reads, followed by a silent Ollama fallback returning 200. Vertex's 403
 * body carries error.status, error.message and error.details[] — and the message is what
 * distinguishes an IAM denial from a quota denial from a disabled API. Truncating a diagnostic
 * to 200 characters was the defect; this core serialises the FULL error (generous 4000-char cap)
 * and counts provider calls in flight, so the load-correlation hypothesis (§3 of the kickoff)
 * becomes falsifiable: quota/rate limits are concurrency-sensitive, IAM denials are stateless.
 *
 * Observability only. No retry, no backoff, no routing — behaviour is unchanged everywhere.
 */

/** The diagnostic cap. 200 was the defect; do not replace it with a smaller number. */
export const PROVIDER_ERROR_CAP = 4000;

export interface SerializedProviderError {
  /** HTTP status from the SDK error (e.status on an OpenAI APIError), null if absent. */
  http_status: number | null;
  /** The body's error.status — e.g. PERMISSION_DENIED vs RESOURCE_EXHAUSTED. THE discriminator. */
  error_status: string | null;
  /** The body's error.code (numeric on Vertex), null if absent. */
  error_code: number | string | null;
  /** The FULL error message, capped at PROVIDER_ERROR_CAP — never 200. */
  message: string;
  /** error.details[] serialised verbatim (capped), null when the body carries none. */
  details: string | null;
}

const cap = (s: string): string => s.slice(0, PROVIDER_ERROR_CAP);

/**
 * Serialise a provider error without losing the body. Tolerates every shape seen in the wild:
 * an OpenAI-SDK APIError (`status` + `error` body), a Vertex REST body (`{ error: { code,
 * message, status, details } }`), a plain Error, or junk. Never throws.
 */
export function serializeProviderError(e: unknown): SerializedProviderError {
  const out: SerializedProviderError = { http_status: null, error_status: null, error_code: null, message: '', details: null };
  try {
    const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
    // OpenAI APIError: .status is the HTTP status number.
    if (typeof o.status === 'number') out.http_status = o.status;
    // The body: APIError.error, or the object itself when a raw body was thrown. Vertex nests
    // { error: { code, message, status, details } }.
    let body = (o.error && typeof o.error === 'object' ? o.error : null) as Record<string, unknown> | null;
    if (body && body.error && typeof body.error === 'object') body = body.error as Record<string, unknown>;
    if (body) {
      if (typeof body.status === 'string') out.error_status = body.status;
      if (typeof body.code === 'number' || typeof body.code === 'string') out.error_code = body.code;
      if (Array.isArray(body.details) && body.details.length) {
        try { out.details = cap(JSON.stringify(body.details)); } catch { /* unserialisable — leave null */ }
      }
      // Prefer the body's own message — it is the IAM-vs-quota discriminator.
      if (typeof body.message === 'string' && body.message) out.message = cap(body.message);
    }
    if (!out.message) out.message = cap(String((o as { message?: unknown }).message ?? e ?? ''));
  } catch {
    try { out.message = cap(String(e)); } catch { out.message = 'unserialisable provider error'; }
  }
  return out;
}

// ── in-flight accounting ──────────────────────────────────────────────────────────────────────
//
// Module-scope, per-process — exactly the scope the hypothesis needs: `inFlightAtError` is the
// number of PROVIDER calls (gemini/openrouter; local Ollama is not a provider) in flight in this
// process when an error lands. A per-minute quota is sensitive to simultaneous in-flight calls;
// an IAM denial is not. Without this field the §3 hypothesis stays unfalsifiable.

const inFlight: Record<string, number> = Object.create(null);

export function beginProviderCall(provider: string): void {
  inFlight[provider] = (inFlight[provider] || 0) + 1;
}

/** Floor at 0 — an unmatched end must never produce a negative count. */
export function endProviderCall(provider: string): void {
  inFlight[provider] = Math.max(0, (inFlight[provider] || 0) - 1);
}

export function providerCallsInFlight(): { total: number; by: Record<string, number> } {
  const by: Record<string, number> = {};
  let total = 0;
  for (const k of Object.keys(inFlight)) {
    if (inFlight[k] > 0) { by[k] = inFlight[k]; total += inFlight[k]; }
  }
  return { total, by };
}

// ── the provider_error event payload ──────────────────────────────────────────────────────────

export interface ProviderErrorPayloadInput {
  provider: 'gemini' | 'openrouter';
  label: string | null;
  /** Feature when known; null under tracedChat — the traces row carries it (join on trace_id). */
  feature: string | null;
  fellBackTo: string;
  intendedModel: string | null;
  fallbackModel: string | null;
  /** Resolved region (gemini only; null for openrouter). */
  region: string | null;
  /** SA identity in use — client_email ONLY, never key material (gemini only). */
  saIdentity: string | null;
  error: unknown;
  inFlightAtError: { total: number; by: Record<string, number> };
}

/** One row per provider failure — everything §4.1/§4.2 of the kickoff names, in one object. */
export function providerErrorPayload(i: ProviderErrorPayloadInput): Record<string, unknown> {
  return {
    provider: i.provider,
    label: i.label,
    feature: i.feature,
    fellBackTo: i.fellBackTo,
    intended_model: i.intendedModel,
    fallback_model: i.fallbackModel,
    region: i.region,
    sa_identity: i.saIdentity,
    inFlightAtError: i.inFlightAtError.total,
    in_flight_by_provider: i.inFlightAtError.by,
    ...serializeProviderError(i.error),
  };
}
