/**
 * lib/mcp-tools.ts — the CDMSS "Lab" MCP tool implementations (pure of transport).
 *
 * Every tool here is MINI-ONLY and data-in/data-out. None can invoke Gemini, change a
 * prompt/engine, or write a production table. Corpus writes are quarantined (labq:) by
 * construction. Consumed by app/api/mcp/route.ts (the JSON-RPC transport).
 */
import { auditOpdNote, opdMiniEngine } from './opd-note-audit';
import { OPD_AUDIT_SYSTEM, buildOpdAuditUser } from './opd-note-audit-core';
import { MINI_MODEL } from './llm';
import { governedChat } from './trace';
import { fetchOpdNoteByUid } from './metabase';
import { sql } from './db';
import { guardReadOnlySql } from './sql-guard-core';
import { retrieve, clampLabRetrieveTopK, BM25_DEFAULT_DFMAX } from './retrieve';
import { retrieveMultiQuery } from './multi-query';
import { RerankBackendUnavailableError } from './rerank';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
import { readState, setSetting, MB_KEYS } from './mini-backfill';
import { LB_KEYS, sanitizeUids, clampN } from './lab-batch-core';
import { readBatchState, batchProgress, batchTick } from './lab-batch';
import {
  ensureLabTables, saveLabAnalysis, updateLabAnalysis, listLabAnalyses, getLabAnalysis, labLabel,
  corpusAddQuarantined, corpusActivate, corpusDelete, corpusLabList, labStorage,
} from './lab';
import {
  parseNdjson, reduceDdxEvents, reduceAskEvents, reduceAppropriatenessEvents,
  reduceDocAuditEvents, labSelfBaseUrl,
} from './lab-clinical-core';
import {
  ADJUDICATION_DDL, buildRollupFindingSql, buildRollupFiredSql, buildRollupMissedSql,
  buildRollupAuditSql, buildRollupReviewerSql, buildLatestLedgerSql, reduceRollup,
  buildDetailSql, shapeDetailRow, parseAdjudicateArgs, buildAdjudicationInsert,
  buildAdjudicationListSql, reduceLedgerList, clampLimit,
  type FindingCountRow, type FiredRow, type MissedRow, type AuditRow as RollupAuditRow,
  type ReviewerRow, type LedgerLatestRow, type DetailRawRow, type LedgerRow, type FeedbackScope,
} from './opd-feedback-rollup-core';

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (obj: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const err = (msg: string): ToolResult => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });
const S = (v: unknown) => (typeof v === 'string' ? v : '');
const APP_SOURCE = process.env.APP_SOURCE || 'standalone';

