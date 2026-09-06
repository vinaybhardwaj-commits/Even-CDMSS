/**
 * lib/lab-v2/adapters/ipd-episode.ts — the ipd_episode adapter (LAB-MCP-V2-PRD-v1.0 §17.5).
 *
 * This is the engine decision 47 existed for. The other six adapters run production code that was
 * already callable — a function, or a route handler. The IPD pipeline was not: its first stage was
 * a db13 read through a module import, and `lib/metabase.ts:115` throws inside the isolation fence,
 * so the episode died at stage one with no row to compare against anything. `computeEpisodeAudit`
 * takes its eight reads and writes as an argument, and this file is what supplies them from a
 * frozen case.
 *
 * ⚠️ IT RUNS THE PRODUCTION PIPELINE, NOT A COPY OF IT. `computeEpisodeAudit` here is the same
 * function `lib/ipd-episode/run.ts` calls in the nightly sweep, byte-identical in body to the
 * pre-extraction engine. That is the entire claim of decision 48's golden A/B: if the replay's
 * answer differs from the stored row's, the extraction changed something.
 *
 * TWO MODES, AND THE DIFFERENCE IS ONE FIELD.
 *
 *   FROZEN (`frozen.steps` is populated). Nothing reaches a provider, a corpus or a database. The
 *   checkpoints are served from the stored checkpoint rows; the two judge replies are served from
 *   `steps`, MATCHED ON THE REQUEST HASH the gateway computes (decision 45), so a prompt that
 *   changed raises REPLAY_DIVERGED instead of quietly answering a different question. Zero model
 *   calls, structurally: the gateway is never called, so the transport is never reached.
 *
 *   FRESH (no steps). The checkpoints run for real through `runCheckpoint`, the judge passes run
 *   for real, and every one of them is priced and attributed by the gateway like any other engine's
 *   stage. This is the mode a Slice B experiment uses to ask what a different model would have
 *   said about the same frozen course.
 *
 * ⚠️ THE RESULT IS THE DETERMINISTIC PROJECTION, AND ONLY THAT. `result_hash` is the worker's hash
 * of `result`, and decision 48 compares it against a hash of the stored row's deterministic fields.
 * Putting anything run-shaped in `result` — a wall time, a trace id, the models this deployment
 * happens to name — would make that comparison fail for reasons that say nothing about the
 * extraction. The per-checkpoint detail `episode_checkpoint_inspect` needs is in `steps`, where a
 * replay can read it without it entering the hash.
 */
import { withLabExecution, exitLabExecution } from '../../lab-execution-context';
import { computeEpisodeAudit, type EpisodeComputeDependencies } from '../../ipd-episode/compute';
import { IPD_EPISODE_ENGINE_VERSION, saveEpisodeAudit, type EpisodeAuditRow, type CheckpointWriteRow } from '../../ipd-episode/store';
import { runCheckpoint } from '../../ipd-episode/checkpoint';
import { IPD_EPISODE_FIDELITY_SYSTEM } from '../../ipd-episode/prompts';
import { retrieve as productionRetrieve, type RetrieveOptions, type RetrieveResult } from '../../retrieve';
import { LabError, hash, ipdFrozenSchema, type IpdFrozenParsed } from '../contracts';
import { dependencyHash } from '../gateway';
import {
  assembledFrom, completionOf, deterministicFields, freezeIpdCase, ipdStageForLabel,
  judgeRepliesFrom, type FrozenIpd, type FrozenIpdCase, type IpdFreezeDeps,
} from '../sources/ipd';
import type { Adapter, AdapterContext, AdapterOutcome } from './types';

/** §17.5 — the three governed stages of the pipeline. Pass B left it under decision 35. */
export const IPD_EPISODE_STAGES = ['checkpoint', 'divergence', 'fidelity'] as const;

/**
 * The per-attempt ceiling. The judge passes declare `audit` class in lib/ipd-episode/model-call.ts
 * and IPNO-416's diff generated for 212,402 ms, so a lab stage on this engine gets the same 380 s
 * the audit class gives it in production. An arm's stage may override it with `options.timeout_ms`.
 */
export const IPD_PER_ATTEMPT_MS = 380_000;

