/**
 * lib/opd-note-audit.ts — OPD note-quality audit ORCHESTRATOR (server).
 *
 * One de-identified OPD note → grounded LLM analyze (findings + PDQI-9 + suggestions)
 * + deterministic completeness + prescribing checks → OPD Note-Quality scorecard.
 * Traced ('opd_note_audit') so model/provider/tokens/latency land in observability.
 * Soft-fails. The full PHI record stays in db13; only de-identified content reaches the LLM.
 */

import { retrieve, resolveNormativeSources, type RetrieveOptions } from './retrieve';
import { hitsToSources, buildCitedContext, type CiteHit, type Source } from './citations-core';
import { startTrace, logEvent, finishTrace, governedChat, setTraceQuestionPreview } from './trace';
import { geminiModelFor, geminiUtilityModel, TEXT_MODEL, MINI_MODEL, AUDIT_LLM_SEED } from './llm';
import { rowToOpdCase, opdCaseText, type OpdKeys, type OpdMed, type DeidOpdCase } from './opd-ingest-core';
import {
  opdCompleteness, prescribingChecks, parseOpdAnalysis, stampFindingIdentity,
  consolidateDecisions, neutralizeMetadataFindings, resolveMedRoute,
  neutralizeScreeningContext, isHealthCheckEncounter,
  NSAID_MOLECULES, MUSCLE_RELAXANT_MOLECULES, medHasMoleculeFrom,
  OPD_AUDIT_SYSTEM, buildOpdAuditUser, OPD_ENGINE_VERSION,
  type OpdFinding, type OpdCompleteness, type OpdSuggestion,
} from './opd-note-audit-core';
import { computeOpdScore, type OpdScorecard, type NetValue, type Pdqi9Attr } from './opd-note-score-core';
import { enrichOpdMeds } from './formulary';
import { doseFindings } from './dose-limits';
import { parseDurationDays } from './dose-aggregation-core';
import { tagInteractions, DDI_MECHANISM_CITATIONS } from './ddi-tags';
import type { FindingProvenance } from './provenance-tier-core';
import { curatedInteractions, mergeRank, type DrugClass } from './ddi';
import type { DdiPair } from './rxlabelguard';
import { applySuppressions, applyDemotes, type Suppression } from './audit-suppression-core';
import { loadActiveSuppressions, loadQuietingConfig } from './audit-suppression-store';
import { stampLvcMetadata, type LvcRuleLite } from './opd-lvc-classify-core';
import { bandFor, type ComplexityBand, type ComplexityInputs } from './opd-complexity-core';
import { bannedFdcFindings } from './cdsco-banned-fdc';
import { fetchPatientHistoryBundle } from './metabase';
import { sql } from './db';
import { buildLongitudinalInput, type LongitudinalNoteInput } from './opd-longitudinal-core';   // Stage 3 (opd-longitudinal/0.1)
// Pure, dependency-free helper (lab-batch-core imports nothing, so this cannot form a cycle).
import { remainingBudgetMs } from './lab-batch-core';

// Best-effort cache of active suppressions (Tier-1 self-heal) so the per-note audit doesn't re-read
// the table each time. Short TTL; a fresh suppression takes effect within a minute. Empty = no-op.
let _suppCache: { at: number; list: Suppression[] } | null = null;
async function getActiveSuppressions(): Promise<Suppression[]> {
  const now = Date.now();
  if (_suppCache && now - _suppCache.at < 60_000) return _suppCache.list;
  try { const list = await loadActiveSuppressions(); _suppCache = { at: now, list }; return list; }
  catch { return _suppCache?.list ?? []; }
}

// Quieting (demote) config — PRD CDMSS-QUIETING-DEMOTE-SYSTEM. Same discipline as getLvcRules:
// 5-min cache + 2s-timeout race. FAIL-SAFE IS LOAD-BEARING (PRD §4): any error ⇒ { rules: [], gen: 0 }
// — the audit scores UN-quieted with gen 0 and a logged warning; quieting config can never block,
// fail, or over-quiet an audit.
export interface QuietingConfig { rules: Suppression[]; gen: number }
let _quietCache: { at: number; cfg: QuietingConfig } | null = null;
async function getQuietingConfig(): Promise<QuietingConfig> {
  const now = Date.now();
  if (_quietCache && now - _quietCache.at < 300_000) return _quietCache.cfg;
  try {
    const cfg = await Promise.race([
      loadQuietingConfig(),
      new Promise<QuietingConfig>((_, rej) => setTimeout(() => rej(new Error('quieting config timeout')), 2000)),
    ]);
    _quietCache = { at: now, cfg };
    return cfg;
  } catch (e) {
    console.warn('[opd-audit] quieting config unavailable — scoring un-quieted at gen 0', (e as Error).message);
    return _quietCache?.cfg ?? { rules: [], gen: 0 };
  }
}

// B4 — the treating clinician's real specialty (doctor_directory), so a specialist's note is judged
// against that specialty's standards, not GP defaults. Small table → cache the whole map (60s TTL).
const _dirRun = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
let _specCache: { at: number; map: Record<string, string> } | null = null;
async function doctorSpecialtyFor(doctorUid: string | null): Promise<string | null> {
  if (!doctorUid) return null;
  const now = Date.now();
  if (!_specCache || now - _specCache.at >= 60_000) {
    try {
      const rows = await _dirRun(`SELECT doctor_uid, speciality FROM doctor_directory WHERE speciality IS NOT NULL`, []);
      const map: Record<string, string> = {};
      for (const r of rows) map[String(r.doctor_uid)] = String(r.speciality);
      _specCache = { at: now, map };
    } catch { if (!_specCache) return null; }
  }
  return _specCache.map[doctorUid] || null;
}

// 0.81.4 (decision 14): the LVC keyword matcher needs the active lvc_recommendations (id, keywords,
// category) at stamp time. The LLM prompt doesn't load them, so this is the ONE audit-path read the
// PRD §7b authorises — cached (5m) + 2s-timeout fail-safe; no rules → stamp rule_ref:null, never block.
let _lvcRulesCache: { at: number; rules: LvcRuleLite[] } | null = null;
function parseKeywords(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === 'string') {
    try { const j = JSON.parse(v); if (Array.isArray(j)) return j.map((x) => String(x)); } catch { /* not json */ }
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}
async function getLvcRules(): Promise<LvcRuleLite[]> {
  const now = Date.now();
  if (_lvcRulesCache && now - _lvcRulesCache.at < 300_000) return _lvcRulesCache.rules;
  try {
    const rows = await Promise.race([
      _dirRun(`SELECT id, keywords, category FROM lvc_recommendations WHERE status = 'active'`, []),
      new Promise<Record<string, unknown>[]>((_, rej) => setTimeout(() => rej(new Error('lvc rules timeout')), 2000)),
    ]);
    const rules: LvcRuleLite[] = (rows as Record<string, unknown>[]).map((r) => ({
      id: String(r.id), keywords: parseKeywords(r.keywords), category: r.category == null ? null : String(r.category),
    }));
    _lvcRulesCache = { at: now, rules };
    return rules;
  } catch { return _lvcRulesCache?.rules ?? []; }
}

// Formulary match types reliable enough to drive a deterministic safety alert (an approximate
// brand-prefix match can drop a molecule from a combination, so it informs display only).
const CONFIDENT_MATCH = new Set(['source-generic', 'brand-exact', 'embedded-generic', 'brand-token']);

function ddiToFinding(p: DdiPair, topical?: Set<string>): OpdFinding {
  const sev = p.severity;
  // BUG-0.8-12 route-awareness: a TOPICAL NSAID has low systemic absorption, so an "additive
  // systemic toxicity" overlap with an oral drug is materially milder — never escalate it.
  const involvesTopical = !!topical && (topical.has(p.drug_a.toLowerCase()) || topical.has(p.drug_b.toLowerCase()));
  const verdict: NetValue = involvesTopical
    ? 'context-dependent'
    : (sev === 'contraindicated' || sev === 'major' ? 'low-value' : 'context-dependent');
  const confidence = involvesTopical ? 0.5
    : (sev === 'contraindicated' ? 0.9 : sev === 'major' ? 0.8 : sev === 'moderate' ? 0.6 : 0.4);
  const topicalNote = involvesTopical ? ' A topically-applied NSAID has low systemic absorption, so the additive systemic (GI/renal) risk is minimal.' : '';
  // Deterministic-Citations (§7 / V3): the MECHANISM is corpus-verified where the rule is a
  // Stage-1-verified class rule; severity is never cited. A mechanism not in the map (curated pair)
  // is marked internally-derived. Additive metadata — never enters scoring.
  const cite = DDI_MECHANISM_CITATIONS[p.mechanism];
  const provenance: FindingProvenance = cite ? { citation: cite, derivation: 'external' } : { citation: null, derivation: 'llm' };
  return {
    subject: `Interaction (${sev}): ${p.drug_a} + ${p.drug_b}`,
    verdict, confidence, domain: 'prescribing_safety',
    rationale: `${p.mechanism} ${p.recommendation}${topicalNote}`.trim(),
    evidence: [], estimates: [], citation_ids: [], source: 'deterministic',
    provenance,
  };
}

