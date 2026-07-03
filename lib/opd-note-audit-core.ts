/**
 * lib/opd-note-audit-core.ts — OPD note-quality audit CORE (pure).
 *
 * Deterministic completeness + prescribing checks, the grounded LLM analyze prompt,
 * and the response parser. PURE: type-only cross-imports (so it loads under
 * `node --experimental-strip-types` for unit tests); the score assembly that needs
 * computeOpdScore lives in the server orchestrator (lib/opd-note-audit.ts).
 */

import type { DeidOpdCase, OpdMed } from './opd-ingest-core';
import type { NetValue, OpdFindingDomain, Pdqi9Attr } from './opd-note-score-core';

// 0.4 — formulary integration: brand→generic resolution + class/schedule/ISMP-high-alert/
//       LASA/VED enrichment + formulary-scoped DDI, so brand-only OPD lines (~36%) are recognised.
// 0.5 — corpus grounding made first-class: persisted CDMSS Sources, cite-or-label findings
//       (every clinical claim cites [n] or is marked reasoning), richer retrieval query. No extra LLM calls.
// 0.6 — encounter-context fix (bit a false Band-A on a teleconsult ortho REFERRAL note): the engine
//       now ingests the onward referral + teleconsult modality, separates AUTO-ATTACHED templated
//       patient-education leaflets from clinician documentation, and instructs the auditor not to (a)
//       praise a handoff's missing meds/imaging as high-value "avoidance", (b) grade a templated
//       leaflet as note thoroughness, or (c) expect a physical exam on a teleconsult.
export const OPD_ENGINE_VERSION = 'opd-note-audit/0.6';

// Local copy of the PDQI-9 keys (kept in sync with opd-note-score-core) so this core has
// no runtime cross-import and stays loadable under `node --experimental-strip-types`.
const PDQI9_KEYS: Pdqi9Attr[] = [
  'up_to_date', 'accurate', 'thorough', 'useful', 'organized',
  'comprehensible', 'succinct', 'synthesized', 'internally_consistent',
];

export interface OpdFinding {
  subject: string;
  verdict: NetValue;
  confidence: number;
  domain: OpdFindingDomain;        // 'appropriateness' | 'prescribing_safety'
  rationale: string;
  evidence: string[];
  estimates: string[];
  citation_ids: number[];
  source: 'llm' | 'deterministic';
  informational?: boolean;         // surfaced for awareness (e.g. high-alert present); never penalises the score
  // Finding identity (governance spec v2.0 §2) — stamped at assembly time by stampFindingIdentity().
  // Optional in the type because stored history predates them; readers may re-derive with the same
  // pure functions (deterministic), so legacy rows need no migration or forced re-audit.
  signal_type?: string;            // coarse controlled-vocab category — the CM triage batch key
  finding_ref?: string;            // stable per-note content hash — the instance address
}
// ── Finding identity — signal_type + finding_ref (governance spec v2.0 §2) ────
// Every finding gets (a) a coarse controlled-vocab `signal_type` (the unit the care manager
// batch-triages on: "drug interaction ×46") and (b) a `finding_ref` — a deterministic content
// hash stable across re-audits for the same specific finding on the same note. Triage rows key
// on (audit_id, finding_ref); CM batch decisions key on (doctor_uid, signal_type).
// Pure + dependency-free (own SHA-1) so this file stays strip-types testable and client-safe.

/** Controlled signal-type vocabulary → human label. Keep coarse: this is the CM batching unit. */
export const OPD_SIGNAL_TYPES: Record<string, string> = {
  drug_interaction: 'Drug interaction',
  incomplete_dosing: 'Incomplete dosing',
  duplicate_prescription: 'Duplicate prescription',
  unverified_brand: 'Unverified brand',
  lasa_pair: 'LASA pair co-prescribed',
  dose_ceiling_exceeded: 'Daily dose exceeds ceiling',
  dose_ceiling_sos: 'Dose may exceed ceiling if all SOS taken',
  duplicate_molecule: 'Same molecule in multiple products',
  high_alert_medication: 'High-alert medication',
  schedule_x: 'Schedule X drug',
  off_formulary: 'Off-formulary items',
  antibiotic_stewardship: 'Antibiotic stewardship',
  // Coarse LLM buckets (by domain × verdict) — a free-text appropriateness/prescribing finding
  // that matches no precise rule batches here, so the CM sees "Low-value appropriateness ×12"
  // rather than 12 one-off drug-named cards. finding_ref stays per-instance for drill.
  appropriateness_low_value: 'Low-value / inappropriate care',
  appropriateness_review: 'Appropriateness — needs review',
  appropriateness_high_value: 'High-value care (positive)',
  prescribing_low_value: 'Low-value / unsafe prescribing',
  prescribing_review: 'Prescribing — needs review',
  prescribing_high_value: 'Sound prescribing (positive)',
  appropriateness_general: 'Appropriateness (other)',
  prescribing_general: 'Prescribing safety (other)',
};

