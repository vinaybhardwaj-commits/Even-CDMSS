// scripts/corpus-eval/ddi-topical-ab.mjs — DDI topical-route-leak golden A/B. THROWAWAY.
// READ-ONLY, no database, no LLM. Replays the 11,598 real stored notes from the formulary-AB cache
// through the deterministic leg of WHATEVER CODE THIS TREE HOLDS. Run ARM=old in a worktree at the
// base commit and ARM=new here; the topical-set membership is the only variable.
//
// Two effects are measured, because the topical set has TWO consumers:
//   · Ruling 1 SUPPRESSES an NSAID–NSAID pair involving a topical  → the finding disappears
//   · ddiToFinding DE-ESCALATES any pair involving a topical (BUG-0.8-12, verdict/confidence)
//     → the finding stays but penalises less
// A report that counted only removals would understate the score movement.
//
//   ARM=old|new node --env-file=.env.local --import tsx scripts/corpus-eval/ddi-topical-ab.mjs
import { createWriteStream, createReadStream, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { rowToOpdCase } from '../../lib/opd-ingest-core.ts';
import { enrichOpdMeds } from '../../lib/formulary.ts';
import { ddiFindings } from '../../lib/opd-note-audit.ts';
import { auditOpdNote } from '../../lib/opd-note-audit.ts';

const ARM = process.env.ARM || 'new';
const CACHE = process.env.CACHE || '.corpus-eval/formulary-ab/cache.jsonl';
const OUT_DIR = '.corpus-eval/ddi-topical';
const COHORT_FILE = `${OUT_DIR}/cohort.json`;
const log = (...a) => console.error(...a);
mkdirSync(OUT_DIR, { recursive: true });

// ── Pass A — census of deterministic interaction findings over every cached note ───────────────
const census = [];
let scanned = 0;
const rl = createInterface({ input: createReadStream(CACHE), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const e = JSON.parse(line);
  scanned++;
  let c;
  try { c = rowToOpdCase(e.row).case; } catch { continue; }
  enrichOpdMeds(c.medications);
  let fs;
  try { fs = ddiFindings(c.medications); } catch { continue; }
  const inter = fs.filter((f) => /^Interaction \(/.test(f.subject || ''));
  if (!inter.length) continue;
  census.push({
    uid: e.uid,
    n: inter.length,
    // subject + the two fields the de-escalation moves, so the new arm can be diffed against it
    items: inter.map((f) => ({ s: f.subject, v: f.verdict, c: f.confidence })).sort((a, b) => (a.s < b.s ? -1 : 1)),
  });
  if (scanned % 3000 === 0) log(`  [${ARM}] scanned ${scanned} · notes with an interaction ${census.length}`);
}
const totalFindings = census.reduce((s, r) => s + r.n, 0);
log(`[${ARM}] PASS A: ${scanned} scanned · ${census.length} notes carry an interaction · ${totalFindings} findings`);

// Cohort = every note carrying an interaction UNDER THE OLD LOGIC (the old arm defines it).
let cohort;
if (ARM === 'old') {
  cohort = census.map((r) => r.uid).sort();
  createWriteStream(COHORT_FILE).end(JSON.stringify(cohort, null, 2));
  log(`[old] cohort of ${cohort.length} written`);
} else {
  if (!existsSync(COHORT_FILE)) { log('FATAL: run ARM=old first'); process.exit(1); }
  cohort = JSON.parse(readFileSync(COHORT_FILE, 'utf8'));
}
const inCohort = new Set(cohort);

// ── Pass B — the REAL scorecard for the cohort, via the deterministic reuse path (no LLM) ──────
const out = createWriteStream(`${OUT_DIR}/arm-${ARM}.jsonl`);
const byUid = new Map(census.map((r) => [r.uid, r]));
let done = 0;
const rl2 = createInterface({ input: createReadStream(CACHE), crlfDelay: Infinity });
for await (const line of rl2) {
  if (!line.trim()) continue;
  const e = JSON.parse(line);
  if (!inCohort.has(e.uid)) continue;
  let audit;
  try {
    audit = await auditOpdNote(e.row, {
      trace: false, suppressions: [], quieting: { rules: [], gen: 0 },
      reuse: { llmFindings: e.llmFindings, pdqi9: e.pdqi9, suggestions: [], sources: [] },
    });
  } catch (err) { out.write(JSON.stringify({ uid: e.uid, error: String(err?.message ?? err).slice(0, 120) }) + '\n'); continue; }
  const inter = audit.findings.filter((f) => /^Interaction \(/.test(f.subject || '') && !f.informational);
  out.write(JSON.stringify({
    uid: e.uid, nqi: audit.scorecard.headline, band: audit.scorecard.band,
    interactions: inter.length,
    items: inter.map((f) => ({ s: f.subject, v: f.verdict, c: f.confidence })).sort((a, b) => (a.s < b.s ? -1 : 1)),
    censusN: byUid.get(e.uid)?.n ?? 0,
  }) + '\n');
  if (++done % 200 === 0) log(`  [${ARM}] cohort scored ${done}/${cohort.length}`);
}
await new Promise((r) => out.end(r));
createWriteStream(`${OUT_DIR}/census-${ARM}.json`).end(JSON.stringify({ scanned, notes: census.length, totalFindings, census }, null, 2));
log(`[${ARM}] DONE`);
