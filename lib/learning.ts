/**
 * lib/learning.ts — wired layer for the OPD-audit → CDMSS learning loop (LL.1 / LL.2-v1).
 *
 * Loads recent OPD audit findings from Neon, runs the pure miner (lib/learning-core), and
 * upserts candidate rule PROPOSALS into the `learning_proposals` review queue. Plus review
 * (approve/reject) helpers. Everything stays in the queue — applying an approved proposal to
 * `lvc_recommendations` is a separate, gated step (LL.2b, after matcher tests). Nothing here
 * mutates the live audit engine, the corpus, or lvc_recommendations.
 */
import { sql } from './db';
import { chatWithFallback, geminiUtilityModel, TEXT_MODEL } from './llm';
import {
  mineRuleCandidates, DEFAULT_THRESHOLDS, isMineableFinding,
  CANONICALIZE_SYSTEM, buildCanonicalizeUser, parseCanonicalMap,
  type AuditRowLite, type MineThresholds,
} from './learning-core';

const APP = process.env.APP_SOURCE || 'standalone';
const sql2 = sql as unknown as (q: string, p: unknown[]) => Promise<Record<string, unknown>[]>;

function asArr<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === 'string' && v.trim()) { try { const p = JSON.parse(v); return Array.isArray(p) ? p as T[] : []; } catch { return []; } }
  return [];
}

/** Latest audit per note (DISTINCT ON uid) over the lookback window — avoids cross-engine-version double counting. */
export async function loadRecentAuditRows(days = 90): Promise<AuditRowLite[]> {
  const rows = await sql2(
    `SELECT DISTINCT ON (uid) id, doctor_uid, consult_type, findings, sources
       FROM opd_note_audits
      WHERE app_source = $1 AND note_date >= NOW() - ($2 || ' days')::interval
      ORDER BY uid, audited_at DESC`,
    [APP, String(Math.max(1, Math.min(365, days)))],
  );
  return rows.map((r) => ({
    id: String(r.id),
    doctor_uid: r.doctor_uid == null ? null : String(r.doctor_uid),
    consult_type: r.consult_type == null ? null : String(r.consult_type),
    findings: asArr(r.findings),
    sources: asArr(r.sources),
  }));
}

/** Flash-canonicalise distinct finding subjects → { subject: canonical practice label }.
 *  Batched (a handful of cheap Flash calls), soft-fails per batch so a Flash outage just falls
 *  back to deterministic-signature clustering — never breaks the mining run. */
async function canonicalizeBatch(batch: string[]): Promise<Record<string, string>> {
  try {
    const r = await chatWithFallback({
      model: TEXT_MODEL,
      messages: [
        { role: 'system', content: CANONICALIZE_SYSTEM },
        { role: 'user', content: buildCanonicalizeUser(batch) },
      ],
      temperature: 0,
      max_tokens: 4000,
      ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
    }, geminiUtilityModel());
    return parseCanonicalMap(r.choices?.[0]?.message?.content || '', batch);
  } catch (e) {
    console.warn('[learning] canonicalize batch failed', (e as Error).message);
    return {};
  }
}

export async function canonicalizeSubjects(subjects: string[]): Promise<Record<string, string>> {
  const B = 100;
  const batches: string[][] = [];
  for (let i = 0; i < subjects.length; i += B) batches.push(subjects.slice(i, i + B));
  // PARALLEL — a capped, bounded set of batches (see caller) so the whole run finishes well
  // within the function limit; sequential batching risked blowing 300s on full data.
  const parts = await Promise.all(batches.map(canonicalizeBatch));
  const map: Record<string, string> = {};
  for (const p of parts) Object.assign(map, p);
  return map;
}

export interface MineSummary { scanned: number; subjects: number; canonicalized: number; candidates: number; inserted: number; refreshed: number }

/** Mine recent audits → upsert candidate rule proposals (proposed-only refresh; rejected/approved left alone). */
export async function mineAndSaveProposals(days = 90, thresholds: MineThresholds = DEFAULT_THRESHOLDS, useCanonical = true): Promise<MineSummary> {
  const rows = await loadRecentAuditRows(days);

  // LL.2: canonicalise the distinct mineable subjects so paraphrases merge before clustering.
  // Cap to the top-N most frequent subjects (bounds the parallel Flash batches so the run finishes
  // well within the function limit). The dropped long-tail singletons fall back to the deterministic
  // signature in the miner — they can't form a ≥15 cluster anyway, so nothing material is lost.
  const counts = new Map<string, number>();
  for (const row of rows) for (const f of row.findings || []) if (isMineableFinding(f) && f.subject) counts.set(f.subject, (counts.get(f.subject) || 0) + 1);
  const subjects = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300).map(([s]) => s);
  const labelMap = useCanonical && subjects.length ? await canonicalizeSubjects(subjects) : {};
  const canonicalLabel = Object.keys(labelMap).length ? (s: string) => labelMap[s] || '' : undefined;

  const cands = mineRuleCandidates(rows, thresholds, { canonicalLabel });
  let inserted = 0; let refreshed = 0;
  for (const c of cands) {
    const res = (await sql`
      INSERT INTO learning_proposals
        (app_source, type, status, cluster_key, title, payload, evidence, provenance, confidence, n_support, suggested_reviewer)
      VALUES (${APP}, ${c.type}, 'proposed', ${c.clusterKey}, ${c.title},
        ${JSON.stringify(c.payload)}::jsonb, ${JSON.stringify(c.evidence)}::jsonb, ${JSON.stringify(c.provenance)}::jsonb,
        ${c.confidence}, ${c.provenance.nOccurrences}, ${c.suggestedReviewer})
      ON CONFLICT (type, cluster_key) DO UPDATE SET
        title = EXCLUDED.title, payload = EXCLUDED.payload, evidence = EXCLUDED.evidence,
        provenance = EXCLUDED.provenance, confidence = EXCLUDED.confidence,
        n_support = EXCLUDED.n_support, suggested_reviewer = EXCLUDED.suggested_reviewer, updated_at = NOW()
        WHERE learning_proposals.status = 'proposed'
      RETURNING (xmax = 0) AS inserted`) as Array<{ inserted: boolean }>;
    if (res.length) { if (res[0].inserted) inserted++; else refreshed++; }
  }
  return { scanned: rows.length, subjects: subjects.length, canonicalized: Object.keys(labelMap).length, candidates: cands.length, inserted, refreshed };
}

/** Approve or reject a proposal (status only — apply-to-lvc is the gated LL.2b step). */
export async function reviewProposal(id: string, action: 'approve' | 'reject', reviewer: string | null, note: string | null): Promise<boolean> {
  const status = action === 'approve' ? 'approved' : 'rejected';
  const rows = (await sql`
    UPDATE learning_proposals
       SET status = ${status}, reviewed_by = ${reviewer}, reviewed_at = NOW(), review_note = ${note}, updated_at = NOW()
     WHERE id = ${id} AND app_source = ${APP} AND status = 'proposed'
     RETURNING id`) as Array<{ id: string }>;
  return rows.length > 0;
}
