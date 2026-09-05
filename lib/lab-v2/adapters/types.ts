/**
 * lib/lab-v2/adapters/types.ts — the engine-adapter seam (LAB-MCP-V2-PRD-v1.0 §14.1).
 *
 * An adapter is the ONLY thing that knows how to turn a frozen case plus an arm into a
 * result. Everything around it — leasing, budgeting, attribution, status derivation — is
 * engine-agnostic and lives in the worker and the gateway. That split is what lets round
 * 2 add five more engines without touching the scheduler.
 *
 * An adapter deliberately CANNOT reach production IO: it runs inside `withLabExecution`,
 * so `sql` and `metabaseQuery` throw beneath it and retrieval delegates to the edge the
 * worker supplied. It gets its inputs from the frozen dataset, and nowhere else.
 */
import { NextRequest } from 'next/server';
import { withLabExecution, exitLabExecution } from '../../lab-execution-context';
import { retrieve as productionRetrieve, type RetrieveOptions, type RetrieveResult } from '../../retrieve';
import { hash, stagesFor, type AssessmentStatus, type EngineId, type ExecutionStatus } from '../contracts';
import type { Gateway } from '../gateway';

export interface AdapterContext {
  runId: string;
  itemId: string;
  caseKey: string;
  /** The dataset's frozen inputs for this case. The adapter's only source of truth. */
  frozen: Record<string, unknown>;
  /** The arm body: engine version, per-stage model spec, retrieval settings. */
  arm: Record<string, unknown>;
  repetition: number;
  /** Budgeted, attributed model access. The adapter never calls a provider itself. */
  gateway: Gateway;
  /** Aborts when the run is cancelled or the lease is lost (§5.4). */
  signal?: AbortSignal;
  /** Structured observation on this item — `retrieval_read`, stage timings, and so on. */
  event: (kind: string, body: Record<string, unknown>) => void;
  /** Memoised stage output for Slice B replay (§4.1 `steps`). */
  checkpoint: <T>(name: string, dependencyHash: string, produce: () => Promise<T>) => Promise<T>;
}

export interface AdapterOutcome {
  /** The full engine output, stored as the item's result and offered as an artifact. */
  result: unknown;
  /** A small, bounded projection safe to return inline from `run_result`. */
  summary: Record<string, unknown>;
  execution_status: ExecutionStatus;
  /** §9 — whether the CLINICAL question got an answer, independent of execution. */
  assessment_status: AssessmentStatus;
}

