// scripts/corpus-eval/incomplete-dosing-ab.mjs — INCOMPLETE-DOSING-PRECISION golden A/B.
// READ-ONLY, no database, no LLM. THROWAWAY (not committed).
//
// Replays REAL stored db13 note rows (the cache built for the formulary A/B: 11,598 canonical
// production notes with their stored LLM findings + PDQI-9) through the deterministic leg of
// WHATEVER CODE THIS WORKING TREE HOLDS. Run once in a worktree at the base commit (ARM=old) and
// once in the fixed tree (ARM=new); the gap logic is the only variable.
//
// Pass A (cheap, whole corpus): prescribingChecks per note → incomplete_dosing finding census.
// Pass B (the 50-note cohort):  auditOpdNote reuse path → the REAL scorecard, so the NQI delta comes
//                               from computeOpdScore and finalize(), never a re-implementation.
//
//   ARM=old|new node --env-file=.env.local --import tsx scripts/corpus-eval/incomplete-dosing-ab.mjs
import { createWriteStream, createReadStream, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { rowToOpdCase } from '../../lib/opd-ingest-core.ts';
import { enrichOpdMeds } from '../../lib/formulary.ts';
import { prescribingChecks } from '../../lib/opd-note-audit-core.ts';
import { auditOpdNote } from '../../lib/opd-note-audit.ts';

const ARM = process.env.ARM || 'new';
const CACHE = process.env.CACHE || '.corpus-eval/formulary-ab/cache.jsonl';
const OUT_DIR = '.corpus-eval/incomplete-dosing';
const COHORT_FILE = `${OUT_DIR}/cohort.json`;
const COHORT_N = 50;
const log = (...a) => console.error(...a);
const DOSING_RE = /^Incomplete dosing: /;

mkdirSync(OUT_DIR, { recursive: true });

// ── Pass A — census over every cached note ────────────────────────────────────────────────────
const census = [];   // { uid, n, gaps: string[][] }
const rl = createInterface({ input: createReadStream(CACHE), crlfDelay: Infinity });
let scanned = 0;
for await (const line of rl) {
  if (!line.trim()) continue;
  const e = JSON.parse(line);
  scanned++;
  let c;
  try { c = rowToOpdCase(e.row).case; } catch { continue; }
  enrichOpdMeds(c.medications);
  let fs;
  try { fs = prescribingChecks(c); } catch { continue; }
  const dosing = fs.filter((f) => DOSING_RE.test(f.subject || ''));
  if (!dosing.length) continue;
  census.push({
    uid: e.uid,
    n: dosing.length,
    gaps: dosing.map((f) => {
      const m = (f.rationale || '').match(/^Missing ([^—]+?)\s*—/);
      return m ? m[1].split(',').map((s) => s.trim()) : [];
    }),
  });
  if (scanned % 3000 === 0) log(`  [${ARM}] scanned ${scanned} · notes with incomplete_dosing ${census.length}`);
}
const totalFindings = census.reduce((s, r) => s + r.n, 0);
log(`[${ARM}] PASS A: ${scanned} notes scanned · ${census.length} carry incomplete_dosing · ${totalFindings} findings`);

// ── The cohort: the FIRST 50 by uid among notes carrying incomplete_dosing UNDER THE OLD LOGIC.
// The old arm writes it; the new arm reads the identical list, so both arms score the same notes.
let cohort;
if (ARM === 'old') {
  cohort = census.map((r) => r.uid).sort().slice(0, COHORT_N);
  const fs2 = createWriteStream(COHORT_FILE); fs2.write(JSON.stringify(cohort, null, 2)); fs2.end();
  log(`[old] cohort of ${cohort.length} written to ${COHORT_FILE}`);
} else {
  if (!existsSync(COHORT_FILE)) { log('FATAL: run ARM=old first — the cohort is defined by the OLD logic'); process.exit(1); }
  cohort = JSON.parse(readFileSync(COHORT_FILE, 'utf8'));
}
const inCohort = new Set(cohort);

// ── Pass B — the real scorecard for the cohort, via the deterministic reuse path (no LLM) ─────
const byUid = new Map(census.map((r) => [r.uid, r]));
const out = createWriteStream(`${OUT_DIR}/arm-${ARM}.jsonl`);
const rl2 = createInterface({ input: createReadStream(CACHE), crlfDelay: Infinity });
let done = 0;
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
  const dosing = audit.findings.filter((f) => DOSING_RE.test(f.subject || '') && !f.informational);
  out.write(JSON.stringify({
    uid: e.uid, nqi: audit.scorecard.headline, band: audit.scorecard.band,
    dosingFindings: dosing.length,
    dosingSubjects: dosing.map((f) => f.subject).sort(),
    censusN: byUid.get(e.uid)?.n ?? 0,
  }) + '\n');
  if (++done % 10 === 0) log(`  [${ARM}] cohort scored ${done}/${cohort.length}`);
}
await new Promise((r) => out.end(r));

const censusOut = createWriteStream(`${OUT_DIR}/census-${ARM}.json`);
censusOut.write(JSON.stringify({ scanned, notesWithDosing: census.length, totalFindings, census }, null, 2));
censusOut.end();
log(`[${ARM}] DONE — census-${ARM}.json + arm-${ARM}.jsonl`);
