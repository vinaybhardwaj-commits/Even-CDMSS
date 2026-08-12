/**
 * lib/__tests__/telemetry-db-stub.ts — a stubbed database for the four telemetry store tests.
 *
 * ⚠️ NOT A TEST FILE, AND NOT ON THE KICKOFF'S SECTION 4 CREATE LIST. It is a shared helper, named
 * so the `lib/**\/__tests__/*.test.ts` glob does not collect it, and the build report says plainly
 * that it exists and why. Four of the test files this build owes — settlement, the invocation
 * store, the worker declaration and the reconciler races — assert what reaches the database, and
 * there is no database in this sandbox. Duplicating this into four files would have kept the file
 * list pure and made the four copies drift.
 *
 * ⚠️ THE SEAM IS `globalThis.fetch`, DELIBERATELY, AND IT IS THE ONLY ONE THAT WORKS HERE.
 * `lib/db.ts` exports `sql` as a `const` Proxy, so it cannot be reassigned; `neonConfig.fetchFunction`
 * is the driver's own documented seam and it does not take under the ESM build this repository
 * loads (verified: the assignment reads back, and the query still resolves DNS). What is left is the
 * transport. The driver posts `{query, params}` as JSON and parses `{fields, rows}` back, so a
 * stub at that layer exercises the REAL statements, the REAL bound parameters and the REAL
 * row-to-object mapping — which is the point: these tests assert bound parameters, and a stub above
 * the driver would assert only what the test itself passed in.
 */
import type { RetrievalRole } from '../retrieval-telemetry-core';

/**
 * One statement as it left the process.
 *
 * ⚠️ `params` IS THE WIRE FORM. The driver renders every bound value to text before sending, so a
 * bound `1` arrives here as `'1'` and a bound `null` as `null`. That is the fidelity this seam buys:
 * a test asserting bound parameters is asserting what Postgres would receive.
 */
export interface DbCall { query: string; params: unknown[] }

/** What a matched statement does. Rows are returned as-is; an Error is thrown to the caller. */
export type DbResult = Record<string, unknown>[] | Error;

interface Route { match: RegExp; result: DbResult | ((call: DbCall) => DbResult); once: boolean; used: boolean }

export interface DbStub {
  /** Every statement, in order, with its bound parameters. */
  readonly calls: DbCall[];
  /** Route a statement. Later routes win over earlier ones, so a test can override a default. */
  on(match: RegExp, result: DbResult | ((call: DbCall) => DbResult)): void;
  /** Route a statement for ONE call only — the shape a race needs. */
  once(match: RegExp, result: DbResult | ((call: DbCall) => DbResult)): void;
  /** The calls whose statement matches. */
  matching(re: RegExp): DbCall[];
  reset(): void;
}

