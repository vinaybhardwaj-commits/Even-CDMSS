/**
 * lib/lab-override.ts — IMPURE wrapper around the F11 provider-override gate (addendum A12).
 *
 * The DECISION lives in lib/lab-override-core.ts (pure, zero imports, 13 tests). This module only
 * gathers the facts that decision needs — env, header, admin cookie, clinician cookie, provider
 * resolution, reachability — and hands them over. Splitting it this way is what makes a gate
 * guarding five clinician-facing routes exhaustively testable without a server.
 *
 * ⚠️ THE CONTRACT: `resolveLabOverride` returns `null` for "no override", and a null result MUST
 * leave the calling route byte-identical to today. It never throws — every failure path inside it is
 * caught and degrades to null, because a gate fault must produce production behaviour, never an
 * error in a clinical response.
 */
import type { NextRequest } from 'next/server';
import { isAdminUnlocked } from './admin-cookie';
import { isCareUnlocked } from './care-cookie';
import { geminiConfigured, openrouterConfigured, MINI_MODEL } from './llm';
import { resolveProvider } from './lab-provider-core';
import {
  decideOverride, overrideAuditLine, shouldLogRefusal,
  OVERRIDE_ENV_FLAG, LAB_ORIGIN_HEADER,
  type OverrideDecision,
} from './lab-override-core';

export type HonouredOverride = Extract<OverrideDecision, { override: true }>;

/**
 * CONDITION 6 — reachability. This is a CONFIGURATION probe, and the naming is deliberate: it
 * verifies the provider is actually wired up in this deployment (credentials present), NOT that the
 * remote endpoint is live right now.
 *
 * WHY NOT A LIVENESS PING. A network round-trip here sits on the request path of a route that also
 * serves clinicians. The failure it would catch — provider up at probe time, down 200ms later — is
 * not eliminated by probing anyway, while the latency and the new failure mode are certain. A
 * misconfigured provider is the realistic failure and this catches it deterministically.
 *
 * If the call later fails at generation time, the governed layer's existing fallback handles it the
 * same way it handles any provider error today. Reported as a deviation, not smuggled in.
 */
export function probeReachable(provider: string): boolean {
  try {
    if (provider === 'ollama') return !!MINI_MODEL;          // the local default path
    if (provider === 'vertex') return geminiConfigured();
    if (provider === 'openrouter') return openrouterConfigured();
    // BEDROCK (PROVIDER-SWITCH PRD §4.2, 2 Aug 2026) — catalogued but NOT YET REACHABLE. It resolves
    // (`bedrock:anthropic.claude-x` parses) and returns false here, so the override is refused with
    // a typed reason instead of silently running somewhere else. Both vars are required, following
    // the vertex precedent (geminiConfigured checks GCP_PROJECT *and* GCP_SA_KEY): a Bedrock call
    // cannot be addressed without a region, so a key alone is not "reachable".
    // ⚠️ BEDROCK_REGION deliberately, NOT AWS_REGION — Vercel's runtime sets AWS_REGION itself, so
    // gating on it would read as half-configured on every deploy. Until Unit C builds the client,
    // neither var is set anywhere and this is false by construction.
    if (provider === 'bedrock') return Boolean(process.env.BEDROCK_API_KEY && process.env.BEDROCK_REGION);
    return false;
  } catch { return false; }
}

/**
 * Gather the six facts and decide. `route` is used only for the audit line.
 *
 * Returns the honoured override, or null. NEVER throws.
 */
export async function resolveLabOverride(
  req: NextRequest,
  requestedModel: unknown,
  route: string,
): Promise<HonouredOverride | null> {
  try {
    const requested = requestedModel == null ? '' : String(requestedModel).trim();
    // Short-circuit before touching cookies/env: the overwhelmingly common path is "no override",
    // and it must cost nothing and depend on nothing.
    if (!requested) return null;

    // Cookie reads are independently fail-safe: an unreadable cookie must not open the gate, so
    // isAdmin degrades to false and isClinicianSession degrades to TRUE (the refusing value).
    const isAdmin = await isAdminUnlocked().catch(() => false);
    const isClinicianSession = await isCareUnlocked().catch(() => true);

    const r = resolveProvider(requested, MINI_MODEL);
    const resolved = r.ok ? { ok: true as const, provider: r.provider, model: r.model, paid: r.paid } : { ok: false as const };
    const reachable = r.ok ? probeReachable(r.provider) : false;

    const decision = decideOverride({
      requestedModel: requested,
      envFlag: process.env[OVERRIDE_ENV_FLAG] ?? null,
      labOriginHeader: req.headers.get(LAB_ORIGIN_HEADER),
      isAdmin,
      isClinicianSession,
      resolved,
      reachable,
      caller: req.headers.get('x-cdmss-lab-caller') || 'lab-mcp',
    });

    if (decision.override) {
      // A12: every honoured override logs route · provider · RESOLVED model · caller.
      console.info(overrideAuditLine(route, decision));
      return decision;
    }
    if (shouldLogRefusal(decision.refusal)) {
      // Refusals are observable to operators but NEVER surfaced to the caller.
      console.info(`[lab-override] route=${route} REFUSED reason=${decision.refusal}`);
    }
    return null;
  } catch (e) {
    // A fault in the gate itself must produce production behaviour, not an error.
    console.warn('[lab-override] gate error — falling through to production default', String((e as Error).message).slice(0, 160));
    return null;
  }
}

/**
 * Map an honoured override onto the governedChat routing opts a route already passes.
 *
 * ADDITIVE BY CONSTRUCTION: with no override this returns `{}`, so a call site written as
 * `{ gemini: G, ...labRoutingOpts(ovr) }` is byte-identical to `{ gemini: G }` — same single key,
 * same value. That is what the per-route byte-identity test asserts.
 *
 * An openrouter or ollama override must also CLEAR `gemini`, or the governed layer would still see a
 * Gemini model and prefer it.
 */
export function labRoutingOpts(ovr: HonouredOverride | null): { gemini?: string | undefined; openrouter?: string } {
  if (!ovr) return {};
  if (ovr.provider === 'vertex') return { gemini: ovr.model };
  if (ovr.provider === 'openrouter') return { gemini: undefined, openrouter: ovr.model };
  return { gemini: undefined };   // ollama — force the local mini
}
