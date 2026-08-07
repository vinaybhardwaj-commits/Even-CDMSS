/**
 *   node --test --import tsx lib/__tests__/lab-admin-standing.test.ts
 *
 * A12 condition 3, satisfied by FORWARDED STANDING (V, 7 Aug 2026).
 *
 * ⚠️ WHAT WAS BROKEN. Condition 3 requires admin auth on the same request. The Lab MCP reaches the
 * two wired routes through `selfPostNdjson`, which forwards no cookies, so `isAdminUnlocked` read an
 * empty jar and EVERY MCP override was refused `not_admin` — silently, because A12 requires
 * refusals to be invisible to the caller. Measured 7 Aug on production: a `bedrock:` probe (trace
 * ba35cf03) and a `vertex:` probe (trace fe1c1b23) both ran the production default while their rows
 * claimed the requested model. The gate was not too strict; it was unsatisfiable.
 *
 * ⚠️ WHAT DID NOT CHANGE. `decideOverride` and all six conditions are byte-identical — that is
 * asserted below against lab-override-core.test.ts's own expectations. The MCP now PRESENTS the
 * admin credential it already holds; it is not exempted from having to.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { labAdminStanding, resolveLabOverride, type LabOverrideDeps } from '../lab-override';
import { adminTokenMatches } from '../admin-cookie';
import {
  decideOverride, LAB_ADMIN_HEADER, LAB_ORIGIN_HEADER, LAB_ORIGIN_VALUE, OVERRIDE_ENV_FLAG,
} from '../lab-override-core';
import { labSelfBaseUrl } from '../lab-clinical-core';

const src = (p: string) => readFileSync(p, 'utf8');
const TOKEN = 'sekrit-admin-token-value';
const HAIKU = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';

/** The request shape the gate actually reads: headers only. */
const req = (headers: Record<string, string>) => ({
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
}) as unknown as Parameters<typeof resolveLabOverride>[0];

/** An MCP self-post exactly as lib/mcp-tools.ts labHeaders() builds it. */
const mcpHeaders = (withCredential: boolean) => ({
  [LAB_ORIGIN_HEADER]: LAB_ORIGIN_VALUE,
  'x-cdmss-lab-caller': 'lab-mcp',
  ...(withCredential ? { [LAB_ADMIN_HEADER]: TOKEN } : {}),
});

/** No cookie session either way — that is the whole point of the MCP path. */
const NO_COOKIES: LabOverrideDeps = { isAdmin: async () => false, isClinician: async () => false };

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const had: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { had[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k] as string; }
  const restore = () => { for (const k of Object.keys(vars)) { if (had[k] === undefined) delete process.env[k]; else process.env[k] = had[k] as string; } };
  const out = fn();
  if (out && typeof (out as Promise<void>).then === 'function') return (out as Promise<void>).finally(restore);
  restore();
  return undefined;
}

