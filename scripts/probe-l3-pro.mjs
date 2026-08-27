// scripts/probe-l3-pro.mjs — ONE QUESTION ONLY:
// does the PRODUCTION pipeline raise a safety finding when a note documents a penicillin
// allergy and prescribes amoxicillin?
//
//   node --env-file=.env.local --import tsx scripts/probe-l3-pro.mjs
//
// Differences from scripts/metamorphic-llm-report.mjs:
//   1. PRODUCTION pipeline. `mini` is `opts.pipeline === 'mini'` (opd-note-audit.ts:1046), so the
//      production path is simply NOT passing the option. Nothing else changes.
//   2. L-3 only. 6 audits, not 18.
//   3. Records EVERY finding subject, not just the ones the matcher accepted. The 1 Aug run could
//      not tell us what the engine DID find, only what it did not.
//   4. Prints the actual prompt text the model received, so we can prove the allergy line reached it.
//   5. Writes under experiment `mm-llm-l3-pro`, so it never mixes with the mini rows in `mm-llm-l3`.
//
// This does NOT write to opd_note_audits. It calls auditOpdNote and saveLabAnalysis only —
// no saveOpdAudit, no stored audit row, no score anywhere. Read-only as far as production is
// concerned.
import { PART_C_RELATIONS } from '../lib/metamorphic-core.ts';
import { auditOpdNote } from '../lib/opd-note-audit.ts';
import { rowToOpdCase, opdCaseText } from '../lib/opd-ingest-core.ts';
import { ensureLabTables, saveLabAnalysis } from '../lib/lab.ts';

const RUNS_PER_ARM = 3;
const rel = PART_C_RELATIONS.find((r) => r.id === 'L-3');
if (!rel) throw new Error('L-3 not found in PART_C_RELATIONS');

await ensureLabTables();

const arms = {
  base: rel.baseRow,
  transformed: rel.transform(structuredClone(rel.baseRow)),
};

// ── Step 0: prove the allergy reaches the prompt at all ───────────────────────
console.log('='.repeat(78));
console.log('STEP 0 — what the model actually receives');
console.log('='.repeat(78));
for (const [arm, row] of Object.entries(arms)) {
  const { case: oc } = rowToOpdCase(row);
  const text = opdCaseText(oc);
  const allergyLine = text.split('\n').find((l) => /^Allergies documented:/.test(l));
  console.log(`\n[${arm}] oc.allergies = ${JSON.stringify(oc.allergies)}`);
  console.log(`[${arm}] prompt allergy line: ${allergyLine ? `PRESENT → "${allergyLine}"` : 'ABSENT — the model is never told'}`);
  const meds = oc.medications.map((m) => m.generic_name || m.name || JSON.stringify(m)).join(', ');
  console.log(`[${arm}] medications: ${meds}`);
}

// ── Steps 1..6: run the production pipeline ───────────────────────────────────
const results = [];
for (const [arm, row] of Object.entries(arms)) {
  for (let run = 1; run <= RUNS_PER_ARM; run++) {
    const started = Date.now();
    let findings = [];
    let error = null;
    try {
      // PRODUCTION PIPELINE — `pipeline` deliberately omitted.
      const audit = await auditOpdNote(row, { trace: false });
      findings = audit.findings ?? [];
    } catch (e) {
      error = String(e?.message ?? e).slice(0, 300);
    }
    const ms = Date.now() - started;

    const safetyFired = findings.some((f) => f.domain === 'prescribing_safety'
      && /allerg|penicillin|amoxicillin/i.test(`${f.subject} ${f.rationale}`)
      && f.informational !== true);
    const anyAllergyMention = findings.some((f) =>
      /allerg|penicillin|amoxicillin/i.test(`${f.subject} ${f.rationale}`));
    const praise = findings.some((f) => f.signal_type === 'appropriateness_high_value'
      || (f.domain === 'appropriateness' && f.verdict === 'high-value'));

    // EVERY finding, not just matches — this is what the 1 Aug run could not show us.
    const allFindings = findings.map((f) => ({
      subject: f.subject, domain: f.domain, verdict: f.verdict,
      signal_type: f.signal_type, informational: f.informational === true,
    }));

    results.push({ arm, run, safetyFired, anyAllergyMention, praise, n: findings.length, ms, error });

    console.log(`\n--- ${arm} run ${run} — ${ms} ms${error ? ` — ERROR: ${error}` : ''}`);
    console.log(`    safety finding about the allergy : ${safetyFired ? 'YES' : 'NO'}`);
    console.log(`    ANY finding mentioning it        : ${anyAllergyMention ? 'YES' : 'NO'}`);
    console.log(`    praise present                   : ${praise ? 'YES' : 'NO'}`);
    console.log(`    all ${findings.length} findings:`);
    for (const f of allFindings) {
      console.log(`      · [${f.domain}/${f.verdict}${f.informational ? '/informational' : ''}] ${f.subject}`);
    }

    try {
      await saveLabAnalysis({
        experiment: 'mm-llm-l3-pro', kind: 'opd_note', engine: 'mm-llm-leg-pro',
        inputRef: null,
        inputPreview: `L-3 ${arm} run ${run} — PRODUCTION pipeline (synthetic fixture, no db13 uid)`,
        output: { relation: 'L-3', arm, run, pipeline: 'production',
                  safetyFired, anyAllergyMention, praise, error, allFindings },
        latencyMs: ms,
      });
    } catch (e) { console.error(`    ! lab write failed (${e?.message}) — probe continues`); }
  }
}

// ── Verdict ───────────────────────────────────────────────────────────────────
const t = results.filter((r) => r.arm === 'transformed');
const hits = t.filter((r) => r.safetyFired).length;
const soft = t.filter((r) => r.anyAllergyMention).length;

console.log(`\n${'='.repeat(78)}`);
console.log('VERDICT — production pipeline, transformed arm (penicillin allergy + amoxicillin)');
console.log('='.repeat(78));
console.log(`  safety finding raised     : ${hits}/${RUNS_PER_ARM}`);
console.log(`  any mention of the allergy: ${soft}/${RUNS_PER_ARM}`);
console.log(`  errors                    : ${results.filter((r) => r.error).length}/${results.length}`);
console.log('');
if (hits === RUNS_PER_ARM) {
  console.log('  → PRO CATCHES IT RELIABLY. The gap is the projection, not the engine.');
} else if (hits > 0) {
  console.log(`  → PRO CATCHES IT ${hits}/${RUNS_PER_ARM} — NON-DETERMINISTIC. Not a safety net.`);
} else {
  console.log('  → PRO MISSES IT TOO. The engine has no allergy capability. Bigger than a projection line.');
}
console.log(`\nJSON: ${JSON.stringify(results)}`);