// ── tool schemas (advertised via tools/list) ────────────────────────────────────
export const LAB_TOOLS = [
  {
    name: 'mini_analyze',
    description: 'Run the CDMSS OPD note-quality audit on the FREE Mac-mini pipeline (Qwen, ₹0, never Gemini) and store the result in the experimental lab (table lab_analyses, namespaced by `experiment`). Provide EITHER metabase_uid (a db13 OPD note) OR text (a pasted clinical note). Does not touch production audit tables.',
    inputSchema: {
      type: 'object',
      properties: {
        experiment: { type: 'string', description: 'Experiment label to file this under (new or existing).' },
        metabase_uid: { type: 'string', description: 'db13 individuals-prescriptions uid to audit (structured OPD audit).' },
        text: { type: 'string', description: 'Raw clinical note text to audit (used if no metabase_uid).' },
      },
      required: ['experiment'],
    },
  },
  {
    name: 'backfill_control',
    description: 'Control the mini-pipeline OPD backfill autopilot (all mini, ₹0). action: status | start | pause | run_day (audit one specific IST day now). Mirrors the /admin/mini-backfill switches.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'start', 'pause', 'run_day'] },
        day: { type: 'string', description: 'YYYY-MM-DD (IST) — required for run_day.' },
        n: { type: 'number', description: 'run_day: notes to audit this call (1–3).' },
        tag: { type: 'string', description: 'run_day: engine run tag (default mini).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'corpus_add',
    description: 'Add vetted medical content to the CDMSS corpus, QUARANTINED. It is chunked and embedded on the mini (nomic, ₹0) and stored inert as source `labq:<label>` — it does NOT affect production retrieval until you call corpus_activate. Fully reversible.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Batch label → source labq:<label>.' },
        book: { type: 'string', description: 'Work/title (dedup is per book+text).' },
        text: { type: 'string', description: 'The content to ingest.' },
        chapter: { type: 'string' }, section: { type: 'string' },
        chunk_type: { type: 'string', description: "e.g. 'guideline','note','abstract' (default 'note')." },
      },
      required: ['label', 'book', 'text'],
    },
  },
  {
    name: 'corpus_manage',
    description: 'Manage lab corpus batches. action: list (all lab batches + status) | activate (labq:<label> → live in production retrieval) | delete (remove a batch). ACTIVATE affects the real clinical tool — use deliberately.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'activate', 'delete'] },
        label: { type: 'string' },
        which: { type: 'string', enum: ['quarantined', 'active', 'both'], description: 'delete scope (default both).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'lab_retrieve',
    description: 'MEASUREMENT SEAM (read-only): run the REAL production retrieve() at served-k through the shipped path (query expansion → nomic embed → vector + BM25 legs → RRF fusion → cross-encoder rerank → source-quality weighting) and return the served hits WITH FULL TEXT and per-stage scores. Diagnoses what retrieval actually serves for a clinical question: which chunks, from which sources, at what vector_rank/bm25_rank/rrf_score/rerank_score/source_quality_weight. useReranker + useSourceWeights default TRUE (every production caller sets them true). multiQuery=true routes through retrieveMultiQuery (the condition Ask/DDx run — variant fan-out fused by RRF, then one rerank over the union) and adds variant_ranks per hit; default false. skipExpand=true holds the query fixed so multi- vs single-query arms are identical. includeQuarantined names ONE quarantined batch (e.g. guidelines-lvc-22jul) to fold in for A/B measurement — that batch ONLY, bound + slugged, never widened; omit it for the exact production condition. topK clamped ≤ 20 (measurement scope, not a bulk export). NB: returns licensed corpus text — do not paste into public docs. No model generation.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The clinical question, exactly as served (required).' },
        topK: { type: 'number', description: 'Hits to return (default 8 = served k; max 20).' },
        includeQuarantined: { type: 'string', description: "One quarantined batch label to fold in (e.g. 'guidelines-lvc-22jul'). Omit for the exact production condition." },
        useReranker: { type: 'boolean', description: 'Cross-encoder rerank (default true).' },
        useSourceWeights: { type: 'boolean', description: 'Source-quality weighting (default true).' },
        hybrid: { type: 'boolean', description: 'Run the BM25 leg alongside vector (default true).' },
        multiQuery: { type: 'boolean', description: 'Route through retrieveMultiQuery — the multi-variant fusion Ask/DDx run (default false).' },
        skipExpand: { type: 'boolean', description: 'Skip query expansion so single- vs multi-query arms are held identical (default false).' },
        bm25Mode: { type: 'string', enum: ['off', 'discriminating'], description: "BM25 leg mode (default 'off' = today's plainto-AND). 'discriminating' keeps only low-DF (rare) lexemes, OR-joins them, caps the scan — the R-2 measurement leg. Lab-only; production is always 'off'." },
        dfMax: { type: 'number', description: `Discriminating mode only: keep lexemes whose corpus document frequency (planner estimate) is ≤ this (default ${BM25_DEFAULT_DFMAX}). Sweep it for the Stage-2 A/B.` },
        rerankBackend: { type: 'string', enum: ['default', 'bge', 'judge'], description: "Rerank backend for this call. 'default' (or omitted) = production default (env-driven, 'judge'). 'bge' = the DETERMINISTIC cross-encoder ruler (bge-reranker-v2-m3, must be pulled on the mini — errors loud if absent, never falls back). 'judge' = the LLM judge. Lab-only; production reranker is unchanged." },
        scoresOnly: { type: 'boolean', description: 'When true, trim each hit to ids + scores (no chunk text, no variant query bodies) — the context-cheap payload for the Stage-2 A/B. Keeps expandedQuery + meta. Default false.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'lab_ddx',
    description: 'Runs the REAL /api/ddx differential-diagnosis pipeline end-to-end (retrieval → hypothesis-first → draft → self-critique → revise → demographic guard) on the FREE mini (₹0, never Gemini), storing the full result in lab_analyses. Tests the ACTUAL production route — for pipeline bugs: missing cannot-miss dx, demographic leaks, anchoring, citation/parse failures. cc required. TIMING: ~2–5 min on the mini, which is longer than the MCP client waits (~180s) — so THIS CALL WILL LIKELY TIME OUT, but the run still completes + stores server-side. A `pending` row appears within ~1s and flips to done. After a timeout, POLL `lab_query experiment=<your-experiment>` (newest first) or `id=<run_id>` for output.status pending→done. Run ONE clinical probe at a time (single Mac-mini). Store many under one `experiment` and mine with audit_query / lab_query. NB: mini = cheaper brain than prod Gemini — reliable for pipeline/parse/retrieval bugs, indicative (not final) for clinical-quality claims.',
    inputSchema: {
      type: 'object',
      properties: {
        experiment: { type: 'string', description: 'Experiment label to file this under.' },
        cc: { type: 'string', description: 'Chief complaint (required).' },
        age: { type: 'string', description: 'Patient age, e.g. "54" or "3 months".' },
        sex: { type: 'string', description: 'Patient sex (M/F/…), used as a hard demographic constraint.' },
        history: { type: 'string' }, exam: { type: 'string' }, vitals: { type: 'string' },
        investigations: { type: 'string', description: 'Free-text investigation results, if any.' },
      },
      required: ['experiment', 'cc'],
    },
  },
  {
    name: 'lab_ask',
    description: 'Runs the REAL /api/ask RAG pipeline (retrieve → draft → audit → revise → cite-or-label) on the FREE mini (₹0), storing the answer + citations in lab_analyses. Tests the actual Ask route — grounding bugs: uncited claims (output.uncited), dead/absent citations, retrieval whiffs. TIMING: ~2–5 min > the MCP client wait (~180s), so THIS CALL WILL LIKELY TIME OUT but the run completes + stores; a `pending` row appears within ~1s. After a timeout, POLL `lab_query experiment=<your-experiment>` or `id=<run_id>` for output.status pending→done. ONE probe at a time. Store many under one `experiment` and mine with audit_query / lab_query.',
    inputSchema: {
      type: 'object',
      properties: {
        experiment: { type: 'string', description: 'Experiment label to file this under.' },
        question: { type: 'string', description: 'The clinical question (required).' },
        investigations: { type: 'string', description: 'Optional investigation results to fold in.' },
      },
      required: ['experiment', 'question'],
    },
  },
  {
    name: 'lab_appropriateness',
    description: 'Runs the REAL /api/appropriateness Right-Care order-check (Choosing-Wisely low-value-care matcher + LLM applicability judge + value analysis) on the FREE mini (₹0). Stores which CW statements FIRED per scenario in lab_analyses — the surface for the known ~74% over-flag: build a specificity set of clearly-appropriate scenarios and mine how often a flag fires when it should not (output.n_flags / output.flag_statements). TIMING: ~2–5 min > the MCP client wait (~180s), so THIS CALL WILL LIKELY TIME OUT but the run completes + stores; a `pending` row appears within ~1s. After a timeout, POLL `lab_query experiment=<your-experiment>` or `id=<run_id>` for output.status pending→done. ONE probe at a time. scenario required; optionally proposedActions (the specific orders), age, sex.',
    inputSchema: {
      type: 'object',
      properties: {
        experiment: { type: 'string', description: 'Experiment label to file this under.' },
        scenario: { type: 'string', description: 'The clinical scenario / presentation (required).' },
        proposedActions: { type: 'array', items: { type: 'string' }, description: 'Specific orders/tests to check (skips the extraction pass).' },
        age: { type: 'string' }, sex: { type: 'string' },
      },
      required: ['experiment', 'scenario'],
    },
  },
  {
    name: 'lab_pathway',
    description: 'Runs the REAL /api/pathway/skeleton care-pathway pass (stage classification + ordered care-path spine) on the FREE mini (₹0), storing the skeleton in lab_analyses. For router coverage / stage-detection bugs / dead branches. TIMING: a single fast pass — usually returns INLINE within the client wait (result in the response). If it does time out, a `pending` row is stored — poll `lab_query experiment=<your-experiment>` or `id=<run_id>`. ONE probe at a time. scenario required; optionally proposedActions, age, sex.',
    inputSchema: {
      type: 'object',
      properties: {
        experiment: { type: 'string', description: 'Experiment label to file this under.' },
        scenario: { type: 'string', description: 'The clinical scenario (required).' },
        proposedActions: { type: 'array', items: { type: 'string' } },
        age: { type: 'string' }, sex: { type: 'string' },
      },
      required: ['experiment', 'scenario'],
    },
  },
  {
    name: 'lab_case_audit',
    description: 'Runs the REAL /api/doc-audit/analyze case-audit + prognosis on the FREE mini (₹0), storing the scored report in lab_analyses. TEXT-ONLY: pass an already-EXTRACTED case (the PDF→OCR extract leg is multimodal Vertex and cannot run on the free mini). `extracted` = an object with docType + case fields (diagnosis, procedure, indication, courseSummary, medications[], investigations[], treatments[], disposition, followUp, patient{age,sex}). For bugs in the appropriateness/foreseeability reasoning independent of OCR. TIMING: ~2–5 min > the MCP client wait (~180s), so THIS CALL WILL LIKELY TIME OUT but the run completes + stores; a `pending` row appears within ~1s. After a timeout, POLL `lab_query experiment=<your-experiment>` or `id=<run_id>` for output.status pending→done. ONE probe at a time.',
    inputSchema: {
      type: 'object',
      properties: {
        experiment: { type: 'string', description: 'Experiment label to file this under.' },
        extracted: { type: 'object', description: 'An already-extracted case (ExtractedCase shape). At least one of diagnosis/procedure/courseSummary/medications/investigations must be present.' },
      },
      required: ['experiment', 'extracted'],
    },
  },
  {
    name: 'lab_query',
    description: 'Inspect the experimental lab + POLL async clinical probes (lab_ddx/lab_ask/lab_appropriateness/lab_pathway/lab_case_audit): fetch one run by id (its output.status is pending → done → error; done rows carry the full result), list runs in one experiment (experiment=…), list experiments (no args), or storage stats (stats=true). args: experiment? | id? | stats?',
    inputSchema: {
      type: 'object',
      properties: {
        experiment: { type: 'string' }, id: { type: 'string' },
        stats: { type: 'boolean' }, limit: { type: 'number' },
      },
    },
  },
  {
    name: 'audit_query',
    description:
      'Run a READ-ONLY SQL query (SELECT/WITH only) against the CDMSS audit database (Neon) — for mining bug prevalence + building golden sets. Readable tables are DE-IDENTIFIED (no PHI): opd_note_audits (per-note audit: uid, doctor_uid, note_date, note_quality_index, band, score_documentation/note_quality/appropriateness/prescribing_safety/patient_centred, pdqi9 jsonb [{attr,value}], completeness_pct, n_missing_mandatory, n_findings, n_low_value, n_interaction_alerts, findings jsonb [{subject,verdict,domain,source,informational,signal_type,finding_ref,citation_ids,rule_ref,lvc_category}] (lvc_category on low-value findings ∈ antibiotic|imaging|supplement_polypharmacy|therapeutic_duplication|systemic_steroid|gi_ppi_prokinetic|antihistamine_allergy|nsaid_analgesic|cough_cold_fdc|cough_expectorant|unindicated_investigation|other — the 8 overuse sub-tags added in engine 0.81.8), suggestions jsonb, missing_fields jsonb, engine_version), plus opd_audit_triage, opd_gov_signal(_event), doctor_directory, doctor_roster, audit_suppression, doctor_operational_metrics, lvc_recommendations (reference), lab_analyses (your lab_ddx/lab_ask/mini_analyze runs — output jsonb), and the DE-IDENTIFIED pipeline views v_trace_summary (feature/status/severity/timings/model_summary — NO clinical text) + v_appropriateness_summary (mode/doc_type/counts). PHI-bearing raw tables (traces, trace_events, appropriateness_runs, ccb_briefs, care_track_assignments, opd_audit_feedback) are BLOCKED — use the views, and the feedback_* tools for opd_audit_feedback. Enforced: SELECT/WITH only, single statement, no writes/DDL/system-functions, blocked-relation guard, LIMIT ≤ 500 (auto-added), audit-logged. Source-NOTE fields (medications count, followUpType, patient age, specialty) live in db13 — take the uids this returns and join via the Metabase MCP.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single SELECT/WITH query. Prefer aggregates + specific columns; findings/suggestions jsonb can be large.' },
        limit: { type: 'number', description: 'Row cap (default & max 500).' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'lab_batch_start',
    description: 'Queue a cohort-scoped FREE-mini (qwen, INR 0) eval batch into lab_analyses (experiment-namespaced; NEVER opd_note_audits). Provide EITHER uids[] OR cohort_sql (a read-only SELECT/WITH returning a uid column). The */2 cron drains it, yielding to the prod backfill; poll lab_batch_status, nudge with lab_batch_tick, analyse with lab_query/audit_query. For model-bridge + eval sweeps at scale without firing per-note calls.',
    inputSchema: {
      type: 'object',
      properties: {
        experiment: { type: 'string', description: 'label to file runs under (a-z0-9_-).' },
        uids: { type: 'array', items: { type: 'string' }, description: 'cohort of db13 OPD note uids (<=2000).' },
        cohort_sql: { type: 'string', description: 'alternative to uids[]: a read-only SELECT/WITH returning a uid column.' },
        n: { type: 'number', description: 'notes per tick (1-2; default 2).' },
        window: { type: 'string', enum: ['night', 'always'], description: "'always' drains all day; default 'night' (00-05 IST)." },
        kind: { type: 'string', description: 'reserved; default opd.' },
      },
      required: ['experiment'],
    },
  },
  {
    name: 'lab_batch_status',
    description: 'Progress of the active lab eval batch: done/total/remaining, enabled, window, last error, last tick summary.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'lab_batch_stop',
    description: 'Pause the lab eval batch (state kept; lab_batch_start resumes/re-arms).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'lab_batch_tick',
    description: 'Synchronously drain up to n (<=2) cohort notes NOW and return - a manual nudge that ignores the night window (still yields to the prod mini-backfill + its own lock). Use for immediate progress instead of waiting for the */2 cron. ~72s/note on the mini.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'feedback_rollup',
    description: 'OPD feedback loop — MEASURED precision from clinician triage of audit findings (opd_audit_feedback), the read path for the feedback instrumentation. Current-state = latest verdict per (audit_id, finding_ref) (earlier rows are history). Returns per (engine_version × signal_type) bucket: fired (findings that fired in opd_note_audits), triaged, coverage_pct = triaged/fired, verdict counts (tp/nitpick/false/contested), precision_strict = tp/(tp+nitpick+false) with contested EXCLUDED (a demand-side dispute, reported separately as contested_rate); plus missed-flag volume by signal_type, audit_scope { n_comments, verdict_counts, n_escalations }, reviewer tally, open_adjudications (clusters with ≥3 false+nitpick and no current non-defer ledger decision), and totals. Zero denominators → null (never NaN). Read-only, fixed parameterized SQL (NOT free SQL — opd_audit_feedback stays blocked from audit_query). Args: engine_version? (default all, grouped), signal_type?, since?/until? (ISO dates on feedback created_at).',
    inputSchema: {
      type: 'object',
      properties: {
        engine_version: { type: 'string', description: 'Filter to one engine version (default: all, grouped).' },
        signal_type: { type: 'string', description: 'Filter to one signal_type.' },
        since: { type: 'string', description: 'ISO date — feedback created_at ≥ this day.' },
        until: { type: 'string', description: 'ISO date — feedback created_at ≤ this day (inclusive).' },
      },
    },
  },
  {
    name: 'feedback_detail',
    description: 'OPD feedback loop — the adjudication feed: individual current-state feedback rows joined to the fired finding (subject/verdict/domain/rationale, located in opd_note_audits.findings by finding_ref; null for missed/audit scope or if the ref no longer resolves, with ref_resolved=false). ⚠️ Returns clinician free-text comments verbatim — treat as potentially containing clinical details; do not paste into public docs. Read-only, fixed parameterized SQL (opd_audit_feedback stays blocked from audit_query). Args: scope? (finding|missed|audit, default finding), verdict?, signal_type?, engine_version?, uid?, history? (default false = current-state only; true also returns superseded rows flagged history=true), limit? (default 50, max 200).',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['finding', 'missed', 'audit'], description: 'default finding.' },
        verdict: { type: 'string', description: 'Filter by verdict (whitelisted per scope).' },
        signal_type: { type: 'string' },
        engine_version: { type: 'string' },
        uid: { type: 'string', description: 'db13 note uid.' },
        history: { type: 'boolean', description: 'default false (current-state only).' },
        limit: { type: 'number', description: 'default 50, max 200.' },
      },
    },
  },
  {
    name: 'feedback_adjudicate',
    description: 'OPD feedback loop — append-only adjudication ledger (opd_feedback_adjudications). The ONLY write tool here; it touches ONLY the ledger table, never opd_audit_feedback or any production table (the Lab MCP no-production-writes promise holds — the ledger is lab infrastructure). action=log records one cluster decision; action=list returns decisions newest-first, flagging the current status per cluster_key. decision ∈ fix (engine change owed) | suppress (down-tier/silence the check) | accept (noise tolerable, working as intended) | defer (need more labels) | monitor (no action now, keep watching). cluster_key convention <signal_type>@<engine_version> (or a bug id like 0.8-17). Table is ensured at call time (CREATE TABLE IF NOT EXISTS).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['log', 'list'] },
        cluster_key: { type: 'string', description: 'log: required; list: optional filter.' },
        decision: { type: 'string', enum: ['fix', 'suppress', 'accept', 'defer', 'monitor'], description: 'log: required.' },
        rationale: { type: 'string', description: 'log: required.' },
        prd_ref: { type: 'string', description: 'log: optional PRD/bug reference.' },
        author: { type: 'string', description: 'log: default cowork-orchestrator.' },
        limit: { type: 'number', description: 'list: default 50, max 200.' },
      },
      required: ['action'],
    },
  },
] as const;

