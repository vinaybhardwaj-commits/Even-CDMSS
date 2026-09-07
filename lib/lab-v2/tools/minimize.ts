/**
 * lib/lab-v2/tools/minimize.ts — `failure_minimize` (§17.11 item 6, decisions 131 and 142).
 *
 * WHAT IT ANSWERS. `failure_cluster` says "these eleven items failed the same way". The next
 * question a person asks is "which of them do I actually need in order to see it again", and until
 * now the only way to answer it was to re-run the whole run and read the wreckage. This tool
 * bisects: it re-runs the group's example cases, keeps halving the set while the failure still
 * reproduces, and reports the smallest set that still does — with the run ids, the steps and the
 * spend, so the answer is checkable rather than asserted.
 *
 * ⚠️ IT MINIMIZES OVER CASES, NOT OVER STAGES. Decision 142 settles that: a stage is not something
 * this platform can switch off per item — an arm prices every stage or the gateway refuses the
 * item by name — so "the smallest input that still fails" is a set of cases. Decision 131's cap is
 * the reason the search is bounded at all: at most 8 cases, every stage of the engine, metered
 * through the arm.
 *
 * ⚠️ "REPRODUCES" IS A NARROW WORD HERE AND IT IS THE WHOLE ANSWER'S MEANING: an item failed with
 * the SAME error category AND the same stage of last model call as the group key. A different
 * category at the same stage is a different fault that happens to live nearby, and counting it
 * would let the bisection converge on a case that never had the problem.
 *
 * ⚠️ THE DATASET IS THE SOURCE RUN'S OWN CASES, RE-USED, NOT RE-FROZEN. Decision 142 says "one
 * dataset from their case keys"; the source run's dataset already holds exactly those cases, with
 * their `member_key`, their `snapshot_policy` and their `replay_exactness`. Re-freezing from a
 * case key is impossible anyway — a Slice D case key is a salted hash of an identifier this
 * platform deliberately did not keep — and re-freezing from production would change the inputs,
 * which is the one thing a minimisation must not do.
 *
 * ⚠️ THE BUDGET CAP IS CHECKED BEFORE EACH STEP AND THE REFUSAL IS THE ANSWER. Decision 131 makes
 * `budget_cap_microusd` required. The estimate is the arm's own declared ceiling — every stage's
 * `max_cost_microusd` summed, times the cases in the step — so a step is refused when the WORST
 * case would breach the cap, never when the average might. A tool that discovered the cap by
 * spending past it would be worse than useless.
 *
 * ⚠️ ZERO MODEL CALLS WHERE THE DATASET REPLAYS. An `ipd_discharge` case frozen by D2c carries its
 * six analyze-family legs, so a step over it prices only the two live stages; an `ipd_episode`
 * case serves every stage from its stored replies and prices nothing. The spend reported is the
 * budget's own movement, not an estimate, so those cases show up as the zero they are.
 */
import { z } from 'zod';
import type { Db } from '../db';
import {
  LabError, RUN_DEADLINE_MS, armBodySchema, datasetBodySchema, experimentBodySchema, hash,
} from '../contracts';
import {
  ensureBudget, getBudget, getObject, getRun, itemsOf, putObject, submitRun,
} from '../store';
import { tick } from '../worker';
import { liveTransport, type Transport } from '../transport';
import type { Adapter } from '../adapters/types';
import { messageHead } from './cluster';

/** Decision 131 — at most eight cases reach a first step, whatever the group holds. */
export const MAX_MINIMIZE_CASES = 8;

/** A guard on the loop itself: eight cases bisect in at most four halvings plus the first run. */
export const MAX_MINIMIZE_STEPS = 8;

