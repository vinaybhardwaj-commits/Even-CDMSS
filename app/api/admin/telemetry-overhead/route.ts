/**
 * app/api/admin/telemetry-overhead/route.ts — the real-database overhead measurement (addendum v4).
 *
 * ⚠️ THIS ROUTE IS TEMPORARY AND IS OWED A DELETION. It exists to take one measurement that a
 * stubbed harness cannot take, from a Vercel Preview against a NON-PRODUCTION Neon branch. Guard 5
 * below is a hard expiry, and it is the ONLY enforcement that this file goes away: nothing in CI
 * enumerates routes, so a note in a report is not a mechanism. After the expiry every request is
 * 410 and the route is inert whatever else is configured.
 *
 * ⚠️ WHY IT EXISTS AT ALL. PRD v2.1 line 267 requires numeric overhead guardrails before a canary;
 * kickoff D18 line 1032 forbids deploying to measure and confines measurement to a local or test
 * database. Both cannot hold, because D18's method excludes the term that decides the acceptance
 * criterion — the Mumbai-to-Singapore round trip. Amendment 1, signed by V before this pass, lifts
 * D18's prohibition FOR PREVIEW ONLY and leaves the prohibition on the production database standing
 * without exception. Guard 4 is that prohibition's mechanism rather than its promise.
 *
 * ⚠️ THE FIVE GUARDS RUN IN THIS ORDER AND ALL FIVE MUST PASS. Each is proven by a child-process
 * case in `lib/__tests__/telemetry-overhead-guard.test.ts`; a guard that exists only in source is
 * not a guard.
 *
 *   1. admin           `requireAdmin` ALONE — no `isAdminUnlocked()` clause
 *   2. preview         VERCEL_ENV === 'preview' AND VERCEL_GIT_COMMIT_REF === 'exp/rerank-telemetry'
 *   3. armed           CDMSS_OVERHEAD_MEASURE === '1'
 *   4. database identity   the Neon endpoint id equals CDMSS_OVERHEAD_DB_ENDPOINT
 *   5. expiry          hard UTC date, 410 after it
 *
 * ⚠️ NOTHING HERE EVER LOGS, ECHOES OR RETURNS ANY PART OF `DATABASE_URL`, including inside an
 * error. Guard 4 compares one label and reports one word.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { sql } from '@/lib/db';
import { retrievalTelemetryDdl, RETRIEVAL_ROLE_NOT_NULL_SQL, type TelemetryRequestContext, type OperationalTelemetry, type RetrievalRole } from '@/lib/retrieval-telemetry-core';
import { declareRetrievals, writeRetrievalTerminal, type LifecycleHandle } from '@/lib/retrieval-telemetry-store';
import { startInvocation } from '@/lib/retrieval-invocation-store';
import { settleRetrievalTelemetry } from '@/lib/retrieval-settlement';
import { createTelemetryCapture, buildRetrievalPayload } from '@/lib/retrieval-capture';
import { activeRun } from '@/lib/backfill-runs';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const maxDuration = 800;

/**
 * GUARD 5's DATE. UTC midnight, 20 August 2026 — the last day addendum v4 §3 permits.
 * Section 12 requires this route deleted before `exp/rerank-telemetry` merges anywhere; this
 * constant is what makes that true even if the deletion is forgotten.
 */
const EXPIRES_AT_UTC = Date.UTC(2026, 7, 20, 0, 0, 0);

/** The only branch this route may serve from. A Preview build carries VERCEL_ENV=preview baked in
 *  and can later be PROMOTED to production, which would serve production traffic from a build that
 *  the environment label alone would admit. The ref is what stops that. */
const ONLY_REF = 'exp/rerank-telemetry';

/**
 * The Neon endpoint id out of `DATABASE_URL`, or null.
 *
 * ⚠️ PARSED BY HAND, NOT BY `new URL`, AND NOTHING IS EVER RETURNED FROM IT. A connection string
 * carries credentials; `new URL` would throw on some of them and its error object retains the input.
 * This takes the substring after the LAST `@` — so a password containing `@` cannot shift the host —
 * stops at the first `/`, `?`, `#` or `:`, and returns only the leading `ep-…` label. Any shape it
 * does not recognise returns null, which guard 4 treats as a refusal rather than as a pass.
 */