/** The camelCase audit row the pipeline builds, in the snake_case shape the stored row has. */
export function rowAsStored(w: EpisodeAuditRow): Record<string, unknown> {
  const c = w.counters as unknown as Record<string, unknown>;
  return {
    findings: w.findings,
    scoring_status: w.scoringStatus,
    divergence_index: w.divergenceIndex,
    divergence_band: w.divergenceBand,
    band_uncertain: w.bandUncertain,
    penalty_total: w.penaltyTotal,
    expectations_evaluated: w.expectationsEvaluated,
    completeness_pct: w.completenessPct,
    capped_count: w.cappedCount,
    resolution_counts: w.resolutionCounts,
    checkpoint_count: w.checkpointCount,
    assembled_events: w.assembledEvents,
    prompt_events: w.promptEvents,
    evidence_tiers: w.evidenceTiers,
    ...c,
  };
}

export interface IpdAdapterDeps {
  retrieve?: (query: string, opts: RetrieveOptions) => Promise<RetrieveResult>;
  /**
   * §17.6 DECISION 67 — the production store writer, and the ONLY thing that separates a repair
   * from an ordinary lab run.
   *
   * Absent (every ordinary run, and every test that does not ask otherwise): `saveEpisodeAudit` is
   * an in-memory no-op and the episode's row exists only as this item's result. Present: the
   * engine's OWN writer runs and a new `ipd_episode_audits` row lands with `is_current` flipped,
   * exactly as the nightly worker writes it. Never an UPDATE — the writer demotes and inserts, and
   * this adapter does not know how to do anything else because it does not do the writing.
   */
  writeAudit?: (row: EpisodeAuditRow, checkpoints: CheckpointWriteRow[]) => Promise<{ status: 'inserted' | 'updated' | 'skipped'; auditId: string | null; failedCheckpoints: number }>;
}

