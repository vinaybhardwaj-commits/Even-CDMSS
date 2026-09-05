/**
 * lib/lab-v2/tools/compare.ts — `run_diff` and `experiment_compare` (§17.4 items 4 and 5, §9).
 *
 * ⚠️ THE DENOMINATORS ARE THE PRODUCT. §9 is explicit that a report counts every item under all
 * three statuses and names the subset its metrics were computed on. So every output here carries
 * the full bucket list — attempted, succeeded, failed, cancelled, expired, unassessable,
 * attribution-invalid — and states `metric_denominator: 'assessable_verified'` beside a number
 * that is smaller than all of them. A comparison that reported only its own denominator would be
 * the most flattering possible summary of a run that half failed.
 *
 * ⚠️ AND THE INTERVALS CLUSTER ON MEMBER. Two audits of the same member are not independent; the
 * bootstrap in analysis-core.ts resamples members, not rows. A dataset without member keys (Slice
 * A single-case, or a cohort frozen before decision 44) degrades to one cluster per case, and the
 * output says how many clusters there were so a reader can see which they got.
 */
import { z } from 'zod';
import {
  bootstrapMetric, countDenominators, diffSubjects, jaccard, pairCase,
  BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED, type CaseMetrics, type PairedCase,
} from '../analysis-core';
import { LabError, datasetBodySchema, experimentBodySchema } from '../contracts';
import { getObject, getRun, itemsOf, putObject } from '../store';
import type { Db } from '../db';
import type { Item } from '../store';

const bootstrapOut = z.object({
  mean: z.number().nullable(), lo: z.number().nullable(), hi: z.number().nullable(),
  n: z.number().int(), clusters: z.number().int(), resamples: z.number().int(), seed: z.number().int(),
});

const denominatorsOut = z.object({
  attempted: z.number().int(), succeeded: z.number().int(), failed: z.number().int(),
  cancelled: z.number().int(), expired: z.number().int(), unassessable: z.number().int(),
  attribution_invalid: z.number().int(), assessable_verified: z.number().int(), sums: z.boolean(),
});

export const COMPARE_SCHEMAS = {
  run_diff: {
    input: z.object({ run_a: z.string().uuid(), run_b: z.string().uuid() }),
    output: z.object({
      run_a: z.string().uuid(),
      run_b: z.string().uuid(),
      paired: z.number().int(),
      only_in_a: z.array(z.string()),
      only_in_b: z.array(z.string()),
      cases: z.array(z.object({
        case_key: z.string(),
        status_a: z.object({ execution: z.string().nullable(), assessment: z.string().nullable(), attribution: z.string().nullable() }),
        status_b: z.object({ execution: z.string().nullable(), assessment: z.string().nullable(), attribution: z.string().nullable() }),
        subjects_added: z.array(z.string()),
        subjects_removed: z.array(z.string()),
        note_quality_index_before: z.number().nullable(),
        note_quality_index_after: z.number().nullable(),
        band_before: z.string().nullable(),
        band_after: z.string().nullable(),
        result_hash_a: z.string().nullable(),
        result_hash_b: z.string().nullable(),
        result_hash_equal: z.boolean(),
      })),
    }),
  },
  experiment_compare: {
    input: z.object({ experiment_id: z.string().uuid() }),
    output: z.object({
      experiment_id: z.string().uuid(),
      baseline_arm_id: z.string().uuid(),
      metric_denominator: z.literal('assessable_verified'),
      replay_exactness: z.string().nullable(),
      caveat: z.string(),
      artifact_id: z.string().uuid(),
      arms: z.array(z.object({
        arm_id: z.string().uuid(),
        is_baseline: z.boolean(),
        denominators: denominatorsOut,
        paired: z.number().int(),
        metrics: z.object({
          delta_n_findings: bootstrapOut,
          delta_n_low_value: bootstrapOut,
          delta_note_quality_index: bootstrapOut,
          subject_jaccard: bootstrapOut,
        }).nullable(),
        band_changed: z.number().int(),
      })),
    }),
  },
} as const;

/** §17.4 item 5 — one run is one sample; the same sentence report_export carries. */
export const COMPARE_CAVEAT =
  'One run is one sample. Judged findings at temperature 0 recur at about 0.58 across same-config pairs.';