export interface Adapter {
  engine: EngineId;
  /** Stage names this engine bills against; an arm must price every one (§4.2). */
  stages: readonly string[];
  /** The engine version on `main`, reported by `engine_describe`. */
  engineVersion(): string;
  /** The frozen inputs this engine needs, reported by `engine_describe`. */
  frozenInputs: readonly string[];
  /**
   * Decision 22 — the per-attempt transport ceiling for this engine's model calls, in ms.
   * The gateway applies it to every stage call unless the arm's stage overrides it with
   * `options.timeout_ms`. Without it a stage call inherits the SDK client default, which is
   * unrelated to the engine's own budget and to the tick's 500 s elapsed bound.
   */
  perAttemptTimeoutMs: number;
  run(ctx: AdapterContext): Promise<AdapterOutcome>;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Round A3 — the shared route adapter (decisions 35, 35a, 37)
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * DECISION 37. The five round-A3 engines are NOT extracted. Their handler bodies stay in
 * `app/api/**` route files untouched, and the adapter imports `POST` and calls it IN PROCESS with a
 * synthetic `NextRequest`. Decision 33 proposed extracting them; the builder measured that doing
 * so breaks ten existing source-text guards that read those route files and count what is inside
 * them, so 33 was withdrawn. Slice B converts them to plain functions under a PRD that rules on
 * those guards first.
 *
 * NEVER A NETWORK SELF-FETCH. `POST(req)` is an ordinary function call. A self-fetch would leave
 * the lab execution context — AsyncLocalStorage does not cross an HTTP boundary — so the fence
 * would silently not apply and the engine would reach production Neon for real.
 */
export interface RouteEngineSpec {
  engine: EngineId;
  /** The route's own path. Used only to build the synthetic URL; nothing routes on it. */
  path: string;
  post: (req: NextRequest) => Promise<Response>;
  /** A bounded projection of the engine's output for `run_result` (§8). */
  summarise: (read: RouteRead) => Record<string, unknown>;
  /** §9 — did the CLINICAL question get an answer, independent of execution. */
  assess: (read: RouteRead) => AssessmentStatus;
}

/**
 * What a route actually returns. The four NDJSON engines end with a `{type:'done', ms}` marker,
 * so the LAST event is not the payload — the payload is in the events before it. Both are handed
 * to the engine's own summarise/assess rather than guessed at here.
 */
export interface RouteRead { status: number; events: unknown[]; json: unknown }

/** The `type` values a streamed route emitted, in order. The shape both helpers key on. */
export function eventTypes(read: RouteRead): string[] {
  return read.events
    .map((e) => (e && typeof e === 'object' ? String((e as { type?: unknown }).type ?? '') : ''))
    .filter(Boolean);
}

/** The first event of a given type, or null. */
export function eventOfType(read: RouteRead, type: string): Record<string, unknown> | null {
  for (const e of read.events) {
    if (e && typeof e === 'object' && (e as { type?: unknown }).type === type) return e as Record<string, unknown>;
  }
  return null;
}

/**
 * §9 for a streamed engine. An `error` event is the engine DECLARING it could not answer — ddx
 * emits one for "no excerpts above threshold", which is a successful execution with no clinical
 * answer, i.e. exactly `unassessable`. A run that reached `done` with no error is `assessed`.
 */
export function assessStream(read: RouteRead): AssessmentStatus {
  const types = eventTypes(read);
  if (types.includes('error')) return 'unassessable';
  return types.includes('done') ? 'assessed' : 'unassessable';
}

/** Injection seam for unit tests (repo idiom). Production passes nothing. */
export interface RouteAdapterDeps {
  retrieve?: (query: string, opts: RetrieveOptions) => Promise<RetrieveResult>;
}

/**
 * The synthetic request the engine sees.
 *
 * URL      `https://lab-v2.internal<path>` — an absolute URL is required to construct a
 *          NextRequest; the host is deliberately not a real one, because nothing may resolve it.
 * METHOD   POST.
 * HEADERS  `content-type: application/json` (all five parse the body with `req.json()`), and
 *          `user-agent: cdmss-lab-v2/adapter` (ask and ddx read it for a trace event, which is
 *          inert inside the fence; sending a truthful one beats sending none).
 * BODY     the frozen request body, minus `labModel` — see below.
 *
 * NO OTHER HEADER IS READ BY ANY OF THE FIVE. The only other header reads in this call tree are
 * inside `resolveLabOverride` (LAB_ORIGIN_HEADER, LAB_ADMIN_HEADER, x-cdmss-lab-caller), and it
 * short-circuits before touching any of them when `labModel` is absent. There is no auth header
 * and no cookie on this path: the routes carry no auth of their own, and the lab's authority was
 * decided at the MCP key.
 *
 * ⚠️ `labModel` IS STRIPPED, and both reasons matter. It would send `resolveLabOverride` down its
 * long path into `isAdminUnlocked()`, which reads the cookie jar and THROWS outside a request
 * scope. And it is a second routing mechanism: model choice on a lab run belongs to the arm and
 * to the gateway that meters it, never to a string in a frozen body.
 */
export function buildSyntheticRequest(path: string, body: Record<string, unknown>): NextRequest {
  const { labModel: _stripped, ...rest } = body;
  void _stripped;
  return new NextRequest(new URL(path, 'https://lab-v2.internal'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'cdmss-lab-v2/adapter' },
    body: JSON.stringify(rest),
  });
}

/** Read a route response. Four of the five stream NDJSON; `pathway` returns plain JSON. */
export async function readRouteResponse(res: Response): Promise<RouteRead> {
  const text = await res.text();
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('ndjson') || (text.includes('\n') && text.trimStart().startsWith('{') && text.trim().split('\n').length > 1)) {
    const events: unknown[] = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { events.push(JSON.parse(t)); } catch { /* a partial line is not a result */ }
    }
    return { status: res.status, events, json: events.length ? events[events.length - 1] : null };
  }
  try { return { status: res.status, events: [], json: JSON.parse(text) }; }
  catch { return { status: res.status, events: [], json: null }; }
}

/**
 * One adapter for all five route engines. The edges are OPD's, exactly:
 *   · `chat`     → the gateway, which reserves and settles before and after the network;
 *   · `retrieve` → captured OUTSIDE the context and run under `exitLabExecution`, so the corpus
 *                  read reaches DATABASE_URL by the normal path and is logged as `retrieval_read`;
 *   · everything else inside the fence throws or no-ops, unchanged from round 1.
 */
