/**
 * Vertex AI access-token minting — pure Node `crypto`, NO new npm dependency.
 *
 * Implements the Google service-account 2-legged OAuth (JWT-bearer) flow:
 *   1. Build an RS256-signed JWT asserting the service account identity, scoped
 *      to cloud-platform.
 *   2. Exchange it at the token endpoint for a short-lived (1h) access token.
 *   3. Cache the token in module scope and refresh ~5 min before expiry.
 *
 * Credentials come from env `GCP_SA_KEY` = the full service-account JSON key
 * (the object Google hands you when you create the key), set in Vercel. The
 * secret is never logged. If GCP_SA_KEY is absent/malformed this throws, and the
 * caller (tracedChat) falls back to the local Ollama path — so a missing
 * credential degrades to "Gemini off", never to a broken request.
 */
import { createSign } from 'crypto';

type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

let cached: { token: string; expiresAt: number } | null = null;
/** ID-token cache, keyed by audience (§3.1 of the Bedrock reference). Separate from `cached`
 *  above: an ID token and an access token are different credentials for different callees, and
 *  one map per audience means a second audience can never be served a token minted for the first. */
const idTokenCache = new Map<string, { token: string; expiresAt: number }>();

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function loadServiceAccount(): ServiceAccount {
  const raw = process.env.GCP_SA_KEY;
  if (!raw) throw new Error('GCP_SA_KEY not set');
  let sa: ServiceAccount;
  try {
    // Accept either raw JSON or base64-encoded JSON (Vercel env values with
    // embedded newlines are fiddly — base64 is the safe way to paste a key).
    const text = raw.trim().startsWith('{')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf8');
    sa = JSON.parse(text);
  } catch {
    throw new Error('GCP_SA_KEY is not valid JSON (or base64 JSON)');
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error('GCP_SA_KEY missing client_email/private_key');
  }
  // PEM keys pasted into env often arrive with literal "\n" — normalise.
  sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  return sa;
}

/**
 * The SA identity in use — client_email ONLY, never key material (403-diagnosis kickoff §4.1:
 * a provider_error record must name WHICH identity Vertex refused). Null when GCP_SA_KEY is
 * absent or unparseable; never throws.
 */
export function vertexSaEmail(): string | null {
  try { return loadServiceAccount().client_email || null; } catch { return null; }
}

/**
 * Returns a valid cloud-platform access token, minting+caching a fresh one when
 * needed. Throws if credentials are missing/invalid or the token exchange fails.
 */
export async function getVertexAccessToken(): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt - 5 * 60_000 > now) {
    return cached.token;
  }

  const sa = loadServiceAccount();
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: tokenUri,
      iat,
      exp,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = b64url(
    createSign('RSA-SHA256').update(signingInput).sign(sa.private_key),
  );
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Vertex token exchange failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('Vertex token exchange returned no access_token');

  cached = {
    token: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600) * 1000,
  };
  return cached.token;
}

/**
 * A Google **ID token** for `audience` — the first leg of the Bedrock chain (AWS STS
 * `AssumeRoleWithWebIdentity` trusts this token; see lib/bedrock.ts).
 *
 * The SAME RS256 JWT-bearer exchange `getVertexAccessToken` performs above, with exactly two
 * differences, both of which are the whole reason this cannot just call that function:
 *   1. the assertion carries `target_audience: <audience>` instead of `scope`;
 *   2. the response field is `id_token`, not `access_token`.
 *
 * Cached per audience, refreshed 5 minutes before expiry — same discipline, same numbers. The
 * token is never logged. Google's ID tokens carry no `expires_in` on this exchange, so the 1-hour
 * validity we asserted in the claims IS the expiry (`exp = iat + 3600`), and we cache to it.
 *
 * ADDITIVE: `getVertexAccessToken` above is byte-identical to before this function existed.
 */
export async function getGcpIdToken(audience: string): Promise<string> {
  const aud = String(audience ?? '').trim();
  if (!aud) throw new Error('getGcpIdToken: audience is required');

  const now = Date.now();
  const hit = idTokenCache.get(aud);
  if (hit && hit.expiresAt - 5 * 60_000 > now) return hit.token;

  const sa = loadServiceAccount();
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      // ⚠️ target_audience, NOT scope — this is what makes the exchange return an ID token.
      target_audience: aud,
      aud: tokenUri,
      iat,
      exp,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = b64url(
    createSign('RSA-SHA256').update(signingInput).sign(sa.private_key),
  );
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) {
    // The BODY is the diagnosis (403-diagnosis §4.1) — a misconfigured audience and a disabled
    // key read identically without it. It carries no token material.
    const detail = await res.text().catch(() => '');
    throw new Error(`Google ID-token exchange failed for audience ${aud} (${res.status}): ${detail.slice(0, 300)}`);
  }

  const json = (await res.json()) as { id_token?: string; expires_in?: number };
  if (!json.id_token) throw new Error(`Google ID-token exchange returned no id_token for audience ${aud}`);

  idTokenCache.set(aud, { token: json.id_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 });
  return json.id_token;
}
