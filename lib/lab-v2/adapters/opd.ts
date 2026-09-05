/**
 * lib/lab-v2/adapters/opd.ts — the opd_note_audit adapter (LAB-MCP-V2-PRD-v1.0 §8.1).
 *
 * The only engine wired end to end in round 1. It runs the REAL production audit —
 * `auditOpdNote` from lib/opd-note-audit.ts, not a copy of it — with three of its live
 * reads replaced by frozen values and its model call redirected through the budgeted
 * gateway. That is the entire point of the design: a lab result is only evidence about
 * production if it was produced by production's own code.
 *
 * WHAT THE CONTEXT CHANGES, AND WHY EACH ONE.
 *   · `sql`, `metabaseQuery`  → throw. A research run must not read identifying rows or
 *                               write any production row. (§7)
 *   · trace writers           → no-op. A research run must not consume production trace
 *                               ids or leave rows the dashboards would count. (§7)
 *   · `governedChat`          → gateway. Every call reserved against a cap before the
 *                               network, and attributed from the transport receipt. (§6)
 *   · `retrieve`              → the edge below. The ONE production read a Slice A run
 *                               makes, and the reason every Slice A dataset is
 *                               `mutable_source`. (§4.2, §8.1)
 *   · getLvcRules, doctorSpecialtyFor, the db13 complexity fetch → frozen. (§8.1)
 */
import { withLabExecution, exitLabExecution } from '../../lab-execution-context';
import { auditOpdNote, opdAuditPerAttemptMs, type OpdLabDependencies } from '../../opd-note-audit';
import { OPD_ENGINE_VERSION } from '../../opd-note-audit-core';
import { retrieve as productionRetrieve, type RetrieveOptions, type RetrieveResult } from '../../retrieve';
import { hash, opdFrozenSchema, OPD_STAGES, type OpdFrozen } from '../contracts';
import type { Adapter, AdapterContext, AdapterOutcome } from './types';

/**
 * The engine's governed call sites carry their own labels; an arm prices STAGES. This is
 * the only place the two vocabularies meet.
 *
 * ⚠️ `lib/opd-note-audit.ts` has exactly ONE governed model call today — `opd_audit_analyze`
 * at line 1137, the audit's analysis leg. `verification` is declared by §4.2 and is
 * priced and budget-checked like any other stage, but the current engine emits no second
 * leg, so no call is reserved against it in round 1. An unrecognised future label maps to
 * `analysis` rather than throwing, because a new engine leg must not be able to fail a
 * research run before anyone has had the chance to price it.
 */
const STAGE_BY_LABEL: Record<string, string> = {
  opd_audit_analyze: 'analysis',
  opd_audit_verify: 'verification',
};

export function stageForLabel(label: string): string {
  return STAGE_BY_LABEL[label] ?? 'analysis';
}

/** Injection seam for unit tests (repo idiom — mirrors WithTraceDeps/MatchDeps). Production
 *  passes nothing and gets lib/retrieve.ts's `retrieve`, which is the whole point of the edge. */
export interface OpdAdapterDeps {
  retrieve?: (query: string, opts: RetrieveOptions) => Promise<RetrieveResult>;
}

