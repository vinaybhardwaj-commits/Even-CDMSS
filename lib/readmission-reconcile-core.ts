/**
 * lib/readmission-reconcile-core.ts — PURE Stage-2 provenance reconciliation (PRD
 * CDMSS-READMISSION-AGENT-PRD-v0.7 §5/§5a/§6, §8c.3, decisions 13/14).
 *
 * No DB, no model, no network. The Vertex passes propose claims (parsed JSON —
 * lib/readmission-prompts.ts); THIS module enforces the reconciliation rules on
 * them, deterministically:
 *
 *   1. Provenance: every evidence item is interested (treating-team prose) or
 *      disinterested (raw lab value, ADT fact, the OTHER team's readmit note).
 *      An avoidable verdict may not rest on interested evidence alone.
 *   2. Temporal provenance for "planned": planned counts ONLY when foreshadowed in
 *      the INDEX summary (written before the outcome). A readmit-note assertion
 *      does not make it planned.
 *   3. Omission audit with the §8c.3 lab-timing coverage gate: confidence scales
 *      with whether the contradicting value is actually near discharge.
 *      admission_only stays get a lower-confidence, clearly-labelled signal —
 *      never a hard "discharged unstable". Missing labs → prose-only track, and
 *      "no contradicting lab" is NEVER "confirmed stable".
 *   4. Same vs different condition by the failing-organ ANALYTE BUNDLE
 *      (renal = creatinine+BUN+K; cardiac = BNP+weight+Na; hepatic =
 *      bilirubin+INR+ammonia), never the diagnosis string a coder can rename.
 *   5. Exculpatory claims ("non-adherent", "justified") stay UNCORROBORATED until
 *      a disinterested source supports them — absent that, the case stays flagged.
 *   6. Two-pass money verdict: both passes must agree AND cite overlapping
 *      evidence ids; same label + disjoint evidence → needs_adjudication.
 *   · Lane D (decision 14): condition pass only; SAME condition → promote to full.
 *   · Out-of-network (decision 13): index-side omission audit only, planned/same
 *     from the CM note, NO avoidable verdict on the other hospital; identity is
 *     authoritative, readmit facts are patient-reported and say so.
 */

// ── Evidence ────────────────────────────────────────────────────────────────────

export type EvidenceSource = 'index_summary' | 'readmit_summary' | 'lab' | 'adt' | 'cm_form';

export interface EvidenceItem {
  id: string;
  source: EvidenceSource;
  /** Which stay a lab/fact belongs to. Summaries imply their own side. */
  side?: 'index' | 'readmit' | null;
  text: string;
  at?: string | null;          // ISO timestamp (labs)
  analyte?: string | null;     // canonical analyte, from canonicalAnalyte()
  abnormal?: boolean | null;
}

export interface EvidenceCatalog { items: EvidenceItem[] }

/** PRD §5 rule 1. The CM form is an interested-but-not-clinical source (§5a):
 *  patient-reported, so NOT disinterested corroboration either. */
export function isDisinterested(item: EvidenceItem): boolean {
  return item.source === 'lab' || item.source === 'adt' || item.source === 'readmit_summary';
}
export function isInterested(item: EvidenceItem): boolean {
  return item.source === 'index_summary';
}

// ── Analyte bundles (PRD §5 rule 4) ─────────────────────────────────────────────

export const ANALYTE_BUNDLES: Record<string, readonly string[]> = {
  renal: ['creatinine', 'bun', 'potassium'],
  cardiac: ['bnp', 'weight', 'sodium'],
  hepatic: ['bilirubin', 'inr', 'ammonia'],
};

const ANALYTE_PATTERNS: Array<[RegExp, string]> = [
  [/creatinin/i, 'creatinine'],
  [/\bbun\b|blood\s*urea/i, 'bun'],
  [/potassium|\bk\+/i, 'potassium'],
  [/\bnt[- ]?pro[- ]?bnp\b|\bbnp\b/i, 'bnp'],
  [/sodium|\bna\+/i, 'sodium'],
  [/\bweight\b/i, 'weight'],
  [/bilirubin/i, 'bilirubin'],
  [/\binr\b|international normali[sz]ed ratio/i, 'inr'],
  [/ammonia/i, 'ammonia'],
];

