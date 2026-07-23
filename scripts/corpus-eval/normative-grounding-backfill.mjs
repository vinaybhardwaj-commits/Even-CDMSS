#!/usr/bin/env node
/**
 * scripts/corpus-eval/normative-grounding-backfill.mjs — deterministic POST-HOC normative grounding
 * over STORED OPD audits. For each low-value finding it attaches CW (category-gated) + guideline
 * (τ-gated) citations. It NEVER recomputes or writes a verdict/score/band/lvc_category — additive only
 * (a finding's citation_ids + the note's sources array). NO LLM, no reranker: vector cosine only.
 *
 *   normative-grounding-backfill.mjs --mode dryrun [--limit N]   # NO DB WRITE — matches + prints stats
 *   normative-grounding-backfill.mjs --mode apply  [--limit N]   # additive UPDATE (idempotent, fail-safe)
 *
 * Run: node --env-file=.env.local --import tsx scripts/corpus-eval/normative-grounding-backfill.mjs --mode dryrun --limit 200
 */
import { sql } from '../../lib/db.ts';
import { groundFinding } from '../../lib/normative-grounding.ts';
import { attachNormativeCitations, isGroundableFinding, CW_SOURCE, GUIDELINE_SOURCES, NORMATIVE_TAU } from '../../lib/normative-grounding-core.ts';

const run = sql;
const APP = process.env.APP_SOURCE || 'standalone';
const ENGINE = process.env.OPD_ENGINE_VERSION_PIN || 'opd-note-audit/0.81.12';   // stored prod engine (pin via env if needed)
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const mode = arg('mode', 'dryrun');
const LIMIT = Math.max(1, Math.min(5000, parseInt(arg('limit', '200'), 10) || 200));

// INFERRED read: notes with ≥1 low-value finding, bounded. findings/sources are jsonb columns.
const READ_SQL = `SELECT uid, findings, sources
  FROM opd_note_audits
  WHERE app_source = $1 AND engine_version = $2 AND excluded_reason IS NULL
    AND findings @> '[{"verdict":"low-value"}]'
  ORDER BY uid
  LIMIT $3`;

// INFERRED apply: additive UPDATE of the two jsonb columns ONLY. No score column (note_quality_index,
// band, score_*) is named — a guard against ever writing one.
const APPLY_SQL = `UPDATE opd_note_audits SET findings = $1::jsonb, sources = $2::jsonb
  WHERE uid = $3 AND engine_version = $4 AND excluded_reason IS NULL`;

const pct = (a) => { const s = [...a].sort((x, y) => x - y); const q = (p) => s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; return { n: s.length, p10: q(0.1), median: q(0.5), p90: q(0.9) }; };

async function main() {
  console.error(`[normative-grounding] mode=${mode} limit=${LIMIT} engine=${ENGINE} τ=${NORMATIVE_TAU}`);
  console.error(`  CW source='${CW_SOURCE}' (category-gated) · guideline sources=${JSON.stringify(GUIDELINE_SOURCES)} (τ-gated) · vector cosine only, NO LLM`);
  let rows;
  try { rows = await run(READ_SQL, [APP, ENGINE, LIMIT]); }
  catch (e) { console.error('READ failed:', String(e.message || e).slice(0, 200)); process.exit(1); }
  console.error(`[normative-grounding] ${rows.length} notes with low-value findings`);

  const perCat = {};   // lvc_category → { findings, grounded_cw, grounded_gl }
  const cwSims = [], glSims = [];
  let notesUpdated = 0, citationsAdded = 0, errored = 0;

  for (const row of rows) {
    try {
      const findings = Array.isArray(row.findings) ? row.findings : JSON.parse(row.findings || '[]');
      const sources = Array.isArray(row.sources) ? row.sources : JSON.parse(row.sources || '[]');
      const perFinding = new Array(findings.length).fill(null).map(() => []);
      for (let i = 0; i < findings.length; i++) {
        const f = findings[i];
        if (!isGroundableFinding(f)) continue;
        const cat = String(f.lvc_category || 'other');
        perCat[cat] ??= { findings: 0, grounded_cw: 0, grounded_gl: 0 };
        perCat[cat].findings++;
        const g = await groundFinding(f);   // soft-fails to no citation, never throws
        if (g.cw) { perCat[cat].grounded_cw++; if (g.cw.similarity != null) cwSims.push(g.cw.similarity); }
        if (g.guideline) { perCat[cat].grounded_gl++; if (g.guideline.similarity != null) glSims.push(g.guideline.similarity); }
        perFinding[i] = g.citations;
      }
      const attached = attachNormativeCitations(findings, sources, perFinding);
      if (attached.added > 0) {
        citationsAdded += attached.added;
        notesUpdated++;
        if (mode === 'apply') {
          await run(APPLY_SQL, [JSON.stringify(attached.findings), JSON.stringify(attached.sources), row.uid, ENGINE]);
        }
      }
    } catch (e) {
      errored++;
      console.error(`  note ${row.uid} skipped: ${String(e.message || e).slice(0, 120)}`);
    }
  }

  console.log('\n=== coverage by lvc_category (grounded = ≥1 citation attached) ===');
  for (const [cat, c] of Object.entries(perCat).sort((a, b) => b[1].findings - a[1].findings)) {
    console.log(`  ${cat.padEnd(26)} findings ${String(c.findings).padStart(5)}  CW ${String(c.grounded_cw).padStart(5)}  guideline ${String(c.grounded_gl).padStart(5)}`);
  }
  console.log('\ncosine distribution (accepted): CW', JSON.stringify(pct(cwSims)), ' guideline', JSON.stringify(pct(glSims)));
  console.log(`\n${mode === 'apply' ? 'APPLIED' : 'DRY-RUN (no write)'}: notes with new citations ${notesUpdated} · citations added ${citationsAdded} · errored ${errored}`);
  console.log('additive only — no verdict/score/band/lvc_category written.' + (mode === 'apply' ? '' : ' Re-run with --mode apply to write.'));
}
main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', String(e.message || e)); process.exit(1); });
