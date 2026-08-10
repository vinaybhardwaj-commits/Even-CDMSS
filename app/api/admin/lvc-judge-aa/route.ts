/**
 * app/api/admin/lvc-judge-aa/route.ts — LVC applicability-judge A/A harness.
 * DETERMINISM-TRIO PRD v1.0 §4 (D-4: MEASURE ONLY), 8 Aug 2026.
 * LVC JUDGE PINNING PRD v1.0 §4 (Unit C — the round is now a parameter), 10 Aug 2026.
 *
 * WHAT IT DOES. For each sampled note it assembles the judge context ONCE through the production
 * pipeline (lib/lvc.ts `matchLowValueCare`), then runs that pipeline TWICE more with the recall
 * result PINNED to what the first pass produced — so both runs hand `defaultJudge` a byte-identical
 * context object at WHATEVER the production configuration currently is (the same model resolution,
 * surface 'surface'). The two verdict sets and their comparison go to `lab_analyses` under the
 * round tag, default `lvc_judge_aa_r1`.
 *
 * ⚠️ THE CONFIGURATION UNDER TEST MOVED ON 10 AUGUST, AND THAT IS THE POINT. r1 measured the
 * judge at temperature 0.1, no seed, no top_p: 38/47 cases identical (80.9%) against a 95% bar.
 * `defaultJudge` is now pinned (temperature 0, seed AUDIT_LLM_SEED, top_p 1) and refuses any
 * non-Gemini served model. This route was NOT re-pointed at the old configuration to preserve a
 * comparison — it deliberately still measures whatever production runs, which is what makes
 * `?experiment=lvc_judge_aa_r2` a before/after and not two different instruments.
 *
 * WHAT IT STILL DOES NOT DO. It reads no threshold and writes no floor, forks no judge, and
 * touches no scoring table. The r1 rows are immutable history; r2 lands under its own tag.
 *
 * ⚠️ WHY THE VERDICTS COME FROM THE TRACE. `matchLowValueCare` returns assembled FLAGS, not the
 * judge's raw verdicts (assembleFlags drops everything below the surface's confidence floor).
 * Reading `lvc_judge_verdicts` — the observability event the
 * pipeline already writes on every real /api/appropriateness call — is the only way to observe the
 * PRODUCTION judge without forking it, and a forked judge would measure a different function than
 * the one in question. Only that event kind is read, and only its (id, verdict, confidence) triples;
 * the payload is never stored. CONSEQUENCE, FLAGGED: each case writes 2 `appropriateness` traces,
 * exactly as two real order-checks would. No scoring table is touched — not opd_note_audits, not
 * appropriateness_runs. Results land in lab_analyses and nowhere else.
 *
 * BUDGET (RE-SIZED 10 Aug 2026 — HARNESS-AND-ATTRIBUTION kickoff item 1). ~2 judge calls per case,
 * fired by the ORCHESTRATOR when this route is called — never by CI and never by the nightly
 * worker. Sequential (concurrency 1), stops cleanly and reports progress; call it again to resume,
 * since uids already stored for the tag are skipped.
 *
 * ⚠️ WHY THE OLD NUMBERS COULD NOT WORK. A judge call measures ~135 s in production after the guard
 * fix, so one case — two calls — is ~275 s. The route's box was 300 s and it would start a case
 * with only 60 s left: the case then died at the clock, wrote nothing, and the invocation was lost
 * mid-flight. 800 s (the box app/api/opd-audit/worker has run in since 30 July, which is the proof
 * this rests on) with a 665 s internal deadline and a ONE-FULL-CASE reserve fixes both ends: cases
 * are only started when they can finish, and a case that overruns anyway is now RECORDED as a
 * timeout by its own watchdog rather than killed by the platform. All three values, and the
 * reasoning, are in lib/lvc-judge-aa-core.ts where they are unit-tested.
 *
 * ⚠️ ATTRIBUTION (item 3). `servedCallForAudit` — the older lookup — has been returning an empty
 * provider and model, so every stored case said nothing about which model judged it. The stored
 * case now ALSO carries `attribution.runA` / `attribution.runB`, taken IN-PROCESS from the
 * transport attribution field 101e4e4 added (MatchResult.judgeAttribution), never re-read from a
 * trace and never inferred from what was requested. `served` is left exactly as it was, beside it.
 *
 * EVERY SQL STRING IN THIS FILE IS INFERRED (the builder has no live DB) and is reproduced verbatim
 * in the build report for orchestrator validation. Fail-safe throughout: a failure returns a JSON
 * error body, never a 500 mid-batch, and never a partial junk row.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { sql } from '@/lib/db';
import { matchLowValueCare, type MatchInput, type JudgeRunAttribution } from '@/lib/lvc';
import type { JudgedRec, LvcRecommendation, Verdict } from '@/lib/lvc-core';
import {
  compareJudgedRuns, summarizeAa, resolveAaExperiment, AA_EXPERIMENT_DEFAULT,
  classifyAaCase, canStartCase, caseBudgetMs,
  AA_ROUTE_MAX_DURATION_S, AA_DEADLINE_MS, AA_PER_CASE_RESERVE_MS, AA_MEASURED_CASE_MS,
  type AaCaseComparison, type AaCaseStatus,
} from '@/lib/lvc-judge-aa-core';
import { fetchOpdNoteByUid } from '@/lib/metabase';
import { rowToOpdCase, opdCaseText, type DeidOpdCase } from '@/lib/opd-ingest-core';
import { OPD_ENGINE_VERSIONS_CURRENT } from '@/lib/opd-note-audit-core';
import { enrichOpdMeds } from '@/lib/formulary';
import { saveLabAnalysis } from '@/lib/lab';
import { doneUids } from '@/lib/lab-batch';
import { servedCallForAudit } from '@/lib/backfill-runs';
import { remainingBudgetMs } from '@/lib/lab-batch-core';

export const runtime = 'nodejs';
// 300 → 800 (item 1). One case is ~275 s measured, so the old box could not hold even one with its
// reserve. The value is not a guess about the plan: app/api/opd-audit/worker has run at 800 since
// 30 July 2026. The route's OWN deadline is AA_DEADLINE_MS (665 s); this is the headroom above it.
//
// ⚠️ A LITERAL, NOT THE IMPORTED CONSTANT. Next parses segment config statically and fails the
// build with `Unknown identifier "AA_ROUTE_MAX_DURATION_S" at "maxDuration"`. The two are pinned
// to each other by a source-assertion test, so they cannot drift apart silently.
export const maxDuration = 800;   // === AA_ROUTE_MAX_DURATION_S

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * ROUND TAG (LVC JUDGE PINNING PRD v1.0 §4, 10 Aug 2026). The round is now a PARAMETER, because
 * D-4 pre-registers a second run of this exact harness against the pinned judge: `?experiment=
 * lvc_judge_aa_r2`. Validated against AA_EXPERIMENT_RE and defaulted to r1, so the baseline tag is
 * what an unparameterised call still writes and reads — nothing about r1 moves.
 *
 * The tag is load-bearing in two places, which is why it is validated rather than passed through:
 * it is the resume skip-set (`doneUids(experiment)`) and it is the `experiment` column the report
 * is read off. A typo would start an empty round that resumes nothing.
 */
