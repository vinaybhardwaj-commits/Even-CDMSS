/**
 * lib/mcp-tools.ts — the CDMSS "Lab" MCP tool implementations (pure of transport).
 *
 * Every tool here is MINI-ONLY and data-in/data-out. None can invoke Gemini, change a
 * prompt/engine, or write a production table. Corpus writes are quarantined (labq:) by
 * construction. Consumed by app/api/mcp/route.ts (the JSON-RPC transport).
 */
import { auditOpdNote, opdMiniEngine } from './opd-note-audit';
import { OPD_AUDIT_SYSTEM, buildOpdAuditUser } from './opd-note-audit-core';
import { MINI_MODEL, llm } from './llm';
import { fetchOpdNoteByUid } from './metabase';
import { sql } from './db';
import { guardReadOnlySql } from './sql-guard-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
import { readState, setSetting, MB_KEYS } from './mini-backfill';
import {
  ensureLabTables, saveLabAnalysis, listLabAnalyses, getLabAnalysis, labLabel,
  corpusAddQuarantined, corpusActivate, corpusDelete, corpusLabList, labStorage,
} from './lab';
import { parseNdjson, reduceDdxEvents, reduceAskEvents, labSelfBaseUrl } from './lab-clinical-core';

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
    description: 'Run the REAL /api/ddx differential-diagnosis pipeline end-to-end (retrieval → hypothesis-first → draft → self-critique → revise → demographic guard) forced onto the FREE Mac-mini (Qwen/Llama, ₹0, never Gemini), and store the full result in the lab (table lab_analyses). This tests the ACTUAL production route code — for finding pipeline bugs: missing cannot-miss dx, demographic leaks, anchoring, citation/parse failures, order-sensitivity. Provide a presentation (cc required). Store many under one `experiment` label and mine them with audit_query / lab_query. NB: mini output is a cheaper brain than prod Gemini — reliable for pipeline/parse/retrieval bugs, indicative (not final) for clinical-quality claims.',
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
    description: 'Run the REAL /api/ask RAG pipeline end-to-end (retrieve → draft → audit → revise → cite-or-label) forced onto the FREE Mac-mini (₹0, never Gemini), and store the answer + citations in the lab (lab_analyses). Tests the actual Ask route — for finding grounding bugs: uncited claims, dead/absent citations, retrieval whiffs. Store many under one `experiment` and mine with audit_query / lab_query.',
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
    name: 'lab_query',
    description: 'Inspect the experimental lab: list experiments (no args), list runs in one experiment, fetch one run by id, or storage stats. args: experiment? | id? | stats?',
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

async function labDdx(a: Record<string, unknown>): Promise<ToolResult> {
  await ensureLabTables();
  const experiment = labLabel(a.experiment);
  const cc = S(a.cc).trim();
  if (!cc) return err('cc (chief complaint) is required');
  const started = Date.now();
  const presentation = {
    cc, age: S(a.age) || undefined, sex: S(a.sex) || undefined,
    history: S(a.history) || undefined, exam: S(a.exam) || undefined,
    vitals: S(a.vitals) || undefined, investigations: S(a.investigations) || undefined,
  };
  let raw: string;
  try { raw = await selfPostNdjson('/api/ddx', presentation); }
  catch (e) { return err(`ddx pipeline call failed: ${String((e as Error).message)}`); }
  const probe = reduceDdxEvents(parseNdjson(raw));
  const preview = [presentation.age, presentation.sex, cc].filter(Boolean).join(' / ').slice(0, 300);
  const id = await saveLabAnalysis({
    experiment, kind: 'ddx', engine: 'ddx-route/mini', inputRef: null, inputPreview: preview,
    output: { presentation, ...probe }, model: MINI_MODEL, latencyMs: Date.now() - started,
  });
  return ok({
    stored_id: id, experiment, kind: 'ddx', ok: probe.ok, error: probe.error,
    cannot_miss: probe.cannot_miss, most_likely: probe.most_likely, other: probe.other,
    n_sources: probe.n_sources, critique_severity: probe.critique_severity,
    demographic_removed: probe.demographic_removed, ms: Date.now() - started,
  });
}

async function labAsk(a: Record<string, unknown>): Promise<ToolResult> {
  await ensureLabTables();
  const experiment = labLabel(a.experiment);
  const question = S(a.question).trim();
  if (!question) return err('question is required');
  const started = Date.now();
  let raw: string;
  try { raw = await selfPostNdjson('/api/ask', { question, investigations: S(a.investigations) || undefined }); }
  catch (e) { return err(`ask pipeline call failed: ${String((e as Error).message)}`); }
  const probe = reduceAskEvents(parseNdjson(raw));
  const id = await saveLabAnalysis({
    experiment, kind: 'ask', engine: 'ask-route/mini', inputRef: null, inputPreview: question.slice(0, 300),
    output: { question, ...probe }, model: MINI_MODEL, latencyMs: Date.now() - started,
  });
  return ok({
    stored_id: id, experiment, kind: 'ask', ok: probe.ok, error: probe.error,
    answer_chars: probe.answer_chars, n_sources: probe.n_sources, citation_ids: probe.citation_ids,
    uncited: probe.uncited, revised: probe.revised, ms: Date.now() - started,
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