/** Canonical analyte for a lab test name, or null when it is outside every bundle. */
export function canonicalAnalyte(testName: string | null | undefined): string | null {
  if (!testName) return null;
  for (const [re, canon] of ANALYTE_PATTERNS) if (re.test(testName)) return canon;
  return null;
}

/** Parse a "3.5-5.1" style reference range. Null when unparseable. */
export function parseRefRange(range: string | null | undefined): { lo: number; hi: number } | null {
  if (!range) return null;
  const m = String(range).match(/(-?\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lo = Number(m[1]), hi = Number(m[2]);
  return Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo ? { lo, hi } : null;
}

/** Abnormality from an explicit flag first, else value-vs-range. Null = unknown. */
export function labAbnormal(value: number | null, flag: string | null | undefined, range: string | null | undefined): boolean | null {
  if (flag != null && String(flag).trim() !== '') {
    const f = String(flag).trim().toLowerCase();
    if (/^(h|hh|l|ll|high|low|abnormal|critical|panic|\*)$/.test(f)) return true;
    if (/^(n|normal|wnl)$/.test(f)) return false;
  }
  const r = parseRefRange(range);
  if (r && value != null && Number.isFinite(value)) return value < r.lo || value > r.hi;
  return null;
}

/** Which bundles have at least one abnormal analyte among these lab items. */
export function abnormalBundles(items: EvidenceItem[]): string[] {
  const abnormalAnalytes = new Set(
    items.filter((i) => i.source === 'lab' && i.abnormal === true && i.analyte).map((i) => i.analyte as string),
  );
  return Object.entries(ANALYTE_BUNDLES)
    .filter(([, analytes]) => analytes.some((a) => abnormalAnalytes.has(a)))
    .map(([bundle]) => bundle);
}

// ── Lab-timing coverage gate (§8c.3) ────────────────────────────────────────────

export type LabTimingProfile = 'no_labs' | 'short_stay' | 'has_late_labs' | 'admission_only';

const H = 3_600_000;
const parseTs = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(s) ? s.replace(' ', 'T') : s);
  return Number.isFinite(t) ? t : null;
};

/**
 * Tag the index stay's lab-timing profile. Only 14% of LOS≥2 stays have any lab
 * after admission+24h (measured §8c.3) — the omission audit cannot assume a "last
 * value before discharge" exists.
 */
export function labTimingProfile(
  labs: Array<{ at: string | null }>,
  admitAt: string | null,
  dischargeAt: string | null,
): LabTimingProfile {
  if (!labs.length) return 'no_labs';
  const admit = parseTs(admitAt);
  const disch = parseTs(dischargeAt);
  // Short stay: admission bloods sit within 48h of discharge, so they ARE near-discharge.
  if (admit != null && disch != null && disch - admit <= 48 * H) return 'short_stay';
  if (admit != null && labs.some((l) => { const t = parseTs(l.at); return t != null && t > admit + 24 * H; })) {
    return 'has_late_labs';
  }
  return 'admission_only';
}

// ── Model-pass claims (parsed JSON — lib/readmission-prompts.ts) ────────────────

export interface PassClaims {
  planned?: { verdict: 'planned' | 'unplanned' | 'unknown'; evidenceIds: string[]; rationale?: string } | null;
  sameCondition?: { verdict: 'same' | 'different' | 'unknown'; organBundle?: string | null; evidenceIds: string[]; rationale?: string } | null;
  omissions?: Array<{ claim: string; claimEvidenceId?: string | null; contradictingEvidenceIds: string[]; danger: 'high' | 'moderate' | 'low'; rationale?: string }> | null;
  exculpatory?: Array<{ claim: string; claimEvidenceId?: string | null; corroboratingEvidenceIds: string[] }> | null;
  avoidable?: { verdict: 'avoidable' | 'justified' | 'uncertain'; evidenceIds: string[]; rationale?: string } | null;
  weakestStep?: string | null;
  refusalRecord?: Array<{ lookedFor: string; found: boolean; note?: string }> | null;
}