export function makeOpdAdapter(deps: OpdAdapterDeps = {}): Adapter {
  const retrieveImpl = deps.retrieve ?? productionRetrieve;
  return {
  engine: 'opd_note_audit',
  stages: OPD_STAGES,
  engineVersion: () => OPD_ENGINE_VERSION,
  frozenInputs: ['note', 'specialty', 'complexity', 'lvc_rules', 'suppressions', 'quieting_config'],
  // Decision 22 — the engine's own per-attempt ceiling, read from PROVIDER_BUDGETS through
  // lib/opd-note-audit.ts. Not restated here: one number, one source.
  perAttemptTimeoutMs: opdAuditPerAttemptMs(),

  async run(ctx: AdapterContext): Promise<AdapterOutcome> {
    const parsed = opdFrozenSchema.safeParse(ctx.frozen);
    if (!parsed.success) {
      return {
        result: { error: 'frozen inputs did not match the opd_note_audit shape', issues: parsed.error.issues.slice(0, 5) },
        summary: { engine: 'opd_note_audit', findings: 0 },
        execution_status: 'failed',
        assessment_status: 'not_reached',
      };
    }
    const frozen: OpdFrozen = parsed.data;

    const labDependencies: OpdLabDependencies = {
      lvcRules: frozen.lvc_rules.map((r) => ({ id: r.id, keywords: r.keywords, category: r.category })),
      specialty: frozen.specialty,
      complexity: frozen.complexity as OpdLabDependencies['complexity'],
      // Decision 10 — pass-through, unmodified. The lab froze what production reads; it
      // does not get a vote on what a suppression or a demote rule means.
      suppressions: frozen.suppressions as unknown as OpdLabDependencies['suppressions'],
      quietingConfig: frozen.quieting_config as unknown as OpdLabDependencies['quietingConfig'],
    };

    // ── the retrieve edge ────────────────────────────────────────────────────────────
    // Captured HERE, outside the context, and it runs the production body under exit().
    // Both halves matter: capturing outside means the closure does not itself carry the
    // store, and exit() means the production `sql` inside `retrieve` sees no context and
    // takes the normal DATABASE_URL read path instead of hitting its own guard.
    // DECISION 41 — a cohort dataset froze its sources at creation, so the edge SERVES THEM and
    // reads nothing. That is what makes such a dataset `replay_exactness: 'frozen'`: the corpus
    // can move underneath and the run still sees what it saw. A Slice A dataset has no frozen
    // list, takes the path below, and stays `mutable_source`. Both are logged as retrieval_read,
    // with `frozen` saying which happened — a report must never have to guess.
    const frozenSources = frozen.sources;
    const retrieveEdge = async (query: string, opts?: unknown): Promise<RetrieveResult> => {
      const started = Date.now();
      if (frozenSources && frozenSources.length) {
        ctx.event('retrieval_read', {
          query_hash: hash(query), chunks: frozenSources.length, ms: Date.now() - started, frozen: true,
        });
        return {
          hits: frozenSources.map((f) => ({
            id: Number(f.id), source: f.source ?? '', book: f.book ?? '', chapter: f.chapter,
            section: null, page_start: null, page_end: null, item_number: null,
            chunk_type: 'narrative', text: f.preview ?? '', token_count: null,
            similarity: f.score ?? 0,
          })) as unknown as RetrieveResult['hits'],
          expandedQuery: query,
          meta: { vector_pool: 0, bm25_pool: 0, fused: frozenSources.length, reranked: false },
        };
      }
      const out = await exitLabExecution(() => retrieveImpl(query, (opts ?? {}) as RetrieveOptions));
      ctx.event('retrieval_read', {
        query_hash: hash(query),
        chunks: out?.hits?.length ?? 0,
        ms: Date.now() - started,
        frozen: false,
      });
      return out;
    };

    // ── the chat edge ────────────────────────────────────────────────────────────────
    // Returns the COMPLETION object, not the text: the engine's own call site reads
    // `r.choices[0].message.content`, and the adapter must not change the shape the
    // engine expects or it stops being the production code path.
    const chatEdge = async (label: string, params: unknown): Promise<unknown> => {
      const staged = await ctx.gateway.call(stageForLabel(label), params as Record<string, unknown>);
      return staged.completion;
    };

    const armVersion = typeof ctx.arm.engine_version === 'string' ? ctx.arm.engine_version : OPD_ENGINE_VERSION;

    return withLabExecution(
      { chat: chatEdge, retrieve: retrieveEdge as unknown as (q: string, o?: unknown) => Promise<unknown>, event: ctx.event },
      async (): Promise<AdapterOutcome> => {
        try {
          const audit = await auditOpdNote(frozen.note as Record<string, unknown>, {
            labDependencies,
            engineVersion: armVersion,
          } as Parameters<typeof auditOpdNote>[1]);

          // §9 — `unassessable` is a SUCCESSFUL execution whose engine declared the case
          // unassessable. For the OPD audit that is exactly `llmLegFailed`: the
          // deterministic half ran and scored, but the clinical question the LLM leg
          // answers did not get an answer. Reporting that as `assessed` would put a
          // half-audit into a comparison denominator as though it were whole.
          const llmLegFailed = (audit as { llmLegFailed?: boolean }).llmLegFailed === true;
          const findings = (audit as { findings?: unknown[] }).findings ?? [];
          return {
            result: audit,
            summary: {
              engine: 'opd_note_audit',
              engine_version: (audit as { engineVersion?: string }).engineVersion ?? armVersion,
              findings: findings.length,
              // experiment_compare pairs on this; deriving it here keeps the summary the one
              // place a comparison reads, rather than re-walking the artifact per case.
              n_low_value: (findings as { verdict?: string; informational?: boolean }[])
                .filter((f) => f.verdict === 'low-value' && !f.informational).length,
              finding_subjects: (findings as { subject?: string }[]).slice(0, 25).map((f) => f.subject ?? null),
              // FIX 26b — the summary read a key the engine does not have. `OpdScorecard`
              // (lib/opd-note-score-core.ts:93) calls the 0..100 OPD Note-Quality Index
              // `headline`; round 1 read `noteQualityIndex`, which is undefined on every audit,
              // so the field was null even on assessed items. The ENGINE was never at fault and
              // does not skip PDQI-9 — lib/opd-note-audit.ts is untouched by this fix.
              note_quality_index: (audit as { scorecard?: { headline?: number } }).scorecard?.headline ?? null,
              band: (audit as { scorecard?: { band?: string } }).scorecard?.band ?? null,
              llm_leg_failed: llmLegFailed,
            },
            execution_status: 'succeeded',
            assessment_status: llmLegFailed ? 'unassessable' : 'assessed',
          };
        } catch (e) {
          const err = e as Error & { code?: string };
          return {
            result: { error: err.message, code: err.code ?? null },
            summary: { engine: 'opd_note_audit', error: err.code ?? 'engine_error' },
            execution_status: 'failed',
            assessment_status: 'not_reached',
          };
        }
      },
    );
    },
  };
}

export const opdAdapter: Adapter = makeOpdAdapter();

export const ADAPTERS: Record<string, Adapter> = { opd_note_audit: opdAdapter };