/** `null` stays null; everything else is rendered the way Postgres renders it in text mode. */
function textOf(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** The type oid the driver needs to parse a column back to the JS value the test wrote. */
function oidOf(v: unknown): number {
  if (typeof v === 'boolean') return 16;                                  // bool
  if (typeof v === 'number') return Number.isInteger(v) ? 23 : 701;       // int4 / float8
  return 25;                                                              // text
}

function encode(rows: Record<string, unknown>[]): unknown {
  const names = rows.length ? Object.keys(rows[0]) : [];
  const fields = names.map((name) => {
    // The oid comes from the first row that actually has a value for this column: a leading null
    // would otherwise type an integer column as text and hand the caller '0' instead of 0.
    const sample = rows.find((r) => r[name] !== null && r[name] !== undefined)?.[name];
    return { name, dataTypeID: oidOf(sample), tableID: 0, columnID: 0, dataTypeSize: -1, dataTypeModifier: -1, format: 'text' };
  });
  return {
    command: 'SELECT',
    fields,
    rowCount: rows.length,
    rows: rows.map((r) => names.map((n) => textOf(r[n]))),
  };
}

let installed: DbStub | null = null;

/**
 * Install the stub. Idempotent: the second call returns the same stub, reset.
 *
 * ⚠️ CALL THIS BEFORE THE FIRST `sql()`, NOT BEFORE THE FIRST IMPORT. `lib/db.ts` builds its client
 * lazily inside `client()`, so `DATABASE_URL` and the transport only have to exist by the time a
 * statement runs — which is why a test file can import the stores at the top in the normal way.
 */
export function installDbStub(): DbStub {
  if (installed) { installed.reset(); return installed; }
  process.env.DATABASE_URL ??= 'postgresql://stub:stub@stub.invalid/stub';
  const calls: DbCall[] = [];
  const routes: Route[] = [];

  const stub: DbStub = {
    calls,
    on(match, result) { routes.push({ match, result, once: false, used: false }); },
    once(match, result) { routes.push({ match, result, once: true, used: false }); },
    matching(re) { return calls.filter((c) => re.test(c.query)); },
    reset() { calls.length = 0; routes.length = 0; },
  };

  (globalThis as unknown as { fetch: unknown }).fetch = async (_url: string, init: { body: string }) => {
    // ⚠️ VALIDATED, NEVER CAST. This line used to be
    // `JSON.parse(init.body) as { query: string; params: unknown[] }`, and that cast was a hole big
    // enough to drive an unguarded UPDATE through: a neon BATCH posts `{queries: [...]}` with no
    // `query` at all, so `call.query` was `undefined`, and every classifier downstream — every
    // `RegExp.test(call.query)` in every test — silently coerced it to the string `"undefined"` and
    // matched nothing. A statement nothing could see is a statement nothing could refuse.
    const call = decodeCall(init.body);
    calls.push(call);
    // Last route wins, so a test can narrow a default without removing it.
    const route = [...routes].reverse().find((r) => r.match.test(call.query) && !(r.once && r.used));
    if (route) route.used = true;
    const result = route ? (typeof route.result === 'function' ? route.result(call) : route.result) : [];
    if (result instanceof Error) throw result;
    return {
      ok: true, status: 200,
      json: async () => encode(result),
      text: async () => '',
    };
  };
  installed = stub;
  return stub;
}

/**
 * Thrown when the transport is handed a body this stub does not model. FAIL CLOSED, deliberately:
 * the alternative is a request that looks like it was observed and was not.
 *
 * ⚠️ NO BATCH SUPPORT, ON PURPOSE. The frozen reconciler route issues one statement per call, and
 * modelling a transport nothing uses would be more code and a second thing to get wrong. A batch
 * body is REFUSED here, loudly, rather than half-understood.
 */
export class UnsupportedStubTransportError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsupportedStubTransportError'; }
}

/**
 * Decode one posted body into a `DbCall`, or refuse it.
 *
 * The accepted shape is the only one the driver sends for `sql(text, params)`: an object with a
 * string `query` and an array `params`. Everything else — a batch, a non-object, a missing or
 * non-string `query`, a non-array `params` — throws, and NOTHING is appended to `calls`.
 */
export function decodeCall(rawBody: string): DbCall {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new UnsupportedStubTransportError(`stub transport: body is not JSON: ${rawBody.slice(0, 120)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UnsupportedStubTransportError(`stub transport: body is not an object (${typeof parsed})`);
  }
  const body = parsed as Record<string, unknown>;
  if ('queries' in body) {
    throw new UnsupportedStubTransportError(
      'stub transport: a batch body ({queries: […]}) is not modelled. The route under test issues one '
      + 'statement per call; a batch here means something is routing around that, and it is refused '
      + 'rather than silently observed as a single undefined statement.',
    );
  }
  if (typeof body.query !== 'string') {
    throw new UnsupportedStubTransportError(`stub transport: 'query' is ${typeof body.query}, not a string`);
  }
  if (!Array.isArray(body.params)) {
    throw new UnsupportedStubTransportError(`stub transport: 'params' is ${typeof body.params}, not an array`);
  }
  return { query: body.query, params: body.params };
}

/** A named error whose CLASS is what the failure store records. */
export function classedError(name: string): Error {
  const e = new Error(`${name} (stub)`);
  e.name = name;
  return e;
}

/** A `LifecycleRun`-shaped literal, so the four test files spell one up the same way. */
export function run(role: RetrievalRole, runId: string, expectedRevision = 0) {
  return { role, runId, expectedRevision };
}
