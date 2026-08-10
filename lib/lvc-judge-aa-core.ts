/**
 * lib/lvc-judge-aa-core.ts — LVC applicability-judge A/A comparator (PURE).
 * DETERMINISM-TRIO PRD v1.0 §4 (D-4: MEASURE ONLY), 8 Aug 2026.
 *
 * WHAT AN A/A RUN IS. The same judge, the same model, the same configuration, asked the SAME
 * question twice. Any disagreement is the judge disagreeing with itself — there is no second
 * condition to attribute it to. `defaultJudge` (lib/lvc.ts:149) runs at temperature 0.1 with no
 * seed and no top_p, and it is the gate on every LVC finding: this file is the instrument that
 * measures how often that gate answers differently on identical input.
 *
 * PURE AND DEPENDENCY-FREE (type-only imports), so it loads under `node --experimental-strip-types`
 * and is unit-tested without a DB, an LLM or a network. It DECIDES NOTHING: no threshold lives here
 * — PRD §4.3 records the 95% decision rule as V's, to be made on the report this produces.
 *
 * PAIRING IS BY REC ID, NEVER BY POSITION. parseJudgeResponse builds its result from the model's
 * own array and back-fills the rest, so run B can return the same verdicts in a different order.
 * Comparing index-to-index would manufacture flips out of ordering noise. A rec present in one run
 * and absent from the other is counted as `unmatched` and never silently dropped.
 */

import type { JudgedRec, Verdict } from './lvc-core';

/** The three verdicts, in a fixed order so the flip matrix's keys are stable across runs. */
export const AA_VERDICTS: Verdict[] = ['applies', 'does_not_apply', 'insufficient_info'];

export interface AaRecComparison {
  recId: string;
  verdictA: Verdict;
  verdictB: Verdict;
  agree: boolean;
  confidenceA: number;
  confidenceB: number;
  /** signed B − A, so a reader can see drift direction as well as magnitude */
  confidenceDelta: number;
}

export interface AaCaseComparison {
  /** the sampled note uid this case came from */
  uid: string;
  /** recs judged in BOTH runs (the comparable set) */
  nRecs: number;
  /** rec ids present in one run only — never silently dropped */
  unmatched: string[];
  /** true iff every comparable rec's verdict matched (the §4.3 headline unit) */
  identicalVerdictSet: boolean;
  nAgree: number;
  nFlips: number;
  /** 'applies→does_not_apply' → count, over flips only (agreements are not in the matrix) */
  flipMatrix: Record<string, number>;
  meanAbsConfidenceDelta: number;
  perRec: AaRecComparison[];
}

export interface AaSummary {
  nCases: number;
  nRecs: number;
  /** % of CASES whose comparable verdict set was identical — 0 when nothing was compared */
  identicalVerdictSetPct: number;
  /** % of RECS whose verdict flipped */
  flipPct: number;
  meanAbsConfidenceDelta: number;
  /** flip matrix summed across every case */
  flipMatrix: Record<string, number>;
  /** cases whose comparable set was EMPTY — they cannot agree or disagree, and are excluded
   *  from identicalVerdictSetPct rather than counted as agreement (which would flatter the judge) */
  nEmptyCases: number;
  nUnmatchedRecs: number;
}

const flipKey = (a: Verdict, b: Verdict): string => `${a}→${b}`;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const pct = (num: number, den: number): number => (den > 0 ? round4((num / den) * 100) : 0);

/** One case: two JudgedRec[] for the SAME rec set, judged twice. */
export function compareJudgedRuns(uid: string, a: JudgedRec[], b: JudgedRec[]): AaCaseComparison {
  const byId = (rs: JudgedRec[]): Map<string, JudgedRec> => {
    const m = new Map<string, JudgedRec>();
    // first occurrence wins — a duplicated id is a parse artefact, not two judgements
    for (const r of rs || []) { const id = String(r?.rec?.id ?? ''); if (id && !m.has(id)) m.set(id, r); }
    return m;
  };
  const A = byId(a), B = byId(b);
  const shared = [...A.keys()].filter((id) => B.has(id)).sort();
  const unmatched = [...new Set([...A.keys()].filter((id) => !B.has(id)).concat([...B.keys()].filter((id) => !A.has(id))))].sort();

  const perRec: AaRecComparison[] = shared.map((id) => {
    const ra = A.get(id) as JudgedRec, rb = B.get(id) as JudgedRec;
    const ca = Number(ra.confidence) || 0, cb = Number(rb.confidence) || 0;
    return {
      recId: id, verdictA: ra.verdict, verdictB: rb.verdict, agree: ra.verdict === rb.verdict,
      confidenceA: ca, confidenceB: cb, confidenceDelta: round4(cb - ca),
    };
  });

  const flips = perRec.filter((r) => !r.agree);
  const flipMatrix: Record<string, number> = {};
  for (const f of flips) { const k = flipKey(f.verdictA, f.verdictB); flipMatrix[k] = (flipMatrix[k] ?? 0) + 1; }
  const meanAbs = perRec.length
    ? round4(perRec.reduce((s, r) => s + Math.abs(r.confidenceDelta), 0) / perRec.length)
    : 0;

  return {
    uid,
    nRecs: perRec.length,
    unmatched,
    // An EMPTY comparable set is not agreement. It is nothing measured, and the summary counts it
    // as such (nEmptyCases) instead of letting it inflate the headline.
    identicalVerdictSet: perRec.length > 0 && flips.length === 0,
    nAgree: perRec.length - flips.length,
    nFlips: flips.length,
    flipMatrix,
    meanAbsConfidenceDelta: meanAbs,
    perRec,
  };
}