/** Formulary-scoped, deterministic DDIs over the CONFIDENTLY-resolved drugs on the script. */
export function ddiFindings(meds: OpdMed[]): OpdFinding[] {
  // BUG-0.8-10 (Q): include a med if it is confidently formulary-matched OR it carries an NSAID
  // ingredient anywhere in its composition (formulary-independent) — so a combination/topical whose
  // parsed primary is a non-NSAID (e.g. Methyl Salicylate) still counts as an NSAID for the overlap.
  const items: DrugClass[] = meds
    .filter((m) => (m.resolvedGeneric && m.formularyMatch && CONFIDENT_MATCH.has(m.formularyMatch)) || medHasMoleculeFrom(m, NSAID_MOLECULES))
    .map((m) => ({
      name: m.resolvedGeneric || m.generic || m.brand || 'medication',
      major: medHasMoleculeFrom(m, NSAID_MOLECULES) ? 'NSAID' : (m.therapeuticClass || ''),
      minor: m.subClass || '',
    }));
  if (items.length < 2) return [];
  // route-aware: molecules applied topically on THIS script (low systemic absorption).
  const topical = new Set(
    meds.filter((m) => resolveMedRoute(m) === 'topical' && (m.resolvedGeneric || m.generic))
        .map((m) => (m.resolvedGeneric || m.generic as string).toLowerCase()));
  // Ruling 1 (0.81.14, CLINICAL-RULINGS §2.1): an NSAID–NSAID additive-toxicity overlap where ANY
  // member resolves to a topical route is routine practice (topical diclofenac ~6% oral systemic
  // bioavailability; we capture neither quantity nor BSA, so the at-risk group is unidentifiable) —
  // SUPPRESS ENTIRELY (was de-escalated to context-dependent, BUG-0.8-12). Restricted to NSAID–NSAID:
  // a topical NSAID + an oral non-NSAID (e.g. an anticoagulant) is a real interaction and still fires.
  const nsaidNames = new Set(items.filter((i) => i.major === 'NSAID').map((i) => i.name.toLowerCase()));
  const pairs = mergeRank([...tagInteractions(items), ...curatedInteractions(items.map((i) => i.name))]);
  return pairs
    .filter((p) => {
      const involvesTopical = topical.has(p.drug_a.toLowerCase()) || topical.has(p.drug_b.toLowerCase());
      const bothNsaid = nsaidNames.has(p.drug_a.toLowerCase()) && nsaidNames.has(p.drug_b.toLowerCase());
      return !(involvesTopical && bothNsaid);
    })
    .map((p) => ddiToFinding(p, topical));
}

/** BUG-0.8-11 (R): the muscle-relaxant-FDC appropriateness objection was LLM-generated, so its
 *  presence and tier swung run-to-run on identical scripts. Determinise it into a fixed-tier
 *  (context-dependent) advisory; the prompt tells the LLM not to raise its own volatile version,
 *  and consolidateDecisions drops any LLM muscle-relaxant finding that slips through. */
export function muscleRelaxantFindings(meds: OpdMed[], ctx?: { mskDocumented?: boolean }): OpdFinding[] {
  // Ruling 4 (0.81.14, CLINICAL-RULINGS §2.3): a muscle relaxant WITH documented musculoskeletal
  // context is a legitimate prescription — fire only when NONE is documented. MEASURED: 598/658
  // (90.9%) already document it. ctx is OPTIONAL; omitting it reproduces prior behaviour exactly
  // (undefined !== true → fires). Same ctx-threading pattern as isGout (0.81.13).
  if (ctx?.mskDocumented === true) return [];
  const mr = meds.filter((m) => medHasMoleculeFrom(m, MUSCLE_RELAXANT_MOLECULES));
  if (!mr.length) return [];
  const names = Array.from(new Set(mr.map((m) => m.resolvedGeneric || m.generic || m.brand || 'muscle relaxant')));
  return [{
    subject: 'Muscle relaxant prescribed — document the indication',
    verdict: 'context-dependent', confidence: 0.5, domain: 'appropriateness',
    rationale: `A muscle relaxant (${names.join(', ')}) has limited evidence as first-line therapy for most musculoskeletal pain / tendinopathy; it is reasonable when muscle spasm is documented. Fixed-tier deterministic finding (replaces the run-to-run-inconsistent LLM objection).`,
    evidence: [], estimates: [], citation_ids: [], source: 'deterministic',
    // 0.81.10 (SIGNAL-TYPE-COLLAPSE S1): this is a documentation-completeness PROMPT, not a
    // care-quality judgement. Surfaced but NON-SCORING (informational) — it must not penalise the
    // note-quality index — and classified deterministic_completeness (signal_type muscle_relaxant_indication).
    informational: true,
  }];
}

// ── 0.81.8 bug 1 — unindicated XANTHINE bronchodilator for an ACUTE URTI ──────────────────────────────
// Deterministic appropriateness backstop, context-GUARDED: fires only for a clear acute upper-respiratory
// presentation and NEVER for a chronic-airways patient (J40–J47 / asthma / COPD), where a xanthine is
// legitimate maintenance. A miss the LLM made inconsistently → determinised (↓appropriateness).
// 0.81.13 (PRD CDMSS-PHARMACY-ROUND1): the antihistamine+montelukast leg was RETIRED (Decision 11 — it
// fired on allergic-rhinitis maintenance, standard care) and the xanthine subject/rationale relabelled
// (Decision 3 — the "mucolytic" claim misdescribed the trigger list, which is xanthines only).
// 0.81.14 (Ruling 12, CLINICAL-RULINGS §2.4): 'acebrophylline' REMOVED — it reads as a secretolytic/
// mucokinetic (covered by the round-1 mucolytic endorsement), and 100% of this rule's output was
// Acebrophylline + Acetylcysteine. The rule becomes DORMANT, not dead: the true xanthine bronchodilators
// remain and would fire if genuinely prescribed for an acute URTI. ACUTE_URTI_RE is unchanged.
const XANTHINE_MOLECULES = ['theophylline', 'doxophylline', 'doxofylline', 'bamifylline', 'etofylline', 'aminophylline', 'choline theophyllinate', 'deriphyllin'];
// ANTIHISTAMINE_MOLECULES was deleted with the montelukast rule (PRD CDMSS-PHARMACY-ROUND1 Decision 11
// — RETIRED entirely; it fired on allergic-rhinitis maintenance, standard care). No live reference remains.
const ACUTE_URTI_RE = /\b(urti|upper respiratory|common cold|coryza|nasopharyngitis|rhinitis|rhinorrho?ea|running nose|sore throat|throat pain|pharyngitis|tonsillitis|viral fever|viral (?:uri|illness)|cough and cold|acute (?:cough|cold))\b/i;
const ACUTE_URTI_ICD = /^J0[0-6]|^J1[01]/i;
const CHRONIC_RESP_RE = /\b(asthma|copd|chronic obstructive|chronic bronchitis|emphysema|bronchiectasis|interstitial lung|reactive airway|\bild\b)\b/i;
const CHRONIC_RESP_ICD = /^J4[0-7]/i;
const uniq = (a: string[]): string[] => Array.from(new Set(a));

function detAppr(subject: string, confidence: number, rationale: string): OpdFinding {
  return { subject, verdict: 'low-value', confidence, domain: 'appropriateness', rationale, evidence: [], estimates: [], citation_ids: [], source: 'deterministic' };
}

export function unindicatedRespFindings(oc: DeidOpdCase): OpdFinding[] {
  const hay = [oc.reasonForConsult || '', ...oc.presentingComplaints, ...oc.impressions, ...oc.history].join(' ');
  const codes = [...oc.diagnosisCodes, ...oc.impressionCodes].map((c) => c.trim());
  const isAcuteUrti = ACUTE_URTI_RE.test(hay) || codes.some((c) => ACUTE_URTI_ICD.test(c));
  const isChronicResp = CHRONIC_RESP_RE.test(hay) || codes.some((c) => CHRONIC_RESP_ICD.test(c));
  if (!isAcuteUrti || isChronicResp) return [];                          // context guard (Decision 4)
  const out: OpdFinding[] = [];
  const xanthines = oc.medications.filter((m) => medHasMoleculeFrom(m, XANTHINE_MOLECULES));
  if (xanthines.length) {
    const names = uniq(xanthines.map((m) => m.resolvedGeneric || m.generic || m.brand || 'xanthine bronchodilator'));
    out.push(detAppr(`Xanthine bronchodilator not indicated for an acute URTI: ${names.join(', ')}`, 0.6,
      `A xanthine bronchodilator (${names.join(', ')}) has no established role in an uncomplicated acute upper-respiratory infection (a self-limiting viral illness) — reserve it for obstructive airways disease. Deterministic appropriateness backstop; a chronic-airways context (asthma/COPD, J40–J47) is excluded.`));
  }
  // Decision 11 — the antihistamine+montelukast leg is RETIRED (not thresholded): it fired on
  // allergic-rhinitis maintenance (standard care), and ACUTE_URTI_RE captures `rhinitis`. The LLM leg
  // covers antihistamine_allergy (~150/wk). No finding is emitted for that combination at any duration.
  return out;
}