// ── dispatch ─────────────────────────────────────────────────────────────────────
export async function callLabTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case 'mini_analyze': return await miniAnalyze(args);
      case 'lab_ddx': return await labDdx(args);
      case 'lab_ask': return await labAsk(args);
      case 'lab_appropriateness': return await labAppropriateness(args);
      case 'lab_pathway': return await labPathway(args);
      case 'lab_case_audit': return await labCaseAudit(args);
      case 'backfill_control': return await backfillControl(args);
      case 'corpus_add': return await corpusAdd(args);
      case 'corpus_manage': return await corpusManage(args);
      case 'lab_retrieve': return await labRetrieve(args);
      case 'lab_query': return await labQuery(args);
      case 'audit_query': return await auditQuery(args);
      case 'lab_batch_start': return await labBatchStart(args);
      case 'lab_batch_status': return await labBatchStatus();
      case 'lab_batch_stop': return await labBatchStop();
      case 'lab_batch_tick': return await labBatchTick();
      case 'feedback_rollup': return await feedbackRollup(args);
      case 'feedback_detail': return await feedbackDetail(args);
      case 'feedback_adjudicate': return await feedbackAdjudicate(args);
      default: return err(`unknown tool: ${name}`);
    }
  } catch (e) {
    return err(String((e as Error).message));
  }
}