// Deterministic subjects match exactly by prefix; LLM subjects fall through to the keyword
// rules, then the slug fallback. Order matters — first match wins.
const SIGNAL_TYPE_RULES: { re: RegExp; type: string }[] = [
  { re: /^interaction\b/, type: 'drug_interaction' },
  { re: /^incomplete dosing\b/, type: 'incomplete_dosing' },
  { re: /^duplicate prescription\b/, type: 'duplicate_prescription' },
  { re: /^unverified brand\b/, type: 'unverified_brand' },
  { re: /^lasa pair\b/, type: 'lasa_pair' },
  { re: /^daily dose exceeds ceiling\b/, type: 'dose_ceiling_exceeded' },
  { re: /^daily dose may exceed ceiling\b/, type: 'dose_ceiling_sos' },
  { re: /^same molecule in \d+ products?\b/, type: 'duplicate_molecule' },
  { re: /^high[\s-]?alert medication/, type: 'high_alert_medication' },
  { re: /^schedule x\b/, type: 'schedule_x' },
  { re: /^off[\s-]?formulary\b/, type: 'off_formulary' },
  { re: /\bantibiotic|antimicrobial\b/, type: 'antibiotic_stewardship' },
  { re: /\b(?:drug[\s–-]+drug\s+)?interaction\b/, type: 'drug_interaction' },
];

// Verdict → coarse class for the LLM buckets. High-value = positive (low triage priority).
const VERDICT_CLASS: Record<string, 'low_value' | 'high_value' | 'review'> = {
  'low-value': 'low_value', 'high-value': 'high_value',
  'context-dependent': 'review', 'uncertain': 'review',
};

/**
 * The controlled-vocab signal type for a finding (pure, derivable for legacy rows).
 * (1) precise rules (deterministic subjects + keyword LLM rules like antibiotics) win;
 * (2) otherwise a free-text LLM finding batches into a COARSE domain×verdict bucket — this is the
 *     fix for queue fragmentation (per-drug subjects were each becoming their own type);
 * (3) with no verdict to class on, the domain's general bucket.
 */
export function opdSignalType(subject: string, domain: OpdFindingDomain, opts?: { verdict?: string }): string {
  // Match on the category part (before ':'), parentheticals stripped, lowercased.
  const prefix = (subject.split(':')[0] || '').replace(/\(.*?\)/g, ' ').trim().toLowerCase();
  for (const r of SIGNAL_TYPE_RULES) if (r.re.test(prefix)) return r.type;
  const domainKey = domain === 'prescribing_safety' ? 'prescribing' : 'appropriateness';
  const cls = opts?.verdict ? VERDICT_CLASS[opts.verdict] : undefined;
  return cls ? `${domainKey}_${cls}` : `${domainKey}_general`;
}

// Compact pure SHA-1 (deterministic content hash; NOT security-sensitive). Verified against the
// standard test vector in the unit tests.
function sha1Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const ml = bytes.length;
  const padded = new Uint8Array(Math.ceil((ml + 9) / 64) * 64);
  padded.set(bytes);
  padded[ml] = 0x80;
  const dv = new DataView(padded.buffer);
  const bitLen = ml * 8;
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(padded.length - 4, bitLen >>> 0, false);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let i = 0; i < padded.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false);
    for (let j = 16; j < 80; j++) { const x = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16]; w[j] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let j = 0; j < 80; j++) {
      let f: number, k: number;
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = ((((a << 5) | (a >>> 27)) + f + e + k + w[j]) | 0) >>> 0;
      e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, '0')).join('');
}

