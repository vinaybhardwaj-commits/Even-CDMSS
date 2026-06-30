/**
 * lib/ccb-brief.ts — Care Conversation Brief: brief generator (WIRED).
 *
 * EpisodeBundle → two-layer, corpus-grounded CcbEnvelope. Orchestrates:
 *   1. de-identified multimodal READ of each result PDF (Gemini, Tokyo/BAA, never persisted)
 *   2. RETRIEVE corpus evidence (reranked) for the episode's clinical content
 *   3. CLINICAL pass (cite-or-label) → grounded findings (incl. surgical_indication)
 *   4. the deterministic WALL (pitchGate) → COMMERCIAL pass only when a cited indication exists
 *   5. assemble the envelope (+ retrieval manifest + grounding summary)
 *
 * Traced ('ccb_brief') with REDACTED events only (counts/verdicts) — never document text,
 * never an identifier. Soft-fails to a minimal (order-level) envelope; never throws.
 * PHI: the LLM sees only de-identified clinical content; uhid/individual_uid ride on the
 * returned envelope's member_ref for join-back, not in any model payload.
 */

import { retrieve } from './retrieve';
import { hitsToSources, buildCitedContext, type CiteHit } from './citations-core';
import { chatWithFallback, geminiModelFor, geminiUtilityModel, TEXT_MODEL } from './llm';
import { generateFromDocument, SUPPORTED_DOC_MIME } from './gemini-multimodal';
import { startTrace, logEvent, finishTrace, tracedChat, setTraceQuestionPreview } from './trace';
import {
  EXTRACT_SYSTEM, buildExtractUser, parseExtractedReport,
  CLINICAL_SYSTEM, buildClinicalUser, parseClinical,
  COMMERCIAL_SYSTEM, buildCommercialUser, parseCommercial,
  composeEpisodeText, retrievalQuery, pitchGate, buildCommercial, assembleEnvelope,
  type ExtractedReport, type CcbEnvelope, type RetrievalManifest,
} from './ccb-brief-core';
import type { EpisodeBundle, ReportDoc } from './ccb-fetch-core';

const MAX_REPORTS = 6;            // latency/cost cap per episode
const MAX_PDF_BYTES = 25 * 1024 * 1024;

function mimeFor(url: string, header: string | null): string {
  const h = (header || '').split(';')[0].trim().toLowerCase();
  if (SUPPORTED_DOC_MIME.has(h)) return h;
  const ext = (url.match(/\.([a-z0-9]{2,4})(?:\?|$)/i)?.[1] || '').toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'application/pdf';        // GCS report bodies are overwhelmingly PDF
}