async function miniAnalyze(a: Record<string, unknown>): Promise<ToolResult> {
  await ensureLabTables();
  const experiment = labLabel(a.experiment);
  const uid = S(a.metabase_uid).trim();
  const text = S(a.text).trim();
  const started = Date.now();

  if (uid) {
    const row = await fetchOpdNoteByUid(uid);
    if (!row) return err(`no db13 OPD note for uid ${uid}`);
    const audit = await auditOpdNote(row, { pipeline: 'mini', engineTag: 'lab', trace: false });
    const output = { index: audit.scorecard.headline, band: audit.scorecard.band, scorecard: audit.scorecard, completeness: audit.completeness, findings: audit.findings, suggestions: audit.suggestions };
    const id = await saveLabAnalysis({ experiment, kind: 'opd_note', engine: audit.engineVersion, inputRef: uid, inputPreview: `uid ${uid}`, output, model: MINI_MODEL, latencyMs: Date.now() - started });
    return ok({ stored_id: id, experiment, kind: 'opd_note', engine: audit.engineVersion, index: audit.scorecard.headline, band: audit.scorecard.band, findings: audit.findings.length });
  }

  if (text) {
    // Text mode: run the OPD audit SYSTEM prompt on the mini over the pasted note (no retrieval
    // grounding — this is an experimental raw pass; structured uid mode is the grounded one).
    // Governed envelope (Stage 4): traceless + no gemini → byte-identical local call.
    const r = await governedChat(undefined, 'mcp_mini_analyze', {
      model: MINI_MODEL,
      messages: [{ role: 'system', content: OPD_AUDIT_SYSTEM }, { role: 'user', content: buildOpdAuditUser(text, '(no corpus excerpts — experimental raw pass)') }],
      temperature: 0.2, max_tokens: 2200,
      ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
    }, { promptRef: 'opd-note-audit-core/OPD_AUDIT_SYSTEM' });
    const raw = r.choices?.[0]?.message?.content || '';
    const output = { raw, note: 'text mode = ungrounded raw mini pass; use metabase_uid for the full grounded audit' };
    const id = await saveLabAnalysis({ experiment, kind: 'text', engine: `${opdMiniEngine('lab')}-textraw`, inputRef: null, inputPreview: text.slice(0, 300), output, model: MINI_MODEL, latencyMs: Date.now() - started });
    return ok({ stored_id: id, experiment, kind: 'text', chars: raw.length, model: MINI_MODEL });
  }

  return err('provide metabase_uid or text');
}