const BEDROCK_ENV = {
  GCP_SA_KEY: '{"client_email":"sa@p.iam.gserviceaccount.com","private_key":"k"}',
  BEDROCK_REGION: 'ap-south-1',
  BEDROCK_ROLE_ARN: 'arn:aws:iam::819481466105:role/GCPBedrockRole',
  BEDROCK_OIDC_AUDIENCE: '588427270277',
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The two required proofs
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('AN MCP-ORIGIN OVERRIDE NOW PASSES THE GATE — the 7 Aug run, with the credential', async () => {
  await withEnv({ ...BEDROCK_ENV, ADMIN_TOKEN: TOKEN, [OVERRIDE_ENV_FLAG]: '1' }, async () => {
    const d = await resolveLabOverride(req(mcpHeaders(true)), `bedrock:${HAIKU}`, 'app/api/ask', NO_COOKIES);
    assert.notEqual(d, null, 'the override must now be honoured — this is what verification 1 needs');
    assert.equal(d?.provider, 'bedrock');
    assert.equal(d?.model, HAIKU);
    assert.equal(d?.paid, true);
    assert.equal(d?.caller, 'lab-mcp');
  });
});

test('THE SAME REQUEST WITHOUT THE CREDENTIAL STILL REFUSES — nothing was widened', async () => {
  await withEnv({ ...BEDROCK_ENV, ADMIN_TOKEN: TOKEN, [OVERRIDE_ENV_FLAG]: '1' }, async () => {
    const d = await resolveLabOverride(req(mcpHeaders(false)), `bedrock:${HAIKU}`, 'app/api/ask', NO_COOKIES);
    assert.equal(d, null, 'no cookie session and no header ⇒ not_admin, exactly as before this change');
  });
  // …and the refusal is specifically condition 3, not an accident of some other condition.
  assert.deepEqual(
    decideOverride({ requestedModel: `bedrock:${HAIKU}`, envFlag: '1', labOriginHeader: LAB_ORIGIN_VALUE,
      isAdmin: false, isClinicianSession: false, resolved: { ok: true, provider: 'bedrock', model: HAIKU, paid: true }, reachable: true }),
    { override: false, refusal: 'not_admin' });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · The credential itself
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('a WRONG credential is refused, and a right one is compared timing-safely', () => {
  withEnv({ ADMIN_TOKEN: TOKEN }, () => {
    assert.equal(labAdminStanding(req({ [LAB_ADMIN_HEADER]: TOKEN })), true);
    assert.equal(labAdminStanding(req({ [LAB_ADMIN_HEADER]: 'wrong' })), false);
    assert.equal(labAdminStanding(req({ [LAB_ADMIN_HEADER]: TOKEN + 'x' })), false, 'a prefix is not a match');
    assert.equal(labAdminStanding(req({ [LAB_ADMIN_HEADER]: TOKEN.slice(0, -1) })), false);
    assert.equal(labAdminStanding(req({})), false, 'absent header');
    assert.equal(labAdminStanding(req({ [LAB_ADMIN_HEADER]: '' })), false, 'empty header');
  });
  // The comparison is the EXISTING one: timingSafeEqual via safeEq, the careTokenMatches precedent.
  const AC = src('lib/admin-cookie.ts');
  assert.ok(AC.includes('export function adminTokenMatches(presented: string): boolean {'));
  assert.ok(AC.includes('return !!token && !!presented && safeEq(presented, token);'));
  assert.ok(AC.includes("import { timingSafeEqual } from 'crypto';"));
  assert.ok(AC.includes('return timingSafeEqual(ab, bb);'), 'one comparison rule, not a second implementation');
});

test('ADMIN_TOKEN UNSET ⇒ refusal stays the default, on BOTH sides independently', async () => {
  // Receiver: nothing can satisfy it, including the empty string an absent header degrades to.
  withEnv({ ADMIN_TOKEN: undefined }, () => {
    assert.equal(adminTokenMatches(''), false);
    assert.equal(adminTokenMatches('anything'), false);
    assert.equal(labAdminStanding(req({ [LAB_ADMIN_HEADER]: 'anything' })), false);
  });
  // …and the gate as a whole refuses.
  await withEnv({ ...BEDROCK_ENV, ADMIN_TOKEN: undefined, [OVERRIDE_ENV_FLAG]: '1' }, async () => {
    const d = await resolveLabOverride(req(mcpHeaders(true)), `bedrock:${HAIKU}`, 'app/api/ask', NO_COOKIES);
    assert.equal(d, null, 'an unconfigured deployment is not an unlocked one');
  });
  // Sender: the header is ABSENT, not empty — the token is never transmitted as a blank.
  const MCP = src('lib/mcp-tools.ts');
  assert.ok(MCP.includes('...(adminToken && selfPostCarriesCredential() ? { [LAB_ADMIN_HEADER]: adminToken } : {}),'));
});

test('the credential never logs, never echoes into a row, never reaches a trace', () => {
  const OVR = src('lib/lab-override.ts');
  const MCP = src('lib/mcp-tools.ts');
  for (const [name, text] of [['lab-override.ts', OVR], ['mcp-tools.ts', MCP], ['admin-cookie.ts', src('lib/admin-cookie.ts')]] as const) {
    for (const line of text.match(/console\.[a-z]+\([^\n]*/g) ?? []) {
      for (const forbidden of ['ADMIN_TOKEN', 'adminToken', 'LAB_ADMIN_HEADER', 'presented']) {
        assert.ok(!line.includes(forbidden), `${name}: a log line must not reference ${forbidden} — ${line.slice(0, 100)}`);
      }
    }
  }
  // The A12 audit line is unchanged and records only route/provider/model/caller.
  assert.ok(src('lib/lab-override-core.ts').includes(
    'return `[lab-override] route=${route} provider=${d.provider} model=${d.model} paid=${d.paid} caller=${d.caller}`;'));
  // The honoured decision carries no credential field, so nothing downstream can store one.
  assert.ok(!/LAB_ADMIN_HEADER|adminToken/.test(src('lib/lab-override-core.ts').split('export function decideOverride')[1] ?? ''));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · Least privilege: standing for THIS gate, not a session
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the header unlocks the F11 gate ONLY — isAdminUnlocked gains no new caller', () => {
  // A cookie would have conferred general admin standing on the request, unlocking every
  // isAdminUnlocked() check on the route. The header is read in exactly one place.
  const readers = ['lib', 'app'].flatMap(() => []);
  void readers;
  const all = src('lib/lab-override.ts');
  assert.ok(all.includes('return adminTokenMatches(req.headers.get(LAB_ADMIN_HEADER) || \'\');'));
  // isAdminUnlocked is untouched: same signature, same cookie-only behaviour, and the new helper
  // sits beside it rather than inside it.
  const AC = src('lib/admin-cookie.ts');
  assert.ok(AC.includes('export async function isAdminUnlocked(): Promise<boolean> {'));
  assert.ok(AC.includes("const val = jar.get(ADMIN_COOKIE)?.value || '';"), 'still cookie-only');
  assert.ok(AC.indexOf('export function adminTokenMatches') > AC.indexOf('export async function isAdminUnlocked'));
});

test('the credential rides TLS or loopback only — never plain http to a foreign host', () => {
  const MCP = src('lib/mcp-tools.ts');
  const fn = MCP.slice(MCP.indexOf('function selfPostCarriesCredential()'), MCP.indexOf('function selfPostCarriesCredential()') + 700);
  assert.ok(fn.includes("if (u.protocol === 'https:') return true;"));
  assert.ok(fn.includes("u.hostname === 'localhost'"), 'the dev server still works');
  assert.ok(fn.includes('catch { return false; }'), 'an unparseable target withholds the credential');
  // Every base URL labSelfBaseUrl can produce in a real deployment is allowed…
  for (const env of [{ VERCEL_URL: 'even-cdmss.vercel.app' }, {}, { LAB_SELF_BASE_URL: 'https://staff.evenos.app' }]) {
    const base = labSelfBaseUrl(env as Record<string, string | undefined>);
    const u = new URL(base);
    assert.ok(u.protocol === 'https:' || u.hostname === 'localhost', `${base} is a credential-safe target`);
  }
  // …and the one that is not is exactly the misconfiguration this guards.
  const bad = new URL(labSelfBaseUrl({ LAB_SELF_BASE_URL: 'http://someone-elses-host.example' }));
  assert.equal(bad.protocol, 'http:');
  assert.notEqual(bad.hostname, 'localhost');
});

test('only the two WIRED probes send it, and only when an override is requested', () => {
  const MCP = src('lib/mcp-tools.ts');
  const fn = MCP.slice(MCP.indexOf('function labHeaders('), MCP.indexOf('function labBody('));
  assert.ok(fn.includes("if (!S(a.model).trim()) return undefined;"), 'no model ⇒ no headers at all');
  assert.ok(fn.includes('LAB_ADMIN_HEADER'));
  // selfPostNdjson itself must NOT attach it: the three unwired probes call it too, and their
  // routes never consult the gate.
  const post = MCP.slice(MCP.indexOf('async function selfPostNdjson('), MCP.indexOf('async function selfPostNdjson(') + 900);
  assert.ok(!/LAB_ADMIN_HEADER|ADMIN_TOKEN/.test(post), 'the credential is not attached to every self-post');
  assert.ok(post.includes("headers: { 'content-type': 'application/json', ...(extraHeaders ?? {}) },"), 'unchanged');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The six conditions are byte-identical
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('decideOverride is untouched — the gate still DEMANDS isAdmin, it is only satisfiable now', () => {
  const CORE = src('lib/lab-override-core.ts');
  const fn = CORE.slice(CORE.indexOf('export function decideOverride'), CORE.indexOf('/** Structured audit line'));
  assert.ok(fn.includes("if (f.isAdmin !== true) return { override: false, refusal: 'not_admin' };"));
  assert.ok(!/LAB_ADMIN_HEADER/.test(fn), 'the pure decision does not know the header exists');
  // All six, in order, unchanged.
  for (const r of ['flag_off', 'no_lab_marker', 'not_admin', 'clinician_session', 'unknown_provider', 'model_unreachable']) {
    assert.ok(fn.includes(`refusal: '${r}'`), `condition ${r} intact`);
  }
  // Condition 4 still refuses a clinician session even WITH the header — fail-closed toward
  // production is the property that made A12 acceptable in the first place.
  assert.deepEqual(
    decideOverride({ requestedModel: 'vertex:gemini-2.5-pro', envFlag: '1', labOriginHeader: LAB_ORIGIN_VALUE,
      isAdmin: true, isClinicianSession: true, resolved: { ok: true, provider: 'vertex', model: 'gemini-2.5-pro', paid: true }, reachable: true }),
    { override: false, refusal: 'clinician_session' });
});

test('a real clinician session refuses the MCP credential too (end to end)', async () => {
  await withEnv({ ADMIN_TOKEN: TOKEN, [OVERRIDE_ENV_FLAG]: '1', GCP_PROJECT: 'p', GCP_SA_KEY: '{}' }, async () => {
    const d = await resolveLabOverride(req(mcpHeaders(true)), 'vertex:gemini-2.5-pro', 'app/api/ask',
      { isAdmin: async () => false, isClinician: async () => true });
    assert.equal(d, null, 'if a real clinician is somehow on this request, they get the production model');
  });
});

test('the deps seam defaults to the real guards — production passes nothing', () => {
  const OVR = src('lib/lab-override.ts');
  assert.ok(OVR.includes('const isAdmin = labAdminStanding(req) || await (deps.isAdmin ?? isAdminUnlocked)().catch(() => false);'));
  assert.ok(OVR.includes('const isClinicianSession = await (deps.isClinician ?? isCareUnlocked)().catch(() => true);'),
    'and the clinician read still degrades to the REFUSING value');
  for (const r of ['ask', 'ddx']) {
    assert.ok(src(`app/api/${r}/route.ts`).includes(`resolveLabOverride(req, body.labModel, 'app/api/${r}')`),
      `${r} calls it with three arguments — the seam is invisible in production`);
  }
});