export const MINIMIZE_SCHEMAS = {
  failure_minimize: {
    input: z.object({
      /** `failure_cluster`'s own group key, verbatim. */
      group_key: z.object({
        engine: z.string().nullable(),
        stage: z.string().nullable(),
        category: z.string().nullable(),
        message_head: z.string().nullable(),
      }),
      run_id: z.string().uuid(),
      /** Decision 131 — required, never defaulted. */
      budget_cap_microusd: z.number().int().positive(),
      idempotency_key: z.string().min(1),
    }),
    output: z.object({
      source_run_id: z.string().uuid(),
      group_key: z.object({
        engine: z.string().nullable(), stage: z.string().nullable(),
        category: z.string().nullable(), message_head: z.string().nullable(),
      }),
      /** What the group offered in this run, before decision 131's cap. */
      candidates: z.number().int(),
      /** The case keys the first step ran over — at most eight. */
      started_with: z.array(z.string()),
      /** The smallest set that still reproduced the group. Empty when nothing did. */
      minimal_case_keys: z.array(z.string()),
      reproducing_run_ids: z.array(z.string().uuid()),
      steps: z.array(z.object({
        step: z.number().int(),
        case_keys: z.array(z.string()),
        run_id: z.string().uuid().nullable(),
        reproduced: z.boolean(),
        matching_items: z.number().int(),
        estimated_microusd: z.number().int(),
        spent_microusd: z.number().int(),
        note: z.string().nullable(),
      })),
      spend_microusd: z.number().int(),
      budget_cap_microusd: z.number().int(),
      /** Why the search ended: 'minimal', 'not_reproduced', 'budget_cap' or 'step_cap'. */
      stopped: z.enum(['minimal', 'not_reproduced', 'budget_cap', 'step_cap']),
      caveat: z.string(),
    }),
  },
} as const;

export const MINIMIZE_CAVEAT =
  'A minimal set is the smallest of the sets this search actually ran, not the smallest that '
  + 'exists: the bisection halves and never re-combines, so two cases that fail only together are '
  + 'reported as the pair they are and a third that would also do it is not searched for. '
  + 'Reproduction means the same error category at the same stage of last model call — the group '
  + 'key, not the message.';

export interface MinimizeDeps {
  db: Db;
  principal: string;
  transport?: Transport;
  /** Injection seam for unit tests (repo idiom). Production passes neither. */
  adapters?: Record<string, Adapter>;
}

interface Candidate { case_key: string; last_stage: string | null; category: string | null; head: string | null }

/** The stage of an item's last model call — `failure_cluster`'s own definition, one item at a time. */
const LAST_STAGE_SQL = `SELECT c.stage FROM lab_v2.calls c WHERE c.item_id = $1
 ORDER BY c.created_at DESC, c.lease_token DESC LIMIT 1`;

function sameGroup(c: Candidate, k: { engine: string | null; stage: string | null; category: string | null; message_head: string | null }): boolean {
  return c.last_stage === k.stage && c.category === k.category && c.head === k.message_head;
}