/** Self-fetch one of the app's own streaming clinical routes, forcing the FREE mini, and
 *  return the raw NDJSON body. Routes are public (clinician app) → no auth header needed. */
async function selfPostNdjson(path: string, body: Record<string, unknown>): Promise<string> {
  const base = labSelfBaseUrl(process.env as Record<string, string | undefined>);
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, providerOverride: 'ollama' }),
  });
  if (!res.ok && res.status >= 400) {
    const t = await res.text().catch(() => '');
    throw new Error(`${path} → HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  return await res.text();   // waits for the whole NDJSON stream to finish
}

/**
 * Lab clinical probe runner. The real pipelines take ~200–285s on the mini — under the /api/mcp
 * function's 300s cap but OVER an MCP client's ~180s wait. Key facts learned live:
 *   • The Vercel function keeps running server-side to 300s even after the client gives up at 180s,
 *     so the DB write is RELIABLE (a client timeout is cosmetic).
 *   • `after()` is NOT reliable for this — Vercel tears the callback down long before a 285s job
 *     finishes (verified: pipeline succeeded @285s but the after() row stayed 'pending'). So we run
 *     the pipeline SYNCHRONOUSLY inside the request-backed function instead.
 * Pattern: write a `pending` row FIRST (visible to a poller within ~1s), run the pipeline, then
 * update the row to done|error. Fast probes (pathway) return inline before 180s; slow ones time the
 * MCP client out but STILL complete + store — poll `lab_query experiment=<exp>` (newest first) or
 * `id=<run_id>`; output.status goes pending → done. One probe at a time (single Mac-mini).
 */
async function runLabProbe(opts: {
  experiment: string; kind: string; engine: string; inputPreview: string; inputRef?: string | null;
  run: () => Promise<{ output: Record<string, unknown>; summary: Record<string, unknown> }>;
}): Promise<ToolResult> {
  await ensureLabTables();
  const startedAt = Date.now();
  const runId = await saveLabAnalysis({
    experiment: opts.experiment, kind: opts.kind, engine: opts.engine, inputRef: opts.inputRef ?? null,
    inputPreview: opts.inputPreview, model: MINI_MODEL, latencyMs: null,
    output: { status: 'pending', started_at: new Date().toISOString() },
  });
  try {
    const { output, summary } = await opts.run();
    await updateLabAnalysis(runId, { status: 'done', ...output }, Date.now() - startedAt);
    return ok({ run_id: runId, experiment: opts.experiment, kind: opts.kind, status: 'done', ...summary, ms: Date.now() - startedAt });
  } catch (e) {
    await updateLabAnalysis(runId, { status: 'error', error: String((e as Error).message) }, Date.now() - startedAt);
    return err(`${opts.kind} probe failed (run_id ${runId}): ${String((e as Error).message)}`);
  }
}

async function labDdx(a: Record<string, unknown>): Promise<ToolResult> {
  const experiment = labLabel(a.experiment);
  const cc = S(a.cc).trim();
  if (!cc) return err('cc (chief complaint) is required');
  const presentation = {
    cc, age: S(a.age) || undefined, sex: S(a.sex) || undefined,
    history: S(a.history) || undefined, exam: S(a.exam) || undefined,
    vitals: S(a.vitals) || undefined, investigations: S(a.investigations) || undefined,
  };
  return runLabProbe({
    experiment, kind: 'ddx', engine: 'ddx-route/mini',
    inputPreview: [presentation.age, presentation.sex, cc].filter(Boolean).join(' / ').slice(0, 300),
    run: async () => {
      const probe = reduceDdxEvents(parseNdjson(await selfPostNdjson('/api/ddx', presentation)));
      return { output: { presentation, ...probe }, summary: { ok: probe.ok } };
    },
  });
}

async function labAsk(a: Record<string, unknown>): Promise<ToolResult> {
  const experiment = labLabel(a.experiment);
  const question = S(a.question).trim();
  if (!question) return err('question is required');
  return runLabProbe({
    experiment, kind: 'ask', engine: 'ask-route/mini', inputPreview: question.slice(0, 300),
    run: async () => {
      const probe = reduceAskEvents(parseNdjson(await selfPostNdjson('/api/ask', { question, investigations: S(a.investigations) || undefined })));
      return { output: { question, ...probe }, summary: { ok: probe.ok } };
    },
  });
}

async function labAppropriateness(a: Record<string, unknown>): Promise<ToolResult> {
  const experiment = labLabel(a.experiment);
  const scenario = S(a.scenario).trim();
  if (!scenario) return err('scenario is required');
  const proposedActions = Array.isArray(a.proposedActions)
    ? (a.proposedActions as unknown[]).map((x) => S(x).trim()).filter(Boolean) : undefined;
  const patient = { age: S(a.age) || undefined, sex: S(a.sex) || undefined };
  return runLabProbe({
    experiment, kind: 'appropriateness', engine: 'appropriateness-route/mini', inputPreview: scenario.slice(0, 300),
    run: async () => {
      const probe = reduceAppropriatenessEvents(parseNdjson(await selfPostNdjson('/api/appropriateness', { scenario, proposedActions, patient })));
      return { output: { scenario, proposedActions, ...probe }, summary: { ok: probe.ok, n_flags: probe.n_flags } };
    },
  });
}

async function labPathway(a: Record<string, unknown>): Promise<ToolResult> {
  const experiment = labLabel(a.experiment);
  const scenario = S(a.scenario).trim();
  if (!scenario) return err('scenario is required');
  const proposedActions = Array.isArray(a.proposedActions)
    ? (a.proposedActions as unknown[]).map((x) => S(x).trim()).filter(Boolean) : undefined;
  const patient = { age: S(a.age) || undefined, sex: S(a.sex) || undefined };
  return runLabProbe({
    experiment, kind: 'pathway', engine: 'pathway-route/mini', inputPreview: scenario.slice(0, 300),
    run: async () => {
      const base = labSelfBaseUrl(process.env as Record<string, string | undefined>);
      const res = await fetch(`${base}/api/pathway/skeleton`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario, proposedActions, patient, providerOverride: 'ollama' }),
      });
      const json = (await res.json()) as Record<string, unknown>;
      const skeleton = (json.skeleton && typeof json.skeleton === 'object' ? json.skeleton : null) as Record<string, unknown> | null;
      const stages = skeleton && Array.isArray(skeleton.stages) ? skeleton.stages as Record<string, unknown>[] : [];
      return {
        output: { scenario, ...json },
        summary: {
          ok: json.ok === true && skeleton != null, detected_stage: skeleton?.detectedStage ?? null,
          n_stages: stages.length, stage_ids: stages.map((s) => String(s.id || '')).filter(Boolean),
        },
      };
    },
  });
}

async function labCaseAudit(a: Record<string, unknown>): Promise<ToolResult> {
  const experiment = labLabel(a.experiment);
  const extracted = (a.extracted && typeof a.extracted === 'object') ? a.extracted as Record<string, unknown> : null;
  if (!extracted) return err('extracted (an already-extracted case object) is required — the PDF→OCR leg is multimodal and cannot run on the free mini');
  const preview = S(extracted.diagnosis) || S(extracted.procedure) || S(extracted.courseSummary) || 'case';
  return runLabProbe({
    experiment, kind: 'case_audit', engine: 'doc-audit-route/mini', inputPreview: preview.slice(0, 300),
    run: async () => {
      const probe = reduceDocAuditEvents(parseNdjson(await selfPostNdjson('/api/doc-audit/analyze', { extracted })));
      return { output: { extracted, ...probe }, summary: { ok: probe.ok, headline: probe.headline, band: probe.band } };
    },
  });
}

async function backfillControl(a: Record<string, unknown>): Promise<ToolResult> {
  const action = S(a.action);
  if (action === 'status') return ok(await readState());
  if (action === 'start') { await setSetting(MB_KEYS.enabled, '1'); return ok({ enabled: true, note: 'autopilot on — runs within its compute window on the next 5-min tick' }); }
  if (action === 'pause') { await setSetting(MB_KEYS.enabled, '0'); return ok({ enabled: false }); }
  if (action === 'run_day') {
    const day = S(a.day);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return err('run_day needs day=YYYY-MM-DD');
    const n = Math.max(1, Math.min(3, Number(a.n) || 1));
    const tag = a.tag ? labLabel(a.tag) : 'mini';
    const { countOpdNotesForDay, fetchOpdNotesForDay } = await import('./metabase');
    const { saveOpdAudit, auditedUidsForDay } = await import('./opd-audit-store');
    const engineStr = opdMiniEngine(tag);
    const total = await countOpdNotesForDay(day);
    const already = await auditedUidsForDay(day, engineStr);
    const rows = total > already.length ? await fetchOpdNotesForDay(day, already, n) : [];
    const results: Record<string, unknown>[] = [];
    for (const row of rows) {
      const t0 = Date.now();
      try { const au = await auditOpdNote(row, { pipeline: 'mini', engineTag: tag }); const st = await saveOpdAudit(au, { model: MINI_MODEL, latencyMs: Date.now() - t0 }); results.push({ uid: au.keys.uid, index: au.scorecard.headline, band: au.scorecard.band, status: st, ms: Date.now() - t0 }); }
      catch (e) { results.push({ error: String((e as Error).message) }); }
    }
    return ok({ day, engine: engineStr, total, already: already.length, processed: results.length, results });
  }
  return err(`unknown action: ${action}`);
}

async function labBatchStart(a: Record<string, unknown>): Promise<ToolResult> {
  const experiment = labLabel(a.experiment);
  if (!experiment) return err('experiment required');
  let uids = sanitizeUids(a.uids);
  const cohortSql = S(a.cohort_sql).trim();
  if (uids.length === 0 && cohortSql) {
    const g = guardReadOnlySql(cohortSql, 2000);
    if (!g.ok) return err(`cohort_sql: ${g.error}`);
    let rows: Record<string, unknown>[];
    try { rows = await run(g.sql, []); } catch (e) { return err(`cohort_sql failed: ${String((e as Error).message)}`); }
    uids = sanitizeUids(rows.map((r) => (r.uid ?? Object.values(r)[0])));
  }
  if (uids.length === 0) return err('no uids - pass uids[] or a cohort_sql returning a uid column');
  const n = clampN(a.n ?? 2);
  const window = S(a.window) === 'always' ? 'always' : 'night';
  const kind = (S(a.kind) || 'opd').replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'opd';
  await ensureLabTables();
  await setSetting(LB_KEYS.experiment, experiment);
  await setSetting(LB_KEYS.uids, JSON.stringify(uids));
  await setSetting(LB_KEYS.n, String(n));
  await setSetting(LB_KEYS.window, window);
  await setSetting(LB_KEYS.kind, kind);
  await setSetting(LB_KEYS.error, '');
  await setSetting(LB_KEYS.enabled, '1');
  const prog = await batchProgress(experiment, uids);
  return ok({ experiment, kind, n, window, ...prog, note: 'queued - the */2 cron drains it (mini, INR 0), yielding to the prod backfill. Poll lab_batch_status; nudge with lab_batch_tick.' });
}

async function labBatchStatus(): Promise<ToolResult> {
  const st = await readBatchState();
  const prog = st.experiment ? await batchProgress(st.experiment, st.uids) : { total: 0, done: 0, remaining: 0 };
  return ok({ enabled: st.enabled, experiment: st.experiment, kind: st.kind, n: st.n, window: st.window, ...prog, last_error: st.lastError, last: st.last });
}

async function labBatchStop(): Promise<ToolResult> {
  await setSetting(LB_KEYS.enabled, '0');
  return ok({ enabled: false, note: 'paused (state kept; lab_batch_start re-arms/resumes)' });
}

async function labBatchTick(): Promise<ToolResult> {
  const st = await readBatchState();
  if (!st.experiment || st.uids.length === 0) return err('no job - call lab_batch_start first');
  return ok(await batchTick({ ignoreWindow: true }));
}

async function corpusAdd(a: Record<string, unknown>): Promise<ToolResult> {
  const label = S(a.label), book = S(a.book), text = S(a.text);
  if (!label || !book || !text) return err('label, book, and text are required');
  const res = await corpusAddQuarantined({ label, book, text, chapter: S(a.chapter) || undefined, section: S(a.section) || undefined, chunkType: S(a.chunk_type) || undefined });
  return ok({ ...res, status: 'quarantined', note: `inert until corpus_manage action=activate label=${labLabel(label)} — does not affect production retrieval yet` });
}

async function corpusManage(a: Record<string, unknown>): Promise<ToolResult> {
  const action = S(a.action);
  if (action === 'list') return ok({ batches: await corpusLabList() });
  if (action === 'activate') { if (!S(a.label)) return err('activate needs label'); return ok({ ...(await corpusActivate(S(a.label))), note: 'now LIVE in production retrieval (Ask/DDx/Right Care/audits)' }); }
  if (action === 'delete') { if (!S(a.label)) return err('delete needs label'); const which = (['quarantined', 'active', 'both'] as const).includes(a.which as never) ? a.which as 'quarantined' | 'active' | 'both' : 'both'; return ok(await corpusDelete(S(a.label), which)); }
  return err(`unknown action: ${action}`);
}

/** Measurement seam: run production retrieve() (or the multi-query fusion Ask/DDx use) and return
 *  served hits + per-stage scores + full text. Read-only; no model generation. Defaults
 *  useReranker/useSourceWeights TRUE (the production config); diagnostics always populated (R-5). */
async function labRetrieve(a: Record<string, unknown>): Promise<ToolResult> {
  const query = S(a.query).trim();
  if (!query) return err('query is required');
  const topK = clampLabRetrieveTopK(a.topK);
  const includeQuarantined = S(a.includeQuarantined).trim() || undefined;
  const useReranker = a.useReranker === undefined ? true : a.useReranker === true;
  const useSourceWeights = a.useSourceWeights === undefined ? true : a.useSourceWeights === true;
  const hybrid = a.hybrid === undefined ? true : a.hybrid === true;
  const multiQuery = a.multiQuery === true;
  const skipExpand = a.skipExpand === true;
  // R-2 Stage 1: lab-only discriminating BM25 leg. 'off' (default) ⇒ today's production behaviour.
  const dfMax = Number.isFinite(Number(a.dfMax)) && Number(a.dfMax) > 0 ? Math.floor(Number(a.dfMax)) : BM25_DEFAULT_DFMAX;
  const bm25Mode = S(a.bm25Mode) === 'discriminating' ? { strategy: 'discriminating' as const, dfMax } : undefined;
  // R-10: deterministic rerank ruler for the A/B. 'default'/omitted ⇒ env default (production 'judge').
  const rb = S(a.rerankBackend);
  const rerankBackend = rb === 'bge' ? 'bge' : rb === 'judge' ? 'judge' : undefined;
  const scoresOnly = a.scoresOnly === true;

  try {
    if (multiQuery) {
      const res = await retrieveMultiQuery(query, { topK, includeQuarantined, useReranker, useSourceWeights, hybrid, skipExpand, bm25Mode, rerankBackend });
      const full = res.hits.map((h, i) => {
        // rerank_score/backend/source_quality_weight/bm25 provenance are present at runtime but off the
        // exported MultiQueryHit type (see multi-query.ts) — read them via a narrow cast.
        const hx = h as typeof h & { rerank_score?: number; rerank_backend?: string; source_quality_weight?: number; bm25_rank?: number | null; bm25_variant_ranks?: (number | null)[] };
        return {
          final_rank: i + 1,
          id: h.id, source: h.source, book: h.book, chapter: h.chapter, section: h.section, item_number: h.item_number,
          similarity: h.similarity,
          vector_rank: null, bm25_rank: hx.bm25_rank ?? null, bm25_variant_ranks: hx.bm25_variant_ranks ?? null,
          rrf_score: h.rrf_score ?? null, variant_ranks: h.variant_ranks ?? null,
          source_quality_weight: hx.source_quality_weight ?? null, rerank_score: hx.rerank_score ?? null,
          rerank_backend: hx.rerank_backend ?? null,
          text: h.text,
        };
      });
      const hits = scoresOnly ? full.map(pickScoreFields) : full;
      return ok({
        query, mode: 'multi_query', expandedQuery: res.expandedQuery, includeQuarantined: includeQuarantined ?? null,
        topK, count: hits.length, bm25Mode: bm25Mode ? 'discriminating' : 'off', rerankBackend: rerankBackend ?? 'default', scoresOnly,
        perVariantCounts: res.perVariantCounts,
        // scoresOnly drops the variant query bodies (large: the expanded paragraph + variant texts).
        ...(scoresOnly ? {} : { variants: res.variants }),
        hits,
      });
    }

    const res = await retrieve(query, { topK, includeQuarantined, useReranker, useSourceWeights, hybrid, skipExpand, withDiagnostics: true, bm25Mode, rerankBackend });
    const full = res.hits.map((h, i) => ({
      final_rank: h.final_rank ?? i + 1,
      id: h.id, source: h.source, book: h.book, chapter: h.chapter, section: h.section, item_number: h.item_number,
      similarity: h.similarity,
      vector_rank: h.vector_rank ?? null, bm25_rank: h.bm25_rank ?? null, bm25_variant_ranks: null, rrf_score: h.rrf_score ?? null,
      source_quality_weight: h.source_quality_weight ?? null, rerank_score: h.rerank_score ?? null, rerank_backend: h.rerank_backend ?? null,
      text: h.text,
    }));
    const hits = scoresOnly ? full.map(pickScoreFields) : full;
    return ok({
      query, mode: 'single_query', expandedQuery: res.expandedQuery, includeQuarantined: includeQuarantined ?? null,
      topK, count: hits.length, bm25Mode: bm25Mode ? 'discriminating' : 'off', rerankBackend: rerankBackend ?? 'default', scoresOnly,
      meta: res.meta, hits,
    });
  } catch (e) {
    // D3: a requested-but-unavailable bge ruler fails LOUD — surfaced named, never a silent judge fallback.
    if (e instanceof RerankBackendUnavailableError) return err(`${e.name}: ${e.message}`);
    throw e;
  }
}

/** scoresOnly payload trim (§D2): ids + scores, NO chunk text/section. Pure — exported for tests. */
export function pickScoreFields(h: Record<string, unknown>): Record<string, unknown> {
  return {
    final_rank: h.final_rank ?? null, id: h.id, source: h.source, book: h.book, chapter: h.chapter, item_number: h.item_number,
    similarity: h.similarity, vector_rank: h.vector_rank ?? null, bm25_rank: h.bm25_rank ?? null,
    bm25_variant_ranks: h.bm25_variant_ranks ?? null, rrf_score: h.rrf_score ?? null,
    rerank_score: h.rerank_score ?? null, rerank_backend: h.rerank_backend ?? null,
    source_quality_weight: h.source_quality_weight ?? null,
  };
}

async function labQuery(a: Record<string, unknown>): Promise<ToolResult> {
  if (a.stats === true) return ok(await labStorage());
  if (S(a.id)) { const row = await getLabAnalysis(S(a.id)); return row ? ok(row) : err('not found'); }
  const experiment = a.experiment ? labLabel(a.experiment) : null;
  return ok({ experiment, results: await listLabAnalyses(experiment, Number(a.limit) || 50) });
}

async function ensureSqlAuditLog(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS lab_sql_audit (
    id bigserial PRIMARY KEY, sql text, rows integer, ms integer, at timestamptz NOT NULL DEFAULT now()
  )`, []);
}

