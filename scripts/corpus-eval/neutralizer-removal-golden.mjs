// scripts/corpus-eval/neutralizer-removal-golden.mjs — NEUTRALISER REMOVAL golden set (gate item 2,
// CDMSS-NEUTRALIZER-REMOVAL-PRD-v1.0-2-AUG-2026).
// READ-ONLY. Writes NOTHING to any table. No LLM. NOT COMMITTED (outside the PRD file contract).
//
// WHAT IT MEASURES: the score movement the removal causes, per stored note. The neutraliser marked
// LLM findings informational under one of eight signal types; those findings are stored INTACT with
// their original verdict/confidence/domain. BEFORE = the stored score, reproduced from the stored
// findings (frame integrity, signal-type-collapse method). AFTER = the same note re-scored with the
// neutralised findings counted, via the ENGINE'S OWN computeOpdScore — never a re-implementation.
//
// DIRECTION FIDELITY: stampDirection's logic is unchanged for contradicted_* findings, so their
// STORED direction stands (underuse still zeroes the penalty). incoherent_with_suggestion findings
// were direction-skipped by the deleted check 2; under 0.81.19 an `underuse:`-prefixed concept_id
// yields direction 'underuse' (penalty 0) and anything else penalises (overuse and undirected
// penalise identically), so only the underuse prefix needs simulating.
//
//   node --env-file=.env.local --import tsx scripts/corpus-eval/neutralizer-removal-golden.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { sql } from '../../lib/db.ts';
import { computeOpdScore, bandFor } from '../../lib/opd-note-score-core.ts';
import { OPD_ENGINE_VERSIONS_CURRENT } from '../../lib/opd-note-audit-core.ts';

const OUT_DIR = '.corpus-eval/neutralizer-removal';
const log = (...a) => console.error(...a);

const NEUT_TYPES = new Set([
  'contradicted_medication_present', 'contradicted_investigation_absent',
  'contradicted_drug_class_absent', 'contradicted_route', 'contradicted_indication_present',
  'contradicted_history', 'contradicted_ratified_rule', 'incoherent_with_suggestion',
]);
const UNDERUSE_PREFIX_RE = /^\s*underuse\s*:/i;