export function makeIpdEpisodeAdapter(deps: IpdAdapterDeps = {}): Adapter {
  const retrieveImpl = deps.retrieve ?? productionRetrieve;
  const writeAudit = deps.writeAudit ?? null;
  return {
    engine: 'ipd_episode',
    stages: IPD_EPISODE_STAGES,
    engineVersion: () => IPD_EPISODE_ENGINE_VERSION,
    frozenInputs: ['real_course', 'checkpoints', 'extraction', 'admission_context', 'steps'],
    perAttemptTimeoutMs: IPD_PER_ATTEMPT_MS,

    async run(ctx: AdapterContext): Promise<AdapterOutcome> {
      const parsed = ipdFrozenSchema.safeParse(ctx.frozen);
      if (!parsed.success) {
        return {
          result: { error: 'frozen inputs did not match the ipd_episode shape', issues: parsed.error.issues.slice(0, 5) },
          summary: { engine: 'ipd_episode', error: 'bad_frozen_inputs' },
          execution_status: 'failed', assessment_status: 'not_reached',
        };
      }
      const frozen = parsed.data as unknown as FrozenIpd;
      const exact = Object.keys(frozen.steps ?? {}).length > 0;

      // ── the eight ────────────────────────────────────────────────────────────────────
      // Seven of them never touch anything: the reads answer from the frozen case and the two
      // writers are in-memory. `saveEpisodeAudit` CAPTURES rather than discards, because the row
      // it is handed is the answer this whole adapter exists to produce.
      let written: { row: EpisodeAuditRow; checkpoints: CheckpointWriteRow[] } | null = null;
      let repairWrite: { status: string; auditId: string | null; failedCheckpoints: number } | null = null;
      let divergedCheckpoint: LabError | null = null;
      const skips: { reason: string; detail: string | null }[] = [];
      const assembled = assembledFrom(frozen);

      const episodeDeps: EpisodeComputeDependencies = {
        // Truthy, with the one field the pipeline reads off it. A frozen episode was selected
        // once already — that is what the audit row IS — so re-checking selection against db13
        // would be asking a question the freeze has answered.
        fetchDischargeSummary: async () => ({ discharge_date_time: frozen.envelope.dischargedAt }),
        fetchProgressNotes: async () => [{ frozen: true }],
        fetchExtractionByIpUid: async () => ({
          extractionVersion: frozen.extraction.extraction_version ?? '',
          extractedJson: frozen.extraction.extracted_case,
          memberId: null,
          extractedAt: null,
        }),
        assembleEpisode: async () => assembled,
        recordSkip: async (a) => { skips.push({ reason: a.reason, detail: a.detail ?? null }); return 'recorded'; },
        clearSkip: async () => {},
        saveEpisodeAudit: async (row, checkpoints) => {
          written = { row, checkpoints };
          // ⚠️ THE ONE PRODUCTION WRITE IN THIS PLATFORM, and it happens only on a repair.
          //
          // `saveEpisodeAudit` reaches `sql`, which THROWS inside the fence — that is §7 working,
          // not an obstacle to route around. `exitLabExecution` is the sanctioned hole the retrieve
          // edge already uses; here it is a WRITE, which is a real escalation, so: the writer is
          // injected (never imported here), it is supplied only by the repair adapter below, and
          // that adapter is reachable only from a run whose operation is 'reaudit' (worker.ts).
          if (writeAudit) {
            const saved = await exitLabExecution(() => writeAudit(row, checkpoints));
            repairWrite = saved;
            return saved;
          }
          return { status: 'inserted', auditId: frozen.audit_id, failedCheckpoints: 0 };
        },
        checkpoint: exact
          ? async (input) => {
            const stored = frozen.checkpoints[input.checkpointId];
            if (!stored) {
              // Same reason as the chat edge: `runCheckpoint`'s caller records a failed checkpoint
              // rather than propagating it, so a missing one would become a quiet `status: error`.
              divergedCheckpoint = new LabError('REPLAY_DIVERGED',
                `the pipeline planned checkpoint ${input.checkpointId}, which the frozen case does not carry`);
              throw divergedCheckpoint;
            }
            // The step is written so `episode_checkpoint_inspect` and a later `run_replay` can
            // read this checkpoint's blinded input and its arithmetic without re-deriving them.
            return ctx.checkpoint(`checkpoint:${input.checkpointId}`, hash({
              checkpoint_id: input.checkpointId, cutoff_at: input.cutoffAt,
              input_event_count: input.events.length,
            }), async () => ({
              ...stored,
              // The BLINDING PROOF is recomputed from the course this replay was given, not copied
              // from the stored row: an input count that came back with the answer would prove
              // nothing. A disagreement with `stored.inputEventCount` is visible in the step.
              inputEventCount: input.events.length,
              cutoffAt: input.cutoffAt,
            }));
          }
          : runCheckpoint,
      };

      // ── the chat edge ────────────────────────────────────────────────────────────────
      // FROZEN: matched on the request hash, refused when it does not match (decision 45).
      // FRESH: the gateway, exactly as every other engine's stage.
      let servedSteps = 0;
      /**
       * ⚠️ A DIVERGENCE MUST NOT BE ABLE TO ARRIVE AS A SKIP, and without this it would.
       *
       * `lib/ipd-episode/model-call.ts` never throws by design — every provider failure comes back
       * as `error`, because an audit that dies on a provider hiccup is worse than one that records
       * it. So a REPLAY_DIVERGED thrown from this edge is CAUGHT by the engine one frame up, and
       * the episode lands as a perfectly ordinary `diff_failed` skip: a replay that silently
       * answered a different question would look exactly like a slow provider. It is held here and
       * re-thrown after the pipeline returns, so the item fails with the code decision 45 names.
       */
      let diverged: LabError | null = null;
      const chatEdge = async (label: string, params: unknown): Promise<unknown> => {
        const stage = ipdStageForLabel(label);
        if (exact) {
          const want = dependencyHash(params);
          const step = frozen.steps[want];
          if (!step) {
            diverged = new LabError('REPLAY_DIVERGED',
              `no stored step for stage '${stage}': the request hash ${want.slice(0, 12)}… is not among the ${Object.keys(frozen.steps).length} the case carries`);
            throw diverged;
          }
          servedSteps += 1;
          await ctx.checkpoint(stage, want, async () => step);
          ctx.event('stage_replayed', { stage, request_hash: want });
          return step.completion;
        }
        const staged = await ctx.gateway.call(stage, params as Record<string, unknown>);
        return staged.completion;
      };

      const retrieveEdge = async (query: string, opts?: unknown): Promise<RetrieveResult> => {
        const started = Date.now();
        const out = await exitLabExecution(() => retrieveImpl(query, (opts ?? {}) as RetrieveOptions));
        ctx.event('retrieval_read', { query_hash: hash(query), chunks: out?.hits?.length ?? 0, ms: Date.now() - started, frozen: false });
        return out;
      };

      return withLabExecution(
        { chat: chatEdge, retrieve: retrieveEdge as unknown as (q: string, o?: unknown) => Promise<unknown>, event: ctx.event },
        async (): Promise<AdapterOutcome> => {
          try {
            const episode = await computeEpisodeAudit(episodeDeps, {
              encounterId: frozen.episode_ref,
              engineVersion: frozen.engine_version,
              deadlineAt: null,
            });
            // Held, not swallowed — see the chat edge's header.
            const held = (diverged ?? divergedCheckpoint) as LabError | null;
            if (held) throw held;
            const w = written as { row: EpisodeAuditRow; checkpoints: CheckpointWriteRow[] } | null;
            if (!w) {
              // No audit row means the pipeline SKIPPED or errored. That is a successful execution
              // of the engine and an unanswerable clinical question, never a silent zero.
              return {
                result: { skipped: true, skip: episode.skip ?? null, error: episode.error ?? null, skips },
                summary: {
                  engine: 'ipd_episode', case_key: frozen.audit_id, exact,
                  skip: episode.skip ?? null, error: episode.error ?? null,
                },
                execution_status: episode.error && !episode.skip ? 'failed' : 'succeeded',
                assessment_status: 'unassessable',
              };
            }
            const deterministic = deterministicFields(rowAsStored(w.row), w.checkpoints.map((c) => ({
              checkpointId: c.checkpointType === 'episode' ? 'cp-episode' : `cp-d${c.dayIndex}`,
              status: c.status, entryCount: c.entryCount, uncitedEntryCount: c.uncitedEntryCount,
              inputEventCount: c.inputEventCount, cutoffAt: c.inputCutoffAt,
            })));
            const storedHash = hash(frozen.stored);
            const replayHash = hash(deterministic);
            return {
              result: deterministic,
              summary: {
                engine: 'ipd_episode',
                case_key: frozen.audit_id,
                engine_version: frozen.engine_version,
                exact,
                replayed_stages: servedSteps,
                n_findings: episode.nFindings ?? null,
                n_divergent: episode.nDivergent ?? null,
                divergence_index: episode.divergenceIndex ?? null,
                divergence_band: episode.divergenceBand ?? null,
                scoring_status: episode.scoringStatus ?? null,
                checkpoint_count: episode.checkpointCount ?? null,
                // DECISION 48, ON THE ITEM ITSELF. A golden A/B that lived only in a report would
                // have to be re-run to be believed; this puts the verdict on the row.
                source_hash: storedHash,
                replay_hash: replayHash,
                equal: storedHash === replayHash,
                // DECISION 65. A frozen run never touches the gateway, so §9's `unknown` would be
                // the wrong word: the models on the record ARE the models that answered, earlier.
                // worker.ts honours this only when the gateway saw no call at all.
                ...(exact ? {
                  attribution_status: 'replayed' as const,
                  served: { model_checkpoint: frozen.models.checkpoint, model_judge: frozen.models.judge },
                } : {}),
                // §17.6 decision 67 — present only on a repair, and it is the row that landed.
                ...(repairWrite ? { repair: { status: repairWrite.status, audit_id: repairWrite.auditId, failed_checkpoints: repairWrite.failedCheckpoints } } : {}),
              },
              execution_status: 'succeeded',
              assessment_status: episode.scoringStatus === 'ok' ? 'assessed' : 'unassessable',
            };
          } catch (e) {
            const err = e as Error & { code?: string };
            // ⚠️ A DIVERGENCE LEAVES THE ADAPTER. Every other failure is returned as an outcome,
            // because the run is more useful with the failure recorded than aborted — but
            // `run_replay` counts divergences by reading `items.error`, and an outcome-shaped
            // failure never reaches that column. So this one is re-thrown and the worker writes it.
            if (err.code === 'REPLAY_DIVERGED') throw err;
            return {
              result: { error: err.message, code: err.code ?? null },
              summary: { engine: 'ipd_episode', case_key: frozen.audit_id, error: err.code ?? 'engine_error', message: String(err.message).slice(0, 300) },
              execution_status: 'failed', assessment_status: 'not_reached',
            };
          }
        },
      );
    },
  };
}

