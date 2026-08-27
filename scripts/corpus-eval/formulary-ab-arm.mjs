// scripts/corpus-eval/formulary-ab-arm.mjs — FORMULARY-CLASS-RESOLUTION golden A/B, step 2.
// READ-ONLY (auditOpdNote reuse + no-trace; nothing persisted). Replays the SHARED cache through
// the deterministic reuse path of WHATEVER CODE THIS WORKING TREE HOLDS — run once in a worktree
// at the base commit (arm OLD) and once in the fixed tree (arm NEW); the matcher is the only
// variable. Suppressions and quieting are pinned empty so live config cannot drift between arms.
// NOT COMMITTED (outside the contract).
//
//   ARM=old|new CACHE=<path> node --env-file=.env.local --import tsx scripts/corpus-eval/formulary-ab-arm.mjs
import { createWriteStream, createReadStream, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { auditOpdNote } from '../../lib/opd-note-audit.ts';

const ARM = process.env.ARM || 'new';
const CACHE = process.env.CACHE || '.corpus-eval/formulary-ab/cache.jsonl';
const OUT = process.env.OUT || `.corpus-eval/formulary-ab/arm-${ARM}.jsonl`;
const log = (...a) => console.error(...a);
const INTERACTION_RE = /^Interaction \(/i;

async function main() {
  mkdirSync('.corpus-eval/formulary-ab', { recursive: true });
  const out = createWriteStream(OUT);
  let n = 0, errs = 0;
  const rl = createInterface({ input: createReadStream(CACHE), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    let audit;
    try {
      audit = await auditOpdNote(e.row, {
        trace: false, suppressions: [], quieting: { rules: [], gen: 0 },
        reuse: { llmFindings: e.llmFindings, pdqi9: e.pdqi9, suggestions: [], sources: [] },
      });
    } catch (err) { errs++; out.write(JSON.stringify({ uid: e.uid, error: String(err?.message ?? err).slice(0, 120) }) + '\n'); continue; }
    const active = audit.findings.filter((f) => !f.informational);
    out.write(JSON.stringify({
      uid: e.uid, storedNqi: e.storedNqi, storedBand: e.storedBand,
      nqi: audit.scorecard.headline, band: audit.scorecard.band,
      interactions: active.filter((f) => INTERACTION_RE.test(f.subject || '')).map((f) => f.subject).sort(),
      nDet: audit.findings.filter((f) => f.source === 'deterministic').length,
      nActive: active.length,
    }) + '\n');
    if (++n % 1000 === 0) log(`  [${ARM}] ${n} notes · ${errs} errors`);
  }
  await new Promise((res) => out.end(res));
  log(`[${ARM}] DONE: ${n} notes, ${errs} errors → ${OUT}`);
}
main().then(() => process.exit(0)).catch((e) => { log('FATAL', e); process.exit(1); });