// ── 0.81.8 bug 3 — topical nasal decongestant used too long (rhinitis medicamentosa) ──────────────────
// Ingredient-level (catches FDCs / brand-only lines via the resolved composition); duration parsed from
// the med line by the shared parseDurationDays. 0.81.13 (Decision 4, Khatija Q14): two tiers — >15 days
// (higher severity: septal thinning / dependence) and >7 && <=15 days (rebound congestion); <=7 days or
// an unparseable duration emits NOTHING (was >5). The prior "3–5 day cap" wording is superseded here.
const NASAL_DECONGESTANT_MOLECULES = ['oxymetazoline', 'xylometazoline', 'naphazoline', 'xylometazolin', 'oxymetazolin'];
// parseDurationDays is the single shared parser (defined in the pure dose core, PRD §3.1); re-exported
// here so its existing export surface and importers are preserved.
export { parseDurationDays };
export function decongestantDurationFindings(meds: OpdMed[]): OpdFinding[] {
  const out: OpdFinding[] = [];
  for (const m of meds) {
    if (!medHasMoleculeFrom(m, NASAL_DECONGESTANT_MOLECULES)) continue;
    const days = parseDurationDays(m.duration);
    if (days === null || days <= 7) continue;                        // Decision 4: <=7 days or unparseable → no finding
    const name = m.resolvedGeneric || m.generic || m.brand || 'topical nasal decongestant';
    const highSeverity = days > 15;
    out.push({
      subject: `Topical nasal decongestant prescribed for ${days} days: ${name}`,
      verdict: 'low-value', confidence: highSeverity ? 0.85 : 0.7, domain: 'prescribing_safety',
      rationale: highSeverity
        ? `An imidazoline nasal decongestant (${name}) used for ${days} days — beyond 15 days risks nasal septal thinning and dependence. Ingredient-level deterministic check.`
        : `An imidazoline nasal decongestant (${name}) used for ${days} days exceeds the 7-day cap — prolonged use causes rebound congestion (rhinitis medicamentosa). Ingredient-level deterministic check.`,
      evidence: [], estimates: [], citation_ids: [], source: 'deterministic',
    });
  }
  return out;
}

// ── 0.81.14 Ruling 13 (CLINICAL-RULINGS §2.5) — Vitamin D weekly-repletion duration ───────────────────
// INFORMATIONAL prompt (non-scoring) when weekly 60,000 IU runs beyond 8 weeks — the standard repletion
// course. NOT a dose ceiling (0 of 1,199 60k prescriptions were on a daily grid) and NOT a frequency
// rule. Fires ONLY when composition is vitamin D3/cholecalciferol AND strength is 60,000/60k AND weekly
// is stated AND parseDurationDays(duration) > 56 (8 weeks). LOAD-BEARING FAIL-SAFE: an unparseable
// duration emits NOTHING — several clinicians write the correct extended protocol as free text
// ("8 weeks followed by once a month for 4 months") which does not parse; they stay silent by design.
// Do NOT extend parseDurationDays to capture them.
const VITAMIN_D_RE = /(vitamin ?d3?|cholecalciferol|calciferol)/i;
export function vitaminDRepletionFindings(meds: OpdMed[]): OpdFinding[] {
  const out: OpdFinding[] = [];
  for (const m of meds) {
    const comp = `${m.resolvedGeneric || ''} ${m.generic || ''} ${m.brand || ''}`;
    if (!VITAMIN_D_RE.test(comp)) continue;                                            // (1) vitamin D composition
    const strengthHay = `${m.strength || ''} ${m.dose || ''} ${comp}`;
    if (!/60[ ,]?000|60k/i.test(strengthHay)) continue;                                // (2) 60,000 IU strength
    if (!/week/i.test(`${m.frequency || ''} ${m.instruction || ''}`)) continue;        // (3) weekly dosing stated
    const days = parseDurationDays(m.duration);
    if (days === null || days <= 56) continue;                                         // (4) > 8 weeks; unparseable → silent
    const weeks = Math.round(days / 7);
    out.push({
      subject: `Vitamin D 60,000 IU weekly prescribed for ${weeks} weeks — document retest of levels`,
      verdict: 'uncertain', confidence: 0, domain: 'prescribing_safety',
      rationale: `Weekly 60,000 IU for 8 weeks is standard repletion once low levels are established, followed by a retest. This course runs ${weeks} weeks. Confirm levels were rechecked or that extended/maintenance dosing is intended. Informational — non-scoring.`,
      evidence: [], estimates: [], citation_ids: [], source: 'deterministic',
      informational: true,
    });
  }
  return out;
}

// ── 0.81.14 Rulings 5–8 (CLINICAL-RULINGS §2.7) — Possible-pregnancy verification advisory ────────────
// The system's first pregnancy-safety capability (register A-9). INFORMATIONAL (non-scoring), framed as
// VERIFY — never as an assertion that a pregnant patient was harmed. Fires when the LMP interval is in
// [36, 90] days AND a trigger molecule is present. NSAIDs are deliberately EXCLUDED (third-trimester-
// specific risk; a recorded LMP cannot establish trimester). No age gate. FAIL-SAFE: no LMP / unparseable
// LMP / interval outside 36–90 → nothing (absence of data must never accuse). ctx (the pre-computed LMP
// interval) is OPTIONAL and threaded from the orchestrator — same pattern as isGout / mskDocumented.
const PREGNANCY_CONTRA_MOLECULES = ['isotretinoin', 'acitretin', 'tretinoin', 'methotrexate', 'misoprostol', 'warfarin', 'valproate', 'divalproex'];
const PREGNANCY_CAUTION_MOLECULES = ['doxycycline', 'minocycline', 'tetracycline', 'ofloxacin', 'levofloxacin', 'ciprofloxacin', 'norfloxacin', 'moxifloxacin', 'enalapril', 'ramipril', 'lisinopril', 'telmisartan', 'losartan', 'olmesartan', 'valsartan', 'fluconazole'];
/** Days between an LMP string and the visit date; null when either is absent/unparseable (fail-safe → no
 *  finding). Parses ISO-like dates only; an unrecognised format degrades to silence, never a wrong flag. */
export function lmpIntervalDays(lmp: string | null | undefined, visitDate: string | null | undefined): number | null {
  if (!lmp || !visitDate) return null;
  const l = new Date(lmp), v = new Date(visitDate);
  if (isNaN(l.getTime()) || isNaN(v.getTime())) return null;
  const days = Math.floor((v.getTime() - l.getTime()) / 86_400_000);
  return isFinite(days) ? days : null;
}
export function pregnancyRiskFindings(meds: OpdMed[], ctx?: { lmpIntervalDays?: number | null }): OpdFinding[] {
  const interval = ctx?.lmpIntervalDays;
  if (interval == null || interval < 36 || interval > 90) return [];                   // possible-pregnancy window only
  const out: OpdFinding[] = [];
  for (const m of meds) {
    const contra = PREGNANCY_CONTRA_MOLECULES.find((n) => medHasMoleculeFrom(m, [n]));
    const caution = contra ? null : PREGNANCY_CAUTION_MOLECULES.find((n) => medHasMoleculeFrom(m, [n]));
    if (!contra && !caution) continue;
    const drug = m.resolvedGeneric || m.generic || m.brand || (contra || caution)!;
    const phrase = contra ? 'contraindicated in' : 'used with caution in';
    out.push({
      subject: `Possible pregnancy — verify status before ${drug}`,
      verdict: 'uncertain', confidence: 0, domain: 'prescribing_safety',
      rationale: `LMP was ${interval} days before this visit, so pregnancy cannot be excluded. ${drug} is ${phrase} pregnancy. Confirm pregnancy status was established before prescribing. Informational — non-scoring.`,
      evidence: [], estimates: [], citation_ids: [], source: 'deterministic',
      informational: true,
    });
  }
  return out;
}

// ── 0.81.14 Ruling 4 (CLINICAL-RULINGS §2.3) — musculoskeletal-context predicate (for muscle relaxant) ─
// Computed in the orchestrator over the SAME haystack unindicatedRespFindings builds; an M-code (any
// musculoskeletal ICD) also counts. Exported for testability.
const MSK_CONTEXT_RE = /\b(back pain|neck pain|spasm|myalgia|muscle|sprain|strain|lumbar|cervical|spondyl|sciatic|shoulder|knee pain|joint pain|stiff|musculoskeletal|body ?ache)\b/i;
export function mskContextDocumented(oc: DeidOpdCase): boolean {
  const hay = [oc.reasonForConsult || '', ...oc.presentingComplaints, ...oc.impressions, ...oc.history].join(' ');
  const codes = [...oc.diagnosisCodes, ...oc.impressionCodes].map((c) => c.trim());
  return MSK_CONTEXT_RE.test(hay) || codes.some((c) => /^M/i.test(c));
}