const AA_ENGINE = 'lvc-judge-aa/1.0';
const APP_SOURCE = process.env.APP_SOURCE || 'standalone';

// ── INFERRED SQL 1 — the sample (§4.2) ────────────────────────────────────────────────────────────
// Recent distinct note uids whose stored current-engine audit contains at least one NON-INFORMATIONAL
// finding with a non-null rule_ref, newest first. `engine_version = ANY(...)` uses the READ-side
// FAMILY (OPD_ENGINE_VERSIONS_CURRENT), which is the documented convention for every user-facing read
// — an exact match on OPD_ENGINE_VERSION would return nothing at all the day an engine bumps.
// jsonb_typeof guards a non-array `findings` (jsonb_array_elements would raise on one).
const SAMPLE_SQL = `SELECT s.uid AS uid, s.note_date AS note_date
  FROM (
    SELECT DISTINCT ON (a.uid) a.uid AS uid, a.note_date AS note_date
      FROM opd_note_audits a
     WHERE a.app_source = $1
       AND a.engine_version = ANY($2)
       AND jsonb_typeof(a.findings) = 'array'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(a.findings) f
          WHERE (f->>'informational') IS DISTINCT FROM 'true'
            AND f->>'rule_ref' IS NOT NULL
       )
     ORDER BY a.uid, a.note_date DESC NULLS LAST
  ) s
 ORDER BY s.note_date DESC NULLS LAST
 LIMIT $3`;

// ── INFERRED SQL 2 — the judge's own verdicts, off the trace the pipeline just wrote ──────────────
// ONE event kind, the LAST one on the trace. Only (id, verdict, confidence) are extracted; the
// payload itself is never stored or returned.
const VERDICTS_SQL = `SELECT payload
  FROM trace_events
 WHERE trace_id = $1 AND kind = 'lvc_judge_verdicts'
 ORDER BY seq DESC
 LIMIT 1`;