// Engine default weights (opd-note-score-core); nq weight collapses to 0 when PDQI-9 absent.
const W = { documentation: 0.25, note_quality: 0.25, appropriateness: 0.20, prescribing_safety: 0.20, patient_centred: 0.10 };
function headlineFrom({ doc, nq, appr, presc, pc }, nqWeight) {
  const parts = [
    [doc, W.documentation], [nq, nqWeight], [appr, W.appropriateness],
    [presc, W.prescribing_safety], [pc, W.patient_centred],
  ];
  const wsum = parts.reduce((s, [, w]) => s + (w > 0 ? w : 0), 0) || 1;
  return Math.round(parts.reduce((s, [v, w]) => s + v * (w > 0 ? w : 0), 0) / wsum);
}
// appr/presc sub-scores are a pure function of the findings — from the real engine core.
function subScores(scoringFindings) {
  const sc = computeOpdScore({
    findings: scoringFindings.map((f) => ({ verdict: f.verdict, confidence: f.confidence, domain: f.domain, direction: f.direction })),
    completenessCoverage: 0, pdqi9: null, patientCentred: { present: 0, total: 0 },
  });
  const d = (k) => sc.domains.find((x) => x.domain === k).score;
  return { appr: d('appropriateness'), presc: d('prescribing_safety') };
}
const verTail = (v) => Number(String(v).match(/(\d+)$/)?.[1] ?? 0);

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const ENG = [...OPD_ENGINE_VERSIONS_CURRENT];
  log(`[golden] frame: current family (${ENG.length} versions) · app_source=standalone · canonical per uid`);

  const rows = [];
  let cursor = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const batch = await sql(
      `SELECT id, uid, engine_version, audited_at, doctor_uid, band, note_quality_index AS nqi, pdqi9,
              score_documentation AS d_doc, score_note_quality AS d_nq, score_appropriateness AS d_appr,
              score_prescribing_safety AS d_presc, score_patient_centred AS d_pc, findings
         FROM opd_note_audits
        WHERE app_source = 'standalone' AND engine_version = ANY($1) AND doctor_uid IS NOT NULL
          AND excluded_reason IS NULL AND id > $2
        ORDER BY id ASC LIMIT 500`, [ENG, cursor]);
    if (!batch.length) break;
    cursor = batch[batch.length - 1].id;
    rows.push(...batch);
  }
  log(`[golden] ${rows.length} stored family rows`);

  // Canonical per uid: highest numeric version tail, then latest audited_at, then id (audit-canonical rule).
  const byUid = new Map();
  for (const r of rows) {
    const prev = byUid.get(r.uid);
    if (!prev) { byUid.set(r.uid, r); continue; }
    const dv = verTail(r.engine_version) - verTail(prev.engine_version);
    if (dv > 0 || (dv === 0 && (String(r.audited_at) > String(prev.audited_at)
      || (String(r.audited_at) === String(prev.audited_at) && String(r.id) > String(prev.id))))) byUid.set(r.uid, r);
  }
  const notesAll = [...byUid.values()];
  log(`[golden] ${notesAll.length} canonical notes`);

  let notes = 0, exposed = 0, changed = 0, untrusted = 0;
  let sumAbs = 0, maxMover = null;
  const perType = {}; const bandMig = new Map(); const deltas = [];
  let resurrectedTotal = 0, resurrectedUnderuse = 0;

  for (const r of notesAll) {
    notes++;
    const findings = Array.isArray(r.findings) ? r.findings : JSON.parse(r.findings || '[]');
    const scoring = findings.filter((f) => f && f.informational !== true);
    const resurrect = findings.filter((f) => f && f.informational === true && NEUT_TYPES.has(f.signal_type));
    if (!resurrect.length) continue;
    exposed++;

    // Frame integrity: the stored sub-scores and NQI must reproduce from the stored findings.
    const base = subScores(scoring);
    const pdqi9 = Array.isArray(r.pdqi9) ? r.pdqi9 : JSON.parse(r.pdqi9 || '[]');
    const nqWeight = pdqi9.length > 0 ? W.note_quality : 0;
    const storedDomains = { doc: r.d_doc, nq: r.d_nq, appr: r.d_appr, presc: r.d_presc, pc: r.d_pc };
    const trustworthy = base.appr === Math.round(r.d_appr) && base.presc === Math.round(r.d_presc)
      && headlineFrom(storedDomains, nqWeight) === Math.round(r.nqi);
    if (!trustworthy) { untrusted++; continue; }

    const adjusted = resurrect.map((f) => {
      perType[f.signal_type] = (perType[f.signal_type] || 0) + 1;
      resurrectedTotal++;
      let direction = f.direction;
      if (f.signal_type === 'incoherent_with_suggestion') {
        direction = UNDERUSE_PREFIX_RE.test(String(f.concept_id ?? '')) ? 'underuse' : undefined;
      }
      if (direction === 'underuse') resurrectedUnderuse++;
      return { verdict: f.verdict, confidence: f.confidence, domain: f.domain, direction };
    });

    const nw = subScores([...scoring, ...adjusted]);
    const oldNqi = Math.round(r.nqi);
    const newNqi = headlineFrom({ ...storedDomains, appr: nw.appr, presc: nw.presc }, nqWeight);
    const delta = newNqi - oldNqi;
    if (delta !== 0) {
      changed++; sumAbs += Math.abs(delta); deltas.push(delta);
      const newBand = bandFor(newNqi);
      if (newBand !== r.band) bandMig.set(`${r.band}->${newBand}`, (bandMig.get(`${r.band}->${newBand}`) || 0) + 1);
      if (!maxMover || Math.abs(delta) > Math.abs(maxMover.delta)) {
        maxMover = {
          id: r.id, oldNqi, newNqi, delta, oldBand: r.band, newBand,
          resurrected: resurrect.map((f) => ({ subject: f.subject, signal_type: f.signal_type, verdict: f.verdict, confidence: f.confidence, domain: f.domain })),
        };
      }
    }
  }

  const bandChanges = [...bandMig.values()].reduce((s, n) => s + n, 0);
  const report = {
    frame: 'current-family canonical per uid, app_source=standalone, doctor_uid NOT NULL, excluded_reason IS NULL',
    notes, exposed, untrustedExcluded: untrusted,
    notesChanged: changed,
    meanAbsIndexChange_changedNotes: changed ? +(sumAbs / changed).toFixed(2) : 0,
    meanAbsIndexChange_allNotes: notes ? +(sumAbs / notes).toFixed(3) : 0,
    maxAbsIndexChange: maxMover ? Math.abs(maxMover.delta) : 0,
    bandChanges, bandMigration: Object.fromEntries([...bandMig.entries()].sort()),
    resurrectedFindings: resurrectedTotal, resurrectedUnderuseZeroPenalty: resurrectedUnderuse,
    perSignalType: perType, maxMover,
    deltaHistogram: deltas.reduce((h, d) => { const k = String(d); h[k] = (h[k] || 0) + 1; return h; }, {}),
  };
  writeFileSync(`${OUT_DIR}/golden-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