// ── 0.81.8 bug 8 — route/formulation-aware duplication ───────────────────────────────────────────────
// Two products sharing a molecule are NOT a therapeutic duplicate when they are applied differently: a
// wash-off cleanser + a leave-on gel (e.g. benzoyl peroxide face wash + gel), or a topical + a systemic
// form. Drop the deterministic duplicate finding in those cases (the co-prescription is intentional).
const WASHOFF_RE = /\b(face\s?wash|cleanser|cleansing bar|shampoo|\bsoap\b|body wash|\bwash\b)\b/i;
const LEAVEON_RE = /\b(cream|ointment|\bgel\b|lotion|serum|emollient|paste|patch|\bung\b)\b/i;
function applicationForm(m: OpdMed): 'washoff' | 'leaveon' | null {
  const hay = `${m.brand || ''} ${m.generic || ''} ${m.instruction || ''} ${m.dose || ''}`;
  if (WASHOFF_RE.test(hay)) return 'washoff';
  if (LEAVEON_RE.test(hay)) return 'leaveon';
  return null;
}
export function dedupeRouteAware(findings: OpdFinding[], meds: OpdMed[]): OpdFinding[] {
  const molOf = (m: OpdMed) => (m.resolvedGeneric || m.generic || '').toLowerCase();
  return findings.filter((f) => {
    if (f.source !== 'deterministic') return true;
    let mol: string | null = null;
    if (/^duplicate prescription:/i.test(f.subject)) mol = f.subject.replace(/^duplicate prescription:\s*/i, '').trim().toLowerCase();
    else if (/^same molecule in \d+ products?/i.test(f.subject)) { const c = f.subject.lastIndexOf(':'); mol = c >= 0 ? f.subject.slice(c + 1).trim().toLowerCase() : null; }
    if (!mol) return true;
    const sharing = meds.filter((m) => { const g = molOf(m); if (!g) return false; return g === mol || g.split(/[+/,]/).map((t) => t.trim()).includes(mol); });
    if (sharing.length < 2) return true;                                  // can't resolve the products → keep the finding
    const routes = new Set(sharing.map((m) => resolveMedRoute(m) || 'unknown'));
    if (routes.has('topical') && (routes.has('oral') || routes.has('parenteral'))) return false;   // topical + systemic → intentional
    const forms = new Set(sharing.map(applicationForm).filter(Boolean));
    if (forms.has('washoff') && forms.has('leaveon')) return false;       // wash-off + leave-on → not a duplicate
    return true;
  });
}

export interface OpdNoteAudit {
  keys: OpdKeys;
  scorecard: OpdScorecard;
  completeness: OpdCompleteness;
  findings: OpdFinding[];
  suggestions: OpdSuggestion[];
  sources: Source[];
  engineVersion: string;
  traceId?: string;
  /** Quieting policy generation this audit was scored under (Q1). 0 = no quieting policy (also the
   *  fail-safe when config is unreachable). Persisted on the audit row (quieting_gen). */
  quietingGen?: number;
  // Right Care case-mix complexity (0.81.3). Computed at audit time from db13 history; NULL band on
  // any fetch failure (never blocks the audit). Persisted on the audit row; excluded from O/E when null.
  complexity?: { band: ComplexityBand | null; inputs: ComplexityInputs | null } | null;
  // Stage 3 (opd-longitudinal/0.1) — the de-identified note projection the post-persistence longitudinal
  // pass consumes. NOT persisted by saveOpdAudit (ignored by its fixed column list); attached only when
  // OPD_LONGITUDINAL_ENABLED=1 (or opts.longitudinal for replay) and never for the mini pipeline, so
  // flag-off the returned audit is byte-identical to today.
  longitudinalInput?: LongitudinalNoteInput | null;
}

/**
 * The retrieve() opts for the OPD audit citation retrieval. R-11 Stage 2 (DORMANT): the normative
 * leg is added ONLY when OPD_NORMATIVE_LEG_ENABLED === '1' AND this is not the mini path — otherwise
 * the `useNormativeLeg` key is ABSENT, so the opts are byte-identical to today and no stored
 * note_quality_index can move. The flag is off in every environment until Phase 0/2 clear it.
 * Pure (env injectable) so the flag-off byte-identity is unit-testable without a DB.
 */
export function opdRetrieveOpts(mini: boolean, env: Record<string, string | undefined> = process.env, evalNormativeLeg?: boolean): RetrieveOptions {
  // Lab eval override (Phase 2): evalNormativeLeg forces the leg ON regardless of env/mini. Absent/false
  // ⇒ today's gate exactly (env==='1' && !mini), so with NO eval config the opts are byte-identical.
  const useNormativeLeg = evalNormativeLeg === true || (env.OPD_NORMATIVE_LEG_ENABLED === '1' && !mini);
  return { topK: 8, useReranker: true, useSourceWeights: true, hybrid: true, ...(useNormativeLeg ? { useNormativeLeg: true } : {}) };
}

async function defaultRetrieve(q: string, mini = false, evalNormativeLeg?: boolean): Promise<CiteHit[]> {
  try {
    const r = await retrieve(q, opdRetrieveOpts(mini, process.env, evalNormativeLeg));
    return r.hits.map((h) => ({
      id: h.id, source: h.source, book: h.book, chapter: h.chapter, section: h.section,
      page_start: h.page_start, page_end: h.page_end, item_number: h.item_number,
      chunk_type: h.chunk_type, similarity: h.similarity, text: h.text,
    }));
  } catch (e) {
    console.warn('[opd-audit] retrieve failed', (e as Error).message);
    return [];
  }
}

// ── R-11 fix candidate: ADDITIVE normative channel (LAB EVAL ONLY) ────────────────
// Phase 2 proved the normative LEG (union) is harmful on the scoring path: ~4 CW chunks evict the
// literature excerpts the audit substantiates low-value findings with (S1 low-value 67→7, NQI +15).
// The CHANNEL keeps the 8 literature excerpts BYTE-IDENTICAL and appends the CW statements as a
// separate labelled block [9+] the model can cite — additive, never by eviction.

/** Statements the channel appends (kept small; the block adds context, it must not crowd it). */
export const NORMATIVE_CHANNEL_K = 4;

/** The channel's standalone CW-only retrieve opts — the shipped restrictSources shape (source =
 *  ANY(normativeSources), min-sim floor via retrieve's default, LIMIT K). skipExpand: the note query
 *  is already a keyword bundle and the lit retrieve pays the expansion; the CW search is exact +
 *  deterministic (matches the REV-5 measurement rig). Pure — exported for tests. */
export function normativeChannelOpts(env: Record<string, string | undefined> = process.env): RetrieveOptions {
  return {
    topK: NORMATIVE_CHANNEL_K,
    restrictSources: resolveNormativeSources(undefined, env.NORMATIVE_LEG_SOURCES),
    useReranker: false, useSourceWeights: false, hybrid: false, skipExpand: true,
  };
}

/** Standalone normative retrieve for the channel. Fail-safe: any error ⇒ [] (the audit proceeds on
 *  literature alone — the channel can only ADD, never degrade). */
async function normativeChannelRetrieve(q: string): Promise<CiteHit[]> {
  try {
    const r = await retrieve(q, normativeChannelOpts());
    return r.hits.map((h) => ({
      id: h.id, source: h.source, book: h.book, chapter: h.chapter, section: h.section,
      page_start: h.page_start, page_end: h.page_end, item_number: h.item_number,
      chunk_type: h.chunk_type, similarity: h.similarity, text: h.text,
    }));
  } catch (e) {
    console.warn('[opd-audit] normative channel retrieve failed', (e as Error).message);
    return [];
  }
}

/** The additive block's framing. Lives in the USER-message context only — OPD_AUDIT_SYSTEM is frozen. */
export const NORMATIVE_CHANNEL_HEADER =
  'NORMATIVE REFERENCES — professional-society recommendations (Choosing Wisely / guidelines). ' +
  'Advisory "avoid/don\'t" statements to CITE when a finding matches. They ADD to the evidence above ' +
  'and do not replace it. Do NOT withhold or downgrade a finding because a normative reference is ' +
  'terse or because guidance exists.';

/** Render the normative block, numbering continuing from the literature excerpts. Pure. */
export function buildNormativeBlock(normHits: CiteHit[], startN: number, perChunkChars = 700): string {
  if (!normHits.length) return '';
  const lines = normHits.map((h, i) => {
    const society = String(h.book ?? h.source ?? 'guideline').trim() || 'guideline';
    const body = String(h.text ?? '').replace(/\s+/g, ' ').trim().slice(0, perChunkChars);
    return `[${startN + i}] ${body} — ${society}`;
  });
  return `${NORMATIVE_CHANNEL_HEADER}\n${lines.join('\n')}`;
}