/** The run-level summary (§4.2). `identicalVerdictSetPct` is over cases that actually compared. */
export function summarizeAa(cases: AaCaseComparison[]): AaSummary {
  const list = cases || [];
  const compared = list.filter((c) => c.nRecs > 0);
  const nRecs = compared.reduce((s, c) => s + c.nRecs, 0);
  const nFlips = compared.reduce((s, c) => s + c.nFlips, 0);
  const flipMatrix: Record<string, number> = {};
  for (const c of compared) for (const [k, v] of Object.entries(c.flipMatrix)) flipMatrix[k] = (flipMatrix[k] ?? 0) + v;
  const sumAbs = compared.reduce((s, c) => s + c.meanAbsConfidenceDelta * c.nRecs, 0);
  return {
    nCases: list.length,
    nRecs,
    identicalVerdictSetPct: pct(compared.filter((c) => c.identicalVerdictSet).length, compared.length),
    flipPct: pct(nFlips, nRecs),
    meanAbsConfidenceDelta: nRecs ? round4(sumAbs / nRecs) : 0,
    flipMatrix,
    nEmptyCases: list.length - compared.length,
    nUnmatchedRecs: list.reduce((s, c) => s + c.unmatched.length, 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit C — re-run support (LVC JUDGE PINNING PRD v1.0 §4, 10 Aug 2026)
// ─────────────────────────────────────────────────────────────────────────────

/** The tag the r1 baseline was stored under. Unchanged, and still the default. */
export const AA_EXPERIMENT_DEFAULT = 'lvc_judge_aa_r1';

/**
 * The ONLY shape a re-run tag may take (PRD §4). Deliberately narrow: the tag keys the resume
 * skip-set (`doneUids`) AND the lab_analyses rows the report is read off, so a typo would silently
 * start a fresh, empty round rather than resume — and two rounds sharing a tag would be
 * indistinguishable in the analysis. `r0`–`r99`, nothing else.
 */
export const AA_EXPERIMENT_RE = /^lvc_judge_aa_r[0-9]{1,2}$/;

/**
 * Resolve the `experiment` query parameter. ANYTHING that does not match falls back to r1 —
 * including empty, absent and junk — so the route can never write rows under a tag nobody will
 * look for. Whitespace is trimmed; nothing else is coerced (no lower-casing: a tag that differs
 * only in case is a different tag to the DB, and quietly folding it would be the same defect the
 * regex exists to prevent).
 */
export function resolveAaExperiment(raw: string | null | undefined): string {
  const v = String(raw ?? '').trim();
  return AA_EXPERIMENT_RE.test(v) ? v : AA_EXPERIMENT_DEFAULT;
}

// ─────────────────────────────────────────────────────────────────────────────
// HARNESS TIMING + PER-CASE OUTCOME (HARNESS-AND-ATTRIBUTION kickoff, 10 Aug 2026)
//
// Pure, so the arithmetic and the classification are unit-tested without a route, a clock or a DB.
// They live here rather than in the route because Next validates a route module's exports — an
// extra export from app/api/**/route.ts fails `next build` — and the test glob only reaches lib/**.
// ─────────────────────────────────────────────────────────────────────────────

/** The platform box. 300 was never a cap: app/api/opd-audit/worker/route.ts has run at 800 since
 *  30 Jul 2026, which is the proof this value rests on rather than an assumption about the plan. */
export const AA_ROUTE_MAX_DURATION_S = 800;

/** MEASURED, 10 Aug 2026, after the guard fix: ~135 s per judge call, and one A/A case is two
 *  calls plus the note fetch, the pass-0 assembly, two verdict reads and the store. */
export const AA_MEASURED_JUDGE_CALL_MS = 135_000;
export const AA_MEASURED_CASE_MS = 275_000;

/** The route's own deadline, scaled from the old pair (250 s inside a 300 s box) so the SAME
 *  fraction of the box stays in reserve for finishing and answering: 800 × 250/300 = 666.7 s,
 *  rounded DOWN to 665 s so the headroom can only be larger than it was, never smaller. */
export const AA_DEADLINE_MS = 665_000;

/** Never start a case we cannot finish — a half-run case stores nothing and would be re-run from
 *  scratch anyway. One full MEASURED case (275 s) plus 30 s, which covers the two trace reads and
 *  the lab store on the slow side of what has been observed. The old value was 60 s, less than a
 *  quarter of a case: it admitted cases that then died at the clock, which is the defect. */
export const AA_PER_CASE_RESERVE_MS = 305_000;

/** May another case start? Pure, so the arithmetic is testable against the measured case length. */
export function canStartCase(remainingMs: number, reserveMs: number = AA_PER_CASE_RESERVE_MS): boolean {
  return Number.isFinite(remainingMs) && remainingMs >= reserveMs;
}

/** The watchdog budget for a case that IS starting: everything left before the internal deadline.
 *  A case can therefore never run past it, which is what makes a `timeout` status recordable
 *  instead of the invocation being killed mid-case with nothing written. */
export function caseBudgetMs(remainingMs: number): number {
  return Math.max(0, Math.floor(remainingMs));
}

/**
 * PER-CASE OUTCOME. `compared` must mean a comparison actually happened, which is why this is
 * classified from ATTRIBUTION and not from the verdicts alone: a REFUSED judge run still returns a
 * full verdict set (every rec insufficient_info) and still writes its trace event, so two refused
 * runs would compare as perfectly identical and inflate r2's headline number. They are not a
 * measurement of repeatability; they are a measurement of nothing.
 */
export type AaCaseStatus =
  | 'compared'            // both runs served a verdict and the comparison ran
  | 'no_orders'           // the note had nothing to judge (unchanged)
  | 'no_recall'           // nothing recalled, so the judge was never called (unchanged)
  | 'integrity_failure'   // a run was served by the wrong model, or refused for that reason
  | 'transport_failure'   // a run's provider call failed, or no cloud model could be resolved
  | 'parse_failure'       // a run's verdicts could not be read back — see the note below
  | 'timeout'             // the case did not finish inside the budget it was started with
  | 'error';              // anything else, with the message in `detail`

/** Refusal reasons that mean THE WRONG MODEL ANSWERED (or that the two evidence sources fought). */
export const AA_INTEGRITY_REASONS = new Set([
  'transport_names_other_model', 'body_names_other_model', 'transport_body_conflict',
  'transport_reports_no_cloud_response', 'served_model_disagrees', 'served_model_empty',
]);
/** Refusal reasons that mean NO MODEL ANSWERED AT ALL — a failed call, or nothing to call. */
export const AA_TRANSPORT_REASONS = new Set([
  'call_failed', 'no_gemini_model_resolved', 'force_ollama_requested',
]);

/** The per-run attribution this classifier needs. Structurally the compact record lib/lvc.ts
 *  carries out of the judge (JudgeRunAttribution); declared locally to keep this module pure. */
export interface AaRunAttribution {
  attribution_state?: string | null;
  attribution_reason?: string | null;
  outcome?: string | null;
  refuse_reason?: string | null;
}

/**
 * Classify one case. Precedence is integrity → transport → parse → compared, because a run that
 * was served by the wrong model is not also a parse problem, and calling it one would file a
 * clinical-integrity event under a data-shape heading.
 *
 * ⚠️ WHAT `parse_failure` HONESTLY MEANS, AND WHAT IT CANNOT SEPARATE. The harness reads verdicts
 * off the `lvc_judge_verdicts` trace event, so "the model returned something the parser could not
 * use" and "no readable verdict event was found on the trace" arrive identically. ONE label covers
 * both. The distinction would need the raw completion, which this route deliberately never stores.
 */
export function classifyAaCase(input: {
  attrA?: AaRunAttribution | null;
  attrB?: AaRunAttribution | null;
  nVerdictsA: number;
  nVerdictsB: number;
}): { status: AaCaseStatus; detail: string | null } {
  const runs: Array<[string, AaRunAttribution | null | undefined]> = [['A', input.attrA], ['B', input.attrB]];

  for (const [name, a] of runs) {
    if (!a) continue;
    const reason = String(a.refuse_reason ?? a.attribution_reason ?? '');
    if (a.attribution_state === 'wrong_model' || AA_INTEGRITY_REASONS.has(reason)) {
      return { status: 'integrity_failure', detail: `run ${name}: ${reason || 'wrong_model'}` };
    }
  }
  for (const [name, a] of runs) {
    if (!a) continue;
    if (a.outcome === 'refusal' && AA_TRANSPORT_REASONS.has(String(a.refuse_reason ?? ''))) {
      return { status: 'transport_failure', detail: `run ${name}: ${a.refuse_reason}` };
    }
  }
  if (input.nVerdictsA <= 0 || input.nVerdictsB <= 0) {
    return {
      status: 'parse_failure',
      detail: `verdicts unreadable (A ${input.nVerdictsA}, B ${input.nVerdictsB}) — unparseable reply or no readable trace event; the harness cannot tell these apart`,
    };
  }
  return { status: 'compared', detail: null };
}
