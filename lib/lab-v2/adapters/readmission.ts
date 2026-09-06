/**
 * lib/lab-v2/adapters/readmission.ts — the readmission adapter
 * (LAB-MCP-V2-PRD-v1.0 §17.8 round D1, decision 104).
 *
 * ⚠️ THE SEAM WAS ALREADY THERE, WHICH IS WHY THIS FILE IS SHORT. R4.1 factored the recon legs
 * into `runReconSequence` (`lib/readmission/run.ts:442`) and made the transport an argument —
 * `PassFn` at `:430` — precisely so a second caller could answer the legs differently. Production
 * passes `vertexPass`; this passes the gateway. Nothing in `lib/readmission/**` changes, and
 * nothing in it may: `readmission-r41-refresh.test.ts:201` pins a sha256 of the `vertexPass`
 * source slice, so the region between `async function vertexPass(` and `// ── Phase 1.5` is
 * untouchable. It is untouched.
 *
 * ⚠️ AND IT RUNS THE PRODUCTION SEQUENCE, NOT A COPY. The lane logic — out-of-network takes one
 * pass, lane `other` takes the condition pass and is promoted on `same`, everything else takes
 * recon A then recon B — is `runReconSequence`'s, imported and called. That is what makes the
 * golden A/B mean something: if a replay's verdict differs from the stored one, something in the
 * engine moved, not something in this file.
 *
 * ⚠️ NO WRITER IS INJECTED, BECAUSE THERE IS NOTHING TO WRITE. `runReadmissionAudit`
 * (`run.ts:506`) is the production wrapper that calls `saveAuditResult`, `startTrace`,
 * `servedReadmitCall` and the narrative leg; this adapter deliberately does NOT call it. The IPD
 * adapter injects a writer that is a no-op; here the shorter path is available, so the store is
 * not reached at all rather than reached and neutered. Decision 104 puts the narrative leg
 * (`run.ts:545`) out of scope for D1 for the same reason: it writes.
 */
import { LabError } from '../contracts';
import { runReconSequence } from '../../readmission/run';
import { READMIT_ENGINE_VERSION, type PendingRow } from '../../readmission/store';
import { parsePassClaims } from '../../readmission-prompts';
import type { Adapter, AdapterContext, AdapterOutcome } from './types';
import type { ThreeSourceInputs } from '../../readmission/assemble';

/** §17.8 item 4 — the four labels `runReconSequence` passes, in the order it can pass them. */
export const READMISSION_STAGES = ['readmit_oon', 'readmit_condition', 'readmit_recon_a', 'readmit_recon_b'] as const;

/**
 * ⚠️ THE FINDING'S VOCABULARY, `AvoidableVerdict` at `lib/readmission-reconcile-core.ts:538`.
 *
 * ⚠️ AND IT IS NOT THE PASS-CLAIM VOCABULARY, WHICH IS THE MISTAKE THIS ROUND MADE FIRST.
 * `readmission-prompts.ts:232` parses a MODEL PASS as one of `avoidable | justified | uncertain`;
 * `reconcile-core.ts:531` types that same claim. But the FINDING that comes out of
 * `reconcileFinding` is `avoidable | justified | needs_adjudication` — `uncertain` never survives
 * reconciliation, and `needs_adjudication` is what the two-pass money verdict produces when the
 * passes disagree, cite disjoint evidence, or rest on treating-team prose alone (`:743`-`:757`).
 * The first draft of this constant used the pass list, and the adapter test caught it on a real
 * run of the sequence: a legitimate `needs_adjudication` would have been reported `unassessable`.
 *
 * ⚠️ `needs_adjudication` IS COUNTED AS `assessed`, ON §17.8 ITEM 6's LITERAL WORDS — "assessed
 * when the verdict is one of the engine's vocabulary". It is a defensible reading either way and
 * it is FLAGGED in the round report: the engine has answered, and its answer is "two passes
 * disagreed, a human decides". Reading it as `unassessable` instead is a one-line change here.
 */
export const AVOIDABLE_VERDICTS = ['avoidable', 'justified', 'needs_adjudication'] as const;