/** Assemble the audit context. No normative hits ⇒ EXACTLY today's assembly (byte-identical).
 *  With normative hits ⇒ literature [1..n] UNCHANGED, then the labelled block [n+1..] appended, and
 *  the sources list extended so citation_ids into the block resolve for display. Pure. */
export function assembleAuditContext(litHits: CiteHit[], normHits: CiteHit[]): { sources: Source[]; citedContext: string } {
  if (!normHits.length) {
    return { sources: hitsToSources(litHits), citedContext: buildCitedContext(litHits) };
  }
  const litN = Math.min(litHits.length, 8);   // buildCitedContext/hitsToSources cap the lit block at 8
  return {
    sources: hitsToSources([...litHits.slice(0, litN), ...normHits], litN + normHits.length),
    citedContext: `${buildCitedContext(litHits)}\n\n${buildNormativeBlock(normHits, litN + 1)}`,
  };
}

/** Fixed thinking/reasoning budget for the eval body (Audit-Determinism §8d, lever 3): Gemini 2.5's
 *  VARIABLE thinking is a hidden variance source, so the OpenRouter reasoning budget is pinned to a
 *  constant. Eval-only. Env-overridable for the A/B sweep. */
export const AUDIT_EVAL_THINKING_BUDGET = Number(process.env.AUDIT_EVAL_THINKING_BUDGET) || 4096;

/** EVAL-ONLY (lab): the OpenRouter chat body. Determinism config (Audit-Score-Determinism PRD §8d —
 *  LAB/EVAL PATH ONLY; the production defaultGenerate params are untouched this phase):
 *   - temperature 0 + top_p 1 + a fixed `seed` (AUDIT_LLM_SEED) — greedy, canonical, seed-pinned so
 *     re-runs are reproducible IF Gemini honors the seed (exactly what Phase 1 measures).
 *   - `reasoning.max_tokens` fixed (lever 3) — pin 2.5's variable thinking budget.
 *   - `provider: { allow_fallbacks:false, require_parameters:true }` (lever 4) — no cross-backend
 *     fallback, and route ONLY to a provider that honors the passed params (seed/top_p), so A/B
 *     re-runs hit one seed-respecting backend.
 *  Pure — exported for tests. */
export function buildOpenRouterBody(model: string, system: string, user: string): Record<string, unknown> {
  return {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0,
    top_p: 1,
    seed: AUDIT_LLM_SEED,
    reasoning: { max_tokens: AUDIT_EVAL_THINKING_BUDGET },
    provider: { allow_fallbacks: false, require_parameters: true },
  };
}

/** Bounded retry for the eval path: 3 tries total, retrying ONLY transient statuses (429/5xx) with
 *  jittered exponential backoff (~0.5s/1s/2s × [0.5,1.5)). A non-transient status or the final
 *  failure throws loudly — never a silent fallback. */
export const OPENROUTER_MAX_TRIES = 3;
export function openRouterRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}
export function openRouterBackoffMs(attempt: number, rand: () => number = Math.random): number {
  return Math.round(500 * 2 ** (attempt - 1) * (0.5 + rand()));   // attempt 1 → ~250-750ms, 2 → ~500-1500ms
}

/**
 * EVAL-ONLY (lab): fetch deadline (PDQI-9 fail-loud PRD D4). With no timeout a hung request never
 * throws and never returns — it takes the whole tick down, which we watched happen. Fail-loud is
 * UNOBSERVABLE if a call can hang forever, so this is a precondition for D2 rather than a request-
 * shape variable: it only converts "hangs" into "throws".
 *
 * ⚠️ 300_000 → 110_000 (Eval-tick-deadline PRD D4). At 110s per attempt, three attempts plus backoff
 * fit inside the 240s tick deadline — so a note can still exhaust its retry budget WITHIN one tick
 * and record its envelope, which is the whole point of the probe. At 300s a single attempt outlived
 * the tick, so the retry budget could never be spent before the invocation was killed.
 */
export const OPENROUTER_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS) || 110_000;

/**
 * The response envelope OpenRouter already returns and this code has always discarded (§R2).
 * `finish_reason` is the discriminator the 20-note probe reads: 'length' ⇒ the pinned reasoning
 * budget consumed the output and an explicit completion `max_tokens` is the fix; anything else ⇒ a
 * different fault and the request shape is not the cause.
 */
export interface LlmEnvelope {
  finish_reason?: string | null;
  native_finish_reason?: string | null;
  provider?: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; reasoning_tokens?: number } | null;
  content_length: number;
  attempt: number;
}

/**
 * The empty-content failure message. NORMATIVE (PRD §4) — this string IS the instrumentation.
 *
 * It must carry the whole envelope because on failure NO `lab_analyses` ROW EXISTS: the tick summary
 * in `app_settings.lab_batch_last` is the only surviving record of what went wrong. Exported so the
 * shape is asserted by test rather than trusted.
 */
export function emptyContentErrorMessage(env: LlmEnvelope, maxTries: number = OPENROUTER_MAX_TRIES): string {
  const v = (x: unknown) => (x == null || x === '' ? 'null' : String(x));
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? String(x) : 'null');
  return `OpenRouter returned EMPTY CONTENT (HTTP 200) — treated as failure, not as an unassessed note.
finish_reason=${v(env.finish_reason)} native_finish_reason=${v(env.native_finish_reason)} provider=${v(env.provider)} attempt=${env.attempt}/${maxTries}
usage: prompt=${n(env.usage?.prompt_tokens)} completion=${n(env.usage?.completion_tokens)} reasoning=${n(env.usage?.reasoning_tokens)} content_length=${env.content_length}`;
}

/**
 * The tick-deadline failure message. NORMATIVE (Eval-tick-deadline PRD §4) — like
 * `emptyContentErrorMessage`, this string IS the instrumentation: no `lab_analyses` row is written
 * for a deadline-hit note, so the tick summary in `app_settings.lab_batch_last` is the only record.
 *
 * `env` is the LAST envelope seen on this note, or null when the deadline was already blown before
 * attempt 1 (nothing has come back off the wire yet) — every field then reads `null`, which is
 * itself the signal that the note never got a response.
 */
export function deadlineErrorMessage(attempt: number, maxTries: number, env: LlmEnvelope | null): string {
  const v = (x: unknown) => (x == null || x === '' ? 'null' : String(x));
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? String(x) : 'null');
  return `TICK DEADLINE reached before attempt ${attempt}/${maxTries} — abandoning this note so the tick can report.
The uid is NOT marked done and will be retried next tick.
last envelope: finish_reason=${v(env?.finish_reason)} native_finish_reason=${v(env?.native_finish_reason)} provider=${v(env?.provider)} content_length=${n(env?.content_length)}`;
}

/** The stable prefix of `deadlineErrorMessage`. The tick counts `deadline_hits` with it, so it is
 *  defined ONCE here beside the builder rather than duplicated as a literal in `lab-batch.ts`. */
export const DEADLINE_ERROR_PREFIX = 'TICK DEADLINE reached before attempt ';

/** True when a per-note error string came from the tick deadline. Pure and total. */
export function isDeadlineErrorMessage(msg: unknown): boolean {
  return typeof msg === 'string' && msg.startsWith(DEADLINE_ERROR_PREFIX);
}

/**
 * Read the envelope off a parsed OpenRouter response. PURE and TOTAL — any shape yields a defined
 * envelope, so capture can never be the thing that fails.
 *
 * ⚠️ INFERRED SHAPE, FLAGGED: OpenRouter documents reasoning tokens as
 * `usage.completion_tokens_details.reasoning_tokens`, but some providers surface a flat
 * `usage.reasoning_tokens`. BOTH are read, flat first. If the probe comes back with
 * `reasoning=null` while `completion` is populated, this is the line to check — not the model.
 */
export function readLlmEnvelope(j: unknown, attempt: number, contentLength: number): LlmEnvelope {
  const o = (j ?? {}) as {
    choices?: { finish_reason?: unknown; native_finish_reason?: unknown }[];
    provider?: unknown;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; reasoning_tokens?: unknown;
              completion_tokens_details?: { reasoning_tokens?: unknown } };
  };
  const c0 = Array.isArray(o.choices) ? o.choices[0] : undefined;
  const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
  const u = o.usage;
  return {
    finish_reason: c0?.finish_reason == null ? null : String(c0.finish_reason),
    native_finish_reason: c0?.native_finish_reason == null ? null : String(c0.native_finish_reason),
    provider: o.provider == null ? null : String(o.provider),
    usage: u
      ? {
        prompt_tokens: num(u.prompt_tokens),
        completion_tokens: num(u.completion_tokens),
        reasoning_tokens: num(u.reasoning_tokens) ?? num(u.completion_tokens_details?.reasoning_tokens),
      }
      : null,
    content_length: contentLength,
    attempt,
  };
}