interface Summary {
  findings?: number; n_low_value?: number; note_quality_index?: number | null;
  band?: string | null; finding_subjects?: (string | null)[];
}

const summaryOf = (i: Item): Summary =>
  (((i.result ?? {}) as { summary?: Summary }).summary ?? {});

const resultHashOf = (i: Item): string | null =>
  ((i.result ?? {}) as { result_hash?: string }).result_hash ?? null;

function metricsOf(i: Item, memberKey: string | null): CaseMetrics {
  const s = summaryOf(i);
  return {
    case_key: i.case_key,
    member_key: memberKey,
    n_findings: typeof s.findings === 'number' ? s.findings : null,
    n_low_value: typeof s.n_low_value === 'number' ? s.n_low_value : null,
    note_quality_index: typeof s.note_quality_index === 'number' ? s.note_quality_index : null,
    band: s.band ?? null,
    subjects: (s.finding_subjects ?? []).filter((v): v is string => typeof v === 'string'),
    result_hash: resultHashOf(i),
  };
}

/** case_key → member_key, from the experiment's dataset. Absent ⇒ every case its own cluster. */
async function memberKeys(db: Db, datasetId: string | null): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!datasetId) return out;
  const ds = await getObject(db, datasetId);
  if (!ds) return out;
  const parsed = datasetBodySchema.safeParse(ds.body);
  if (!parsed.success) return out;
  for (const c of parsed.data.cases) out.set(c.case_key, c.member_key ?? null);
  return out;
}

export interface CompareDeps { db: Db; principal: string }

// ── run_diff ─────────────────────────────────────────────────────────────────────────
export async function runDiff(deps: CompareDeps, args: { run_a: string; run_b: string }) {
  const { db } = deps;
  const [a, b] = await Promise.all([getRun(db, args.run_a), getRun(db, args.run_b)]);
  if (!a) throw new LabError('NOT_FOUND', `no run ${args.run_a}`);
  if (!b) throw new LabError('NOT_FOUND', `no run ${args.run_b}`);
  const [ia, ib] = await Promise.all([itemsOf(db, a.id, 1000, 0), itemsOf(db, b.id, 1000, 0)]);
  const mapA = new Map(ia.map((i) => [i.case_key, i]));
  const mapB = new Map(ib.map((i) => [i.case_key, i]));

  const cases = [...mapA.keys()].filter((k) => mapB.has(k)).sort().map((key) => {
    const x = mapA.get(key)!;
    const y = mapB.get(key)!;
    const sx = summaryOf(x);
    const sy = summaryOf(y);
    const d = diffSubjects(
      (sx.finding_subjects ?? []).filter((v): v is string => typeof v === 'string'),
      (sy.finding_subjects ?? []).filter((v): v is string => typeof v === 'string'),
    );
    const ha = resultHashOf(x);
    const hb = resultHashOf(y);
    return {
      case_key: key,
      status_a: { execution: x.execution_status, assessment: x.assessment_status, attribution: x.attribution_status },
      status_b: { execution: y.execution_status, assessment: y.assessment_status, attribution: y.attribution_status },
      subjects_added: d.added,
      subjects_removed: d.removed,
      note_quality_index_before: typeof sx.note_quality_index === 'number' ? sx.note_quality_index : null,
      note_quality_index_after: typeof sy.note_quality_index === 'number' ? sy.note_quality_index : null,
      band_before: sx.band ?? null,
      band_after: sy.band ?? null,
      result_hash_a: ha,
      result_hash_b: hb,
      result_hash_equal: ha != null && ha === hb,
    };
  });

  return {
    run_a: a.id,
    run_b: b.id,
    paired: cases.length,
    only_in_a: [...mapA.keys()].filter((k) => !mapB.has(k)).sort(),
    only_in_b: [...mapB.keys()].filter((k) => !mapA.has(k)).sort(),
    cases,
  };
}