export function makeRouteAdapter(spec: RouteEngineSpec, deps: RouteAdapterDeps = {}): Adapter {
  const retrieveImpl = deps.retrieve ?? productionRetrieve;
  const stages = stagesFor(spec.engine);
  return {
    engine: spec.engine,
    stages: stages.map((s) => s.name),
    engineVersion: () => `${spec.engine}/route`,
    frozenInputs: ['body'],
    // These engines run one governed leg per stage; the audit leg's ceiling is the closest
    // measured bound the platform has, and the arm may override it per stage.
    perAttemptTimeoutMs: 380_000,

    async run(ctx: AdapterContext): Promise<AdapterOutcome> {
      const frozen = ctx.frozen as { engine?: string; body?: Record<string, unknown> };
      const body = frozen?.body;
      if (!body || typeof body !== 'object') {
        return {
          result: { error: `frozen inputs for ${spec.engine} must carry a request body` },
          summary: { engine: spec.engine, error: 'bad_frozen_inputs' },
          execution_status: 'failed', assessment_status: 'not_reached',
        };
      }

      const retrieveEdge = async (query: string, opts?: unknown): Promise<RetrieveResult> => {
        const started = Date.now();
        const out = await exitLabExecution(() => retrieveImpl(query, (opts ?? {}) as RetrieveOptions));
        ctx.event('retrieval_read', { query_hash: hash(query), chunks: out?.hits?.length ?? 0, ms: Date.now() - started });
        return out;
      };

      // The label IS the stage for these engines (decision 35). An unrecognised label is passed
      // through unchanged so the gateway refuses it by NAME — a new governed leg must surface as
      // "the arm prices no stage 'x'", never as a silent charge to a neighbouring stage.
      const chatEdge = async (label: string, params: unknown): Promise<unknown> => {
        const staged = await ctx.gateway.call(label, params as Record<string, unknown>);
        return staged.completion;
      };

      return withLabExecution(
        { chat: chatEdge, retrieve: retrieveEdge as unknown as (q: string, o?: unknown) => Promise<unknown>, event: ctx.event },
        async (): Promise<AdapterOutcome> => {
          try {
            const res = await spec.post(buildSyntheticRequest(spec.path, body));
            const read = await readRouteResponse(res);
            if (read.status >= 400) {
              return {
                result: { error: 'engine returned an error status', status: read.status, body: read.json },
                summary: { engine: spec.engine, status: read.status },
                execution_status: 'failed', assessment_status: 'not_reached',
              };
            }
            return {
              result: { status: read.status, result: read.json, events: read.events },
              summary: { engine: spec.engine, status: read.status, ...spec.summarise(read) },
              execution_status: 'succeeded',
              assessment_status: spec.assess(read),
            };
          } catch (e) {
            const err = e as Error & { code?: string };
            return {
              result: { error: err.message, code: err.code ?? null },
              summary: {
                engine: spec.engine,
                error: err.code ?? 'engine_error',
                // The REASON rides in the inline summary, not only in the artifact. An operator
                // reading run_result must be able to see WHICH stage the arm failed to price
                // without fetching a body — "MODEL_UNSUPPORTED" alone names nothing.
                message: String(err.message).slice(0, 300),
              },
              execution_status: 'failed', assessment_status: 'not_reached',
            };
          }
        },
      );
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// The engine registry
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Every engine wired end to end. It lives HERE rather than beside one engine because round 1
 * put `ADAPTERS` in adapters/opd.ts, and §17.3 leaves that file untouched.
 *
 * The import of `./opd` below is a VALUE import and this module is what opd.ts imports its types
 * from — but opd.ts uses `import type`, which is erased, so there is no runtime cycle.
 */
export function allAdapters(): Record<string, Adapter> {
  // Required lazily so the five route modules are not pulled into every importer of this file
  // (the observation tools import Adapter types and must not drag five clinical routes with them).
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { opdAdapter } = require('./opd') as typeof import('./opd');
  const { makeAskAdapter } = require('./ask') as typeof import('./ask');
  const { makeDdxAdapter } = require('./ddx') as typeof import('./ddx');
  const { makeAppropriatenessAdapter } = require('./appropriateness') as typeof import('./appropriateness');
  const { makePathwayAdapter } = require('./pathway') as typeof import('./pathway');
  const { makeDocAuditAdapter } = require('./doc-audit') as typeof import('./doc-audit');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    opd_note_audit: opdAdapter,
    ask: makeAskAdapter(),
    ddx: makeDdxAdapter(),
    appropriateness: makeAppropriatenessAdapter(),
    pathway: makePathwayAdapter(),
    doc_audit: makeDocAuditAdapter(),
  };
}

let _cached: Record<string, Adapter> | null = null;
export function ALL_ADAPTERS(): Record<string, Adapter> {
  if (!_cached) _cached = allAdapters();
  return _cached;
}