/** EVAL-ONLY (lab): generate one audit via OpenRouter's OpenAI-compatible endpoint. Any model id is
 *  accepted (the orchestrator passes it). Key from env OPENROUTER_API_KEY. Direct fetch — no new dep;
 *  this is the lab dry-run path and NEVER production generation. Transient 429/5xx are retried
 *  (bounded, jittered); ultimate failure throws. fetchImpl/sleepFn injectable for tests.
 *
 *  ═══ FAIL LOUD (PDQI-9 Phase 1) ═══
 *  EMPTY CONTENT NOW THROWS. A 200 with `choices: []`, a missing `message`, `content: ""` or
 *  `content: null` used to return '' on the same statement as a full response — `parseOpdAnalysis('')`
 *  → null → `pdqi9Score(null)` → weight 0, which RAISES the index because note_quality is the
 *  lowest-scoring domain. Measured: notes the engine could not assess average 95.21 NQI (52% exactly
 *  100) against 78.36 for assessed notes. A failure to measure was being scored as excellence.
 *
 *  Empty content is RETRYABLE on the EXISTING 3-try budget — only the final attempt throws, and
 *  OPENROUTER_MAX_TRIES is deliberately NOT raised.
 *
 *  `onEnvelope` is APPENDED and optional, so every existing call site is unchanged. It fires on
 *  EVERY attempt — success, HTTP failure, empty content and transport failure alike — and is wrapped
 *  so instrumentation can never be the thing that breaks a run.
 *
 *  ═══ TICK DEADLINE (Eval-tick-deadline PRD D1/D2) ═══
 *  `deadlineAt` is APPENDED and optional (absolute epoch ms), so every existing call site — every
 *  production path included — is byte-identical when it is absent. When present it bounds this
 *  note's TOTAL time, not one attempt:
 *    · before EACH attempt, an exhausted budget throws immediately — no sleep, no fetch;
 *    · before sleeping between retries, a backoff that would cross the deadline throws instead;
 *    · the AbortController timeout is clamped to the remaining budget.
 *  So the pool always resolves normally and the tick reaches the line that writes its summary and
 *  clears the lock. Deliberately NOT `Promise.race` on the pool (D3): racing returns partial results
 *  while in-flight calls keep running, and those calls write `lab_analyses` rows AFTER the lock is
 *  released — the next tick would re-run the same uid, recreating the duplicate-row defect `bed1449`
 *  fixed.
 */
export async function openRouterGenerate(
  model: string, system: string, user: string,
  fetchImpl: typeof fetch = fetch,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  onEnvelope: (e: LlmEnvelope) => void = () => {},
  deadlineAt?: number,
): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set — required for eval generation (evalModel)');
  // The last envelope seen on this note, carried into the deadline message. Assignment only.
  let lastEnv: LlmEnvelope | null = null;
  // Envelope capture must NEVER throw and NEVER block a real result (PRD §4 fail-safe direction).
  const emit = (e: LlmEnvelope) => { lastEnv = e; try { onEnvelope(e); } catch { /* instrumentation is never fatal */ } };
  // D1 — backoff that would cross the deadline throws NOW rather than sleeping through it. With no
  // deadline this is exactly `await sleepFn(openRouterBackoffMs(attempt))`, one `rand()` draw and all.
  const sleepOrThrow = async (attempt: number): Promise<void> => {
    const backoff = openRouterBackoffMs(attempt);
    if (deadlineAt != null && remainingBudgetMs(deadlineAt) <= backoff) {
      throw new Error(deadlineErrorMessage(attempt + 1, OPENROUTER_MAX_TRIES, lastEnv));
    }
    await sleepFn(backoff);
  };
  let lastErr: Error = new Error('OpenRouter: no attempt made');
  for (let attempt = 1; attempt <= OPENROUTER_MAX_TRIES; attempt++) {
    // D1 — before EACH attempt. An exhausted budget throws immediately: no sleep, no fetch.
    if (deadlineAt != null && remainingBudgetMs(deadlineAt) <= 0) {
      throw new Error(deadlineErrorMessage(attempt, OPENROUTER_MAX_TRIES, lastEnv));
    }
    // D4 — a per-attempt deadline. Cleared in `finally` so a completed request never leaves a timer.
    // D2 — clamped to the remaining tick budget when there is one, so a fetch can never outlive the
    // tick. With no deadline this is OPENROUTER_TIMEOUT_MS exactly, as before.
    const ctrl = new AbortController();
    const timeoutMs = deadlineAt == null
      ? OPENROUTER_TIMEOUT_MS
      : Math.min(OPENROUTER_TIMEOUT_MS, remainingBudgetMs(deadlineAt));
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(buildOpenRouterBody(model, system, user)),
        signal: ctrl.signal,
      });
    } catch (e) {
      // A timeout surfaces here as an AbortError, as does any transport failure (DNS/socket/reset).
      // Both are treated as normal retryable failures on the SAME bounded budget: an abort that was
      // not retryable would make the deadline strictly worse than no deadline.
      emit({ finish_reason: null, native_finish_reason: null, provider: null, usage: null, content_length: 0, attempt });
      const aborted = ctrl.signal.aborted;
      lastErr = new Error(aborted
        ? `OpenRouter TIMEOUT after ${timeoutMs}ms (attempt ${attempt}/${OPENROUTER_MAX_TRIES})`
        : `OpenRouter transport error (attempt ${attempt}/${OPENROUTER_MAX_TRIES}): ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      if (attempt === OPENROUTER_MAX_TRIES) throw lastErr;
      await sleepOrThrow(attempt);
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      // Widened cast: the envelope fields have always been on the wire and have always been discarded.
      const j = (await res.json().catch(() => null)) as {
        choices?: { message?: { content?: string } }[];
      } | null;
      const content = j?.choices?.[0]?.message?.content || '';
      const env = readLlmEnvelope(j, attempt, content.length);
      emit(env);
      if (content) return content;
      // EMPTY CONTENT — a failure, not an unassessed note. Retryable on the existing budget.
      lastErr = new Error(emptyContentErrorMessage(env, OPENROUTER_MAX_TRIES));
      if (attempt === OPENROUTER_MAX_TRIES) throw lastErr;
      await sleepOrThrow(attempt);
      continue;
    }
    emit({ finish_reason: null, native_finish_reason: null, provider: null, usage: null, content_length: 0, attempt });
    lastErr = new Error(`OpenRouter HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    if (!openRouterRetryable(res.status) || attempt === OPENROUTER_MAX_TRIES) throw lastErr;
    await sleepOrThrow(attempt);
  }
  throw lastErr;
}

async function defaultGenerate(traceId: string | undefined, system: string, user: string, mini = false, evalModel?: string, onEnvelope?: (e: LlmEnvelope) => void, deadlineAt?: number): Promise<string> {
  // EVAL-ONLY (lab): route to OpenRouter when an eval model is named. evalModel unset ⇒ the Gemini/mini
  // path below is byte-identical to today (no production audit ever passes evalModel).
  // `onEnvelope` and `deadlineAt` are threaded ONLY here, on the eval branch. The production path
  // below — its params, its governedChat call and its `content || ''` — is untouched (D1).
  if (evalModel) return openRouterGenerate(evalModel, system, user, fetch, undefined, onEnvelope, deadlineAt);
  // mini=true forces the Mac-mini Ollama bridge (no Gemini) with MINI_MODEL — the
  // scoped mini pipeline (OPD mini backfill). Default path is byte-identical to before.
  const geminiModel = mini ? undefined : (geminiModelFor('doc_audit') ?? geminiUtilityModel());
  // Reasoning-class local models (DeepSeek-R1 / QwQ) emit a long <think> block before the
  // JSON, so they need greedy decoding (eval determinism), a bigger output budget (the JSON
  // must survive the reasoning tokens) and the full context window. Gated on the mini path +
  // model name, so qwen2.5:14b backfill and the Gemini path are byte-for-byte unchanged.
  const isReasoning = mini && /(?:^|[:/_-])(?:r1|qwq|deepseek-r1|reason|think)/i.test(MINI_MODEL);
  // Audit-Score-Determinism PRD §8d (Phase 2): the PRODUCTION Vertex-Gemini scorer runs greedy +
  // seed-pinned + canonical + fixed-thinking — the exact levers the Phase-1 OpenRouter A/B proved
  // (100/100 byte-identical index+band). Gated on `onGemini` (a resolved Gemini model ⇒ Vertex is
  // configured), so the mini/qwen backfill and any Gemini-unconfigured Ollama fallback are BYTE-
  // IDENTICAL to today (temperature isReasoning ? 0 : 0.2, no seed/top_p/thinking).
  const onGemini = !!geminiModel;
  const params = {
    model: mini ? MINI_MODEL : TEXT_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: onGemini ? 0 : (isReasoning ? 0 : 0.2),
    max_tokens: isReasoning ? 8192 : 2200,
    ...({ options: { num_ctx: isReasoning ? 16384 : 8192 }, keep_alive: '15m' } as Record<string, unknown>),
    // seed/top_p flow through governedChat→tracedChat's `...rest` to the Vertex OpenAI-compat client;
    // `google.thinking_config.thinking_budget` is the ONLY thinking form Vertex honors (trace.ts note)
    // — a FIXED positive budget (Pro rejects 0). NOT sent on the mini/Ollama path (out of scope).
    ...(onGemini ? { seed: AUDIT_LLM_SEED, top_p: 1, google: { thinking_config: { thinking_budget: AUDIT_EVAL_THINKING_BUDGET } } } : {}),
  };
  // Governed envelope (Stage 4): OPD-audit vertical fingerprint — the system prompt here is
  // always OPD_AUDIT_SYSTEM (see the single call site).
  const r = await governedChat(traceId, 'opd_audit_analyze', params, { gemini: geminiModel, promptRef: 'opd-note-audit-core/OPD_AUDIT_SYSTEM' });
  return r.choices?.[0]?.message?.content || '';
}