// ── The finding ─────────────────────────────────────────────────────────────────

export type AvoidableVerdict = 'avoidable' | 'justified' | 'needs_adjudication';

export interface ReadmissionFinding {
  findingClass: 'even_even' | 'out_of_network';
  verdictScope: 'pair' | 'index_side_only';
  planned: { verdict: 'planned' | 'unplanned' | 'unknown'; confidence: number; evidenceIds: string[]; enforcement?: string } | null;
  sameCondition: { verdict: 'same' | 'different' | 'unknown'; confidence: number; basis: 'analyte_bundle' | 'model_prose' | 'patient_reported'; bundles: string[]; evidenceIds: string[] } | null;
  omissions: Array<{ claim: string; danger: 'high' | 'moderate' | 'low'; confidence: 'high' | 'moderate' | 'low'; caveat?: string; evidenceIds: string[] }>;
  exculpatory: Array<{ claim: string; corroborated: boolean; corroboratingIds: string[] }>;
  /** null on condition-only (lane D first pass) and ALWAYS null out-of-network. */
  avoidable: { verdict: AvoidableVerdict; evidenceIds: string[]; reason?: string } | null;
  /** Decision 14: lane-D condition pass came back SAME → run the full reconciliation. */
  promoteToFull?: boolean;
  labProfile: LabTimingProfile;
  /** Never 'corroborated' from absence of labs (§5 rule 6). */
  stabilityAssessment: 'contradicted' | 'corroborated' | 'unverifiable';
  corroborationTrack: 'lab_corroborated' | 'prose_only';
  provenance: { interested: number; disinterested: number; ratio: number; needsHumanReview: boolean };
  weakestStep: string | null;
  refusalRecord: Array<{ lookedFor: string; found: boolean; note?: string }>;
  /** Out-of-network honesty (§5a). */
  readmitFactsPatientReported?: boolean;
  identityResolved?: boolean;
}

export interface ReconcileInput {
  findingClass: 'even_even' | 'out_of_network';
  catalog: EvidenceCatalog;
  labProfile: LabTimingProfile;
  indexDischargeAt: string | null;
  passA: PassClaims | null;
  /** The second, differently-prompted avoidable pass. Required for a full even_even audit. */
  passB: PassClaims | null;
  /** Lane D first pass (decision 9): same/different-condition only. */
  conditionOnly?: boolean;
  formFlags?: { isPlanned: boolean | null; sameCondition: boolean | null } | null;
}

const byId = (catalog: EvidenceCatalog) => {
  const m = new Map<string, EvidenceItem>();
  for (const i of catalog.items) m.set(i.id, i);
  return m;
};
const validIds = (ids: string[] | undefined | null, m: Map<string, EvidenceItem>): string[] =>
  Array.from(new Set((ids ?? []).filter((id) => m.has(id))));

// ── Rule 2: temporal provenance for "planned" ───────────────────────────────────

export function enforcePlanned(
  claim: PassClaims['planned'],
  catalog: EvidenceCatalog,
  findingClass: 'even_even' | 'out_of_network',
  formFlags?: ReconcileInput['formFlags'],
): ReadmissionFinding['planned'] {
  const m = byId(catalog);
  if (!claim) {
    // Out-of-network may classify planned from the form flag alone (§5a).
    if (findingClass === 'out_of_network' && formFlags?.isPlanned != null) {
      return { verdict: formFlags.isPlanned ? 'planned' : 'unplanned', confidence: 0.5, evidenceIds: [], enforcement: 'from-cm-form-flag' };
    }
    return null;
  }
  const ids = validIds(claim.evidenceIds, m);
  if (claim.verdict !== 'planned') {
    return { verdict: claim.verdict, confidence: 0.7, evidenceIds: ids };
  }
  // "Planned" must be foreshadowed BEFORE the outcome: index summary for even_even;
  // the CM note / form flag is the only record out-of-network has (§5a).
  const allowed: EvidenceSource[] = findingClass === 'out_of_network' ? ['cm_form', 'index_summary'] : ['index_summary'];
  const foreshadowed = ids.some((id) => allowed.includes(m.get(id)!.source));
  const formPlanned = findingClass === 'out_of_network' && formFlags?.isPlanned === true;
  if (foreshadowed || formPlanned) {
    return { verdict: 'planned', confidence: 0.8, evidenceIds: ids };
  }
  return {
    verdict: 'unplanned', confidence: 0.6, evidenceIds: ids,
    enforcement: 'planned-claim-rejected: intent asserted only after the outcome (readmit-side), not foreshadowed in the index summary',
  };
}

