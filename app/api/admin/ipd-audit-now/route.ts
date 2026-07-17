import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { extractCase, analyzeCase } from '@/lib/doc-audit';
import { GEMINI_MODEL } from '@/lib/llm';
import { getVertexAccessToken } from '@/lib/gcp-auth';
import { fetchIpdDoc, fetchIpdAdmissionHeader } from '@/lib/ipd-audit/db13';
import { fetchBilledTotal, fetchBillingEnvelope } from '@/lib/ipd-audit/billing';
import { buildIpdAuditRow } from '@/lib/ipd-audit/assemble';
import { saveIpdAudit, IPD_ENGINE_VERSION } from '@/lib/ipd-audit/store';
import { persistEpisodeState } from '@/lib/ipd-audit/episode-adapter';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 300;

// POST /api/admin/ipd-audit-now — the SINGLE-DOC audit primitive (S3.5; S4 scales this).
// Body: { documentId } (db13 miscellaneous_documents _doc_id).
// Flow: db13 envelope → GCS fetch → shipped doc-audit extract+analyze (+ value-score-core,
// computed inside analyzeCase) → persist de-identified via lib/ipd-audit/store.
// The LLM sees ONLY the document bytes + the de-identified extract — never the db13 header.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const documentId = typeof body.documentId === 'string' ? body.documentId.trim() : '';
  if (!documentId) return NextResponse.json({ ok: false, error: 'documentId required' }, { status: 400 });

  try {
    const doc = await fetchIpdDoc(documentId);
    if (!doc?.pdfUrl) return NextResponse.json({ ok: false, error: 'document not found or has no PDF' }, { status: 404 });
    const header = doc.ipUid ? await fetchIpdAdmissionHeader(doc.ipUid) : null;
    // S7: the billed ₹ scalar, best-effort — no linked bill (~8%) is a normal null, not a failure.
    const billedTotal = doc.ipUid ? await fetchBilledTotal(doc.ipUid).catch(() => null) : null;

    // GCS fetch: plain URL first (bucket is publicly readable today — flagged to infra),
    // service-account Bearer as the durable path.
    let res = await fetch(doc.pdfUrl).catch(() => null);
    if (!res?.ok) {
      const token = await getVertexAccessToken();
      res = await fetch(doc.pdfUrl, { headers: { Authorization: `Bearer ${token}` } });
    }
    if (!res.ok) return NextResponse.json({ ok: false, error: `GCS fetch ${res.status}` }, { status: 502 });
    const buf = Buffer.from(await res.arrayBuffer());

    const { extracted, traceId: extractTraceId } = await extractCase({
      base64: buf.toString('base64'), mime: 'application/pdf',
      docTypeHint: 'discharge_summary', bytes: buf.length,
    });
    if (!extracted) return NextResponse.json({ ok: false, error: 'could not read the document', extractTraceId }, { status: 200 });

    const { report, traceId: analyzeTraceId } = await analyzeCase(extracted);
    if (!report) return NextResponse.json({ ok: false, error: 'analysis could not be completed', extractTraceId, analyzeTraceId }, { status: 200 });

    const row = buildIpdAuditRow({
      documentId: doc.documentId,
      ipUid: doc.ipUid,
      memberId: doc.memberId,
      speciality: header?.speciality ?? null,
      dischargeType: header?.dischargeType ?? null,
      losDays: header?.losDays ?? null,
      dischargedAt: header?.dischargeDate ? `${header.dischargeDate}T00:00:00+05:30` : null,
      billedTotal,
      engineVersion: IPD_ENGINE_VERSION,
      model: GEMINI_MODEL,
      traceId: analyzeTraceId ?? null,
    }, extracted, report);
    const saved = await saveIpdAudit(row);

    // EpisodeState (#4 SL2) — additive + best-effort; never throws, never affects the audit above.
    const billing = doc.ipUid ? await fetchBillingEnvelope(doc.ipUid).catch(() => null) : null;
    const episode = await persistEpisodeState(doc.documentId, extracted, header, billing);

    const idRows = (await sql(
      `SELECT id FROM ipd_discharge_audits WHERE document_id = $1 AND engine_version = $2 LIMIT 1`,
      [doc.documentId, IPD_ENGINE_VERSION],
    )) as Array<{ id: string }>;

    return NextResponse.json({
      ok: true, saved, id: idRows[0]?.id ?? null,
      careValueIndex: row.careValueIndex, band: row.band,
      nFindings: row.nFindings, nLowValue: row.nLowValue,
      episodeState: episode ? { status: episode.status, episodeRef: episode.episodeRef } : null,
      extractTraceId, analyzeTraceId,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
