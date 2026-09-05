/**
 * lib/mcp-v2/auth.ts — the four keys and the timing-safe compare
 * (LAB-MCP-V2-PRD-v1.0 §3.1, decisions 4 and 5).
 *
 * Decision 4 keeps env-var secrets rather than a principals table: no token minting path,
 * no DB read on the auth hot path, V holds the keys. Decision 5 gives each SCOPE its own
 * key, so the key a caller holds IS its authority — there is no header a client can set
 * to claim a role, and therefore no header a compromised client can lie in.
 *
 * The compare is `timingSafeEqual` on equal-length buffers, matching v1's `labKeyMatches`
 * exactly. It is inherited rather than re-invented (kickoff grounding), including the
 * length pre-check, which leaks only length and is required because timingSafeEqual
 * throws on a length mismatch.
 *
 * ⚠️ V1 AND V2 KEYS ARE DISJOINT. LAB_API_KEY is not accepted here and none of these four
 * is accepted by v1 (§3.1). The two surfaces share no secret, so a v1 key that leaks
 * cannot reach v2's write tools.
 */
import { timingSafeEqual } from 'crypto';
import { KEY_ENV_BY_PRINCIPAL, PRINCIPALS, SCOPES_BY_PRINCIPAL, type Principal, type Scope } from '../lab-v2/contracts';

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try { return timingSafeEqual(ab, bb); } catch { return false; }
}

/** §3.1 — 503 unless at least one of the four is set. Dark by default. */
export function labV2KeysConfigured(): boolean {
  return PRINCIPALS.some((p) => !!process.env[KEY_ENV_BY_PRINCIPAL[p]]);
}

/**
 * Resolve a presented secret to its principal, or null.
 *
 * Every configured key is compared even after a match, so the work done is a function of
 * how many keys are SET, never of which one matched or of how early it appeared. An
 * empty env var for a principal is treated as unset, so a half-configured deployment
 * cannot be authenticated with the empty string.
 */
export function principalFor(presented: string | null | undefined): Principal | null {
  if (!presented) return null;
  let found: Principal | null = null;
  for (const p of PRINCIPALS) {
    const secret = process.env[KEY_ENV_BY_PRINCIPAL[p]];
    if (!secret) continue;
    if (safeEq(presented, secret) && !found) found = p;
  }
  return found;
}

export function scopesFor(principal: Principal): readonly Scope[] {
  return SCOPES_BY_PRINCIPAL[principal];
}