/** READ-ONLY SQL over the de-identified CDMSS audit DB (guarded). For golden-set mining. */
async function auditQuery(a: Record<string, unknown>): Promise<ToolResult> {
  const cap = Math.max(1, Math.min(500, Number(a.limit) || 500));
  const g = guardReadOnlySql(S(a.sql), cap);
  if (!g.ok) return err(g.error);
  await ensureSqlAuditLog().catch(() => {});
  const t0 = Date.now();
  let rows: Record<string, unknown>[];
  try { rows = (await run(g.sql, [])) as Record<string, unknown>[]; }
  catch (e) { return err(`query failed: ${String((e as Error).message)}`); }
  const ms = Date.now() - t0;
  await run(`INSERT INTO lab_sql_audit (sql, rows, ms) VALUES ($1,$2,$3)`, [g.sql.slice(0, 4000), rows.length, ms]).catch(() => {});
  return ok({ sql: g.sql, rows: rows.length, ms, data: rows });
}

// ── OPD feedback loop (PRD OPD-FEEDBACK-LOOP-MCP §4) ──────────────────────────────
// Fixed parameterized SQL compiled in lib/opd-feedback-rollup-core.ts — NOT routed through
// guardReadOnlySql (opd_audit_feedback stays in BLOCKED_RELATIONS; free SQL can never touch it).
// The only write is the ledger table, ensured at call time (ensureSqlAuditLog pattern).
async function ensureAdjudicationTable(): Promise<void> {
  await run(ADJUDICATION_DDL, []);
}