export const ipdEpisodeAdapter: Adapter = makeIpdEpisodeAdapter();

/**
 * §17.6 DECISION 67 — the repair adapter. One line of difference, and it is the whole of the
 * difference: `saveEpisodeAudit` is `lib/ipd-episode/store.ts`'s own writer, so the row this lands
 * is byte-for-byte the row the nightly worker lands, demote-then-insert included. It is exported
 * for `worker.ts` alone and is never in `ALL_ADAPTERS`.
 */
export function makeIpdEpisodeRepairAdapter(deps: IpdAdapterDeps = {}): Adapter {
  return makeIpdEpisodeAdapter({ ...deps, writeAudit: deps.writeAudit ?? saveEpisodeAudit });
}

/**
 * DECISION 48's step-keying pass, and the reason it lives here rather than in sources/ipd.ts.
 *
 * The steps must be keyed by "the request hash the gateway would compute". Nobody can know that
 * without BUILDING the request, and only the pipeline builds it — the diff prompt is a digest of
 * five expected courses, the fidelity prompt carries the stripped extracted case. So the freeze
 * runs the pipeline ONCE against the case it is freezing, with an edge that answers from the
 * reconstructed judge replies and RECORDS the hash it was asked for. The keys are therefore the
 * hashes a replay will actually produce, not hashes this file guessed at.
 *
 * ⚠️ AND IT DISCRIMINATES ON THE SYSTEM PROMPT, not on a label, because a transport-shaped edge
 * sees only the request. The two judge passes carry different system prompts; the checkpoints
 * never reach this edge at all, because `deps.checkpoint` serves them from the stored rows.
 */