// ── Rule 4: same condition by physiology ────────────────────────────────────────

export function resolveSameCondition(
  claim: PassClaims['sameCondition'],
  catalog: EvidenceCatalog,
  formFlags?: ReconcileInput['formFlags'],
): ReadmissionFinding['sameCondition'] {
  const m = byId(catalog);
  const indexLabs = catalog.items.filter((i) => i.source === 'lab' && i.side === 'index');
  const readmitLabs = catalog.items.filter((i) => i.source === 'lab' && i.side === 'readmit');
  const idxBundles = abnormalBundles(indexLabs);
  const rdBundles = abnormalBundles(readmitLabs);
  const shared = idxBundles.filter((b) => rdBundles.includes(b));
  const labIds = (bundles: string[]) => catalog.items
    .filter((i) => i.source === 'lab' && i.abnormal === true && i.analyte
      && bundles.some((b) => ANALYTE_BUNDLES[b]?.includes(i.analyte as string)))
    .map((i) => i.id);

  // The analyte bundle DECIDES when it can (rule 4) — a renamed diagnosis string cannot move it.
  if (shared.length) {
    return { verdict: 'same', confidence: 0.9, basis: 'analyte_bundle', bundles: shared, evidenceIds: labIds(shared) };
  }
  if (idxBundles.length && rdBundles.length) {
    return { verdict: 'different', confidence: 0.7, basis: 'analyte_bundle', bundles: Array.from(new Set([...idxBundles, ...rdBundles])), evidenceIds: labIds([...idxBundles, ...rdBundles]) };
  }
  // Insufficient physiology on one/both sides → the model's prose judgment, at reduced confidence.
  if (claim) {
    return { verdict: claim.verdict, confidence: 0.6, basis: 'model_prose', bundles: [], evidenceIds: validIds(claim.evidenceIds, m) };
  }
  if (formFlags?.sameCondition != null) {
    return { verdict: formFlags.sameCondition ? 'same' : 'different', confidence: 0.4, basis: 'patient_reported', bundles: [], evidenceIds: [] };
  }
  return null;
}

// ── Rule 3 + coverage gate: the omission audit ──────────────────────────────────

export function scoreOmissions(
  omissions: NonNullable<PassClaims['omissions']>,
  catalog: EvidenceCatalog,
  labProfile: LabTimingProfile,
  indexDischargeAt: string | null,
): ReadmissionFinding['omissions'] {
  const m = byId(catalog);
  const disch = parseTs(indexDischargeAt);
  const out: ReadmissionFinding['omissions'] = [];
  for (const o of omissions) {
    const ids = validIds(o.contradictingEvidenceIds, m);
    const labItems = ids.map((id) => m.get(id)!).filter((i) => i.source === 'lab');
    if (!labItems.length) continue;   // a lab-omission claim with no surviving lab evidence is dropped
    const nearDischarge = disch != null && labItems.some((l) => {
      const t = parseTs(l.at);
      return t != null && t <= disch && t >= disch - 48 * H;
    });
    let confidence: 'high' | 'moderate' | 'low';
    let caveat: string | undefined;
    if (nearDischarge || labProfile === 'short_stay') {
      confidence = 'high';
    } else if (labProfile === 'has_late_labs') {
      confidence = 'moderate';
      caveat = 'contradicting value is not from the final 48h before discharge';
    } else {
      // admission_only: an admission abnormality expected to correct is NOT evidence of
      // premature discharge (§8c.3) — lower-confidence, clearly labelled, never a hard claim.
      confidence = 'low';
      caveat = 'admission-only labs: the abnormal value is from the admission workup and may have corrected before discharge — not a "discharged unstable" claim';
    }
    const claimIds = o.claimEvidenceId && m.has(o.claimEvidenceId) ? [o.claimEvidenceId] : [];
    out.push({ claim: o.claim, danger: o.danger, confidence, ...(caveat ? { caveat } : {}), evidenceIds: [...claimIds, ...ids] });
  }
  const rank = { high: 0, moderate: 1, low: 2 };
  out.sort((a, b) => rank[a.danger] - rank[b.danger]);   // ranked by clinical danger, not count
  return out;
}