async function feedbackRollup(a: Record<string, unknown>): Promise<ToolResult> {
  await ensureAdjudicationTable().catch(() => {}); // the open-adjudication gate reads this table
  const filters = {
    appSource: APP_SOURCE,
    engineVersion: S(a.engine_version).trim() || null,
    since: S(a.since).trim() || null,
    until: S(a.until).trim() || null,
    signalType: S(a.signal_type).trim() || null,
  };
  const [findingQ, firedQ, missedQ, auditQ, reviewerQ, ledgerQ] = [
    buildRollupFindingSql(filters), buildRollupFiredSql(filters), buildRollupMissedSql(filters),
    buildRollupAuditSql(filters), buildRollupReviewerSql(filters), buildLatestLedgerSql(),
  ];
  const [findingRows, firedRows, missedRows, auditRows, reviewerRows, ledgerRows] = await Promise.all([
    run(findingQ.text, findingQ.params), run(firedQ.text, firedQ.params), run(missedQ.text, missedQ.params),
    run(auditQ.text, auditQ.params), run(reviewerQ.text, reviewerQ.params), run(ledgerQ.text, ledgerQ.params),
  ]);
  const rollup = reduceRollup({
    findingRows: findingRows as unknown as FindingCountRow[],
    firedRows: firedRows as unknown as FiredRow[],
    missedRows: missedRows as unknown as MissedRow[],
    auditRows: auditRows as unknown as RollupAuditRow[],
    reviewerRows: reviewerRows as unknown as ReviewerRow[],
    ledgerRows: ledgerRows as unknown as LedgerLatestRow[],
  });
  return ok({ ok: true, filters: { engine_version: filters.engineVersion, signal_type: filters.signalType, since: filters.since, until: filters.until }, ...rollup });
}