/** The transport ceiling for one recon leg. Four legs at most, inside the tick's own bound. */
export const READMISSION_PER_ATTEMPT_MS = 120_000;

interface FrozenReadmission {
  engine?: string;
  row?: Record<string, unknown>;
  inputs?: ThreeSourceInputs;
  index_discharge_at?: string | null;
}

export function makeReadmissionAdapter(): Adapter {
  return {
    engine: 'readmission',
    stages: READMISSION_STAGES,
    engineVersion: () => READMIT_ENGINE_VERSION,
    frozenInputs: ['row', 'inputs', 'index_discharge_at'],
    perAttemptTimeoutMs: READMISSION_PER_ATTEMPT_MS,

    async run(ctx: AdapterContext): Promise<AdapterOutcome> {
      const frozen = (ctx.frozen ?? {}) as FrozenReadmission;
      if (!frozen.row || !frozen.inputs) {
        return {
          result: { error: 'frozen inputs did not match the readmission shape', keys: Object.keys(frozen) },
          summary: { engine: 'readmission', error: 'bad_frozen_inputs' },
          execution_status: 'failed', assessment_status: 'not_reached',
        };
      }

      /**
       * The gateway as `PassFn`. Three things happen here and nowhere else:
       *   · the stage NAME is the leg label, so the arm prices what actually fired;
       *   · the reply is parsed with the engine's OWN `parsePassClaims`, so an unparseable leg
       *     is null here for the same reason it is null in production;
       *   · `null` is returned rather than thrown, because `runReconSequence` treats null as
       *     "unparseable or unavailable" and throws its own error with the leg named.
       */
      let legs = 0;
      const pass = async (label: string, prompt: { system: string; user: string }) => {
        legs += 1;
        const staged = await ctx.gateway.call(label, {
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          temperature: 0.1,
          max_tokens: 3000,
        });
        const completion = staged.completion as { choices?: { message?: { content?: string } }[] } | null;
        const content = completion?.choices?.[0]?.message?.content ?? staged.text ?? '';
        ctx.event('readmit_leg', { label, chars: String(content).length });
        return parsePassClaims(String(content));
      };

      try {
        const seq = await runReconSequence({
          row: frozen.row as unknown as PendingRow,
          inputs: frozen.inputs,
          indexDischargeAt: frozen.index_discharge_at ?? null,
          pass,
        });
        const verdict = seq.finding?.avoidable?.verdict ?? null;
        // §17.8 item 6 — the assessable key, and the only place the two statuses can differ.
        const assessed = verdict != null && (AVOIDABLE_VERDICTS as readonly string[]).includes(String(verdict));
        return {
          result: seq.finding,
          summary: {
            engine: 'readmission',
            engine_version: READMIT_ENGINE_VERSION,
            // ⚠️ THE VERDICT, AND NOT THE dedup_key. A summary is returned inline by `run_result`
            // and copied into every report; decision 99 keeps the identifier out of all of them.
            avoidable_verdict: verdict == null ? null : String(verdict),
            promoted: seq.promoted,
            finding_class: frozen.row.finding_class ?? null,
            lane: frozen.row.lane ?? null,
            legs,
          },
          execution_status: 'succeeded',
          assessment_status: assessed ? 'assessed' : 'unassessable',
        };
      } catch (e) {
        // ⚠️ A THROWN LEG IS AN EXECUTION FAILURE, NOT AN UNASSESSABLE CASE. `runReconSequence`
        // throws when a leg is unparseable or the model was unavailable; production leaves the row
        // `detected` and lets the sweep retry. Here that is `failed` / `not_reached`, and the two
        // must not be confused: `unassessable` means the engine answered "I cannot say", and
        // nothing answered at all.
        if (e instanceof LabError) throw e;
        return {
          result: { error: String((e as Error).message).slice(0, 500) },
          summary: { engine: 'readmission', engine_version: READMIT_ENGINE_VERSION, legs, error: 'recon_failed' },
          execution_status: 'failed', assessment_status: 'not_reached',
        };
      }
    },
  };
}
