/**
 * lib/__tests__/telemetry-overhead-guard.test.ts — the five guards on the temporary measurement
 * route, each proven by execution (addendum v4 §3, §6, §10).
 *
 * ⚠️ EVERY CASE RUNS IN A CHILD PROCESS. Three of the five guards read `process.env` at request
 * time and one reads the clock, and a serverless request IS one process — so a case that mutated
 * `process.env` in the shared test process would prove less and could leak into its neighbours.
 * Each child gets its own environment, and guard 5's child gets its own `Date.now`.
 *
 * ⚠️ NO SOCKET IS OPENED, TO ANY HOST. The child installs `telemetry-db-stub`, which replaces
 * `globalThis.fetch` — the transport the Neon driver uses — before the route runs. So even the
 * all-guards-pass case, which proceeds into the DDL and a measurement cell, never leaves the
 * process. `DATABASE_URL` in these cases is a syntactically valid but entirely fictional endpoint.
 *
 * ⚠️ THE ROUTE THIS TESTS IS TEMPORARY AND IS OWED A DELETION (addendum v4 §12). When
 * `app/api/admin/telemetry-overhead/route.ts` goes, this file goes with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

/** A fictional but well-formed Neon connection string. Nothing ever connects to it. */
const FAKE_ENDPOINT = 'ep-measure-branch-000001';
const FAKE_DB_URL = `postgresql://cdmss_user:s3cr3t-p%40ssword@${FAKE_ENDPOINT}.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`;
/** A different, equally fictional endpoint standing in for production's. */
const OTHER_ENDPOINT = 'ep-production-primary-999999';

/** The parts of the connection string that must never appear in any response, in any case. */
const SECRETS = [
  FAKE_DB_URL, 'cdmss_user', 's3cr3t-p%40ssword', 's3cr3t-p@ssword',
  'ap-southeast-1.aws.neon.tech', 'neondb', FAKE_ENDPOINT,
];

const BASE_ENV = {
  VERCEL_ENV: 'preview',
  VERCEL_GIT_COMMIT_REF: 'exp/rerank-telemetry',
  CDMSS_OVERHEAD_MEASURE: '1',
  CDMSS_OVERHEAD_DB_ENDPOINT: FAKE_ENDPOINT,
  DATABASE_URL: FAKE_DB_URL,
};

interface ChildResult { status: number; body: Record<string, unknown>; raw: string }