// ── Rule 5: exculpatory needs corroboration ─────────────────────────────────────

export function checkExculpatory(
  claims: NonNullable<PassClaims['exculpatory']>,
  catalog: EvidenceCatalog,
): ReadmissionFinding['exculpatory'] {
  const m = byId(catalog);
  return claims.map((c) => {
    const ids = validIds(c.corroboratingEvidenceIds, m).filter((id) => isDisinterested(m.get(id)!));
    return { claim: c.claim, corroborated: ids.length > 0, corroboratingIds: ids };
  });
}

// ── The two-pass money verdict (§5 two-pass rule + rules 1/5) ───────────────────

export function twoPassAvoidable(
  a: PassClaims['avoidable'],
  b: PassClaims['avoidable'],
  catalog: EvidenceCatalog,
  exculpatory: ReadmissionFinding['exculpatory'],
  omissions: ReadmissionFinding['omissions'],
): NonNullable<ReadmissionFinding['avoidable']> {
  const m = byId(catalog);
  if (!a || !b) {
    return { verdict: 'needs_adjudication', evidenceIds: [], reason: 'missing a pass — the money verdict is only ever produced twice' };
  }
  if (a.verdict !== b.verdict) {
    return { verdict: 'needs_adjudication', evidenceIds: [], reason: `passes disagree (${a.verdict} vs ${b.verdict})` };
  }
  const idsA = validIds(a.evidenceIds, m);
  const idsB = validIds(b.evidenceIds, m);
  const overlap = idsA.filter((id) => idsB.includes(id));
  if (a.verdict === 'avoidable') {
    if (!overlap.length) {
      return { verdict: 'needs_adjudication', evidenceIds: Array.from(new Set([...idsA, ...idsB])), reason: 'same label, disjoint evidence — a single hallucinated citation cannot survive this' };
    }
    // Rule 1: an avoidable verdict may not rest on interested evidence alone.
    if (overlap.every((id) => isInterested(m.get(id)!))) {
      return { verdict: 'needs_adjudication', evidenceIds: overlap, reason: 'avoidable rested on treating-team prose alone — no disinterested support' };
    }
    return { verdict: 'avoidable', evidenceIds: overlap };
  }
  if (a.verdict === 'justified') {
    // Rule 5: an uncorroborated exculpatory claim does not clear the case.
    if (exculpatory.length && exculpatory.every((e) => !e.corroborated) && omissions.length) {
      return { verdict: 'needs_adjudication', evidenceIds: Array.from(new Set([...idsA, ...idsB])), reason: 'justification rests on uncorroborated exculpatory claims while omission flags stand — stays flagged, not cleared' };
    }
    return { verdict: 'justified', evidenceIds: Array.from(new Set([...idsA, ...idsB])) };
  }
  return { verdict: 'needs_adjudication', evidenceIds: Array.from(new Set([...idsA, ...idsB])), reason: 'both passes uncertain' };
}

// ── Assembly ────────────────────────────────────────────────────────────────────

