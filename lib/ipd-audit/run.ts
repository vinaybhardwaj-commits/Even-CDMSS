/**
 * lib/ipd-audit/run.ts — the shared single-doc audit chain (S5/S6). ONE implementation used by
 * the audit-now button, the daily Gemini worker, and the Mini/Qwen backfill: db13 envelope →
 * GCS fetch → shipped doc-audit extract+analyze (+ value-score-core) → persist de-identified.
 *
 * The engine is CALLED, never edited. The only per-caller difference is the model swap:
 * `forceOllama` routes the ANALYZE pass to the Mac-mini (Qwen, ₹0) — the EXTRACT pass is
 * Gemini-multimodal by construction (it reads the PDF), exactly as the OPD mini backfill's
 * extract stays on Gemini. PHI posture is structural: only the de-identified extract/report and
 * the db13 admission ENVELOPE (ids, speciality, LOS, dates) ever reach the row — names/UHID are
 * read at surface time only.
 */

import { extractCase, analyzeCase } from '../doc-audit';
import { MINI_MODEL } from '../llm';
import { getVertexAccessToken } from '../gcp-auth';
import { fetchIpdAdmissionHeader } from './db13';
import { fetchBilledTotal, fetchBillingEnvelope } from './billing';
import { persistEpisodeState } from './episode-adapter';
import { buildIpdAuditRow } from './assemble';
import { saveIpdAudit, IPD_ENGINE_VERSION, IPD_MINI_ENGINE_VERSION } from './store';
import { sql } from '../db';

/** T-5, applied to IPD (2 Aug 2026) — the model column records what actually SERVED, not a
 *  hardcoded literal. This row said `gemini-2.5-pro` whether or not Gemini answered, so there was
 *  no way to tell whether IPD had been silently degrading to the local model the way OPD was for
 *  three days (the 110 s OpenRouter ceiling, fixed in 3039c42: 126 OPD notes graded by qwen, zero
 *  by Gemini, every row still claiming Pro). A constant cannot report a fallback.
 *
 *  Unit B (§5, 2 Aug 2026): it now returns the PROVIDER beside the model, from the SAME row of the
 *  SAME query. Deliberately one query: reading them separately could pair a model from one event
 *  with a provider from another and attribute the call to a route it never took, which is a worse
 *  lie than the ambiguity being fixed. `provider` on the llm_response payload is set AFTER fallback
 *  (lib/trace.ts reassigns it to 'ollama' when the local model serves), so it is the served route.
 *
 *  Byte-identical to the OPD worker's helper EXCEPT the stage, which is
 *  `doc_audit_analyze` here (lib/doc-audit.ts:175) rather than `opd_audit_analyze` — the two legs
 *  are different pipelines and reading the wrong stage would silently return null forever.
 *  tracedChat's llm_response event carries the POST-fallback model (`actualModel`), so the audit's
 *  own trace is the source of truth. Null when unknown (no trace / LLM leg dead) — an honest gap,
 *  never a guess, and never a throw: a failed lookup must not fail an audit that already ran. */
async function servedCallFor(traceId: string | undefined): Promise<{ model: string | null; provider: string | null }> {
  const none = { model: null, provider: null };
  if (!traceId) return none;
  try {
    const rows = (await (sql as unknown as (q: string, p: unknown[]) => Promise<{ model?: string; provider?: string }[]>)(
      `SELECT payload->>'model' AS model, payload->>'provider' AS provider FROM trace_events
        WHERE trace_id = $1 AND kind IN ('llm_response', 'llm_stream_usage')
          AND stage = 'doc_audit_analyze'
        ORDER BY seq DESC LIMIT 1`,
      [traceId],
    ));
    const r = rows?.[0];
    return {
      model: typeof r?.model === 'string' && r.model ? r.model : null,
      provider: typeof r?.provider === 'string' && r.provider ? r.provider : null,
    };
  } catch { return none; }
}

export interface IpdRunInput {
  documentId: string;
  ipUid?: string | null;
  memberId?: string | null;
  pdfUrl: string;
}

export interface IpdRunResult {
  documentId: string;
  ip_uid?: string | null;
  status?: 'inserted' | 'updated' | 'skipped';
  id?: string | null;
  band?: string;
  cvi?: number;
  nFindings?: number;
  nLowValue?: number;
  latencyMs?: number;
  error?: string;
  skip?: 'no-pdf' | 'unreadable';
  // BOTH trace ids — the extract (Gemini multimodal, the PDF read) and the analyze chain are
  // separate traces, so real per-doc cost needs both. The row persists only the analyze trace.
  extractTraceId?: string | null;
  analyzeTraceId?: string | null;
}

