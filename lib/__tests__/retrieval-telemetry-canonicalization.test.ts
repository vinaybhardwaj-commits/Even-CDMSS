/**
 * lib/__tests__/retrieval-telemetry-canonicalization.test.ts — `canonicalJson`, the ONE function
 * used for both the identical-content no-op check and persistence (D12). Proof 56.
 *
 * GOVERNED BY addendum v25 (authorized by the orchestrator on V's delegation, ratified by Saul review
 * 35; supersedes v23), §3.4, under Saul review 36 — which held proof 56 because the first cut of this
 * file SIMULATED PostgreSQL's key order in memory. Kickoff v11 §6 is the numbering authority:
 *
 *   56  Recursive canonicalization, nested-key permutation, JSONB round trip, array reorder not
 *       equal, undefined array element rejected.
 *
 * D12: "Keys sorted recursively at every depth. Array order preserved. `undefined` omitted in
 * objects and rejected in arrays. Non-finite numbers rejected. Comparison against the normalized
 * JSON used for persistence, after a JSONB round trip."
 *
 * ⚠️ THIS FILE USES A REAL POSTGRESQL — A DISPOSABLE, NON-PRODUCTION ONE THAT IT CREATES AND DESTROYS
 * ITSELF. `before()` runs `initdb` into a fresh temporary directory, starts a `postgres` on 127.0.0.1
 * at a random high port with `pg_ctl`, and creates one table; every round trip below is a real
 * INSERT of `jsonb` and a real SELECT back, executed through `psql` over that loopback socket;
 * `after()` stops the server (`pg_ctl stop -m fast`) and deletes the directory. No connection string
 * from the environment is read, nothing outside 127.0.0.1 is dialled, and no production or shared
 * database — not the Neon production branch, not any branch carrying patient-derived values — is
 * touched. The cluster is empty except for the literal fixtures below. If the PostgreSQL binaries
 * (`initdb`, `pg_ctl`, `psql`) cannot be found, `before()` FAILS LOUDLY and every test in this file
 * fails with it — the round trip is not simulated and the tests are not skipped (v25 §3.4).
 *
 * WHAT THIS FILE DOES NOT CLAIM. It does not claim the telemetry store's SQL performs the equality —
 * the update-precedence order (no-op check first) is `retrieval-telemetry-store`'s and is pinned
 * elsewhere. It does not claim the round trip was performed against the deployed database version;
 * it was performed against the local PostgreSQL the binaries belong to, whose version is asserted
 * and printed by 56.0. Every fixture value is a literal.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '../retrieval-telemetry-core';

type Obj = Record<string, unknown>;
/** A type GUARD, not a cast. */
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// ── The disposable cluster ──────────────────────────────────────────────────────────────────────

/** Where PostgreSQL's binaries live on this machine: `PGBIN` if set, else the first directory on
 *  PATH or in the usual Homebrew / Debian / pgsql locations that holds all three tools. */
function findPgBin(): string {
  const candidates: string[] = [];
  if (process.env.PGBIN) candidates.push(process.env.PGBIN);
  for (const dir of (process.env.PATH ?? '').split(':')) if (dir) candidates.push(dir);
  for (const root of ['/opt/homebrew/opt', '/usr/local/opt']) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root)) if (/^postgresql(@\d+)?$/.test(d)) candidates.push(join(root, d, 'bin'));
  }
  if (existsSync('/usr/lib/postgresql')) {
    for (const v of readdirSync('/usr/lib/postgresql')) candidates.push(join('/usr/lib/postgresql', v, 'bin'));
  }
  candidates.push('/usr/local/pgsql/bin');
  for (const dir of candidates) {
    if (['initdb', 'pg_ctl', 'psql'].every((t) => existsSync(join(dir, t)))) return dir;
  }
  throw new Error('proof 56 needs a local PostgreSQL (initdb, pg_ctl, psql) to create a DISPOSABLE cluster; none found on PATH, PGBIN, Homebrew or /usr/lib/postgresql. The JSONB round trip is not simulated (addendum v25 §3.4).');
}

const cluster = { bin: '', dir: '', port: 0, up: false, version: '' };
const PGUSER = 'cdmss_proof56';