export function reconcileFinding(input: ReconcileInput): ReadmissionFinding {
  const { catalog, labProfile } = input;
  const m = byId(catalog);
  const oon = input.findingClass === 'out_of_network';
  const a = input.passA ?? {};
  const b = input.passB ?? {};

  const sameCondition = resolveSameCondition(a.sameCondition ?? null, catalog, input.formFlags);

  if (input.conditionOnly) {
    return {
      findingClass: input.findingClass, verdictScope: 'pair',
      planned: null, sameCondition, omissions: [], exculpatory: [], avoidable: null,
      promoteToFull: sameCondition?.verdict === 'same',
      labProfile, stabilityAssessment: 'unverifiable', corroborationTrack: labProfile === 'no_labs' ? 'prose_only' : 'lab_corroborated',
      provenance: provenanceOf([...(sameCondition?.evidenceIds ?? [])], m),
      weakestStep: a.weakestStep ?? null,
      refusalRecord: a.refusalRecord ?? [],
    };
  }

  const planned = enforcePlanned(a.planned ?? null, catalog, input.findingClass, input.formFlags);
  const omissions = scoreOmissions(a.omissions ?? [], catalog, labProfile, input.indexDischargeAt);
  const exculpatory = checkExculpatory(a.exculpatory ?? [], catalog);

  // §5a: no avoidable/for-money verdict on the other hospital. Ever.
  const avoidable = oon ? null : twoPassAvoidable(a.avoidable ?? null, b.avoidable ?? null, catalog, exculpatory, omissions);

  const citedIds = Array.from(new Set([
    ...(planned?.evidenceIds ?? []),
    ...(sameCondition?.evidenceIds ?? []),
    ...omissions.flatMap((o) => o.evidenceIds),
    ...(avoidable?.evidenceIds ?? []),
  ]));
  const provenance = provenanceOf(citedIds, m);

  // Coverage honesty (§5 rule 6): absence of labs is never confirmation of stability.
  const hasIndexLabs = catalog.items.some((i) => i.source === 'lab' && i.side === 'index');
  const stabilityAssessment: ReadmissionFinding['stabilityAssessment'] =
    omissions.length ? 'contradicted'
      : hasIndexLabs && (labProfile === 'short_stay' || labProfile === 'has_late_labs') ? 'corroborated'
        : 'unverifiable';
  const corroborationTrack: ReadmissionFinding['corroborationTrack'] = hasIndexLabs ? 'lab_corroborated' : 'prose_only';

  const refusal: ReadmissionFinding['refusalRecord'] = [...(a.refusalRecord ?? [])];
  if (labProfile === 'no_labs') refusal.push({ lookedFor: 'any lab result for the index stay', found: false, note: 'verdict rests on the treating team’s own prose (prose-only track)' });
  if (labProfile === 'admission_only') refusal.push({ lookedFor: 'labs drawn after admission+24h', found: false, note: 'admission workup only — no near-discharge values exist' });
  if (oon) refusal.push({ lookedFor: 'a readmit discharge summary', found: false, note: 'the readmission happened outside Even; readmit facts are patient-reported via the CM note' });

  return {
    findingClass: input.findingClass,
    verdictScope: oon ? 'index_side_only' : 'pair',
    planned, sameCondition, omissions, exculpatory, avoidable,
    labProfile, stabilityAssessment, corroborationTrack, provenance,
    weakestStep: a.weakestStep ?? null,
    refusalRecord: refusal,
    ...(oon ? { readmitFactsPatientReported: true, identityResolved: true } : {}),
  };
}

function provenanceOf(citedIds: string[], m: Map<string, EvidenceItem>): ReadmissionFinding['provenance'] {
  const items = citedIds.map((id) => m.get(id)).filter((i): i is EvidenceItem => !!i);
  const interested = items.filter(isInterested).length;
  const disinterested = items.filter(isDisinterested).length;
  // PRD §6: disinterested support divided by interested support. A verdict resting
  // only on treating-team prose scores low and auto-routes to human review.
  const ratio = interested > 0 ? disinterested / interested : disinterested;
  return { interested, disinterested, ratio, needsHumanReview: disinterested === 0 };
}