interface SampledUid { uid: string; noteDate: string | null }

/** Fail-safe: any error returns an empty sample and the caller reports it — never throws. */
async function sampleUids(n: number): Promise<{ rows: SampledUid[]; error?: string }> {
  try {
    const rows = await run(SAMPLE_SQL, [APP_SOURCE, [...OPD_ENGINE_VERSIONS_CURRENT], n]);
    return {
      rows: rows.map((r) => ({ uid: String(r.uid), noteDate: r.note_date == null ? null : String(r.note_date) }))
        .filter((r) => !!r.uid),
    };
  } catch (e) {
    return { rows: [], error: `sample query failed: ${String((e as Error).message).slice(0, 300)}` };
  }
}

/** The judge's verdicts for one run, read back from its trace and re-paired with the recs. */
async function verdictsFromTrace(traceId: string | undefined, recs: LvcRecommendation[]): Promise<JudgedRec[]> {
  if (!traceId) return [];
  let rows: Record<string, unknown>[];
  try { rows = await run(VERDICTS_SQL, [traceId]); } catch { return []; }
  const payload = rows?.[0]?.payload as { verdicts?: unknown } | null | undefined;
  const list = Array.isArray(payload?.verdicts) ? payload!.verdicts as unknown[] : [];
  const byId = new Map(recs.map((r) => [r.id, r]));
  const out: JudgedRec[] = [];
  for (const v of list) {
    const o = (v ?? {}) as Record<string, unknown>;
    const rec = byId.get(String(o.id ?? ''));
    if (!rec) continue;
    out.push({
      rec,
      verdict: String(o.verdict ?? 'insufficient_info') as Verdict,
      confidence: Number(o.confidence) || 0,
      why: '', consider_instead: null,
    });
  }
  return out;
}

/** The judge context for one note, assembled from the note the SAME way the audit assembles it. */
function inputForCase(oc: DeidOpdCase): MatchInput {
  // enrichOpdMeds is what auditOpdNote runs before anything reads the case (brand→generic + class),
  // so the scenario text this harness judges is the text the rest of the system would see.
  enrichOpdMeds(oc.medications);
  const orders = [
    ...oc.medications.map((m) => (m.resolvedGeneric || m.generic || m.brand || '').trim()),
    ...oc.investigations.map((i) => String(i || '').trim()),
  ].filter(Boolean);
  return {
    scenario: opdCaseText(oc),
    proposedActions: Array.from(new Set(orders)),
    surface: 'surface',            // §4.1 — the opt-in surface's model resolution, the judge under test
  };
}

interface CaseResult {
  uid: string;
  status: AaCaseStatus;
  comparison?: AaCaseComparison;
  stored?: string;
  detail?: string;
  /** Per-run attribution, surfaced in the response as well as stored (item 3). */
  attribution?: { runA: JudgeRunAttribution | null; runB: JudgeRunAttribution | null };
}

/**
 * One case: assemble ONCE, judge TWICE on the pinned context, compare, store.
 * Never throws — the caller records the status and moves to the next uid.
 */
