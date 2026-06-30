/**
 * lib/ccb-store.ts — persist + read Care Conversation Briefs (Neon `ccb_briefs`).
 *
 * Maps a de-identified CcbEnvelope → one presc_uid-keyed row. Idempotent insert
 * (ON CONFLICT (presc_uid, engine_version) DO NOTHING) — the table is its own watermark.
 * The re-identification keys (presc_uid/individual_uid/uhid/kx_encounter_id) live here only
 * for join-back + the P5 conversion funnel; they are never in the stored envelope's model path.
 */

import { sql } from './db';
import type { CcbEnvelope } from './ccb-brief-core';
import type { EpisodeKeys } from './ccb-fetch-core';

export interface SaveBriefMeta { model?: string | null; latencyMs?: number | null }

/** Insert one brief. Returns 'inserted' | 'exists' (already generated at this engine version) | 'skipped'. */
export async function saveBrief(env: CcbEnvelope, keys: EpisodeKeys, meta: SaveBriefMeta = {}): Promise<'inserted' | 'exists' | 'skipped'> {
  if (!keys.prescUid) return 'skipped';
  const gs = env.grounding_summary;
  const rows = (await sql(
    `INSERT INTO ccb_briefs
       (presc_uid, individual_uid, uhid, kx_encounter_id, note_date, coverage,
        engine_version, priority, pitch_allowed,
        n_findings, n_cited, citation_coverage_pct, distinct_sources,
        envelope, model, trace_id, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6, $7,$8,$9, $10,$11,$12,$13, $14::jsonb,$15,$16,$17)
     ON CONFLICT (presc_uid, engine_version) DO NOTHING
     RETURNING id`,
    [
      keys.prescUid, keys.individualUid, keys.kxUhid, keys.kxEncounterId, keys.noteDate, env.episode.coverage,
      env.engine_version, env.commercial.priority, env.commercial.pitch_allowed,
      gs.findings, gs.corpus_cited, gs.citation_coverage_pct, gs.distinct_sources,
      JSON.stringify(env), meta.model ?? null, env.trace_id ?? null, meta.latencyMs ?? null,
    ],
  )) as Array<{ id: string }>;
  return rows.length ? 'inserted' : 'exists';
}

/** Latest stored envelope for a prescription at an engine version (P1 read-through cache). */
export async function getBriefByUid(prescUid: string, engineVersion: string): Promise<CcbEnvelope | null> {
  const rows = (await sql(
    `SELECT envelope FROM ccb_briefs WHERE presc_uid = $1 AND engine_version = $2 ORDER BY created_at DESC LIMIT 1`,
    [prescUid, engineVersion],
  )) as Array<{ envelope: CcbEnvelope }>;
  return rows[0]?.envelope ?? null;
}