async function feedbackDetail(a: Record<string, unknown>): Promise<ToolResult> {
  const scope = (S(a.scope).trim() || 'finding') as FeedbackScope;
  let q;
  try {
    q = buildDetailSql({
      appSource: APP_SOURCE, scope,
      verdict: S(a.verdict).trim() || null,
      signalType: S(a.signal_type).trim() || null,
      engineVersion: S(a.engine_version).trim() || null,
      uid: S(a.uid).trim() || null,
      history: a.history === true,
      limit: clampLimit(a.limit),
    });
  } catch (e) { return err(String((e as Error).message)); }
  const rows = await run(q.text, q.params);
  const shaped = (rows as unknown as DetailRawRow[]).map(shapeDetailRow);
  return ok({ ok: true, scope, history: a.history === true, count: shaped.length, note: 'comments are clinician free text — do not paste into public docs', rows: shaped });
}

async function feedbackAdjudicate(a: Record<string, unknown>): Promise<ToolResult> {
  const parsed = parseAdjudicateArgs(a);
  if (!parsed.ok) return err(parsed.error);
  await ensureAdjudicationTable();
  if (parsed.action === 'log') {
    const ins = buildAdjudicationInsert({ cluster_key: parsed.cluster_key, decision: parsed.decision, rationale: parsed.rationale, prd_ref: parsed.prd_ref, author: parsed.author });
    const rows = await run(ins.text, ins.params);
    return ok({ ok: true, action: 'log', logged: rows[0] ?? null });
  }
  const q = buildAdjudicationListSql({ cluster_key: parsed.cluster_key, limit: parsed.limit });
  const rows = await run(q.text, q.params);
  return ok({ ok: true, action: 'list', count: rows.length, rows: reduceLedgerList(rows as unknown as LedgerRow[]) });
}
