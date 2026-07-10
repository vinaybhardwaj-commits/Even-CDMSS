/**
 * lib/ccb-extract-cache.ts — CCB v2 P1: per-document extract cache, WIRED half.
 *
 * A finalized result PDF never changes, so its de-identified extract is immutable and has no TTL.
 * Caching it turns a `fresh=1` regenerate from N multimodal PDF reads into 0–N (only new docs).
 *
 * Keyed by `docSha(url)` — the hash, not the URL. The stored value is the already-de-identified
 * `ExtractedReport` (the extractor strips name/uhid/mobile); same PHI posture as the envelope.
 *
 * FAIL-SAFE: a read error is a MISS (regenerate), a write error is a skipped persist. Never throws.
 */

import { sql } from './db';
import { docSha } from './ccb-extract-cache-core';
import type { ExtractedReport } from './ccb-brief-core';

/** Cached extract for this exact URL, or null on miss / corrupt row / read error. */
export async function getExtract(url: string): Promise<ExtractedReport | null> {
  try {
    const rows = (await sql(
      `SELECT extract FROM ccb_doc_extract WHERE doc_sha = $1`,
      [docSha(url)],
    )) as Array<{ extract: unknown }>;

    let v = rows[0]?.extract;
    if (v === undefined || v === null) return null;
    if (typeof v === 'string') {
      try { v = JSON.parse(v); } catch { return null; }
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    return v as ExtractedReport;
  } catch {
    return null;
  }
}

/** Persist an extract. Immutable: first write wins (`ON CONFLICT DO NOTHING`). Never throws. */
export async function putExtract(url: string, extract: ExtractedReport, model?: string | null): Promise<void> {
  try {
    await sql(
      `INSERT INTO ccb_doc_extract (doc_sha, extract, model)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (doc_sha) DO NOTHING`,
      [docSha(url), JSON.stringify(extract), model ?? null],
    );
  } catch {
    // Cache persist is best-effort; the brief has already been read successfully.
  }
}
