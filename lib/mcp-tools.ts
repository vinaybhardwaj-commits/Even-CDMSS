/**
 * lib/mcp-tools.ts — the CDMSS "Lab" MCP tool implementations (pure of transport).
 *
 * Every tool here is MINI-ONLY and data-in/data-out. None can invoke Gemini, change a
 * prompt/engine, or write a production table. Corpus writes are quarantined (labq:) by
 * construction. Consumed by app/api/mcp/route.ts (the JSON-RPC transport).
 */
import { after } from 'next/server';
import { auditOpdNote, opdMiniEngine } from './opd-note-audit';
import { OPD_AUDIT_SYSTEM, buildOpdAuditUser } from './opd-note-audit-core';
import { MINI_MODEL, llm } from './llm';
import { fetchOpdNoteByUid } from './metabase';
import { sql } from './db';
import { guardReadOnlySql } from './sql-guard-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
import { readState, setSetting, MB_KEYS } from './mini-backfill';
import {
  ensureLabTables, saveLabAnalysis, updateLabAnalysis, listLabAnalyses, getLabAnalysis, labLabel,
  corpusAddQuarantined, corpusActivate, corpusDelete, corpusLabList, labStorage,
} from './lab';
import {
  parseNdjson, reduceDdxEvents, reduceAskEvents, reduceAppropriatenessEvents,
  reduceDocAuditEvents, labSelfBaseUrl,
} from './lab-clinical-core';

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (obj: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const err = (msg: string): ToolResult => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });
const S = (v: unknown) => (typeof v === 'string' ? v : '');

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
    name: 'lab_ddx',
    description: 'ASYNC — returns a run_id immediately; poll `lab_query id=<run_id>` until output.status is done (~2–4 min on the mini; run ONE clinical probe at a time — single Mac-mini). Runs the REAL /api/ddx differential-diagnosis pipeline end-to-end (retrieval → hypothesis-first → draft → self-critique → revise → demographic guard) on the FREE mini (₹0, never Gemini), storing the full result in lab_analyses. Tests the ACTUAL production route — for pipeline bugs: missing cannot-miss dx, demographic leaks, anchoring, citation/parse failures, order-sensitivity. cc required. Store many under one `experiment` and mine with audit_query / lab_query. NB: mini = cheaper brain than prod Gemini — reliable for pipeline/parse/retrieval bugs, indicative (not final) for clinical-quality claims.',
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
    description: 'ASYNC — returns a run_id immediately; poll `lab_query id=<run_id>` until output.status is done (~2–4 min on the mini; ONE probe at a time). Runs the REAL /api/ask RAG pipeline (retrieve → draft → audit → revise → cite-or-label) on the FREE mini (₹0), storing the answer + citations in lab_analyses. Tests the actual Ask route — grounding bugs: uncited claims (output.uncited), dead/absent citations, retrieval whiffs. Store many under one `experiment` and mine with audit_query / lab_query.',
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
    description: 'ASYNC — returns a run_id immediately; poll `lab_query id=<run_id>` until output.status is done (~2–4 min on the mini; ONE probe at a time). Runs the REAL /api/appropriateness Right-Care order-check (Choosing-Wisely low-value-care matcher + LLM applicability judge + value analysis) on the FREE mini (₹0). Stores which CW statements FIRED per scenario in lab_analyses — the surface for the known ~74% over-flag: build a specificity set of clearly-appropriate scenarios and mine how often a flag fires when it should not (output.n_flags / output.flag_statements). scenario required; optionally proposedActions (the specific orders), age, sex.',
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
    description: 'ASYNC — returns a run_id immediately; poll `lab_query id=<run_id>` until output.status is done (faster than the others — a single pass — but still poll; ONE probe at a time). Runs the REAL /api/pathway/skeleton care-pathway pass (stage classification + ordered care-path spine) on the FREE mini (₹0), storing the skeleton in lab_analyses. For router coverage / stage-detection bugs / dead branches. scenario required; optionally proposedActions, age, sex.',
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
    description: 'ASYNC — returns a run_id immediately; poll `lab_query id=<run_id>` until output.status is done (~2–4 min on the mini; ONE probe at a time). Runs the REAL /api/doc-audit/analyze case-audit + prognosis on the FREE mini (₹0), storing the scored report in lab_analyses. TEXT-ONLY: pass an already-EXTRACTED case (the PDF→OCR extract leg is multimodal Vertex and cannot run on the free mini). `extracted` = an object with docType + case fields (diagnosis, procedure, indication, courseSummary, medications[], investigations[], treatments[], disposition, followUp, patient{age,sex}). For bugs in the appropriateness/foreseeability reasoning independent of OCR.',
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
      'Run a READ-ONLY SQL query (SELECT/WITH only) against the CDMSS audit database (Neon) — for mining bug prevalence + building golden sets. Readable tables are DE-IDENTIFIED (no PHI): opd_note_audits (per-note audit: uid, doctor_uid, note_date, note_quality_index, band, score_documentation/note_quality/appropriateness/prescribing_safety/patient_centred, pdqi9 jsonb [{attr,value}], completeness_pct, n_missing_mandatory, n_findings, n_low_value, n_interaction_alerts, findings jsonb [{subject,verdict,domain,source,informational,signal_type,finding_ref,citation_ids}], suggestions jsonb, missing_fields jsonb, engine_version), plus opd_audit_triage, opd_gov_signal(_event), doctor_directory, doctor_roster, audit_suppression, doctor_operational_metrics, lvc_recommendations (reference), lab_analyses (your lab_ddx/lab_ask/mini_analyze runs — output jsonb), and the DE-IDENTIFIED pipeline views v_trace_summary (feature/status/severity/timings/model_summary — NO clinical text) + v_appropriateness_summary (mode/doc_type/counts). PHI-bearing raw tables (traces, trace_events, appropriateness_runs, ccb_briefs, care_track_assignments, opd_audit_feedback) are BLOCKED — use the views. Enforced: SELECT/WITH only, single statement, no writes/DDL/system-functions, blocked-relation guard, LIMIT ≤ 500 (auto-added), audit-logged. Source-NOTE fields (medications count, followUpType, patient age, specialty) live in db13 — take the uids this returns and join via the Metabase MCP.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single SELECT/WITH query. Prefer aggregates + specific columns; findings/suggestions jsonb can be large.' },
        limit: { type: 'number', description: 'Row cap (default & max 500).' },
      },
      required: ['sql'],
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
      case 'lab_query': return await labQuery(args);
      case 'audit_query': return await auditQuery(args);
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
    const r = await llm.chat.completions.create({
      model: MINI_MODEL,
      messages: [{ role: 'system', content: OPD_AUDIT_SYSTEM }, { role: 'user', content: buildOpdAuditUser(text, '(no corpus excerpts — experimental raw pass)') }],
      temperature: 0.2, max_tokens: 2200,
      ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
    });
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
 * ASYNC lab probe: the real clinical pipelines take ~200–270s on the mini, but an MCP client
 * gives up at ~180s. So: write a `pending` lab_analyses row, run the pipeline in a post-response
 * `after()` task (kept alive by the /api/mcp function up to its 300s cap), fill the row in when
 * done, and return the run_id IMMEDIATELY. The caller polls `lab_query id=<run_id>` — output.status
 * goes pending → done | error. Runs stay one-at-a-time on the single Mac-mini regardless.
 */
async function startAsyncLabRun(opts: {
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
  after(async () => {
    try {
      const { output } = await opts.run();
      await updateLabAnalysis(runId, { status: 'done', ...output }, Date.now() - startedAt);
    } catch (e) {
      await updateLabAnalysis(runId, { status: 'error', error: String((e as Error).message) }, Date.now() - startedAt);
    }
  });
  return ok({
    run_id: runId, experiment: opts.experiment, kind: opts.kind, status: 'started',
    poll: `lab_query id=${runId}`,
    note: 'Runs on the free mini (~1–4 min, one at a time). Poll lab_query with this id — output.status goes pending → done. Don\'t start another clinical probe until this one is done (single mini).',
  });
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
  return startAsyncLabRun({
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
  return startAsyncLabRun({
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
  return startAsyncLabRun({
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
  return startAsyncLabRun({
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
  return startAsyncLabRun({
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
