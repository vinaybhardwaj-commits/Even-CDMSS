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

export const LAB_PROVIDERS = ['ollama', 'openrouter', 'vertex'] as const;
export type LabProvider = (typeof LAB_PROVIDERS)[number];

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
