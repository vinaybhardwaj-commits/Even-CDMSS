/**
 * lib/llm-cost-core.ts — LLM cost model CORE (pure).
 *
 * Turns logged token counts (trace_events.payload.usage) into rupees, using an editable price
 * table (data/llm-pricing.json, loaded + fx-overridden in the wired lib/llm-cost.ts). PURE +
 * dependency-free so it unit-tests under `node --experimental-strip-types`. All arithmetic here
 * is deterministic; the wired layer only supplies the SQL-summed tokens + the pricing object.
 *
 * Tiering: Gemini 2.5 Pro list price steps up above a 200k-token prompt. `hi` selects the high
 * tier — per call it's `inTok > hiThresholdTokens`; for pre-bucketed aggregates the SQL groups by
 * that boolean so the right rate is applied without losing tiering.
 */

export interface ModelPrice {
  match: string;              // substring matched (case-insensitive) against the logged model name
  label: string;
  inUsdPerM: number;          // USD per 1M input tokens
  outUsdPerM: number;         // USD per 1M output tokens
  hiThresholdTokens?: number; // prompt size above which the high tier applies
  hiInUsdPerM?: number;
  hiOutUsdPerM?: number;
}
export interface Pricing {
  fxUsdInr: number;
  models: ModelPrice[];
  fallback: Omit<ModelPrice, 'match'>;
}

/** The price row whose `match` substring appears in the model name (else the fallback). */
export function priceFor(model: string, pricing: Pricing): Omit<ModelPrice, 'match'> {
  const m = (model || '').toLowerCase();
  return pricing.models.find((p) => m.includes(p.match.toLowerCase())) ?? pricing.fallback;
}

/** Input/output $/1M rates for a model at the base or high tier. */
export function ratesFor(model: string, hi: boolean, pricing: Pricing): { inRate: number; outRate: number; label: string } {
  const p = priceFor(model, pricing);
  const useHi = hi && p.hiInUsdPerM != null && p.hiOutUsdPerM != null;
  return { inRate: useHi ? (p.hiInUsdPerM as number) : p.inUsdPerM, outRate: useHi ? (p.hiOutUsdPerM as number) : p.outUsdPerM, label: p.label };
}

export function modelLabel(model: string, pricing: Pricing): string { return priceFor(model, pricing).label; }

/** ₹ cost for a token count at an explicit tier (used for SQL-bucketed aggregates). */
export function costInr(model: string, inTok: number, outTok: number, hi: boolean, pricing: Pricing): number {
  const { inRate, outRate } = ratesFor(model, hi, pricing);
  const usd = ((Number(inTok) || 0) * inRate + (Number(outTok) || 0) * outRate) / 1_000_000;
  return usd * pricing.fxUsdInr;
}

/** ₹ cost for a single call, choosing the tier from its own prompt size. */
export function perCallInr(model: string, inTok: number, outTok: number, pricing: Pricing): number {
  const p = priceFor(model, pricing);
  const hi = p.hiThresholdTokens != null && (Number(inTok) || 0) > p.hiThresholdTokens;
  return costInr(model, inTok, outTok, hi, pricing);
}

/** ₹ with Indian grouping; compact for large sums. `paise` keeps 2dp for tiny per-call amounts. */
export function fmtInr(n: number, opts: { paise?: boolean } = {}): string {
  const v = Number(n) || 0;
  if (opts.paise && v < 100) return `₹${v.toFixed(2)}`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
}