/** Reuse the stored LLM half of an audit so a deterministic-only rule change (e.g. the 0.5 dosing
 *  calibration) can refresh a stored row WITHOUT re-running retrieval/LLM. */
export interface AuditReuse {
  llmFindings: OpdFinding[];
  pdqi9: Partial<Record<Pdqi9Attr, number>> | null;
  suggestions: OpdSuggestion[];
  sources: Source[];
}
export interface AuditOpdOpts {
  trace?: boolean;
  /** EVAL-ONLY (PDQI-9 fail-loud Phase 1). Fires on every OpenRouter attempt with the response
   *  envelope. Only reached when `evalModel` is set; production never passes it. Never throws. */
  onEnvelope?: (e: LlmEnvelope) => void;
  reuse?: AuditReuse;
  /** 'mini' = run the audit LLM pass on the Mac-mini bridge (MINI_MODEL, no Gemini) and tag
   *  the row with the '-<tag>' engine version — invisible to all prod dashboards/APIs, which
   *  filter on the exact prod engine version. Rows coexist per uid (PK uid+engine_version). */
  pipeline?: 'mini';
  /** Engine suffix for mini rows (default 'mini'). A NEW tag (e.g. 'mini2') re-audits the same
   *  notes as a fresh run — the uid+engine PK treats it as a distinct generation. */
  engineTag?: string;
  /** With pipeline:'mini', write the row under the PLAIN prod engine version (OPD_ENGINE_VERSION,
   *  no '-<tag>' suffix) so it is VISIBLE on prod dashboards — the free mini model correcting the
   *  prod scores. (V decision, 2 Jul: re-audit history on the free mini, treat 0.6 as 0.6.) */
  prodTag?: boolean;
  /** Active Tier-1 suppressions to apply (defaults to the cached active set). Pass [] to disable. */
  suppressions?: Suppression[];
  /** Quieting config override (tests / replay). Omitted → cached store read with gen-0 fail-safe. */
  quieting?: QuietingConfig;
  /** Stage 3 — force-attach the de-identified longitudinal note projection regardless of the env flag
   *  (the replay endpoint sets this so it can recompute a note's longitudinal block on demand). */
  longitudinal?: boolean;
  /** LAB EVAL ONLY (R-11 Stage 2, Phase 2): force the normative retrieval leg ON regardless of env/mini.
   *  Absent ⇒ today's gate exactly. Set only by the lab eval batch; never by any production caller. */
  evalNormativeLeg?: boolean;
  /** LAB EVAL ONLY: route audit generation to this OpenRouter model id. Absent ⇒ Gemini/mini as today. */
  evalModel?: string;
  /** LAB EVAL ONLY (R-11 fix candidate): ADDITIVE normative channel — the 8 literature excerpts stay
   *  byte-identical and the CW statements are appended as a separate citable block [9+]. Independent
   *  of evalNormativeLeg (the harmful union); absent ⇒ today's context assembly exactly. */
  evalNormativeChannel?: boolean;
  /** LAB EVAL ONLY (Eval-tick-deadline PRD D1): absolute epoch-ms deadline for the tick this note is
   *  being audited in. Reaches the LLM only via `defaultGenerate`'s evalModel branch, so it is inert
   *  unless `evalModel` is also set. ABSENT ⇒ every existing call site, production included, is
   *  byte-identical. Set ONLY by `batchTick`'s eval branch; never by any production caller. */
  deadlineAt?: number;
}

/** Engine tag for mini-pipeline rows (default run). */
export const OPD_MINI_ENGINE_VERSION = `${OPD_ENGINE_VERSION}-mini`;
/** Engine string for an arbitrary mini run tag. */
export function opdMiniEngine(tag?: string): string {
  const t = (tag || 'mini').replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'mini';
  return `${OPD_ENGINE_VERSION}-${t}`;
}