/** Stamp signal_type + finding_ref on every finding of one note (final assembly step).
 *  finding_ref = sha1(signal_type + '|' + normalized detail-after-colon), first 12 hex chars —
 *  stable across re-audits for the same specific finding; within-note collisions suffixed '#2'…
 *  Deterministic: re-stamping stored findings yields identical refs. */
export function stampFindingIdentity(findings: OpdFinding[]): OpdFinding[] {
  const used = new Set<string>();
  return findings.map((f) => {
    const signal_type = opdSignalType(f.subject, f.domain, { verdict: f.verdict });
    const colon = f.subject.indexOf(':');
    const detail = (colon >= 0 ? f.subject.slice(colon + 1) : f.subject).trim().toLowerCase().replace(/\s+/g, ' ');
    const base = sha1Hex(`${signal_type}|${detail}`).slice(0, 12);
    let ref = base;
    for (let n = 2; used.has(ref); n++) ref = `${base}#${n}`;
    used.add(ref);
    return { ...f, signal_type, finding_ref: ref };
  });
}

export interface OpdCompletenessItem { key: string; label: string; present: boolean; mandatory: boolean }
export interface OpdCompleteness {
  items: OpdCompletenessItem[];
  coverage: number;                          // 0..1 over applicable items
  missing: string[];
  patientCentred: { present: number; total: number };
}
export interface OpdSuggestion { priority: number; text: string }

// ── Dose / route resolution (0.5 calibration) ─────────────────────────────────
// The EMR's medication fields are entered inconsistently: the strength is frequently embedded in
// the drug NAME ("Cefix 200mg Tab", `strength` field empty ~36%) and `route_of_administration` is
// blank ~17% but is obvious from the dosage form. Reading the fields literally false-flagged ~1/3
// of otherwise-complete notes as "incomplete dosing". These pure helpers read what the note ACTUALLY
// documents (field OR name OR inferred form); only a route that can be neither read nor inferred,
// and an amount that appears nowhere, are treated as real gaps.
const STRENGTH_RE = /\b\d+(?:\.\d+)?\s?(?:mg|mcg|µg|ug|g|ml|iu|units?|meq|lac|lakh|k)\b/i;

/** Dose/amount is documented if it's in the `dosage` field, the `strength` field, or embedded in
 *  the drug name (e.g. "Cefix 200mg Tab"). */
export function medDoseDocumented(m: OpdMed): boolean {
  if ((m.dose && m.dose.trim()) || (m.strength && m.strength.trim())) return true;
  return STRENGTH_RE.test(`${m.brand || ''} ${m.generic || ''}`);
}

const ROUTE_RULES: { re: RegExp; route: string }[] = [
  { re: /\b(inj|injection|vial|amp(?:oule)?|iv|im|s\/?c|subcut|parenteral)\b/i, route: 'parenteral' },
  { re: /\b(inhaler|rotacap|rotahaler|respule|neb(?:uli[sz]er?|ule)?|mdi|puff|inhalation)\b/i, route: 'inhaled' },
  { re: /\b(eye|ophthalmic|ocular)\b/i, route: 'ophthalmic' },
  { re: /\b(ear|otic)\b/i, route: 'otic' },
  { re: /\b(nasal|nostril|intranasal)\b/i, route: 'nasal' },
  { re: /\b(supp(?:ository)?|rectal|per\s?rectum|pr)\b/i, route: 'rectal' },
  { re: /\b(pessary|vaginal|per\s?vagina|pv)\b/i, route: 'vaginal' },
  { re: /\b(cream|ointment|gel|lotion|topical|patch|transderm|ung|apply|local(?:ly)?)\b/i, route: 'topical' },
  { re: /\b(tab(?:let)?s?|cap(?:sule)?s?|syr(?:up)?|susp(?:ension)?|solution|oral|po|sachet|powder|granule|lozenge|chewable|drops?)\b/i, route: 'oral' },
];

/** The documented route, else one inferred from the dosage form in the name/dose/instruction.
 *  Null ONLY when the route is truly ambiguous (no field + no inferable form) — that is a real gap. */