/** Fetch one result PDF and read it into a de-identified ExtractedReport (null on any failure). */
async function readReport(report: ReportDoc): Promise<ExtractedReport | null> {
  try {
    const res = await fetch(report.url);
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > MAX_PDF_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_PDF_BYTES) return null;
    const mime = mimeFor(report.url, res.headers.get('content-type'));
    const raw = await generateFromDocument(EXTRACT_SYSTEM, buildExtractUser(report.kind), buf.toString('base64'), mime, {
      maxOutputTokens: 2048, temperature: 0.1,
    });
    return raw ? parseExtractedReport(raw, report.kind) : null;
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (it: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

async function generate(traceId: string | undefined, label: string, system: string, user: string): Promise<string> {
  const geminiModel = geminiModelFor('ccb') ?? geminiModelFor('doc_audit') ?? geminiUtilityModel();
  const params = {
    model: TEXT_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0.2,
    max_tokens: 2200,
    ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
  };
  if (traceId) {
    const r = await tracedChat(traceId, label, params, { gemini: geminiModel });
    return r.choices?.[0]?.message?.content || '';
  }
  const r = await chatWithFallback(params, geminiModel);
  return r.choices?.[0]?.message?.content || '';
}

export interface BriefOpts { trace?: boolean }

export async function generateBrief(bundle: EpisodeBundle, opts: BriefOpts = {}): Promise<CcbEnvelope> {
  const doTrace = opts.trace !== false;
  const traceId = doTrace
    ? await startTrace('ccb_brief', {
        coverage: bundle.coverage, nOrders: bundle.orders.length, nReports: bundle.reports.length,
        hasReferral: bundle.prescription.specialistReferral.length > 0,
      }).catch(() => undefined as string | undefined)
    : undefined;

  // 1. Read result PDFs (de-identified). order_only bundles skip this.
  const toRead = bundle.reports.slice(0, MAX_REPORTS);
  const extracted = (await mapLimit(toRead, 3, readReport)).filter(Boolean) as ExtractedReport[];
  if (traceId) await logEvent(traceId, 'ccb_reports_read', null, { requested: toRead.length, read: extracted.length });

  const episodeText = composeEpisodeText(bundle, extracted);
  const query = retrievalQuery(bundle, extracted);
  const artifactCount = 1 /* prescription */ + bundle.orders.length + extracted.length;

  try {
    // 2. Retrieve corpus evidence (reranked, source-weighted — matches Ask/DDx/OPD-audit).
    let hits: CiteHit[] = [];
    let manifest: RetrievalManifest = { ran: false, queries: [query], chunks_considered: 0, reranked: false };
    try {
      const r = await retrieve(query, { topK: 8, useReranker: true, useSourceWeights: true, hybrid: true });
      hits = r.hits.map((h) => ({
        id: h.id, source: h.source, book: h.book, chapter: h.chapter, section: h.section,
        page_start: h.page_start, page_end: h.page_end, item_number: h.item_number,
        chunk_type: h.chunk_type, similarity: h.similarity, text: h.text,
      }));
      manifest = {
        ran: true, queries: [query],
        chunks_considered: r.meta?.pool_size ?? r.meta?.fused ?? hits.length,
        reranked: r.meta?.reranked ?? true,
      };
    } catch (e) {
      console.warn('[ccb] retrieve failed', (e as Error).message);
    }
    const sources = hitsToSources(hits);
    const citedContext = buildCitedContext(hits);
    if (traceId) await logEvent(traceId, 'ccb_sources', null, { count: sources.length });

    // 3. Clinical pass (cite-or-label).
    const clinicalRaw = await generate(traceId, 'ccb_clinical', CLINICAL_SYSTEM, buildClinicalUser(episodeText, citedContext));
    const clinical = parseClinical(clinicalRaw, sources.length);

    // 4. The deterministic WALL → commercial pass only on a cited surgical indication.
    const gate = pitchGate(clinical);
    let commercialGen = null as Awaited<ReturnType<typeof parseCommercial>>;
    if (gate.allowed) {
      const citedFindings = clinical.filter((f) => gate.gatedOn.includes(f.id));
      const commRaw = await generate(traceId, 'ccb_commercial', COMMERCIAL_SYSTEM, buildCommercialUser(citedFindings));
      commercialGen = parseCommercial(commRaw);
    }
    const commercial = buildCommercial(bundle, gate, commercialGen);

    // 5. Assemble.
    const envelope = assembleEnvelope({
      traceId: traceId ?? null, bundle, clinical, commercial,
      lowValueFlags: [],            // P2: wire lib/lvc matcher; P1 surfaces cautions via clinical[]
      sources, retrieval: manifest, artifactCount,
    });

    if (traceId) {
      await setTraceQuestionPreview(traceId,
        `CCB · ${envelope.grounding_summary.citation_coverage_pct}% grounded · ${clinical.length} finding(s) · pitch ${commercial.pitch_allowed ? 'on' : 'off'}`).catch(() => {});
      await logEvent(traceId, 'ccb_result', null, {
        coverage: bundle.coverage, findings: clinical.length,
        cited: envelope.grounding_summary.corpus_cited, sources: sources.length,
        pitch_allowed: commercial.pitch_allowed, gated_on: commercial.gated_on.length, priority: commercial.priority,
      });
      await finishTrace(traceId, 'success');
    }
    return envelope;
  } catch (e) {
    if (traceId) await finishTrace(traceId, 'error', String((e as Error).message)).catch(() => {});
    // Minimal order-level envelope — never throw the brief away.
    return assembleEnvelope({
      traceId: traceId ?? null, bundle, clinical: [],
      commercial: buildCommercial(bundle, { allowed: false, gatedOn: [] }, null),
      lowValueFlags: [], sources: [],
      retrieval: { ran: false, queries: [query], chunks_considered: 0, reranked: false },
      artifactCount,
    });
  }
}