async function runCase(uid: string, save: boolean, experiment: string): Promise<CaseResult> {
  const t0 = Date.now();
  try {
    const row = await fetchOpdNoteByUid(uid);
    if (!row) return { uid, status: 'error', detail: 'no db13 OPD note for uid' };
    const { case: oc } = rowToOpdCase(row);
    const input = inputForCase(oc);
    if (!input.proposedActions?.length) return { uid, status: 'no_orders' };

    // ── Pass 0: assemble the context ONCE, through the production pipeline. The injected judge
    // captures what the real judge WOULD have been handed and returns the pipeline's own soft-fail
    // shape, so no LLM judge call is spent and nothing downstream is disturbed. Untraced: it makes
    // no model call worth attributing.
    let captured: LvcRecommendation[] = [];
    await matchLowValueCare({ ...input, trace: false }, {
      judge: async (_ctx, recs) => {
        captured = recs;
        return recs.map((rec) => ({ rec, verdict: 'insufficient_info' as Verdict, confidence: 0, why: '', consider_instead: null }));
      },
    });
    if (!captured.length) {
      // Nothing recalled ⇒ the judge is never called on this note. Stored (when saving) so the
      // resume skip is honest and the uid is not re-fetched every call.
      const empty = compareJudgedRuns(uid, [], []);
      const stored = save ? await saveLabAnalysis({
        experiment, kind: 'lvc_judge_aa', engine: AA_ENGINE, inputRef: uid,
        inputPreview: input.scenario.slice(0, 200),
        output: { uid, status: 'no_recall', nRecs: 0, comparison: empty },
        model: null, latencyMs: Date.now() - t0, provider: null,
      }) : undefined;
      return { uid, status: 'no_recall', comparison: empty, stored };
    }

    // ── Passes A and B: the REAL judge, twice, on the pinned recall. `recall` is pinned so the two
    // runs cannot differ in what they were asked; `judge` is NOT injected, so defaultJudge runs at
    // the production configuration. `proposedActions` is set, so candidate extraction is skipped
    // and the candidates (hence judgeCtx) are identical by construction.
    const pinned = { recall: async () => captured };
    const a = await matchLowValueCare(input, pinned);
    const b = await matchLowValueCare(input, pinned);
    const [judgedA, judgedB] = await Promise.all([
      verdictsFromTrace(a.traceId, captured),
      verdictsFromTrace(b.traceId, captured),
    ]);
    // ITEM 3 — WHICH MODEL ACTUALLY JUDGED EACH RUN, carried in-process off the transport
    // attribution field (101e4e4) rather than re-read from a trace. Null only when the judge never
    // ran or the pipeline soft-failed before it.
    const attrA = a.judgeAttribution ?? null;
    const attrB = b.judgeAttribution ?? null;
    const attribution = { runA: attrA, runB: attrB };

    // ITEM 2 — the per-case outcome, classified BEFORE the comparison is believed. A refused run
    // returns a full verdict set (every rec insufficient_info), so two refusals would compare as
    // perfectly identical and inflate r2's headline; `compared` must mean a judgement happened.
    const { status, detail } = classifyAaCase({
      attrA, attrB, nVerdictsA: judgedA.length, nVerdictsB: judgedB.length,
    });
    const comparison = compareJudgedRuns(uid, judgedA, judgedB);
    if (status !== 'compared') {
      // Stored, so a failed case is COUNTABLE and the resume skip is honest — but never counted as
      // a comparison: `comparison` rides along for diagnosis and the status says what it is worth.
      const storedFail = save ? await saveLabAnalysis({
        experiment, kind: 'lvc_judge_aa', engine: AA_ENGINE, inputRef: uid,
        inputPreview: input.scenario.slice(0, 200),
        output: {
          uid, status, detail, surface: 'surface',
          nRecsRecalled: captured.length,
          runA: { traceId: a.traceId ?? null, nVerdicts: judgedA.length },
          runB: { traceId: b.traceId ?? null, nVerdicts: judgedB.length },
          attribution,
        },
        model: attrA?.dispatched_model ?? null, provider: attrA?.dispatched_provider ?? null,
        latencyMs: Date.now() - t0,
      }) : undefined;
      return { uid, status, detail: detail ?? undefined, attribution, stored: storedFail };
    }

    // `served` is the OLDER lookup (F11 / DEC-2) and is LEFT EXACTLY AS IT WAS beside the new
    // field — readers of r1 rows must find it unchanged, empty values and all.
    const served = await servedCallForAudit(a.traceId, 'lvc_judge');
    const stored = save ? await saveLabAnalysis({
      experiment, kind: 'lvc_judge_aa', engine: AA_ENGINE, inputRef: uid,
      inputPreview: input.scenario.slice(0, 200),
      output: {
        uid, status: 'compared', surface: 'surface',
        nRecsRecalled: captured.length,
        orders: input.proposedActions,
        runA: { traceId: a.traceId ?? null, verdicts: judgedA.map((j) => ({ id: j.rec.id, verdict: j.verdict, confidence: j.confidence })), nFlags: a.flags.length },
        runB: { traceId: b.traceId ?? null, verdicts: judgedB.map((j) => ({ id: j.rec.id, verdict: j.verdict, confidence: j.confidence })), nFlags: b.flags.length },
        comparison,
        served,
        attribution,
      },
      // The COLUMNS take the new evidence first and fall back to the old lookup, so a row is no
      // longer blank about which model judged it. r1 rows are untouched history either way.
      model: attrA?.dispatched_model ?? served.model,
      provider: attrA?.dispatched_provider ?? served.provider,
      latencyMs: Date.now() - t0,
    }) : undefined;
    return { uid, status: 'compared', comparison, stored, attribution };
  } catch (e) {
    return { uid, status: 'error', detail: String((e as Error).message).slice(0, 300) };
  }
}