/** Run one request in a fresh process with the given environment. */
function runGuardChild(env: Record<string, string | undefined>, args: string[] = []): ChildResult {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...BASE_ENV, ...env })) {
    if (v !== undefined) childEnv[k] = String(v);
  }
  // An explicit `undefined` in `env` means UNSET, which is a distinct case from "set to empty".
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];

  const r = spawnSync(process.execPath, ['--import', 'tsx', SELF, '--guard-child', ...args], {
    encoding: 'utf8', env: childEnv as unknown as NodeJS.ProcessEnv,
  });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `child produced no RESULT line.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const parsed = JSON.parse(line.slice('RESULT '.length)) as { status: number; body: Record<string, unknown> };
  return { status: parsed.status, body: parsed.body, raw: line };
}

// ── the child ──────────────────────────────────────────────────────────────────────────────────
async function runChild(): Promise<void> {
  const nowArg = process.argv.find((a) => a.startsWith('--now='));
  if (nowArg) {
    const fixed = Number(nowArg.slice('--now='.length));
    Date.now = () => fixed;                       // guard 5's clock, before the route is imported
  }
  const { installDbStub } = await import('./telemetry-db-stub.ts');
  installDbStub();                                // replaces globalThis.fetch — no socket, ever
  const { NextRequest } = await import('next/server');
  const { POST } = await import('../../app/api/admin/telemetry-overhead/route.ts');

  const url = 'https://cdmss.invalid/api/admin/telemetry-overhead?cell=declare&max=8&conc=8&n=2';
  const res = await POST(new NextRequest(url, { method: 'POST' }));
  let body: unknown = null;
  try { body = await res.json(); } catch { body = { unparseable: true }; }
  process.stdout.write(`RESULT ${JSON.stringify({ status: res.status, body })}\n`);
}

if (process.argv.includes('--guard-child')) {
  void runChild().catch((e) => {
    process.stdout.write(`RESULT ${JSON.stringify({ status: -1, body: { childThrew: String((e as Error).message) } })}\n`);
  });
} else {
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // The five guards
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  test('GUARD 1 — admin: a set ADMIN_TOKEN with nothing presented is refused, and isAdminUnlocked is NOT consulted', () => {
    const r = runGuardChild({ ADMIN_TOKEN: 'a-token-not-presented' });
    assert.equal(r.status, 401);
    // ⚠️ THE SOURCE CLAIM ALONGSIDE THE BEHAVIOUR. The migration route admits an admin browser
    // session via the admin cookie; this route must not, because that turns a credential into a
    // session. Asserted as an absence, since no request can prove a branch that is not there.
    //
    // ⚠️ AND IT IS CHECKED ON CODE, NOT ON PROSE. The route's own comment explains WHY it omits
    // that clause, so it names the function — and a raw-text search read that explanation as the
    // defect it warns against. Found by running it. This is the third time in this workstream a
    // text-level check has had to decide whether comments are in scope: the import scanner in pass
    // 1, the call-form pin in pass 2, and this.
    const code = readRouteCode();
    assert.equal(/isAdminUnlocked/.test(code), false, 'the route must not consult the admin cookie');
    assert.match(code, /const denied = requireAdmin\(req\);\n\s*if \(denied\) return denied;/);
  });

  test('GUARD 2 — preview: VERCEL_ENV=production is refused even with everything else correct', () => {
    const r = runGuardChild({ VERCEL_ENV: 'production' });
    assert.equal(r.status, 403);
    assert.equal(r.body.refused, 'not_preview');
  });

  test('GUARD 2 — preview: VERCEL_ENV=preview on a DIFFERENT branch is refused', () => {
    // The clause that matters: a Preview build carries VERCEL_ENV=preview baked in and can later be
    // PROMOTED to production, which would serve production traffic from a build the environment
    // label alone would admit.
    const r = runGuardChild({ VERCEL_GIT_COMMIT_REF: 'main' });
    assert.equal(r.status, 403);
    assert.equal(r.body.refused, 'not_preview');
  });

  test('GUARD 3 — arming: an unset CDMSS_OVERHEAD_MEASURE is refused', () => {
    const r = runGuardChild({ CDMSS_OVERHEAD_MEASURE: undefined });
    assert.equal(r.status, 403);
    assert.equal(r.body.refused, 'not_armed');
  });

  test('GUARD 4 — THE ONE THAT MATTERS: a production endpoint id is refused', () => {
    // Pointed at a different database with every other guard satisfied. The branch is a
    // copy-on-write clone, so row counts and schema are identical and no CONTENT check could tell
    // these apart — the host is the only discriminator.
    const r = runGuardChild({ CDMSS_OVERHEAD_DB_ENDPOINT: OTHER_ENDPOINT });
    assert.equal(r.status, 403);
    assert.equal(r.body.refused, 'endpoint_mismatch');
    assert.deepEqual(Object.keys(r.body).sort(), ['ok', 'refused'], 'and nothing else is returned');
  });

  test('GUARD 4 — an UNSET expectation refuses, it does not pass', () => {
    // The failure direction is always "do not run". An absent expectation is the shape a
    // half-configured preview has, and it must not be the shape that opens the route.
    const r = runGuardChild({ CDMSS_OVERHEAD_DB_ENDPOINT: undefined });
    assert.equal(r.status, 403);
    assert.equal(r.body.refused, 'endpoint_mismatch');
  });

  test('GUARD 4 — an unparseable DATABASE_URL refuses', () => {
    const r = runGuardChild({ DATABASE_URL: 'not-a-connection-string' });
    assert.equal(r.status, 403);
    assert.equal(r.body.refused, 'endpoint_mismatch');
  });

  test('GUARD 4 — a password containing @ cannot shift the parsed host', () => {
    // The parse takes the substring after the LAST `@`, so an embedded `@` in the credentials
    // cannot make some other label look like the endpoint.
    const tricky = `postgresql://u:p@${OTHER_ENDPOINT}.example.com@${FAKE_ENDPOINT}.ap-southeast-1.aws.neon.tech/neondb`;
    const r = runGuardChild({ DATABASE_URL: tricky });
    assert.equal(r.status, 200, 'the real host is the one after the last @, so this is the branch');
    assert.equal(r.body.ok, true);
  });

  test('GUARD 5 — expiry: past the hard UTC date every request is 410', () => {
    // Guard 5 is the ONLY enforcement that this route is deleted: nothing in CI enumerates routes,
    // and a note in a report is not a mechanism.
    const past = Date.UTC(2026, 7, 20, 0, 0, 1);      // one second after the expiry
    const r = runGuardChild({}, [`--now=${past}`]);
    assert.equal(r.status, 410);
    assert.equal(r.body.refused, 'expired');
  });

  test('GUARD 5 — before the expiry the route still runs', () => {
    const before = Date.UTC(2026, 7, 19, 23, 59, 59);
    const r = runGuardChild({}, [`--now=${before}`]);
    assert.equal(r.status, 200, 'not vacuous: the expiry check discriminates rather than always refusing');
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // All five pass, and nothing leaks
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  test('ALL FIVE PASS — the route runs, writes route=script, and reports the first sample separately', () => {
    const r = runGuardChild({});
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.route_written_as, 'script', '§7: the closed InvocationRoute union cannot name this route');
    assert.equal((r.body.cell as string), 'declare');
    assert.deepEqual(r.body.shape, { max: 8, conc: 8 });
    const first = r.body.first_statement_in_process as { n: number; ms: number | null };
    assert.equal(first.n, 1, 'the first sample is n=1 and never enters a percentile column');
    assert.ok(typeof first.ms === 'number');
    const dist = r.body.distribution_excluding_first as Record<string, number>;
    assert.equal(dist.n, 1, 'n=2 requested, one consumed as the first sample');
    assert.ok(String(r.body.label).includes('SYNTHETIC'), 'every response labels itself synthetic');
  });

  test('NO ERROR PATH RETURNS ANY SUBSTRING OF DATABASE_URL — across every case above', () => {
    // ⚠️ CHECKED ON THE WHOLE RAW LINE, not on a parsed field. A leak could arrive inside a driver
    // error message, a step string or a key name, and only the raw bytes cover all three.
    const cases: Array<[string, ChildResult]> = [
      ['guard2-production', runGuardChild({ VERCEL_ENV: 'production' })],
      ['guard3-unarmed', runGuardChild({ CDMSS_OVERHEAD_MEASURE: undefined })],
      ['guard4-other-endpoint', runGuardChild({ CDMSS_OVERHEAD_DB_ENDPOINT: OTHER_ENDPOINT })],
      ['guard4-unset', runGuardChild({ CDMSS_OVERHEAD_DB_ENDPOINT: undefined })],
      ['guard4-unparseable', runGuardChild({ DATABASE_URL: 'not-a-connection-string' })],
      ['guard5-expired', runGuardChild({}, [`--now=${Date.UTC(2026, 7, 21)}`])],
      ['all-pass', runGuardChild({})],
      ['db-error', runGuardChild({ CDMSS_OVERHEAD_FORCE_DB_ERROR: '1' })],
    ];
    for (const [name, r] of cases) {
      for (const secret of SECRETS) {
        assert.equal(
          r.raw.includes(secret), false,
          `${name} leaked "${secret.slice(0, 24)}…" — no response may carry any part of the connection string`,
        );
      }
    }
  });

  test('the route is POST-only, and carries its own expiry and deletion notice in source', () => {
    const src = readRouteSource();
    assert.match(src, /export async function POST\(/);
    assert.equal(/export async function GET\(/.test(src), false, 'no GET: this is not a browsable endpoint');
    assert.match(src, /const EXPIRES_AT_UTC = Date\.UTC\(2026, 7, 20, 0, 0, 0\);/, 'the hard expiry is 2026-08-20 UTC');
    assert.match(src, /OWED A DELETION/i, 'the file says plainly that it is temporary');
    assert.match(src, /export const maxDuration = 800;/);
    assert.match(src, /export const runtime = 'nodejs';/);
  });
}

function readRouteSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:fs').readFileSync('app/api/admin/telemetry-overhead/route.ts', 'utf8');
}

/** The route's source with every comment removed — for claims about what the CODE does. */
function readRouteCode(): string {
  return readRouteSource()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
}