export function resolveMedRoute(m: OpdMed): string | null {
  if (m.route && m.route.trim()) return m.route.trim();
  const hay = `${m.brand || ''} ${m.generic || ''} ${m.dose || ''} ${m.instruction || ''}`;
  for (const r of ROUTE_RULES) if (r.re.test(hay)) return r.route;
  return null;
}

// ── Deterministic NABH-OPD completeness (from the structured row) ─────────────
export function opdCompleteness(c: DeidOpdCase): OpdCompleteness {
  const hasMeds = c.medications.length > 0;
  // Complete dosing = an amount is documented (field or in the name) + a frequency + a route that is
  // documented OR inferable from the form. Route that can't be inferred at all remains a real gap.
  const dosingComplete = hasMeds && c.medications.every((m) => medDoseDocumented(m) && !!m.frequency && resolveMedRoute(m) !== null);
  // NABH-OPD items we can actually observe in this EMR's structured data. Allergy is never
  // stored at the prescription level (always empty) and history is folded into the presenting
  // complaint / HPI, so both were removed (they were false-flagging ~100% of notes).
  // 0.6 — the "plan" is satisfied by a clinician plan OR an onward referral (a referral handoff's
  // plan IS the referral). Examination is only expected for IN-PERSON encounters; for a teleconsult
  // a physical exam is not applicable, so it is not scored (rather than silently counting as met).
  const hasPlan = c.advice.length > 0 || (c.referrals?.length ?? 0) > 0;
  const isTele = c.isTeleconsult === true;
  const items: OpdCompletenessItem[] = [
    { key: 'presenting_complaint', label: 'Presenting complaint', present: c.presentingComplaints.length > 0 || !!c.reasonForConsult, mandatory: true },
    { key: 'diagnosis', label: 'Diagnosis / impression', present: c.diagnosisCodes.length > 0 || c.impressionCodes.length > 0 || c.impressions.length > 0, mandatory: true },
    { key: 'medication_dosing', label: 'Complete medication dosing', present: hasMeds ? dosingComplete : true, mandatory: true },
    { key: 'advice_given', label: 'Advice / plan', present: hasPlan, mandatory: true },
    { key: 'follow_up', label: 'Follow-up specified', present: !!c.followUpType, mandatory: true },
  ];
  // Physical examination — applicable only to in-person encounters (a teleconsult can't examine).
  if (!isTele) items.push({ key: 'examination', label: 'Examination recorded', present: c.examination.length > 0, mandatory: true });
  const present = items.filter((i) => i.present).length;
  const coverage = items.length ? present / items.length : 1;
  const missing = items.filter((i) => !i.present).map((i) => i.label);
  // Continuity / patient-centred subset (advice + follow-up).
  const pc = ['advice_given', 'follow_up'];
  const pcItems = items.filter((i) => pc.includes(i.key));
  return {
    items,
    coverage,
    missing,
    patientCentred: { present: pcItems.filter((i) => i.present).length, total: pcItems.length },
  };
}