/** Fetch the PDF: plain URL first (bucket is publicly readable — flagged to infra), Bearer fallback. */
async function fetchPdf(url: string): Promise<Buffer> {
  let res = await fetch(url).catch(() => null);
  if (!res?.ok) {
    const token = await getVertexAccessToken();
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!res.ok) throw new Error(`GCS fetch ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Audit one discharge summary and persist it. `mini` swaps the analyze pass to Qwen and writes
 * under the isolated '-mini' engine version (invisible to prod reads via the composite PK).
 * K=1 by construction — one extract, one analyze. Returns a compact per-doc outcome; never throws.
 */
export async function runIpdAudit(input: IpdRunInput, opts: { mini?: boolean } = {}): Promise<IpdRunResult> {
  const t0 = Date.now();
  const mini = opts.mini === true;
  try {
    if (!input.pdfUrl) return { documentId: input.documentId, skip: 'no-pdf' };
    const buf = await fetchPdf(input.pdfUrl);
    const { extracted, traceId: extractTraceId } = await extractCase({
      base64: buf.toString('base64'), mime: 'application/pdf',
      docTypeHint: 'discharge_summary', bytes: buf.length,
    });
    if (!extracted) return { documentId: input.documentId, skip: 'unreadable', extractTraceId };

    // mini → analyze on the free Mac-mini (Qwen); extract stays Gemini-multimodal (reads the PDF)
    const { report, traceId } = await analyzeCase(extracted, {}, mini ? { forceOllama: true } : {});
    if (!report?.valueScore) return { documentId: input.documentId, skip: 'unreadable', extractTraceId, analyzeTraceId: traceId };

    // S7: the admission envelope + its billed ₹ scalar, both read-time db13 joins. billed_total is
    // best-effort — a billing outage must never cost us the audit, and ~8% of admissions have no
    // linked bill at all, so null is a normal value here, not a failure.
    const [header, billedTotal] = input.ipUid
      ? await Promise.all([
          fetchIpdAdmissionHeader(input.ipUid).catch(() => null),
          fetchBilledTotal(input.ipUid).catch(() => null),
        ])
      : [null, null];
    // The MINI path keeps MINI_MODEL and records provider 'ollama' — a local run has no fallback to
    // discover, and 'ollama' is the truth about it rather than a guess. The cloud path asks the
    // trace what actually answered, for BOTH fields, from one row of one query.
    const served = mini
      ? { model: MINI_MODEL, provider: 'ollama' as string | null }
      : await servedCallFor(traceId);
    const row = buildIpdAuditRow({
      documentId: input.documentId,
      ipUid: input.ipUid ?? null,
      memberId: input.memberId ?? null,
      speciality: header?.speciality ?? null,
      dischargeType: header?.dischargeType ?? null,
      losDays: header?.losDays ?? null,
      dischargedAt: header?.dischargeDate ? `${header.dischargeDate}T00:00:00+05:30` : null,
      billedTotal,
      engineVersion: mini ? IPD_MINI_ENGINE_VERSION : IPD_ENGINE_VERSION,
      model: served.model,
      traceId: traceId ?? null,
    }, extracted, report);
    // `provider` is set on the ROW rather than threaded through buildIpdAuditRow's meta:
    // lib/ipd-audit/assemble.ts constructs the row field-by-field and is outside this unit's file
    // contract, so a meta field would be silently dropped there. Assigning here is equivalent and
    // keeps the change inside the files this unit owns — flagged in the build report.
    row.provider = served.provider;
    const status = await saveIpdAudit(row);

    // EpisodeState (#4 SL2) — build + persist the phased episode object, ADDITIVE + BEST-EFFORT.
    // The audit is already saved above; persistEpisodeState never throws, so this cannot turn a
    // successful audit into a failure. The billing envelope is fetched here (best-effort) for the
    // ₹ fact; a billing outage just yields a null netTotal. Forward-only — no backfill.
    const billing = input.ipUid ? await fetchBillingEnvelope(input.ipUid).catch(() => null) : null;
    await persistEpisodeState(input.documentId, extracted, header, billing);

    return {
      documentId: input.documentId, ip_uid: row.ipUid, status,
      band: row.band, cvi: row.careValueIndex, nFindings: row.nFindings, nLowValue: row.nLowValue,
      latencyMs: Date.now() - t0, extractTraceId, analyzeTraceId: traceId,
    };
  } catch (e) {
    return { documentId: input.documentId, error: String((e as Error).message), latencyMs: Date.now() - t0 };
  }
}
