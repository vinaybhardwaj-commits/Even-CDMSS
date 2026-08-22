/**
 * lib/__tests__/d2-r3-auth.test.ts — D2 commit 2 (Saul Rep 48): strict R3 authentication, and
 * schema DDL that no longer borrows the feature flag's dormancy.
 *
 * ⚠️ WHAT WAS WRONG. Both R3 routes checked the FEATURE FLAG before authentication, and their own
 * doc blocks said why: `requireAdmin()` FAILS OPEN when ADMIN_TOKEN is unset — "if unset (dev
 * mode), allow all" — so auth was not what made them dormant. The flag was. That is a real
 * argument, and it means the flag was doing security's job while also meaning "is the feature on",
 * which are different questions with different answers.
 *
 * ⚠️ EACH CASE RUNS IN A CHILD PROCESS. `ADMIN_TOKEN` and the flag are read at request time, and a
 * case that mutated `process.env` in the shared test process would leak into its neighbours and
 * could not prove the four-way combination cleanly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const SELF = fileURLToPath(import.meta.url);
const FLAG = 'LVC_RULE_GOVERNANCE_ENABLED';
const TOKEN = 'a-configured-admin-token';

interface ChildResult { status: number; body: Record<string, unknown>; out: string }

function runRoute(route: 'migrate' | 'propose', env: Record<string, string | undefined>, query = ''): ChildResult {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) {
    if (v !== undefined) childEnv[k] = String(v);
  }
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];
  // The runner's own variables must not reach the child, or it re-enters the test runner and
  // emits serialized events instead of a result.
  for (const k of Object.keys(childEnv)) if (k.startsWith('NODE_TEST_')) delete childEnv[k];
  const r = spawnSync(process.execPath, ['--import', 'tsx', SELF, '--route-child', route, `--query=${query}`],
    { encoding: 'utf8', env: childEnv as NodeJS.ProcessEnv });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `child produced no RESULT line.\n${out}`);
  const parsed = JSON.parse(line.slice('RESULT '.length)) as { status: number; body: Record<string, unknown> };
  return { status: parsed.status, body: parsed.body, out };
}

async function child(): Promise<void> {
  const which = process.argv[process.argv.indexOf('--route-child') + 1];
  const q = (process.argv.find((a) => a.startsWith('--query=')) ?? '--query=').slice('--query='.length);
  const { NextRequest } = await import('next/server');
  const url = `https://cdmss.invalid/api/admin/x${q ? `?${q}` : ''}`;
  let res: Response;
  if (which === 'migrate') {
    const { GET } = await import('../../app/api/admin/migrate-rule-governance/route.ts');
    res = await (GET as (r: unknown) => Promise<Response>)(new NextRequest(url, { method: 'GET' }));
  } else {
    const { POST } = await import('../../app/api/admin/rule-governance/propose-pattern/route.ts');
    res = await (POST as (r: unknown) => Promise<Response>)(
      new NextRequest(url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }));
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { body = { unparseable: true }; }
  process.stdout.write(`RESULT ${JSON.stringify({ status: res.status, body })}\n`);
}

if (process.argv.includes('--route-child')) {
  void child().catch((e) => {
    process.stdout.write(`RESULT ${JSON.stringify({ status: -1, body: { threw: String((e as Error).message) } })}\n`);
  });
} else {

test('D2.13 — the MIGRATION route refuses with ADMIN_TOKEN UNSET, flag set or unset — all four combinations', () => {
  // §3 item 12. The four combinations, named, because the whole point is that the answer no longer
  // depends on the flag.
  const cases: Array<[string, Record<string, string | undefined>]> = [
    ['token unset, flag unset', { ADMIN_TOKEN: undefined, [FLAG]: undefined }],
    ['token unset, flag set', { ADMIN_TOKEN: undefined, [FLAG]: '1' }],
    ['token unset, flag "0"', { ADMIN_TOKEN: undefined, [FLAG]: '0' }],
    ['token set but NOT PRESENTED, flag set', { ADMIN_TOKEN: TOKEN, [FLAG]: '1' }],
  ];
  for (const [label, env] of cases) {
    const r = runRoute('migrate', env);
    assert.equal(r.status, 401, `${label}: must refuse`);
  }
  // ⚠️ AND THE UNCONFIGURED CASE SAYS SO, distinctly. An operator must be able to tell "you did not
  // present a token" from "this deployment has no token, so nobody can authenticate".
  const unconfigured = runRoute('migrate', { ADMIN_TOKEN: undefined, [FLAG]: '1' });
  assert.match(String(unconfigured.body.error), /not configured/);
  const notPresented = runRoute('migrate', { ADMIN_TOKEN: TOKEN, [FLAG]: '1' });
  assert.match(String(notPresented.body.error), /admin token required/);
});

test('D2.14 — the MIGRATION route SUCCEEDS with a valid credential and the FLAG UNSET', () => {
  // §3 item 13, and the heart of §2: schema creation no longer borrows the flag's dormancy.
  // Creating tables and enabling the feature are different decisions.
  const r = runRoute('migrate', {
    ADMIN_TOKEN: TOKEN, [FLAG]: undefined,
    DATABASE_URL: 'postgresql://stub:stub@stub.invalid/stub',
  }, `token=${TOKEN}`);
  // It gets PAST auth and the flag and reaches the DDL, which then fails on the fictional host.
  // A 404 would mean the flag still gates it; a 401 would mean auth refused a valid credential.
  assert.notEqual(r.status, 404, 'the flag must no longer gate the schema route');
  assert.notEqual(r.status, 401, 'a valid credential must be accepted');
  assert.equal(r.status, 500, 'it reached the DDL and failed on the fictional database');
});

test('D2.15 — the PROPOSE route still refuses when the FLAG is unset, even with a valid credential', () => {
  // §3 item 14. The proposal route performs an OPERATIONAL write, so it stays exact-flag gated.
  const r = runRoute('propose', { ADMIN_TOKEN: TOKEN, [FLAG]: undefined }, `token=${TOKEN}`);
  assert.equal(r.status, 404, 'flag unset ⇒ 404, credential notwithstanding');
  // …and it ALSO refuses an unconfigured deployment, so it gained the strict gate too.
  const noToken = runRoute('propose', { ADMIN_TOKEN: undefined, [FLAG]: '1' });
  assert.equal(noToken.status, 401);
  assert.match(String(noToken.body.error), /not configured/);
});

test('D2.16 — requireAdmin KEEPS its fail-open semantics for unrelated routes', () => {
  // §2: Rep 48 chose a governance-specific helper over a global change, because the fail-open
  // branch is load-bearing for local development on every other admin route. Asserted on the
  // source of the original function, which must be untouched.
  const src = readFileSync('lib/admin-gate.ts', 'utf8');
  assert.match(src, /export function requireAdmin\(req: NextRequest\): NextResponse \| null \{\n\s*const expected = process\.env\.ADMIN_TOKEN;\n\s*if \(!expected\) return null; \/\/ dev mode/,
    'requireAdmin must still allow all when ADMIN_TOKEN is unset');
  assert.match(src, /export function requireConfiguredAdmin/, 'and the strict helper is a SECOND function');
});

test('D2.17 — neither R3 route admits the admin COOKIE any more', () => {
  // A browser session does not depend on a configured credential, so admitting it would reintroduce
  // the path being closed. Checked on code with comments stripped — the doc blocks discuss the
  // cookie, and a raw scan would read the explanation as the defect.
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  for (const f of [
    'app/api/admin/migrate-rule-governance/route.ts',
    'app/api/admin/rule-governance/propose-pattern/route.ts',
  ]) {
    const code = strip(readFileSync(f, 'utf8'));
    assert.doesNotMatch(code, /isAdminUnlocked/, `${f} must not consult the admin cookie`);
    assert.match(code, /requireConfiguredAdmin\(req\)/, `${f} must use the strict helper`);
    assert.doesNotMatch(code, /requireAdmin\(req\)/, `${f} must not use the fail-open helper`);
  }
});

test('D2.18 — ONLY the schema flag gate was removed: every operational write stays exact-flag gated', () => {
  // ⚠️ COMMENTS STRIPPED. This failed first because the doc comment RECORDING that assertEnabled()
  // was removed contains the words `assertEnabled()`. A pin that reads prose reads the explanation
  // as the thing it explains — the recurring trap in this codebase, and the reason the explanation
  // must stay sayable rather than be deleted to satisfy a scan.
  const raw = readFileSync('lib/rule-governance-store.ts', 'utf8');
  const store = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const bodyOf = (fn: string) => {
    const i = store.indexOf(`export async function ${fn}`);
    assert.ok(i > 0, `${fn} exists`);
    return store.slice(i, store.indexOf('\n}\n', i));
  };
  // …and the explanation IS still there, in the prose.
  assert.match(raw, /NO .?assertEnabled\(\).? HERE ANY MORE/);
  assert.doesNotMatch(bodyOf('ensureRuleGovernanceTables'), /assertEnabled\(\)/,
    'schema DDL is authenticated, not flag-gated');
  for (const fn of ['proposePatternAsRule', 'bootstrapRuleVersions']) {
    assert.match(bodyOf(fn), /assertEnabled\(\);/, `${fn} must stay exact-flag gated`);
  }
});

test('D2.19 — flag off ⇒ ZERO store writes, proven behaviourally by a runner that counts', async () => {
  // §3 item 15. Not a source inspection: the runner records every call it receives, and the
  // assertion is that it received none.
  const { proposePatternAsRule } = await import('../rule-governance-store');
  const saved = process.env[FLAG];
  delete process.env[FLAG];
  const calls: unknown[] = [];
  const runner = (async (t: string) => { calls.push(t); return []; }) as never;
  try {
    await assert.rejects(() => proposePatternAsRule({
      ruleRef: 'r', statement: 's', precondition: null, rationale_text: null, evidence_note: null,
      category: 'c', action_type: 'a', keywords: [], lvpPatternId: 'pattern:c-1',
      snapshot: { pattern_id: 'pattern:c-1', concept_id: 'c-1' } as never,
      evidence: { ratified_by: 'V (Dr Vinay Bhardwaj)', rationale: 'r', sample_size: 1,
                  reviewed_n: 1, sample_seed: 's', n_not_belonging: 0 },
    }, runner), /disabled/);
  } finally { if (saved !== undefined) process.env[FLAG] = saved; }
  assert.equal(calls.length, 0, 'flag off must send no statement at all');
});

test('D2.20 — bootstrap and the activation writer still have ZERO production callers', () => {
  // §3 item 16, and §2 says REPORT the count rather than assert it — so the count is emitted and
  // the assertion is only that the sweep ran over a real file set.
  const { execSync } = require('node:child_process') as typeof import('node:child_process');
  const files = execSync("git ls-files 'lib/**/*.ts' 'app/**/*.ts' 'app/**/*.tsx' 'scripts/**/*.mjs'",
    { encoding: 'utf8' }).split('\n').filter(Boolean)
    .filter((f) => !f.includes('__tests__') && f !== 'lib/rule-governance-store.ts');
  const strip = (s: string) => s
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  const callersOf = (name: string) =>
    files.filter((f) => new RegExp(name).test(strip(readFileSync(f, 'utf8'))));
  const bootstrap = callersOf('bootstrapRuleVersions');
  const activation = callersOf('recordActivationEvent');
  // REPORTED, per §2.
  console.log(`ZERO-CALLER COUNT — bootstrapRuleVersions: ${bootstrap.length}`
    + ` | recordActivationEvent: ${activation.length} (absent on this branch; it is r3a2's unit)`
    + ` | files swept: ${files.length}`);
  assert.ok(files.length > 100, 'the sweep must cover a real file set, not an empty one');
  assert.deepEqual(bootstrap, []);
  assert.deepEqual(activation, []);
});

}