const dedupCI = (a: string[]): string[] => {
  const seen = new Set<string>(); const out: string[] = [];
  for (const x of a) { const k = x.toLowerCase(); if (x && !seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
};
function det(subject: string, verdict: NetValue, confidence: number, rationale: string, informational = false): OpdFinding {
  return { subject, verdict, confidence, domain: 'prescribing_safety', rationale, evidence: [], estimates: [], citation_ids: [], source: 'deterministic', ...(informational ? { informational: true } : {}) };
}

// ── Deterministic rational-prescribing checks (from the medications array) ─────
// Uses the formulary-RESOLVED generic where the note gave only a brand, so brand-only lines
// finally dedupe and stop false-flagging. Formulary safety facts (ISMP high-alert, Schedule X,
// LASA pairs, off-formulary items) surface as findings; the purely-informational ones carry
// `informational` + confidence 0 so they inform without ever penalising the score.
export function prescribingChecks(c: DeidOpdCase): OpdFinding[] {
  const out: OpdFinding[] = [];
  const seen = new Map<string, { n: number; label: string }>();
  const highAlerts: string[] = [];
  const scheduleX: string[] = [];
  let nNonFormularyDrug = 0;
  let nNutraceutical = 0;

  for (const m of c.medications) {
    const gen = m.resolvedGeneric || m.generic;
    const name = gen || m.brand || 'medication';

    // brand-only AND unresolved: the note named a proprietary product the formulary couldn't
    // map. Flag only genuine drugs (nutraceuticals/cosmetics are rolled up informationally).
    if (!gen) {
      if (m.nonFormulary === 'nutraceutical-cosmetic') nNutraceutical++;
      else {
        nNonFormularyDrug++;
        out.push(det(`Unverified brand: ${m.brand || 'medication'}`, 'context-dependent', 0.4,
          'Prescribed by a brand not in the hospital formulary and not resolvable to a generic — molecule, class and interactions cannot be verified. NABH expects generic naming.'));
      }
    }

    const gaps: string[] = [];
    if (!medDoseDocumented(m)) gaps.push('dose/strength');
    if (!m.frequency) gaps.push('frequency');
    if (resolveMedRoute(m) === null) gaps.push('route');
    if (!m.duration) gaps.push('duration');
    if (gaps.length) out.push(det(`Incomplete dosing: ${name}`, 'context-dependent', 0.5, `Missing ${gaps.join(', ')} — incomplete prescription (strength read from the drug name and route inferred from the dosage form where possible).`));

    if (gen) { const k = gen.toLowerCase(); const p = seen.get(k); seen.set(k, { n: (p?.n || 0) + 1, label: gen }); }
    if (gen && m.highAlert) highAlerts.push(gen);
    if (gen && m.schedule === 'X') scheduleX.push(gen);
  }

  for (const { n, label } of seen.values()) {
    if (n > 1) out.push(det(`Duplicate prescription: ${label}`, 'low-value', 0.7, `The same generic appears ${n} times on the prescription.`));
  }

  // LASA pair co-prescribed — a drug AND one of its look-alike/sound-alike confusables both present.
  const names = c.medications.map((m) => (m.resolvedGeneric || m.generic || m.brand || '').toLowerCase()).filter(Boolean);
  const lasaSeen = new Set<string>();
  for (const m of c.medications) {
    const self = (m.resolvedGeneric || m.generic || '').toLowerCase();
    for (const la of m.lasa || []) {
      const laLow = la.toLowerCase();
      const hit = names.find((nm) => nm && nm !== self && (nm.includes(laLow) || laLow.includes(nm)));
      if (hit && self) {
        const key = [self, hit].sort().join('|');
        if (!lasaSeen.has(key)) {
          lasaSeen.add(key);
          out.push(det(`LASA pair co-prescribed: ${m.resolvedGeneric || m.generic} & ${hit}`, 'context-dependent', 0.45,
            'Look-alike/sound-alike drugs on the same prescription — dispensing/administration confusion risk (NABH / ISMP LASA).'));
        }
      }
    }
  }

  // Informational formulary roll-ups (confidence 0 → never penalise the score).
  if (highAlerts.length) out.push(det(`High-alert medication${highAlerts.length > 1 ? 's' : ''}: ${dedupCI(highAlerts).join(', ')}`, 'uncertain', 0,
    'ISMP high-alert medication present — heightened harm potential if mis-prescribed/administered; confirm dose, monitoring and indication.', true));
  if (scheduleX.length) out.push(det(`Schedule X drug: ${dedupCI(scheduleX).join(', ')}`, 'uncertain', 0,
    'Schedule X (narcotic/psychotropic) present — requires the prescribed format and record-keeping controls under the D&C Rules.', true));
  if (nNonFormularyDrug || nNutraceutical) {
    const parts: string[] = [];
    if (nNonFormularyDrug) parts.push(`${nNonFormularyDrug} not in formulary`);
    if (nNutraceutical) parts.push(`${nNutraceutical} nutraceutical/cosmetic`);
    out.push(det(`Off-formulary items: ${parts.join('; ')}`, 'uncertain', 0,
      'Items prescribed outside the hospital drug formulary (retail brands / nutraceuticals / cosmetics) — informational; not assessed as formulary drugs.', true));
  }

  return out;
}

// ── LLM analyze pass (grounded) — findings + PDQI-9 + suggestions ─────────────
export const OPD_AUDIT_SYSTEM = `You are a clinical quality auditor reviewing a SINGLE outpatient (OPD) consultation note, given a DE-IDENTIFIED structured record of the encounter and NUMBERED EVIDENCE EXCERPTS [1], [2], … from a medical corpus. Produce an advisory, NON-DIRECTIVE note-quality audit. Do THREE things.

ENCOUNTER CONTEXT — read the header fields FIRST and let them frame everything:
   - TELECONSULT: if the modality is teleconsult, a physical examination is not possible — never treat a missing examination as a gap and never lower "thorough" for it.
   - REFERRAL / HANDOFF: if the encounter refers the patient onward (e.g. to an in-person specialist) or the disposition/follow-up is a referral, it is a TRIAGE/HANDOFF, not a definitive-management episode. The plan IS the referral. Do NOT credit the absence of medications, investigations or imaging as a deliberate "high-value" choice, "avoidance", or "prudent restraint" — that framing is a category error for a handoff and must not appear as a high-value finding. Judge only what a good handoff needs: a clear reason for referral, a working diagnosis, and safety-netting.
   - PATIENT-EDUCATION MATERIAL: any attached templated self-care leaflet (generic exercises, video/YouTube links) is AUTO-GENERATED, not clinician-authored. Do NOT reward it in PDQI-9 thoroughness/useful/synthesized, and do not treat it as evidence of a rich plan. Grade only the clinician's own documentation.

1) FINDINGS — appropriateness and prescribing-safety issues for THIS encounter:
   - appropriateness: low-value / inappropriate tests, treatments or referrals for the presentation.
   - prescribing_safety: irrational or unsafe prescribing — wrong/unnecessary drug, an antibiotic for a likely-viral illness, drug–drug or drug–allergy interactions, duplications, dosing problems. Each medication carries the molecule plus [drug class · D&C schedule · ISMP high-alert] resolved from the hospital formulary (the note often gives only a brand); use these to judge class duplication, interactions and high-alert handling. Items tagged "nutraceutical/cosmetic" or "not in hospital formulary" are NOT formulary drugs — do not invent drug interactions for them, but you may note non-evidence-based / cosmetic prescribing.
   Each finding: "subject", "verdict" (high-value | context-dependent | low-value | uncertain), "confidence" 0–1, "domain" ("appropriateness" | "prescribing_safety"), "rationale", "evidence" (points SUPPORTED by the excerpts), "estimates" (your own/general-knowledge points), "citation_ids" (the [n] that actually support the evidence).
   CITE OR LABEL — this is critical, the audit is shown to clinical reviewers who must see what is sourced: when a numbered excerpt supports a point, put it in "evidence" and list every supporting [n] in citation_ids; if no excerpt supports the point, it MUST go in "estimates" with citation_ids empty — NEVER present an uncited claim as cited evidence. Prefer findings you can ground in the excerpts; an uncited finding is still allowed but will be shown to the reviewer as "general clinical reasoning", so reserve it for points genuinely worth raising.
   GUARD AGAINST ANCHORING: weigh PRE-TEST PROBABILITY and the dominant clinical syndrome; treat outside low-utility tests (e.g. Widal) with skepticism; do not reward a low-yield confirmatory test. Do NOT invent a diagnosis the note doesn't support.
   Do NOT penalise the mere absence of a field as a clinical error (documentation gaps are scored separately) — focus findings on the actual clinical decisions taken.

2) PDQI9 — rate the QUALITY OF THE DOCUMENTATION THAT IS PRESENT on the validated 9 attributes, each 1 (poor) to 5 (excellent). ANCHOR: 3 = acceptable/adequate, 5 = excellent, 1 = unacceptable. CRITICAL — completeness is scored SEPARATELY, so do NOT re-penalise missing sections here. A terse but internally-correct note (correct drug names + dosing, a coded diagnosis, a coherent plan) is ACCEPTABLE: rate accurate, comprehensible, succinct and internally_consistent ≈ 3–5 unless what IS written is actually wrong, confusing/unreadable, padded, or self-contradictory — reserve 1–2 for those genuine defects, not for brevity. Only thorough, useful and synthesized may legitimately fall for sparseness. Rate each attribute for what it measures:
   - up_to_date: consistent with current standards · accurate: factually correct, no errors in what is stated · thorough: covers the relevant clinical ground (low if sparse) · useful: gives a downstream reader what they need (low if sparse) · organized: logically structured · comprehensible: clear and readable · succinct: concise without padding (terse is NOT a defect) · synthesized: ties findings into a coherent assessment/plan (low if sparse) · internally_consistent: no contradictions among the documented items.

3) SUGGESTIONS — prioritised, concrete improvements (priority 1 = highest).

Advisory only; never blame the clinician. Separate cited EVIDENCE from ESTIMATES; never present an estimate as cited.

Return ONLY JSON, no prose:
{"findings":[{"subject":"…","verdict":"…","confidence":0.0,"domain":"appropriateness|prescribing_safety","rationale":"…","evidence":["…"],"estimates":["…"],"citation_ids":[1]}],"pdqi9":{"up_to_date":3,"accurate":3,"thorough":3,"useful":3,"organized":3,"comprehensible":3,"succinct":3,"synthesized":3,"internally_consistent":3},"suggestions":[{"priority":1,"text":"…"}]}`;

export function buildOpdAuditUser(caseText: string, citedContext: string): string {
  const ev = citedContext.trim() ? citedContext.trim() : '(no excerpts retrieved — leave citation_ids empty; put clinical reasoning in estimates, not evidence)';
  return `DE-IDENTIFIED OPD ENCOUNTER:\n${caseText}\n\nNUMBERED EVIDENCE EXCERPTS:\n${ev}`;
}

// ── parse ────────────────────────────────────────────────────────────────────
function extractJsonObject(text: string): unknown {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}
function s(v: unknown): string { return v == null ? '' : String(v).trim(); }
function num(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}
function strArr(v: unknown, cap = 12): string[] {
  return Array.isArray(v) ? v.map(s).filter(Boolean).slice(0, cap) : [];
}
const VERDICTS: NetValue[] = ['high-value', 'context-dependent', 'low-value', 'uncertain'];
function normVerdict(v: unknown): NetValue { const x = s(v).toLowerCase().replace(/\s+/g, '-'); return (VERDICTS as string[]).includes(x) ? (x as NetValue) : 'uncertain'; }
function normDomain(v: unknown): OpdFindingDomain { return s(v).toLowerCase().includes('prescrib') ? 'prescribing_safety' : 'appropriateness'; }

export interface OpdAnalysis {
  findings: OpdFinding[];
  pdqi9: Partial<Record<Pdqi9Attr, number>> | null;
  suggestions: OpdSuggestion[];
}

export function parseOpdAnalysis(text: string, sourceCount = 0): OpdAnalysis | null {
  const o = extractJsonObject(text) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;

  const rawF = Array.isArray(o.findings) ? o.findings : [];
  const findings: OpdFinding[] = rawF.map((r) => {
    const f = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const ids = Array.isArray(f.citation_ids)
      ? f.citation_ids.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 1 && n <= sourceCount)
      : [];
    return {
      subject: s(f.subject) || '(unnamed finding)',
      verdict: normVerdict(f.verdict),
      confidence: num(f.confidence, 0, 1, 0.5),
      domain: normDomain(f.domain),
      rationale: s(f.rationale),
      evidence: strArr(f.evidence),
      estimates: strArr(f.estimates),
      citation_ids: ids,
      source: 'llm' as const,
    };
  }).filter((f) => f.subject !== '(unnamed finding)' || f.rationale);

  let pdqi9: Partial<Record<Pdqi9Attr, number>> | null = null;
  const rawP = (o.pdqi9 && typeof o.pdqi9 === 'object') ? o.pdqi9 as Record<string, unknown> : null;
  if (rawP) {
    pdqi9 = {};
    for (const a of PDQI9_KEYS) { const v = rawP[a]; if (v != null && Number.isFinite(Number(v))) pdqi9[a] = num(v, 1, 5, 3); }
    if (Object.keys(pdqi9).length === 0) pdqi9 = null;
  }

  const rawS = Array.isArray(o.suggestions) ? o.suggestions : [];
  const suggestions: OpdSuggestion[] = rawS.map((r, i) => {
    const x = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    return { priority: num(x.priority, 1, 99, i + 1), text: s(x.text) };
  }).filter((x) => x.text).sort((a, b) => a.priority - b.priority);

  return { findings, pdqi9, suggestions };
}