function neonEndpointId(raw: string | undefined): string | null {
  if (!raw) return null;
  const at = raw.lastIndexOf('@');
  const afterAuth = at >= 0 ? raw.slice(at + 1) : raw.replace(/^[a-z+]+:\/\//i, '');
  const host = afterAuth.split(/[/?#:]/)[0] ?? '';
  const label = host.split('.')[0] ?? '';
  return /^ep-[a-z0-9-]+$/i.test(label) ? label : null;
}

// ── statistics ─────────────────────────────────────────────────────────────────────────────────
/** Nearest-rank percentile on an already-sorted ascending array. */
function pct(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}
function summarise(samples: number[]) {
  const s = samples.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return {
    n: s.length,
    min: s[0] ?? null,
    median: s.length ? (s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2) : null,
    p95: pct(s, 95),
    p99: pct(s, 99),
    max: s[s.length - 1] ?? null,
  };
}

const ctxFor = (): TelemetryRequestContext => ({
  // §7: `/api/admin/telemetry-overhead` is not a member of the closed `InvocationRoute` union and
  // adding one is forbidden by §6. `script` is an existing member, it is honest about what this is,
  // and it keeps every synthetic row separable from real traffic by one predicate.
  invocationId: randomUUID(), route: 'script', routeClass: 'manual',
  deploymentSha: process.env.VERCEL_GIT_COMMIT_SHA || null, vercelRequestId: null,
  startedAt: new Date().toISOString(), routingFlags: {},
});

const operationalFor = (ctx: TelemetryRequestContext, role: RetrievalRole): OperationalTelemetry => ({
  route: 'script', route_class: 'manual', retrieval_role: role,
  invocation_id: ctx.invocationId, trace_id: null, deployment_sha: ctx.deploymentSha,
  started_at: ctx.startedAt, completed_at: new Date().toISOString(), routing_flags: {},
  active_backfill_run_id: null, active_backfill_target: null, active_backfill_state: null,
  active_lab_experiment_id: null,
});

const payloadFor = (role: RetrievalRole) =>
  buildRetrievalPayload(createTelemetryCapture(role), {
    hmacKey: process.env.CDMSS_TELEMETRY_HMAC_KEY ?? null,
    scorerContext: role === 'primary' ? '' : null,
  });

export async function POST(req: NextRequest) {
  // ── GUARD 1. ADMIN, AND ONLY ADMIN. ───────────────────────────────────────────────────────────
  // Deliberately NOT the migration route's `|| isAdminUnlocked()`: that turns a credential into a
  // browser session. `lib/admin-gate.ts` returns null when ADMIN_TOKEN is unset, so this guard is
  // open by default — it is the weakest of the five and nothing here is load-bearing on it.
  const denied = requireAdmin(req);
  if (denied) return denied;

  // ── GUARD 2. PREVIEW, ON THIS BRANCH ONLY. ────────────────────────────────────────────────────
  if (process.env.VERCEL_ENV !== 'preview' || process.env.VERCEL_GIT_COMMIT_REF !== ONLY_REF) {
    return NextResponse.json({ ok: false, refused: 'not_preview' }, { status: 403 });
  }

  // ── GUARD 3. EXPLICITLY ARMED. ────────────────────────────────────────────────────────────────
  if (process.env.CDMSS_OVERHEAD_MEASURE !== '1') {
    return NextResponse.json({ ok: false, refused: 'not_armed' }, { status: 403 });
  }

  // ── GUARD 4. DATABASE IDENTITY. THE ONE THAT MATTERS. ─────────────────────────────────────────
  // The branch is a copy-on-write clone, so row counts and schema are identical to production and
  // NO CONTENT CHECK CAN TELL THEM APART. The host is the only discriminator. An absent expectation
  // refuses, an unparseable URL refuses, and a mismatch refuses — the failure direction is always
  // "do not run".
  const expectedEndpoint = (process.env.CDMSS_OVERHEAD_DB_ENDPOINT || '').trim();
  const actualEndpoint = neonEndpointId(process.env.DATABASE_URL);
  if (!expectedEndpoint || !actualEndpoint || expectedEndpoint !== actualEndpoint) {
    // One word. No endpoint id, no host, no fragment of the connection string, in either direction.
    return NextResponse.json({ ok: false, refused: 'endpoint_mismatch' }, { status: 403 });
  }

  // ── GUARD 5. HARD EXPIRY. ─────────────────────────────────────────────────────────────────────
  if (Date.now() >= EXPIRES_AT_UTC) {
    return NextResponse.json({
      ok: false, refused: 'expired',
      expired_at: new Date(EXPIRES_AT_UTC).toISOString(),
      note: 'This measurement route is past its hard expiry and must be deleted (addendum v4 §12).',
    }, { status: 410 });
  }

  // ══ ALL FIVE GUARDS PASSED. Everything below runs against the branch and nothing else. ═════════
  const params = req.nextUrl.searchParams;
  const cell = (params.get('cell') || 'declare').trim();
  const shapeMax = Math.max(1, Math.min(100, parseInt(params.get('max') || '8', 10) || 8));
  const shapeConc = Math.max(1, Math.min(64, parseInt(params.get('conc') || '8', 10) || 8));
  const n = Math.max(1, Math.min(2000, parseInt(params.get('n') || '50', 10) || 50));
  const auditMode = params.get('audit') === 'null' ? 'null' : 'real';

  const steps: Record<string, string> = {};
  try {
    // ── THE ROUTE CREATES ITS OWN TABLES. ───────────────────────────────────────────────────────
    // The branch was cloned from `main`, and `main` has none of the three telemetry tables — so
    // there is nothing to write to until this runs. It is done HERE, after guard 4, and never by a
    // human aiming the migration route at a preview: that endpoint is aimed by hand and the failure
    // mode is aiming it at production.
    //
    // ⚠️ TWO DELIBERATE DEVIATIONS FROM THE MIGRATION ROUTE'S STOP RULE, AND THEIR REASONS.
    //
    // 1. That route returns 409 when the table exists WITH ROWS, because it would otherwise replace
    //    a CHECK constraint underneath legacy rows. Here, a second invocation ALWAYS finds rows —
    //    its own, from the previous cell — and §4 requires one cell per invocation, so a literal 409
    //    would make the matrix unreachable after the first call. Instead the decision is taken on
    //    EXISTENCE alone: absent ⇒ create, present ⇒ skip the DDL entirely. That is strictly safer
    //    than the migration route, because on the present branch no constraint is touched at all.
    //
    // 2. THE EMPTINESS COUNT IS GONE, AND NOT BECAUSE IT WAS INCONVENIENT.
    //    `lib/__tests__/telemetry-non-exposure.test.ts` fails on any `FROM <telemetry table>` in a
    //    file outside its ALLOWED set, and that test file is NOT on addendum v4 §6's contract, so it
    //    cannot be extended here. The two ways to keep the count were to edit that allow-list, which
    //    §6 forbids, or to build the table name dynamically so the source-text scan cannot see it —
    //    which is evading a privacy control by obfuscation, and is worse than not having the number.
    //    So the route reads NOTHING from the three telemetry tables. `to_regclass` asks the catalog
    //    whether a relation exists and reads no row of it. §5's row-count verification is owed and
    //    is flagged in Part XI rather than smuggled.
    const reg = (await sql`SELECT to_regclass('public.opd_audit_retrieval_telemetry') IS NOT NULL AS present`) as Array<{ present: boolean }>;
    if (!reg[0]?.present) {
      for (const stmt of retrievalTelemetryDdl()) { await sql(stmt.sql, []); }
      await sql(RETRIEVAL_ROLE_NOT_NULL_SQL, []);
      steps.schema = 'created';
    } else {
      steps.schema = 'already present — DDL skipped, no constraint touched';
    }

    // ── A REAL `opd_note_audits` ID, BECAUSE `audit_id` REFERENCES IT. ──────────────────────────
    // Production always settles with a real one, so the UPDATE carries an index probe into the
    // largest table in the schema. Passing null omits that probe and reads systematically low with
    // nothing in the output to show it. The branch is a clone, so real ids exist on it.
    let realAuditId: string | null = null;
    try {
      const a = (await sql`SELECT id FROM opd_note_audits ORDER BY id DESC LIMIT 1`) as Array<{ id: string }>;
      realAuditId = a[0]?.id != null ? String(a[0].id) : null;
    } catch { realAuditId = null; }
    const auditId = auditMode === 'null' ? null : realAuditId;
    steps.audit_id = auditMode === 'null'
      ? 'null (FK probe deliberately omitted — comparison arm)'
      : (realAuditId ? 'a real opd_note_audits row on the BRANCH' : 'NONE FOUND on the branch — see warning');

    const samples: number[] = [];
    const mark = async (fn: () => Promise<unknown>) => {
      const t0 = performance.now();
      await fn();
      samples.push(performance.now() - t0);
    };

    // ── THE CELLS. One boundary at one batch shape, per invocation (§4). ────────────────────────
    for (let i = 0; i < n; i++) {
      const ctx = ctxFor();
      if (cell === 'declare') {
        // BOUNDARY 1 — declaration insert PLUS the invocation counter update. PER BATCH, not per
        // note: build report §8 shows both are batch-level, which is what makes the per-note serial
        // chain three statements and not five.
        await startInvocation(ctx);                       // untimed: the counter UPDATE needs a row
        const runs = Array.from({ length: shapeMax }, () => ({
          role: 'primary' as const, runId: randomUUID(), uid: null, engineVersion: null,
        }));
        await mark(() => declareRetrievals(ctx, runs, 'will_persist'));
      } else if (cell.startsWith('terminal') || cell.startsWith('settle')) {
        const role: RetrievalRole = cell.endsWith('normative') ? 'normative_channel' : 'primary';
        await startInvocation(ctx);
        const runId = randomUUID();
        const handle = await declareRetrievals(ctx, [{ role, runId, uid: null, engineVersion: null }], 'will_persist');
        if (cell.startsWith('terminal')) {
          // BOUNDARY 2 — the terminal update, per role, per note.
          await mark(() => writeRetrievalTerminal(handle, role, {
            payload: payloadFor(role), operational: operationalFor(ctx, role), traceId: null,
            completedAt: new Date().toISOString(),
          }));
        } else {
          // BOUNDARY 3 — the settlement read PLUS update, per role, per note.
          const settled: LifecycleHandle = await writeRetrievalTerminal(handle, role, {
            payload: payloadFor(role), operational: operationalFor(ctx, role), traceId: null,
            completedAt: new Date().toISOString(),
          });
          await mark(() => settleRetrievalTelemetry(settled, {
            outcome: 'persisted_clean', auditId, settledAt: new Date().toISOString(),
          }));
        }
      } else if (cell === 'activerun') {
        // BOUNDARY 4 — activeRun('opd'). The FIRST call in a process also runs ensureRunsTable's
        // CREATE TABLE and two CREATE INDEX; every later call is one SELECT. `ensured` is module
        // state with no reset, so that split is per process and not per iteration.
        await mark(() => activeRun('opd'));
      } else {
        return NextResponse.json({
          ok: false, error: 'unknown cell',
          cells: ['declare', 'terminal_primary', 'terminal_normative', 'settle_primary', 'settle_normative', 'activerun'],
        }, { status: 400 });
      }
    }

    // ── THE FIRST SAMPLE IS NOT A PERCENTILE. ───────────────────────────────────────────────────
    // One request is one process, so the first statement absorbs TLS setup and, if the branch
    // compute has scaled to zero, a resume of hundreds of milliseconds. It is reported on its own
    // with n = 1 and is NOT called cold — cold cannot be forced in-process, because `ensured` in
    // `lib/backfill-runs.ts` is module state with no reset and no export.
    const [firstSample, ...rest] = samples;

    return NextResponse.json({
      ok: true,
      label: 'SYNTHETIC-AGAINST-A-BRANCH. Not a production measurement. No threshold is proposed.',
      cell,
      shape: { max: shapeMax, conc: shapeConc },
      shape_note: shapeConc > 1 && cell !== 'declare'
        ? 'conc is recorded as provenance only: the per-note boundaries are measured serially, so concurrency is not exercised in this cell'
        : 'max is the batch size the declaration insert carries',
      audit_mode: auditMode,
      first_statement_in_process: { n: 1, ms: firstSample ?? null },
      distribution_excluding_first: summarise(rest),
      route_written_as: 'script',
      row_count_verification: 'NOT PERFORMED BY THIS ROUTE — see Part XI. Reading the three telemetry '
        + 'tables from here would either need the non-exposure allow-list extended, which addendum v4 §6 '
        + 'forbids, or the table name built dynamically to evade that scan, which is worse. Owed.',
      steps,
      raw_samples_ms: samples,
      raw_samples_note: 'Save this response body as the archive; nothing is written to disk from a serverless function.',
    });
  } catch (e) {
    // ⚠️ THE MESSAGE IS TRUNCATED AND THE CONNECTION STRING IS NEVER IN IT. A driver error can
    // carry the host; 200 characters of a Postgres message is enough to diagnose a missing table
    // and is checked by the guard test against every DATABASE_URL substring.
    return NextResponse.json({
      ok: false, steps, error: String((e as Error).message).slice(0, 200),
    }, { status: 500 });
  }
}