export async function recordIpdSteps(frozen: FrozenIpd): Promise<FrozenIpd['steps']> {
  const replies = judgeRepliesFrom(
    (frozen.stored.findings ?? []) as never[],
    frozen.checkpoints,
  );
  const served: { provider: string; model: string | null } = { provider: 'bedrock', model: frozen.models.judge };
  const steps: FrozenIpd['steps'] = {};
  const assembled = assembledFrom(frozen);
  let seen = 0;

  const chat = async (_label: string, params: unknown) => {
    void _label;
    const system = String((params as { messages?: { content?: unknown }[] })?.messages?.[0]?.content ?? '');
    // ⚠️ COMPARED AGAINST THE PROMPT ITSELF, not against a word in it. A regex over the text would
    // be a guess that keeps working until someone rewords a prompt, and it would fail SILENTLY —
    // both replies would be filed under one stage and the case would replay a fidelity request
    // with a divergence answer. The constant is the only honest discriminator.
    const isFidelity = system === IPD_EPISODE_FIDELITY_SYSTEM;
    const stage = isFidelity ? 'fidelity' : 'divergence';
    const text = isFidelity ? replies.fidelity : replies.divergence;
    const request_hash = dependencyHash(params);
    steps[request_hash] = { stage, request_hash, completion: completionOf(text), text, served };
    seen += 1;
    return completionOf(text);
  };

  const episodeDeps: EpisodeComputeDependencies = {
    fetchDischargeSummary: async () => ({ discharge_date_time: frozen.envelope.dischargedAt }),
    fetchProgressNotes: async () => [{ frozen: true }],
    fetchExtractionByIpUid: async () => ({
      extractionVersion: frozen.extraction.extraction_version ?? '',
      extractedJson: frozen.extraction.extracted_case, memberId: null, extractedAt: null,
    }),
    assembleEpisode: async () => assembled,
    recordSkip: async () => 'recorded',
    clearSkip: async () => {},
    saveEpisodeAudit: async () => ({ status: 'inserted', auditId: frozen.audit_id, failedCheckpoints: 0 }),
    checkpoint: async (input) => {
      const stored = frozen.checkpoints[input.checkpointId];
      if (!stored) throw new LabError('SOURCE_UNAVAILABLE', `no stored checkpoint ${input.checkpointId}`);
      return { ...stored, inputEventCount: input.events.length, cutoffAt: input.cutoffAt };
    },
  };

  await withLabExecution(
    { chat, retrieve: async () => ({ hits: [], expandedQuery: '', meta: {} }), event: () => {} },
    () => computeEpisodeAudit(episodeDeps, {
      encounterId: frozen.episode_ref, engineVersion: frozen.engine_version, deadlineAt: null,
    }),
  );

  if (seen !== 2) {
    throw new LabError('SOURCE_UNAVAILABLE',
      `the freeze pass reached ${seen} judge call(s), not 2 — this episode cannot be replayed exactly`);
  }
  return steps;
}

/** Production's IPD freezer: the three reads, then decision 48's step-keying pass. */
export function freezeIpdEpisode(auditId: string, deps: IpdFreezeDeps = {}): Promise<FrozenIpdCase> {
  return freezeIpdCase(auditId, { recordSteps: recordIpdSteps, ...deps });
}

export type { IpdFrozenParsed };
