/**
 * lib/lab-v2/tools/paired-audit.ts — paired signed/override OPD audit.
 *
 * `paired_audit_submit` queues the batch and returns a run id. The lab-v2 cron drains it.
 * `paired_audit_status` and `paired_audit_results` read that run. Results carry findings,
 * not the override text: the text stays on `lab_v2.paired_audit_items` and is never selected
 * here.
 *
 * Submit is identifying on every call (uids plus prescription text). Status and results are
 * research reads so a reviewer can retrieve a run and cannot launch one.
 */
import { z } from 'zod';
import type { Db } from '../db';
import {
  PAIRED_DEFAULT_MODEL, PAIRED_MAX_LLM_CALLS, PAIRED_MAX_PAIRS, PAIRED_MAX_SIGNED_REPEATS, PAIRED_UID_RE,
} from '../paired-audit-core';
import { pairedAuditResults, pairedAuditStatus, submitPairedAudit } from '../paired-audit';

const ARM_RE = /^[a-z][a-z0-9_-]{0,31}$/;

const findingSchema = z.object({
  subject: z.string().nullable(),
  rationale: z.string().nullable(),
  verdict: z.string().nullable(),
  confidence: z.number().nullable(),
  domain: z.string().nullable(),
  informational: z.boolean(),
  signal_type: z.string().nullable(),
  rule_ref: z.string().nullable(),
  lvc_category: z.string().nullable(),
  direction: z.string().nullable(),
  severity: z.string().nullable(),
});

const flagSchema = z.object({
  key: z.string(),
  subject: z.string().nullable(),
  verdict: z.string().nullable(),
  signal_type: z.string().nullable(),
  domain: z.string().nullable(),
  severity: z.string().nullable(),
});

const pairSchema = z.object({
  uid: z.string().regex(PAIRED_UID_RE),
  override_text: z.string().min(1).max(100_000),
  external_ref: z.string().min(1).max(200),
});

export const PAIRED_AUDIT_SCHEMAS = {
  paired_audit_submit: {
    input: z.object({
      experiment_label: z.string().min(1).max(120),
      idempotency_key: z.string().min(1).max(200),
      pairs: z.array(pairSchema).min(1).max(PAIRED_MAX_PAIRS),
      arms: z.tuple([z.string().min(1).max(32), z.string().min(1).max(32)]),
      signed_repeats: z.number().int().min(1).max(PAIRED_MAX_SIGNED_REPEATS).default(1),
      noise_uids: z.array(z.string().regex(PAIRED_UID_RE)).max(PAIRED_MAX_PAIRS).default([]),
      max_llm_calls: z.number().int().min(1).max(PAIRED_MAX_LLM_CALLS),
      max_spend_microusd: z.number().int().positive().nullable().optional(),
      model: z.string().min(3).max(200).default(PAIRED_DEFAULT_MODEL),
    }).superRefine((data, ctx) => {
      const signed = data.arms.filter((arm) => arm === 'signed').length;
      if (signed !== 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['arms'], message: 'arms must include signed exactly once' });
      }
      const other = data.arms.find((arm) => arm !== 'signed');
      if (!other || !ARM_RE.test(other)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom, path: ['arms'],
          message: 'the non-signed arm must match ^[a-z][a-z0-9_-]{0,31}$',
        });
      }
      const uids = data.pairs.map((p) => p.uid);
      if (new Set(uids).size !== uids.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pairs'], message: 'duplicate uid in one batch' });
      }
      const known = new Set(uids);
      if (data.signed_repeats > 1 && data.noise_uids.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom, path: ['noise_uids'],
          message: 'signed_repeats above 1 requires the subset of uids to repeat',
        });
      }
      for (const uid of data.noise_uids) {
        if (!known.has(uid)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['noise_uids'], message: `noise uid ${uid} is not in pairs` });
        }
      }
    }),
    output: z.object({
      run_id: z.string().uuid(),
      deduplicated: z.boolean(),
      experiment_label: z.string(),
      engine_version: z.string(),
      prompt_hash: z.string(),
      model: z.string(),
      status: z.string(),
      counts: z.object({
        pairs: z.number().int(),
        items: z.number().int(),
        queued: z.number().int(),
      }),
    }),
  },
  paired_audit_status: {
    input: z.object({ run_id: z.string().uuid() }),
    output: z.object({
      run_id: z.string().uuid(),
      status: z.string(),
      stop_reason: z.string().nullable(),
      experiment_label: z.string(),
      engine_version: z.string(),
      prompt_hash: z.string(),
      model: z.string(),
      calls_used: z.number(),
      spend_microusd: z.number(),
      max_llm_calls: z.number(),
      max_spend_microusd: z.number().nullable(),
      counts: z.object({
        queued: z.number().int(),
        running: z.number().int(),
        succeeded: z.number().int(),
        deduped: z.number().int(),
        skipped: z.number().int(),
        failed: z.number().int(),
        stopped: z.number().int(),
      }),
    }),
  },
  paired_audit_results: {
    input: z.object({
      run_id: z.string().uuid(),
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
    }),
    output: z.object({
      run_id: z.string().uuid(),
      items: z.array(z.object({
        uid: z.string(),
        external_ref: z.string(),
        arm: z.string(),
        repeat_idx: z.number().int(),
        status: z.string(),
        skip_reason: z.string().nullable(),
        clinician_uid: z.string().nullable(),
        engine_version: z.string(),
        prompt_hash: z.string(),
        band: z.string().nullable(),
        note_quality_index: z.number().nullable(),
        llm_leg_failed: z.boolean().nullable(),
        findings: z.array(findingSchema),
      })),
      diffs: z.array(z.object({
        uid: z.string(),
        external_ref: z.string(),
        only_a: z.array(flagSchema),
        only_b: z.array(flagSchema),
        both: z.array(flagSchema),
      })),
      signed_repeats: z.array(z.object({
        uid: z.string(),
        repeats: z.number().int(),
        identical_flag_sets: z.boolean(),
      })),
      limit: z.number().int(),
      offset: z.number().int(),
      total: z.number().int(),
    }),
  },
} as const;

type SubmitArgs = {
  experiment_label: string;
  idempotency_key: string;
  pairs: { uid: string; override_text: string; external_ref: string }[];
  arms: [string, string];
  signed_repeats: number;
  noise_uids: string[];
  max_llm_calls: number;
  max_spend_microusd?: number | null;
  model: string;
};

export async function pairedAuditSubmitTool(deps: { db: Db; principal: string }, args: SubmitArgs) {
  return submitPairedAudit(deps.db, deps.principal, {
    experiment_label: args.experiment_label,
    idempotency_key: args.idempotency_key,
    pairs: args.pairs,
    arms: args.arms,
    signed_repeats: args.signed_repeats,
    noise_uids: args.noise_uids,
    max_llm_calls: args.max_llm_calls,
    max_spend_microusd: args.max_spend_microusd ?? null,
    model: args.model,
  });
}

export async function pairedAuditStatusTool(deps: { db: Db }, args: { run_id: string }) {
  return pairedAuditStatus(deps.db, args.run_id);
}

export async function pairedAuditResultsTool(
  deps: { db: Db },
  args: { run_id: string; limit: number; offset: number },
) {
  return pairedAuditResults(deps.db, args.run_id, args.limit, args.offset);
}
