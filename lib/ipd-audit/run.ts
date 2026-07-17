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
import { GEMINI_MODEL, MINI_MODEL } from '../llm';
import { getVertexAccessToken } from '../gcp-auth';
import { fetchIpdAdmissionHeader } from './db13';
import { buildIpdAuditRow } from './assemble';
import { saveIpdAudit, IPD_ENGINE_VERSION, IPD_MINI_ENGINE_VERSION } from './store';

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

    const header = input.ipUid ? await fetchIpdAdmissionHeader(input.ipUid).catch(() => null) : null;
    const row = buildIpdAuditRow({
      documentId: input.documentId,
      ipUid: input.ipUid ?? null,
      memberId: input.memberId ?? null,
      speciality: header?.speciality ?? null,
      dischargeType: header?.dischargeType ?? null,
      losDays: header?.losDays ?? null,
      dischargedAt: header?.dischargeDate ? `${header.dischargeDate}T00:00:00+05:30` : null,
      engineVersion: mini ? IPD_MINI_ENGINE_VERSION : IPD_ENGINE_VERSION,
      model: mini ? MINI_MODEL : GEMINI_MODEL,
      traceId: traceId ?? null,
    }, extracted, report);
    const status = await saveIpdAudit(row);
    return {
      documentId: input.documentId, ip_uid: row.ipUid, status,
      band: row.band, cvi: row.careValueIndex, nFindings: row.nFindings, nLowValue: row.nLowValue,
      latencyMs: Date.now() - t0, extractTraceId, analyzeTraceId: traceId,
    };
  } catch (e) {
    return { documentId: input.documentId, error: String((e as Error).message), latencyMs: Date.now() - t0 };
  }
}