export async function failureMinimize(deps: MinimizeDeps, args: {
  group_key: { engine: string | null; stage: string | null; category: string | null; message_head: string | null };
  run_id: string; budget_cap_microusd: number; idempotency_key: string;
}) {
  const { db, principal } = deps;
  const transport = deps.transport ?? liveTransport;
  const key = args.group_key;

  const source = await getRun(db, args.run_id);
  if (!source) throw new LabError('NOT_FOUND', `no run ${args.run_id}`);
  if (source.owner !== principal) throw new LabError('OWNER_ONLY', 'a run may only be minimised by its owner');

  const sourceItems = await itemsOf(db, source.id, 1000, 0);
  if (!sourceItems.length) throw new LabError('INVALID_INPUT', `run ${source.id} has no items`);

  // ── which of this run's items belong to the group ────────────────────────────────
  const candidates: Candidate[] = [];
  for (const i of sourceItems) {
    const failed = i.execution_status === 'failed' || i.assessment_status === 'unassessable' || i.attribution_status === 'invalid';
    if (!failed) continue;
    const engine = (i.payload as { engine?: string })?.engine ?? null;
    if (key.engine != null && engine !== key.engine) continue;
    const err = (i.error ?? null) as { category?: unknown; message?: unknown } | null;
    const stageRows = await db.query<{ stage: string }>(LAST_STAGE_SQL, [i.id]).catch(() => []);
    const c: Candidate = {
      case_key: i.case_key,
      last_stage: stageRows[0]?.stage ?? null,
      category: err?.category == null ? null : String(err.category),
      head: messageHead(err?.message),
    };
    if (sameGroup(c, key)) candidates.push(c);
  }
  if (!candidates.length) {
    throw new LabError('NOT_FOUND',
      `run ${source.id} holds no failed item in that group (engine ${key.engine ?? 'any'}, stage `
      + `${key.stage ?? 'none'}, category ${key.category ?? 'none'}). A group key and a run id have `
      + 'to come from the same failure_cluster report.');
  }

  // ── the arm and the dataset the source run used ──────────────────────────────────
  const armHash = sourceItems[0].arm_hash;
  const armRows = await db.query<{ id: string; body: Record<string, unknown> }>(
    `SELECT id, body FROM lab_v2.objects WHERE kind = 'arm' AND hash = $1 LIMIT 1`, [armHash],
  );
  if (!armRows.length) {
    throw new LabError('NOT_FOUND',
      `the arm this run was executed with (hash ${String(armHash).slice(0, 12)}…) is no longer in the `
      + 'store, so its failure cannot be reproduced at the same model. Decision 142 minimises with '
      + "the FAILED RUN'S arm and will not substitute another.");
  }
  const arm = armBodySchema.parse(armRows[0].body);

  const experimentObj = source.experiment_id ? await getObject(db, source.experiment_id) : null;
  if (!experimentObj || experimentObj.kind !== 'experiment') {
    throw new LabError('INVALID_INPUT',
      `run ${source.id} was not an experiment run, so it has no dataset to take cases from`);
  }
  const sourceExperiment = experimentBodySchema.parse(experimentObj.body);
  const datasetObj = await getObject(db, sourceExperiment.dataset_id);
  if (!datasetObj) throw new LabError('NOT_FOUND', `experiment ${experimentObj.id} references a dataset that is gone`);
  const sourceDataset = datasetBodySchema.parse(datasetObj.body);
  const caseByKey = new Map(sourceDataset.cases.map((c) => [c.case_key, c]));

  // Decision 131's cap, applied to the group's own cases in the order the run holds them.
  const started = candidates.map((c) => c.case_key).filter((k) => caseByKey.has(k)).slice(0, MAX_MINIMIZE_CASES);
  if (!started.length) {
    throw new LabError('INVALID_INPUT',
      "the group's failed cases are not in this run's dataset any more, so there is nothing to re-run");
  }

  /**
   * The worst-case cost of one step, from the arm's OWN declared ceilings. Every stage is priced
   * (`experiment_create` refuses an arm that leaves one unbounded), so this is an upper bound the
   * gateway itself enforces per call, not an estimate of what a model usually charges.
   */
  const perCase = Object.values(arm.stages).reduce((sum, st) => sum + Number(st.max_cost_microusd ?? 0), 0);
  const budget = await ensureBudget(db, principal, sourceExperiment.budget_name, args.budget_cap_microusd);
  const before = await getBudget(db, budget.id);
  const spentAtStart = Number(before?.spent_microusd ?? 0) + Number(before?.unknown_microusd ?? 0);

  const steps: {
    step: number; case_keys: string[]; run_id: string | null; reproduced: boolean;
    matching_items: number; estimated_microusd: number; spent_microusd: number; note: string | null;
  }[] = [];
  const reproducingRunIds: string[] = [];
  let stopped: 'minimal' | 'not_reproduced' | 'budget_cap' | 'step_cap' = 'minimal';
  let stepNo = 0;

  /** One step: a dataset of exactly these cases, an experiment on the source arm, a run, driven here. */
  const runStep = async (caseKeys: string[]): Promise<{ reproduced: boolean; runId: string | null; matching: number; estimate: number; spent: number; note: string | null }> => {
    stepNo += 1;
    const estimate = perCase * caseKeys.length;
    const now = await getBudget(db, budget.id);
    const spentNow = Number(now?.spent_microusd ?? 0) + Number(now?.unknown_microusd ?? 0) + Number(now?.reserved_microusd ?? 0);
    if (spentNow + estimate > args.budget_cap_microusd) {
      return {
        reproduced: false, runId: null, matching: 0, estimate, spent: 0,
        note: `refused before the step: ${spentNow} microusd already committed plus this step's worst `
          + `case ${estimate} would exceed the cap of ${args.budget_cap_microusd}`,
      };
    }

    const body = datasetBodySchema.parse({
      ...sourceDataset,
      cases: caseKeys.map((k) => caseByKey.get(k)!),
      source_versions: {
        ...sourceDataset.source_versions,
        minimized_from_dataset: datasetObj.id,
        minimized_from_run: source.id,
        step: stepNo,
      },
    });
    const { object: dataset } = await putObject(db, principal, 'dataset', body, 'deidentified',
      `${args.idempotency_key}:dataset:${stepNo}`);

    const experimentBody = experimentBodySchema.parse({
      hypothesis: `failure_minimize step ${stepNo} over ${caseKeys.length} case(s) from run ${source.id}`,
      dataset_id: dataset.id,
      dataset_hash: dataset.hash,
      baseline_arm_id: armRows[0].id,
      arm_ids: [armRows[0].id],
      repeats: 1,
      endpoints: [],
      budget_name: sourceExperiment.budget_name,
      purpose: 'failure_minimize',
    });
    const { object: experiment } = await putObject(db, principal, 'experiment', experimentBody, 'deidentified',
      `${args.idempotency_key}:experiment:${stepNo}`);

    const items = caseKeys.map((k) => ({
      case_key: k,
      arm_hash: String(armHash),
      repetition: 1,
      payload: { engine: sourceDataset.engine, frozen: caseByKey.get(k)!.frozen, arm: armRows[0].body, budget_id: budget.id, arm_id: armRows[0].id },
    }));
    const { run } = await submitRun(
      db, principal, 'failure_minimize', experiment.id, budget.id,
      `${args.idempotency_key}:run:${stepNo}`, hash({ step: stepNo, cases: caseKeys }),
      RUN_DEADLINE_MS, items,
    );

    // Driven here rather than by the cron: a bisection is only useful if the next step can be
    // decided from this one, and the tick that would do it is up to a minute away.
    for (let pass = 0; pass < 40; pass += 1) {
      const report = await tick({ db, transport, maxItems: MAX_MINIMIZE_CASES, adapters: deps.adapters });
      if (report.claimed === 0) break;
    }

    const after = await itemsOf(db, run.id, 1000, 0);
    let matching = 0;
    for (const i of after) {
      const failed = i.execution_status === 'failed' || i.assessment_status === 'unassessable' || i.attribution_status === 'invalid';
      if (!failed) continue;
      const err = (i.error ?? null) as { category?: unknown; message?: unknown } | null;
      const stageRows = await db.query<{ stage: string }>(LAST_STAGE_SQL, [i.id]).catch(() => []);
      if (sameGroup({
        case_key: i.case_key,
        last_stage: stageRows[0]?.stage ?? null,
        category: err?.category == null ? null : String(err.category),
        head: messageHead(err?.message),
      }, key)) matching += 1;
    }
    const budgetAfter = await getBudget(db, budget.id);
    const spent = Number(budgetAfter?.spent_microusd ?? 0) + Number(budgetAfter?.unknown_microusd ?? 0) - spentAtStart;
    return { reproduced: matching > 0, runId: run.id, matching, estimate, spent, note: null };
  };

  // ── the bisection ────────────────────────────────────────────────────────────────
  let current = started;
  const record = async (caseKeys: string[]) => {
    const r = await runStep(caseKeys);
    steps.push({
      step: stepNo, case_keys: [...caseKeys], run_id: r.runId, reproduced: r.reproduced,
      matching_items: r.matching, estimated_microusd: r.estimate, spent_microusd: r.spent, note: r.note,
    });
    if (r.reproduced && r.runId) reproducingRunIds.push(r.runId);
    return r;
  };

  const first = await record(current);
  if (first.note) {
    stopped = 'budget_cap';
  } else if (!first.reproduced) {
    stopped = 'not_reproduced';
    current = [];
  } else {
    while (current.length > 1) {
      if (steps.length >= MAX_MINIMIZE_STEPS) { stopped = 'step_cap'; break; }
      const mid = Math.ceil(current.length / 2);
      const left = current.slice(0, mid);
      const right = current.slice(mid);

      const l = await record(left);
      if (l.note) { stopped = 'budget_cap'; break; }
      if (l.reproduced) { current = left; continue; }

      if (steps.length >= MAX_MINIMIZE_STEPS) { stopped = 'step_cap'; break; }
      const r = await record(right);
      if (r.note) { stopped = 'budget_cap'; break; }
      if (r.reproduced) { current = right; continue; }

      // Neither half alone does it: the current set is minimal for this search. See the caveat.
      break;
    }
  }

  const budgetEnd = await getBudget(db, budget.id);
  const spend = Number(budgetEnd?.spent_microusd ?? 0) + Number(budgetEnd?.unknown_microusd ?? 0) - spentAtStart;

  return {
    source_run_id: source.id,
    group_key: key,
    candidates: candidates.length,
    started_with: started,
    minimal_case_keys: stopped === 'not_reproduced' ? [] : current,
    reproducing_run_ids: reproducingRunIds,
    steps,
    spend_microusd: spend,
    budget_cap_microusd: args.budget_cap_microusd,
    stopped,
    caveat: MINIMIZE_CAVEAT,
  };
}