// ── experiment_compare ───────────────────────────────────────────────────────────────
export async function experimentCompare(deps: CompareDeps, args: { experiment_id: string }) {
  const { db, principal } = deps;
  const experiment = await getObject(db, args.experiment_id);
  if (!experiment || experiment.kind !== 'experiment') throw new LabError('NOT_FOUND', `no experiment ${args.experiment_id}`);
  const body = experimentBodySchema.parse(experiment.body);

  const runs = await db.query<{ id: string }>(
    `SELECT id FROM lab_v2.runs WHERE experiment_id = $1 AND operation = 'experiment_run' ORDER BY created_at`,
    [experiment.id]);
  if (!runs.length) throw new LabError('NOT_FOUND', `experiment ${experiment.id} has no runs yet`);

  const items: Item[] = [];
  for (const r of runs) items.push(...await itemsOf(db, r.id, 1000, 0));

  const members = await memberKeys(db, body.dataset_id);
  const dataset = await getObject(db, body.dataset_id);
  const replayExactness = (() => {
    const p = dataset ? datasetBodySchema.safeParse(dataset.body) : null;
    return p?.success ? p.data.replay_exactness : null;
  })();

  // Items are grouped by ARM, and an arm is identified by the hash of the arm object it ran.
  const armHashById = new Map<string, string>();
  for (const armId of body.arm_ids) {
    const o = await getObject(db, armId);
    if (o) armHashById.set(armId, o.hash);
  }
  const byArmHash = new Map<string, Item[]>();
  for (const i of items) {
    const arr = byArmHash.get(i.arm_hash);
    if (arr) arr.push(i); else byArmHash.set(i.arm_hash, [i]);
  }

  const baselineHash = armHashById.get(body.baseline_arm_id);
  const baselineItems = baselineHash ? (byArmHash.get(baselineHash) ?? []) : [];
  const baselineByCase = new Map(baselineItems.map((i) => [i.case_key, i]));

  const arms = body.arm_ids.map((armId) => {
    const armHash = armHashById.get(armId);
    const armItems = armHash ? (byArmHash.get(armHash) ?? []) : [];
    const isBaseline = armId === body.baseline_arm_id;
    const denominators = countDenominators(armItems.map((i) => ({
      execution_status: i.execution_status, assessment_status: i.assessment_status, attribution_status: i.attribution_status,
    })));

    // Pairs are formed ONLY over cases assessable-and-verified on BOTH sides. A case that failed
    // on one arm cannot contribute a difference, and silently pairing it against nothing would
    // move the mean without appearing in any denominator.
    const usable = (i: Item) =>
      i.execution_status === 'succeeded' && i.assessment_status === 'assessed' && i.attribution_status === 'verified';
    const pairs: PairedCase[] = [];
    if (!isBaseline) {
      for (const i of armItems) {
        const base = baselineByCase.get(i.case_key);
        if (!base || !usable(i) || !usable(base)) continue;
        const mk = members.get(i.case_key) ?? null;
        pairs.push(pairCase(metricsOf(base, mk), metricsOf(i, mk)));
      }
    }

    return {
      arm_id: armId,
      is_baseline: isBaseline,
      denominators,
      paired: pairs.length,
      metrics: isBaseline || !pairs.length ? null : {
        delta_n_findings: bootstrapMetric(pairs, (p) => p.delta_n_findings),
        delta_n_low_value: bootstrapMetric(pairs, (p) => p.delta_n_low_value),
        delta_note_quality_index: bootstrapMetric(pairs, (p) => p.delta_note_quality_index),
        subject_jaccard: bootstrapMetric(pairs, (p) => p.subject_jaccard),
      },
      band_changed: pairs.filter((p) => p.band_changed).length,
    };
  });

  const report = {
    kind: 'experiment_compare',
    experiment_id: experiment.id,
    baseline_arm_id: body.baseline_arm_id,
    hypothesis: body.hypothesis,
    dataset_id: body.dataset_id,
    replay_exactness: replayExactness,
    metric_denominator: 'assessable_verified',
    bootstrap: { resamples: BOOTSTRAP_RESAMPLES, seed: BOOTSTRAP_SEED, cluster: 'member_key' },
    arms,
    caveat: COMPARE_CAVEAT,
  };
  const { object } = await putObject(db, principal, 'report', report, 'deidentified', `compare:${experiment.id}`);

  return {
    experiment_id: experiment.id,
    baseline_arm_id: body.baseline_arm_id,
    metric_denominator: 'assessable_verified' as const,
    replay_exactness: replayExactness,
    caveat: COMPARE_CAVEAT,
    artifact_id: object.id,
    arms,
  };
}

export { jaccard };