/** Run SQL from stdin against the disposable cluster, psql variables interpolated (`:'name'`), one
 *  value per line, unaligned, tuples only. Fails on the first SQL error. */
function sql(text: string, vars: Record<string, string> = {}): string[] {
  const args = ['-X', '-q', '-A', '-t', '-h', '127.0.0.1', '-p', String(cluster.port), '-U', PGUSER, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  args.push('-f', '-');
  const out = execFileSync(join(cluster.bin, 'psql'), args, { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return out.split('\n').filter((l) => l.length > 0);
}

before(() => {
  cluster.bin = findPgBin();
  cluster.dir = mkdtempSync(join(tmpdir(), 'cdmss-proof56-pg-'));
  const data = join(cluster.dir, 'data');
  execFileSync(join(cluster.bin, 'initdb'), ['-D', data, '-A', 'trust', '-U', PGUSER, '--no-locale', '-E', 'UTF8'], { stdio: ['ignore', 'pipe', 'pipe'] });
  // A random high port on loopback; retry a few times if it is taken.
  let started = false;
  let lastErr = '';
  for (let attempt = 0; attempt < 5 && !started; attempt++) {
    cluster.port = 20000 + Math.floor(Math.random() * 20000);
    try {
      execFileSync(join(cluster.bin, 'pg_ctl'), [
        '-D', data, '-w', '-t', '30', '-l', join(cluster.dir, 'postgres.log'),
        '-o', `-c listen_addresses=127.0.0.1 -c port=${cluster.port} -c unix_socket_directories=${cluster.dir}`,
        'start',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      started = true;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  assert.ok(started, `the disposable PostgreSQL started on 127.0.0.1: ${lastErr}`);
  cluster.up = true;
  cluster.version = sql('SELECT version();')[0] ?? '';
  sql('CREATE TABLE proof56_docs (id integer PRIMARY KEY, doc jsonb NOT NULL);');
});

after(() => {
  if (cluster.up) {
    try { execFileSync(join(cluster.bin, 'pg_ctl'), ['-D', join(cluster.dir, 'data'), '-m', 'fast', '-w', 'stop'], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch { /* the directory is removed either way */ }
    cluster.up = false;
  }
  if (cluster.dir) rmSync(cluster.dir, { recursive: true, force: true });
});

// ── The proofs ──────────────────────────────────────────────────────────────────────────────────

test('56.0 — the round trip runs against a REAL, DISPOSABLE PostgreSQL on 127.0.0.1 in a temporary directory: it answers SELECT version(), holds the one empty table, and is not any shared or production database', () => {
  assert.match(cluster.version, /^PostgreSQL \d+/, `a real server answered: ${cluster.version}`);
  assert.ok(cluster.dir.startsWith(tmpdir()), 'its data directory is under the OS temp dir — created by this file, destroyed by this file');
  assert.equal(sql('SELECT count(*) FROM proof56_docs;')[0], '0', 'the table starts empty');
  assert.equal(sql("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';")[0], '1', 'the cluster holds nothing but this file\'s one table');
  assert.equal(sql('SELECT host(inet_server_addr());')[0], '127.0.0.1', 'loopback only');
});

test('56.1 — RECURSIVE canonicalization: keys are sorted at EVERY depth, inside objects and inside objects nested in arrays, and array order is preserved', () => {
  const value = {
    zeta: { delta: 1, alpha: [{ y: 2, x: 1 }, { b: null, a: 'q' }] },
    alpha: 0,
    mid: { c: { z: true, a: false }, b: [3, 1, 2] },
  };
  assert.equal(
    canonicalJson(value),
    '{"alpha":0,"mid":{"b":[3,1,2],"c":{"a":false,"z":true}},"zeta":{"alpha":[{"x":1,"y":2},{"a":"q","b":null}],"delta":1}}',
    'depth 1, depth 2, and depth 3 inside an array are all sorted; [3,1,2] stays [3,1,2]',
  );
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson('s'), '"s"');
  assert.equal(canonicalJson(7), '7');
  assert.equal(canonicalJson(true), 'true');
});

test('56.2 — NESTED-KEY PERMUTATION: two documents whose keys are inserted in different orders at several depths canonicalize to the SAME string', () => {
  const a = { outer: { m: { q: 1, p: 2 }, k: [{ s: 1, r: 2 }] }, first: 'x' };
  const b = { first: 'x', outer: { k: [{ r: 2, s: 1 }], m: { p: 2, q: 1 } } };
  assert.notEqual(JSON.stringify(a), JSON.stringify(b), 'the naive serialization DOES differ — this test is not vacuous');
  assert.equal(canonicalJson(a), canonicalJson(b), 'the canonical forms are identical');
  const c = { first: 'x', outer: { k: [{ r: 2, s: 9 }], m: { p: 2, q: 1 } } };
  assert.notEqual(canonicalJson(a), canonicalJson(c));
});

test('56.3 — JSONB ROUND TRIP, REAL: the canonical bytes are INSERTed as jsonb into the disposable PostgreSQL and SELECTed back; PostgreSQL returns them in ITS key order (visibly not the canonical order), and canonicalizing what came back reproduces the persisted bytes exactly — the identical-content no-op check compares equal', () => {
  const original = {
    manifest_schema_version: 3,
    expansion: { status: 'skipped', served_route_class: null, attempts: [] },
    batches: [{ batch_index: 0, attempts: [{ provider: 'vertex', outcome: 'success', attempt: 1, status: 200 }], outcome: 'success' }],
    retrieval_config: { topK: 8, rerank_temperature: 0, rerank_seed_status: 'unseeded' },
    fused_candidate_ids: [11, 12, 13],
  };
  const stored = canonicalJson(original);
  sql("INSERT INTO proof56_docs (id, doc) VALUES (1, :'doc'::jsonb);", { doc: stored });
  const [back] = sql('SELECT doc::text FROM proof56_docs WHERE id = 1;');
  assert.ok(back, 'a row came back');
  assert.notEqual(back, stored, `PostgreSQL re-serialized the document in its own order/spacing: ${back}`);
  // jsonb's storage order is shorter keys first: `topK` before `rerank_temperature` — a real, visible
  // reorder that the canonicalizer must undo. Asserted so the round trip is known to have reordered.
  assert.ok(back.indexOf('"topK"') < back.indexOf('"rerank_temperature"'), 'jsonb put the shorter key first');
  assert.ok(stored.indexOf('"rerank_temperature"') < stored.indexOf('"topK"'), 'where the canonical form has it after');
  const parsed: unknown = JSON.parse(back);
  assert.equal(canonicalJson(parsed), stored, 'canonical(parse(what PostgreSQL returned)) === the persisted canonical bytes');
  assert.equal(canonicalJson(parsed) === canonicalJson(original), true, 'the no-op check compares EQUAL after the round trip — no revision burned');
  // And PostgreSQL agrees on content: jsonb equality of what it holds against the original literal.
  assert.equal(sql("SELECT (doc = :'doc'::jsonb) FROM proof56_docs WHERE id = 1;", { doc: JSON.stringify(original) })[0], 't', 'jsonb equality holds against the original insertion order');
  // A single changed value after the round trip is NOT equal — the check is not vacuously true.
  assert.ok(isObj(parsed) && isObj(parsed.retrieval_config), 'the round-tripped document is an object with a config object');
  parsed.retrieval_config.topK = 9;
  assert.notEqual(canonicalJson(parsed), stored);
});

test('56.4 — ARRAY REORDER IS NOT EQUAL: array order is content, at the top level and nested — for canonicalJson AND for the jsonb PostgreSQL holds; a reordered array round-tripped through the database is a DIFFERENT document', () => {
  // Pure.
  assert.notEqual(canonicalJson([1, 2, 3]), canonicalJson([3, 2, 1]));
  assert.notEqual(canonicalJson({ ids: [11, 12] }), canonicalJson({ ids: [12, 11] }));
  assert.notEqual(canonicalJson({ b: [{ a: 1 }, { a: 2 }] }), canonicalJson({ b: [{ a: 2 }, { a: 1 }] }));
  const one = { ordered_final_candidate_ids: [12, 11, 13], fused_candidate_ids: [11, 12, 13] };
  const two = { ordered_final_candidate_ids: [11, 12, 13], fused_candidate_ids: [11, 12, 13] };
  assert.notEqual(canonicalJson(one), canonicalJson(two), 'a reordered ranking is a different document');
  assert.equal(canonicalJson(one), canonicalJson({ fused_candidate_ids: [11, 12, 13], ordered_final_candidate_ids: [12, 11, 13] }), 'while the SAME arrays under permuted keys are equal — order inside arrays, not order of keys');
  // Through the database (v25 §3.4, the array-order mutation): store `one`, then produce a
  // round-tripped copy whose ONE array is reordered by PostgreSQL itself, and compare.
  const stored = canonicalJson(one);
  sql("INSERT INTO proof56_docs (id, doc) VALUES (2, :'doc'::jsonb);", { doc: stored });
  const [same] = sql('SELECT doc::text FROM proof56_docs WHERE id = 2;');
  const [reordered] = sql("SELECT jsonb_set(doc, '{ordered_final_candidate_ids}', '[11,12,13]'::jsonb)::text FROM proof56_docs WHERE id = 2;");
  assert.ok(same && reordered);
  const backSame: unknown = JSON.parse(same);
  const backReordered: unknown = JSON.parse(reordered);
  assert.equal(canonicalJson(backSame), stored, 'the untouched row round-trips to the persisted bytes');
  assert.notEqual(canonicalJson(backReordered), stored, 'the array-reordered row does NOT — the no-op check would (correctly) see new content');
  assert.equal(canonicalJson(backReordered), canonicalJson(two), 'and it equals the document that has that order');
  // PostgreSQL's own jsonb equality says the same two things: key order is not content, array order is.
  assert.equal(sql("SELECT ('[11,12,13]'::jsonb = '[12,11,13]'::jsonb);")[0], 'f', 'jsonb: array reorder is NOT equal');
  assert.equal(sql(`SELECT ('{"a":1,"b":[1,2]}'::jsonb = '{"b":[1,2],"a":1}'::jsonb);`)[0], 't', 'jsonb: key permutation IS equal');
});

test('56.5 — an UNDEFINED ARRAY ELEMENT is REJECTED (thrown, not dropped and not nulled), while undefined in an object is omitted', () => {
  assert.throws(() => canonicalJson([1, undefined, 3]), /undefined array element/, 'top-level array');
  assert.throws(() => canonicalJson({ batches: [{ a: 1 }, undefined] }), /undefined array element/, 'nested array');
  assert.throws(() => canonicalJson({ deep: { deeper: [undefined] } }), /undefined array element/, 'deep in objects');
  assert.notEqual(canonicalJson([1, 3]), canonicalJson([1, null, 3]), 'the two "repairs" are themselves different documents');
  assert.equal(canonicalJson({ b: 1, a: undefined }), '{"b":1}');
  assert.notEqual(canonicalJson({ b: 1, a: undefined }), canonicalJson({ b: 1, a: null }), 'omitted ≠ null');
});

test('56.6 — NON-FINITE numbers are rejected at any depth, and finite ones pass — and survive the real round trip', () => {
  assert.throws(() => canonicalJson(Number.NaN), /non-finite/);
  assert.throws(() => canonicalJson({ a: [{ b: Number.POSITIVE_INFINITY }] }), /non-finite/);
  assert.throws(() => canonicalJson([Number.NEGATIVE_INFINITY]), /non-finite/);
  const nums = { a: 0, b: -1.5, c: 1e21, d: 0.1 };
  const stored = canonicalJson(nums);
  assert.equal(stored, '{"a":0,"b":-1.5,"c":1e+21,"d":0.1}');
  sql("INSERT INTO proof56_docs (id, doc) VALUES (3, :'doc'::jsonb);", { doc: stored });
  const [back] = sql('SELECT doc::text FROM proof56_docs WHERE id = 3;');
  assert.ok(back);
  assert.equal(canonicalJson(JSON.parse(back)), stored, 'numeric values survive jsonb (numeric) and re-canonicalize identically');
});