export async function auditOpdNote(row: Record<string, unknown>, opts: AuditOpdOpts = {}): Promise<OpdNoteAudit> {
  const mini = opts.pipeline === 'mini';
  // prodTag: a mini run that writes the PLAIN prod engine version (visible on dashboards) — the free
  // model correcting prod scores. Otherwise mini stays isolated under '-<tag>'.
  const engineVersion = mini ? (opts.prodTag ? OPD_ENGINE_VERSION : opdMiniEngine(opts.engineTag)) : OPD_ENGINE_VERSION;
  const { case: oc, keys } = rowToOpdCase(row);
  enrichOpdMeds(oc.medications);   // brand→generic + class/schedule/high-alert/LASA/VED from the formulary

  // Decision 6 — etoricoxib's 120 mg/day ceiling applies ONLY under a documented gout diagnosis; else
  // the tighter 90 mg default. Same haystack unindicatedRespFindings builds, plus an M10/M1A ICD code.
  // Absent context → isGout false → 90 mg applies (fail-safe conservative).
  const goutHay = [oc.reasonForConsult || '', ...oc.presentingComplaints, ...oc.impressions, ...oc.history].join(' ');
  const goutCodes = [...oc.diagnosisCodes, ...oc.impressionCodes].map((c) => c.trim());
  const isGout = /\bgout\b|\bgouty\b|\btophus\b|\btophi\b/i.test(goutHay) || goutCodes.some((c) => /^M1[0A]/i.test(c));
  // 0.81.14 case context threaded into the meds[] checks (Rulings 4 + 5–8; same pattern as isGout).
  const mskDocumented = mskContextDocumented(oc);                                   // Ruling 4 — muscle relaxant gate
  const lmpDays = lmpIntervalDays(oc.lmp, oc.noteDate);                             // Rulings 5–8 — possible-pregnancy window (visit_date proxied by oc.noteDate)
  const det = [...prescribingChecks(oc), ...doseFindings(oc.medications, { isGout }), ...ddiFindings(oc.medications), ...muscleRelaxantFindings(oc.medications, { mskDocumented }),
    ...unindicatedRespFindings(oc), ...decongestantDurationFindings(oc.medications),   // 0.81.8 bugs 1, 3
    ...vitaminDRepletionFindings(oc.medications),                                    // 0.81.14 Ruling 13 (informational)
    ...pregnancyRiskFindings(oc.medications, { lmpIntervalDays: lmpDays }),          // 0.81.14 Rulings 5–8 (informational)
    ...bannedFdcFindings(oc.medications)];   // CDSCO banned-FDC (C1) — seed live at v1.0 (5 entries); zero match current prescribing
  const completeness = opdCompleteness(oc);
  const healthCheck = isHealthCheckEncounter(oc);   // 0.81.8 bug 2 — institutional screening context

  // Tier-1 self-heal: apply human-approved active suppressions to the final (identity-stamped)
  // findings — drop, or downgrade to informational (out of the triage queue + score). No-op when
  // none are active. Applied AFTER stampFindingIdentity so it matches on signal_type + subject.
  const supps = opts.suppressions ?? await getActiveSuppressions();
  const lvcRules = await getLvcRules();   // 0.81.4 matcher input (cached, 2s-timeout fail-safe → [])
  // Quieting config (demote rules + policy gen) — fail-safe to { rules: [], gen: 0 } (never blocks).
  const quietCfg = opts.quieting ?? await getQuietingConfig();
  const noMeds = oc.medications.length === 0;
  const finalize = (fs: OpdFinding[]): OpdFinding[] => {
    let out = stampFindingIdentity(fs);
    // B1 — nothing was prescribed this encounter → there is no prescription to fault. Deterministic
    // prescribing checks can't fire with 0 meds, so any prescribing_safety finding here is an LLM
    // ghost (typically read out of the patient's history). Drop it. (Interaction/duplication with a
    // history drug is only valid when a CURRENT med exists — which requires meds.length > 0.)
    if (noMeds) out = out.filter((f) => f.domain !== 'prescribing_safety');
    out = dedupeRouteAware(out, oc.medications);   // 0.81.8 bug 8: wash-off + leave-on / topical + systemic is not a duplicate
    out = consolidateDecisions(out);   // BUG-0.8-12: one decision → one finding, across sources
    out = neutralizeMetadataFindings(out);   // BUG-0.8-16: don't penalise the doctor for our metadata
    out = neutralizeScreeningContext(out, healthCheck);   // 0.81.8 bug 2: don't penalise a health-check package's protocol panel
    // 0.81.4 (RIGHT-CARE §5 / decision 14): stamp rule_ref/lvc_category on the SURVIVING,
    // non-informational low-value findings (after neutralisation) — keyword-matched against the active
    // lvc_recommendations. Additive metadata — never changes verdict/domain/score.
    out = stampLvcMetadata(out, lvcRules);
    out = applySuppressions(out, keys.doctorUid, supps).findings;
    // QUIETING SEAM (PRD Q1 — the one engine touch-point): active demote rules mark matching
    // findings informational + quieted_by, via the exact mechanism scoring already excludes
    // upstream (findings.filter(f => !f.informational) below). Safety signal types are skipped
    // in applyDemotes regardless of rules (engine-side half of the severity floor).
    return applyDemotes(out, keys.doctorUid, quietCfg.rules).findings;
  };

  // Right Care complexity — computed once per audit from db13 history (0.81.3). Fully guarded: a bad
  // individual_uid, a db13 error, or a 3s timeout yields a null band and NEVER blocks/fails the audit.
  const complexityFor = async (): Promise<OpdNoteAudit['complexity']> => {
    // The note uid resolves the patient (individual_uid) inside the fetcher — "individuals-prescriptions"
    // has no individual_uid (live-validated 8 Jul). keys.noteDate is the as-of hint (index timestamp).
    const noteUid = keys.uid ? String(keys.uid) : '';
    if (!noteUid) return { band: null, inputs: null };
    try {
      const inputs = await fetchPatientHistoryBundle(noteUid, keys.noteDate ? String(keys.noteDate) : undefined);
      return inputs ? { band: bandFor(inputs), inputs } : { band: null, inputs: null };
    } catch {
      return { band: null, inputs: null };
    }
  };

  // Deterministic REUSE path (backfill): recompute the deterministic findings + completeness, KEEP
  // the stored LLM findings + PDQI-9, re-score. No retrieval, no LLM, no trace — so a completeness/
  // prescribing rule change refreshes stored rows at ~zero cost.
  if (opts.reuse) {
    // stampFindingIdentity: signal_type + finding_ref on every finding (governance spec v2.0 §2);
    // deterministic, so re-stamping stored LLM findings reproduces their refs.
    const findings: OpdFinding[] = finalize([...det, ...opts.reuse.llmFindings]);
    const scorecard = computeOpdScore({
      findings: findings.filter((f) => !f.informational).map((f) => ({ verdict: f.verdict, confidence: f.confidence, domain: f.domain })),
      completenessCoverage: completeness.coverage,
      pdqi9: opts.reuse.pdqi9,
      patientCentred: completeness.patientCentred,
    });
    return { keys, scorecard, completeness, findings, suggestions: opts.reuse.suggestions, sources: opts.reuse.sources, engineVersion: engineVersion, traceId: undefined, quietingGen: quietCfg.gen };
  }

  const doTrace = opts.trace !== false;
  // Non-identifying trace input (the uid lives only on the returned audit / the audit row).
  const traceId = doTrace
    ? await startTrace('opd_note_audit', {
        consultType: keys.consultType, prescriptionType: keys.prescriptionType,
        nMeds: oc.medications.length, nDx: oc.diagnosisCodes.length, nInvestigations: oc.investigations.length,
        ...(mini ? { pipeline: 'mini' } : {}),
      }).catch(() => undefined as string | undefined)
    : undefined;

  try {
    // Richer retrieval query so the corpus is hit on the actual clinical content (readable dx
    // names + reason + complaints + resolved molecules), not just ICD codes — improves grounding.
    const query = [
      ...oc.impressions,
      ...oc.diagnosisCodes,
      oc.reasonForConsult || '',
      ...oc.presentingComplaints.slice(0, 4),
      ...oc.medications.map((m) => m.resolvedGeneric || m.generic || m.brand || '').filter(Boolean),
      'outpatient appropriateness rational prescribing evidence-based management guideline',
    ].filter(Boolean).join('. ');

    const hits = await defaultRetrieve(query, mini, opts.evalNormativeLeg);
    // R-11 additive channel (lab eval only): a SEPARATE CW-only retrieve appended as [9+] — the 8
    // literature excerpts above are untouched. No channel ⇒ assembleAuditContext is byte-identical
    // to the previous hitsToSources(hits) + buildCitedContext(hits).
    const normHits = opts.evalNormativeChannel === true ? await normativeChannelRetrieve(query) : [];
    const { sources, citedContext } = assembleAuditContext(hits, normHits);
    if (traceId) await logEvent(traceId, 'opd_audit_sources', null, { count: sources.length });

    const specialty = await doctorSpecialtyFor(keys.doctorUid);
    const raw = await defaultGenerate(traceId, OPD_AUDIT_SYSTEM, buildOpdAuditUser(opdCaseText(oc, { specialty }), citedContext), mini, opts.evalModel, opts.onEnvelope, opts.deadlineAt);
    const parsed = parseOpdAnalysis(raw, sources.length);

    const findings: OpdFinding[] = finalize([...det, ...(parsed?.findings ?? [])]);
    const scorecard = computeOpdScore({
      findings: findings.filter((f) => !f.informational).map((f) => ({ verdict: f.verdict, confidence: f.confidence, domain: f.domain })),
      completenessCoverage: completeness.coverage,
      pdqi9: parsed?.pdqi9 ?? null,
      patientCentred: completeness.patientCentred,
    });

    if (traceId) {
      const nLow = findings.filter((f) => f.verdict === 'low-value').length;
      await setTraceQuestionPreview(traceId, `OPD audit · index ${scorecard.headline} (Band ${scorecard.band}) · ${findings.length} finding(s)`).catch(() => {});
      await logEvent(traceId, 'opd_audit_result', null, {
        index: scorecard.headline, band: scorecard.band, coverage: Math.round(completeness.coverage * 100),
        n_findings: findings.length, n_low_value: nLow, pdqi9_assessed: !!parsed?.pdqi9,
      });
      await finishTrace(traceId, 'success');
    }

    // Stage 3 — attach the de-identified projection the post-persistence longitudinal pass consumes.
    // Pure extraction (no I/O, no LLM), so it never blocks or delays base persistence; gated so flag-off
    // (and every mini row) is byte-identical to today.
    const longitudinalInput = ((process.env.OPD_LONGITUDINAL_ENABLED === '1' || opts.longitudinal) && !mini)
      ? buildLongitudinalInput(oc, keys, engineVersion, opdCaseText(oc, { specialty }))
      : null;

    return {
      keys, scorecard, completeness,
      findings, suggestions: parsed?.suggestions ?? [],
      sources, engineVersion: engineVersion, traceId,
      quietingGen: quietCfg.gen,
      complexity: await complexityFor(),
      longitudinalInput,
    };
  } catch (e) {
    if (traceId) await finishTrace(traceId, 'error', String((e as Error).message)).catch(() => {});
    // ═══ FAIL LOUD, EVAL PATH ONLY (D1 + D2) ═══
    // Without this rethrow the whole build is inert: the throw added in openRouterGenerate lands
    // HERE, and this block would swallow it and return a deterministic-only audit that is then
    // persisted and scores ~95 — exactly the defect, one level up. (This is the second site the
    // response document's R3 missed; §2.4 of the PRD.)
    //
    // On rethrow: drainOne's per-note catch records the error, NO lab_analyses row is written, the
    // uid stays un-done, and the next tick retries it. Coverage becomes a visible gap instead of a 95.
    //
    // PRODUCTION IS BYTE-IDENTICAL BELOW THIS LINE. The production defect (a failed LLM leg scored as
    // a deterministic-only ~95) is real and STAYS LIVE by decision — it gets its own PRD. Fix the
    // instrument first; changing a live clinical surface follows evidence rather than preceding it.
    if (opts.evalModel) throw e;
    // Even on LLM failure, return the deterministic-only audit (completeness + prescribing).
    const scorecard = computeOpdScore({
      findings: det.filter((f) => !f.informational).map((f) => ({ verdict: f.verdict, confidence: f.confidence, domain: f.domain })),
      completenessCoverage: completeness.coverage,
      pdqi9: null,
      patientCentred: completeness.patientCentred,
    });
    return { keys, scorecard, completeness, findings: finalize(det), suggestions: [], sources: [], engineVersion: engineVersion, traceId, complexity: await complexityFor(), quietingGen: quietCfg.gen };
  }
}