/**
 * ITEM 2 — the watchdog that makes `timeout` a RECORDED outcome instead of a lost invocation.
 * The judge calls themselves are not cancellable (no abort signal is plumbed through
 * matchLowValueCare, and plumbing one would reach into the pipeline this build must not touch), so
 * the losing leg keeps running in the background until the invocation ends. What this buys is
 * honesty: the route returns a JSON body naming the case that overran, rather than being killed
 * with nothing written. FLAGGED in the build report.
 */
async function runCaseWithin(uid: string, save: boolean, experiment: string, budgetMs: number): Promise<CaseResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CaseResult>((resolve) => {
    timer = setTimeout(() => resolve({
      uid, status: 'timeout',
      detail: `case did not finish within its ${Math.round(budgetMs / 1000)} s budget (measured case ≈ ${Math.round(AA_MEASURED_CASE_MS / 1000)} s); the judge calls are not cancellable and continue in the background`,
    }), budgetMs);
  });
  try {
    return await Promise.race([runCase(uid, save, experiment), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// GET /api/admin/lvc-judge-aa?n=50&save=1&experiment=lvc_judge_aa_r2 — admin-gated.
// Sequential, resumable, 250 s deadline. `experiment` omitted or junk ⇒ the r1 baseline tag.
export async function GET(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const deadlineAt = Date.now() + AA_DEADLINE_MS;

  const nRaw = parseInt(req.nextUrl.searchParams.get('n') || '50', 10);
  const n = Math.max(1, Math.min(100, Number.isFinite(nRaw) ? nRaw : 50));
  const save = (req.nextUrl.searchParams.get('save') ?? '1') !== '0';
  const experimentRaw = req.nextUrl.searchParams.get('experiment');
  const experiment = resolveAaExperiment(experimentRaw);
  // Reported so a rejected tag is VISIBLE rather than silently swallowed — a caller who typo'd
  // `lvc_judge_aa_R2` must be able to see that they measured r1 again.
  const experimentRejected = !!experimentRaw && experiment !== experimentRaw.trim();

  const sample = await sampleUids(n);
  if (sample.error) return NextResponse.json({ ok: false, experiment, experimentRejected, error: sample.error, stored: 0 });

  // Resume: uids already stored for this tag are done (the SAME done-set primitive the lab batch uses).
  let done: Set<string>;
  try { done = await doneUids(experiment); } catch { done = new Set<string>(); }
  const queue = sample.rows.filter((r) => !done.has(r.uid));

  const results: CaseResult[] = [];
  let stopped: string | null = null;
  for (const item of queue) {
    const left = remainingBudgetMs(deadlineAt);
    // Never start a case that cannot finish (item 1). The reserve is now a FULL measured case.
    if (!canStartCase(left)) { stopped = 'deadline'; break; }
    // sequential — concurrency 1 (§4.2) — and bounded, so an overrun is recorded, not fatal.
    results.push(await runCaseWithin(item.uid, save, experiment, caseBudgetMs(left)));
  }

  const comparisons = results.map((r) => r.comparison).filter((c): c is AaCaseComparison => !!c);
  return NextResponse.json({
    ok: true,
    experiment,
    experimentRejected,
    defaultExperiment: AA_EXPERIMENT_DEFAULT,
    save,
    sampled: sample.rows.length,
    alreadyDone: sample.rows.length - queue.length,
    processed: results.length,
    remaining: Math.max(0, queue.length - results.length),
    stopped,
    stored: results.filter((r) => !!r.stored).length,
    statuses: results.reduce<Record<string, number>>((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {}),
    // The budget the orchestrator is actually running under, reported so a timing change is
    // visible in the response rather than only in the source.
    budget: { maxDurationS: AA_ROUTE_MAX_DURATION_S, deadlineMs: AA_DEADLINE_MS, perCaseReserveMs: AA_PER_CASE_RESERVE_MS },
    // ⚠️ summarizeAa is fed ONLY the cases that actually compared — a refused or failed case
    // contributes no comparison, so it cannot flatter the repeatability headline.
    summary: summarizeAa(comparisons),
    cases: results.map((r) => ({
      uid: r.uid, status: r.status, detail: r.detail ?? null,
      nRecs: r.comparison?.nRecs ?? 0,
      identicalVerdictSet: r.comparison?.identicalVerdictSet ?? null,
      nFlips: r.comparison?.nFlips ?? 0,
      attribution: r.attribution ?? null,
    })),
  });
}
