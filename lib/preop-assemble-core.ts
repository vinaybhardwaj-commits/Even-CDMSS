/**
 * lib/preop-assemble-core.ts — turning many observations into ONE set of instrument
 * inputs, and one set of inputs into ONE snapshot (PRD v1.1-LOCKED §5, §7, §8;
 * Build Plan B1).
 *
 * NO database, NO fetch, NO clock, NO model. The clock is the caller's: `computedAt`
 * and `daysToSurgery` arrive as arguments so this file stays testable and so two
 * snapshots computed from the same evidence are byte-identical whenever they run.
 *
 * THREE JOBS
 *
 * 1 · SOURCE PRECEDENCE (mockup note 3). Several sources may back one input; the
 *     highest-precedence one SCORES it and the rest corroborate:
 *         LAB / PAC-mapped  >  BOOKING  >  EXTRACTED
 *     LAB and PAC tie deliberately — a mapped PAC field and an Eka lab value are both
 *     the primary record of what they describe, and they describe different things.
 *     Ties break on the most recent observation, then on input order, so the result is
 *     a pure function of the observation list.
 *
 * 2 · CONFLICT TAGGING. When a losing observation asserts the OPPOSITE status the input
 *     is tagged `conflict` and both chips render (mockup note 3). The conflict never
 *     changes the score — precedence already decided that — it changes what the reader
 *     is shown, which is the honest handling of two records that disagree.
 *
 * 3 · THE CONFIDENCE FLOOR (PRD §7). An EXTRACTED observation below the floor is
 *     DROPPED, not down-weighted, and the input falls back to whatever else backs it —
 *     usually nothing, i.e. UNKNOWN, which widens the instrument to a range. This is the
 *     PRD's "low-confidence extraction feeds the same §8 degradation machinery as a
 *     missing input. No new uncertainty concept."
 *
 * CLOSED WORLD, STATED OUT LOUD. A booking form ENUMERATES a patient's comorbidities,
 * so a comorbidity absent from a form that exists is `absent`, not `unknown` — that is
 * the only reason Lakshmamma's booking-only Charlson is a point score of 3 rather than a
 * range from 3 to 27. Inputs that no enumeration can close (creatinine, functional
 * status, the procedure's risk class, age) are `unknown` until something observes them.
 * If there is no booking form at all, nothing is closed and everything is unknown.
 */

import {
  charlsonCategories, computeCharlson, computeMfi5, computeRcri,
  CHARLSON_CATEGORIES, PREOP_INSTRUMENTS_VERSION,
  type CharlsonCategoryId, type InstrumentScore, type Tri,
} from './preop-instruments-core';
import {
  cardLines, computeTier,
  type EpisodeContext, type TierResult,
} from './preop-tier-core';

/** Bumped when precedence, the floor, the closed-world set or the snapshot shape change. */
export const PREOP_ASSEMBLE_RULE_VERSION = 'preop-assemble/1';

// ── sources and precedence ──────────────────────────────────────────────────────

export type PreopSource = 'LAB' | 'PAC' | 'BOOKING' | 'EXTRACTED';

/** Lower rank wins. LAB and PAC tie at the top on purpose (see the header). */
export const SOURCE_RANK: Record<PreopSource, number> = { LAB: 0, PAC: 0, BOOKING: 1, EXTRACTED: 2 };

/**
 * Below this, an EXTRACTED observation is dropped and its input reverts to UNKNOWN.
 * 0.80 is a STARTING floor, not a measured one — B5 measures the extraction rail on the
 * golden set and V moves it by PRD amendment if the measurement says so. Flagged.
 */
export const EXTRACT_CONFIDENCE_FLOOR = 0.8;

// ── the canonical input space ───────────────────────────────────────────────────
//
// The union of the three instruments' inputs. Ids are SHARED where the clinical fact is
// shared: one `congestive_heart_failure` observation feeds RCRI, mFI-5 and Charlson at
// once. That sharing is exactly why the mockup insists mFI-5 and Charlson are read as
// two correlated lenses and not as independent confirmation (PRD §3).

export type PreopInputId =
  | 'high_risk_surgery' | 'ischaemic_heart_disease' | 'congestive_heart_failure'
  | 'cerebrovascular_disease' | 'insulin_treated_diabetes' | 'creatinine_over_2'
  | 'functional_status_dependent' | 'diabetes_mellitus' | 'copd_or_pneumonia'
  | 'hypertension_on_medication'
  | CharlsonCategoryId
  | 'age';

/**
 * Inputs a booking comorbidity enumeration can close the world over. Everything NOT in
 * this set stays UNKNOWN until something actually observes it.
 */
export const ENUMERATED_INPUTS: ReadonlySet<PreopInputId> = new Set<PreopInputId>([
  'ischaemic_heart_disease', 'congestive_heart_failure', 'cerebrovascular_disease',
  'insulin_treated_diabetes', 'diabetes_mellitus', 'copd_or_pneumonia',
  'hypertension_on_medication',
  ...CHARLSON_CATEGORIES.map((c) => c.id),
]);

/** Never closed by an enumeration — a form that lists comorbidities says nothing here. */
export const NEVER_ENUMERATED: ReadonlySet<PreopInputId> = new Set<PreopInputId>([
  'high_risk_surgery', 'creatinine_over_2', 'functional_status_dependent', 'age',
]);

// ── observations in, resolved inputs out ────────────────────────────────────────

/** One source's assertion about one input. An observation always asserts something —
 *  "unknown" is the ABSENCE of an observation, never an observation of its own. */
export interface Observation {
  inputId: PreopInputId;
  status: 'present' | 'absent';
  /** short evidence text the card prints in parentheses, e.g. 'MI 2019' */
  detail?: string | null;
  /** the underlying value where there is one, e.g. 1.4 for creatinine */
  value?: string | number | null;
  source: PreopSource;
  /** the row/document this came from — the provenance chip's link-back */
  provenanceRef?: string | null;
  /** ISO timestamp of the observation (not of the read) — breaks precedence ties */
  observedAt?: string | null;
  /** EXTRACTED only; compared against the floor */
  confidence?: number | null;
  /** EXTRACTED only; the DERIVED model label, never a typed one (house rule) */
  extractedBy?: string | null;
}

export interface ResolvedInput {
  inputId: PreopInputId;
  status: Tri;
  detail: string | null;
  value: string | number | null;
  /** null when the status is 'unknown' or came from the closed-world rule */
  source: PreopSource | null;
  provenanceRef: string | null;
  observedAt: string | null;
  confidence: number | null;
  extractedBy: string | null;
  /** the losing observations that AGREE — they corroborate, they do not score */
  corroborating: Observation[];
  /** a losing observation asserts the opposite status */
  conflict: boolean;
  /** EXTRACTED observations dropped below the floor — shown so the drop is not silent */
  droppedBelowFloor: Observation[];
  /** true when 'absent' came from the closed-world rule rather than from an observation */
  closedWorld: boolean;
}

export interface ResolveOptions {
  /** PREOP_EXTRACT_ENABLED. Off ⇒ EXTRACTED observations never enter the resolution. */
  includeExtracted: boolean;
  /** A booking form exists and enumerated this patient's comorbidities. */
  bookingEnumerated: boolean;
  confidenceFloor?: number;
}

function rank(o: Observation): number { return SOURCE_RANK[o.source]; }

function newer(a: Observation, b: Observation): boolean {
  const ta = a.observedAt ? Date.parse(a.observedAt) : NaN;
  const tb = b.observedAt ? Date.parse(b.observedAt) : NaN;
  if (Number.isNaN(ta) && Number.isNaN(tb)) return false;
  if (Number.isNaN(tb)) return true;
  if (Number.isNaN(ta)) return false;
  return ta > tb;
}

/**
 * Every input the module knows about, in factor-table order, DEDUPED: two ids —
 * congestive_heart_failure and cerebrovascular_disease — are both an RCRI/mFI-5 factor
 * and a Charlson category, and they are ONE clinical fact with one observation and one
 * resolution. That sharing is precisely why the mockup insists mFI-5 and Charlson be
 * read as two correlated lenses rather than as independent confirmation (PRD §3).
 */
export const ALL_INPUT_IDS: PreopInputId[] = [...new Set<PreopInputId>([
  'high_risk_surgery', 'ischaemic_heart_disease', 'congestive_heart_failure',
  'cerebrovascular_disease', 'insulin_treated_diabetes', 'creatinine_over_2',
  'functional_status_dependent', 'diabetes_mellitus', 'copd_or_pneumonia',
  'hypertension_on_medication',
  ...CHARLSON_CATEGORIES.map((c) => c.id),
  'age',
])];

/**
 * Resolve every input in the canonical space. The output is a complete record: an input
 * nothing observed appears with status 'unknown' (or 'absent' by the closed-world rule),
 * never missing from the map — a snapshot must be able to say what it does not know.
 */
export function resolveInputs(observations: Observation[], opts: ResolveOptions): Record<PreopInputId, ResolvedInput> {
  const floor = opts.confidenceFloor ?? EXTRACT_CONFIDENCE_FLOOR;
  const byInput = new Map<PreopInputId, Observation[]>();
  const dropped = new Map<PreopInputId, Observation[]>();

  for (const o of observations) {
    if (o.source === 'EXTRACTED') {
      if (!opts.includeExtracted) continue;                       // flag off: never entered
      if ((o.confidence ?? 0) < floor) {                          // below floor: dropped, shown
        const d = dropped.get(o.inputId) ?? []; d.push(o); dropped.set(o.inputId, d);
        continue;
      }
    }
    const list = byInput.get(o.inputId) ?? []; list.push(o); byInput.set(o.inputId, list);
  }

  const out = {} as Record<PreopInputId, ResolvedInput>;
  for (const id of ALL_INPUT_IDS) {
    const list = byInput.get(id) ?? [];
    const droppedHere = dropped.get(id) ?? [];
    if (!list.length) {
      const closed = opts.bookingEnumerated && ENUMERATED_INPUTS.has(id) && !NEVER_ENUMERATED.has(id);
      out[id] = {
        inputId: id, status: closed ? 'absent' : 'unknown', detail: null, value: null,
        source: closed ? 'BOOKING' : null, provenanceRef: null, observedAt: null,
        confidence: null, extractedBy: null, corroborating: [], conflict: false,
        droppedBelowFloor: droppedHere, closedWorld: closed,
      };
      continue;
    }
    let win = list[0];
    for (const o of list.slice(1)) {
      if (rank(o) < rank(win)) { win = o; continue; }
      if (rank(o) === rank(win) && newer(o, win)) win = o;
    }
    const rest = list.filter((o) => o !== win);
    out[id] = {
      inputId: id, status: win.status, detail: win.detail ?? null, value: win.value ?? null,
      source: win.source, provenanceRef: win.provenanceRef ?? null, observedAt: win.observedAt ?? null,
      confidence: win.confidence ?? null, extractedBy: win.extractedBy ?? null,
      corroborating: rest.filter((o) => o.status === win.status),
      conflict: rest.some((o) => o.status !== win.status),
      droppedBelowFloor: droppedHere, closedWorld: false,
    };
  }
  return out;
}

// ── the procedure's RCRI risk class ─────────────────────────────────────────────

/**
 * RCRI's "high-risk surgery" is intraperitoneal, intrathoracic or suprainguinal-vascular
 * surgery (Lee). This classifier reads the procedure text and returns tri-state — and
 * it returns UNKNOWN for anything it does not recognise, which widens RCRI to a range
 * rather than quietly scoring a 0. An unrecognised procedure is a data gap, and the
 * card says so.
 *
 * The approved mockup's own arithmetic settles the minimal-access question: Farhan's
 * laparoscopic cholecystectomy and Divya's laparoscopic appendectomy both score RCRI
 * high-risk-surgery ABSENT even though the peritoneum is entered. B3 revisits this
 * against real procedure text with the PAC's `za` (planned procedure) field.
 */
export function classifyProcedureRisk(procedure: string | null | undefined): { status: Tri; reason: string } {
  const p = (procedure ?? '').toLowerCase().trim();
  if (!p) return { status: 'unknown', reason: 'no procedure text on the episode' };

  const MINIMAL_ACCESS = /\b(lap|laparoscop\w*|endoscop\w*|arthroscop\w*|percutaneous|robotic)\b/;
  const INTRAPERITONEAL = /\b(hemicolectomy|colectomy|colostomy|gastrectomy|laparotomy|whipple|pancreatic\w*|hepatectomy|splenectomy|nephrectomy|cystectomy|hysterectomy|bowel resection|small bowel|ileostomy|oesophagectomy|esophagectomy|open cholecystectomy|open appendicectomy|open appendectomy)\b/;
  const INTRATHORACIC = /\b(thoracotomy|lobectomy|pneumonectomy|cabg|coronary artery bypass|valve replacement|thymectomy|decortication)\b/;
  const SUPRAINGUINAL_VASCULAR = /\b(aortic|aorto\w*|infrarenal|supra-?renal|iliac|aneurysm repair|evar)\b/;

  if (MINIMAL_ACCESS.test(p)) {
    return { status: 'absent', reason: `${procedure} — minimal-access, not an RCRI high-risk approach` };
  }
  if (INTRAPERITONEAL.test(p)) return { status: 'present', reason: `${procedure} — intraperitoneal` };
  if (INTRATHORACIC.test(p)) return { status: 'present', reason: `${procedure} — intrathoracic` };
  if (SUPRAINGUINAL_VASCULAR.test(p)) return { status: 'present', reason: `${procedure} — suprainguinal vascular` };

  const KNOWN_LOW = /\b(knee|hip|shoulder|acl|tkr|thr|arthroplasty|replacement|cataract|phaco\w*|lens|hernia|herniorrhaphy|hernioplasty|tonsill\w*|septoplasty|cystoscopy|tur\w*|circumcision|fistul\w*|haemorrhoid\w*|hemorrhoid\w*|carpal|ganglion|excision biopsy|lipoma|skin|dental|cochlear|mastoid|thyroidectomy|breast|lumpectomy|mastectomy|spine|discectomy|laminectomy|fixation|orif|amputation below)\b/;
  if (KNOWN_LOW.test(p)) {
    return { status: 'absent', reason: `${procedure} — not intraperitoneal / intrathoracic / suprainguinal-vascular` };
  }
  return { status: 'unknown', reason: `${procedure} — procedure not in the risk-class list; class unconfirmed` };
}

// ── inputs -> the three instruments ─────────────────────────────────────────────

type Inputs = Record<PreopInputId, ResolvedInput>;
const st = (m: Inputs, id: PreopInputId): Tri => m[id]?.status ?? 'unknown';

export function rcriFrom(m: Inputs): InstrumentScore {
  return computeRcri({
    highRiskSurgery: st(m, 'high_risk_surgery'),
    ischaemicHeartDisease: st(m, 'ischaemic_heart_disease'),
    congestiveHeartFailure: st(m, 'congestive_heart_failure'),
    cerebrovascularDisease: st(m, 'cerebrovascular_disease'),
    insulinTreatedDiabetes: st(m, 'insulin_treated_diabetes'),
    creatinineOver2: st(m, 'creatinine_over_2'),
  });
}

export function mfi5From(m: Inputs): InstrumentScore {
  return computeMfi5({
    functionalStatusDependent: st(m, 'functional_status_dependent'),
    diabetesMellitus: st(m, 'diabetes_mellitus'),
    copdOrPneumonia: st(m, 'copd_or_pneumonia'),
    congestiveHeartFailure: st(m, 'congestive_heart_failure'),
    hypertensionOnMedication: st(m, 'hypertension_on_medication'),
  });
}

/** Age rides in the resolved-input map like every other input, so it carries provenance
 *  and appears in the missing list when nothing observed it. */
export function resolvedAge(m: Inputs): number | null {
  const v = m.age?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function charlsonFrom(m: Inputs): InstrumentScore {
  const overrides: Partial<Record<CharlsonCategoryId, Tri>> = {};
  for (const c of CHARLSON_CATEGORIES) overrides[c.id] = st(m, c.id);
  return computeCharlson({ age: resolvedAge(m), categories: charlsonCategories(overrides, 'unknown') });
}

// ── the snapshot ────────────────────────────────────────────────────────────────

export interface PacState {
  /** a PAC report exists for this patient */
  onFile: boolean;
  status: string | null;
  /** the anaesthetist's conclusion, quoted VERBATIM — never paraphrased, never replaced */
  verdict: string | null;
  reportUid: string | null;
  finalizedAt: string | null;
}

export const PAC_NONE: PacState = { onFile: false, status: null, verdict: null, reportUid: null, finalizedAt: null };

export interface EpisodeFacts {
  episodeKey: string;
  individualUid: string | null;
  uhid: string | null;
  patientName: string | null;
  age: number | null;
  sex: string | null;
  procedure: string | null;
  hospital: string | null;
  surgeryDate: string | null;
  surgeon: string | null;
  department: string | null;
}

export interface SnapshotInput {
  engineVersion: string;
  episode: EpisodeFacts;
  observations: Observation[];
  pac: PacState;
  /** whole days from today to surgeryDate — the CALLER's clock, IST (this core has none) */
  daysToSurgery: number | null;
  /** a human marked the CURRENT stored version reviewed */
  reviewed: boolean;
  includeExtracted: boolean;
  bookingEnumerated: boolean;
  /**
   * The episode has NO document beyond the booking form — no OPD visit, no lab row, no
   * PAC (PRD §4: 28 of 105 patients). A document-level fact only the assembler can know,
   * so it is passed in rather than guessed from which source happened to win an input.
   */
  bookingOnly: boolean;
  /** the CALLER's clock again — excluded from the fingerprint by construction */
  computedAt: string;
  confidenceFloor?: number;
}

export interface PreopSnapshot {
  episodeKey: string;
  engineVersion: string;
  computedAt: string;
  rules: { instruments: string; tier: string; assemble: string };
  episode: EpisodeFacts;
  pac: PacState;
  context: EpisodeContext;
  inputs: ResolvedInput[];
  rcri: InstrumentScore;
  mfi5: InstrumentScore;
  charlson: InstrumentScore;
  tier: TierResult;
  lines: { why: string; missing: string; situation: string };
  /** true when BOOKING is the only source backing any input (mockup note 3) */
  bookingOnly: boolean;
  /** the evidence+arithmetic fingerprint — see snapshotFingerprint */
  fingerprint: string;
}

/**
 * Compose one snapshot. Pure: same arguments in, byte-identical snapshot out, every time.
 * This is the function the worker calls per episode and the function the tests call with
 * the mockup's four synthetic patients.
 */
export function composeSnapshot(inp: SnapshotInput): PreopSnapshot {
  // Age rides in the input map. If the caller did not observe it, take it off the episode
  // record (the booking/ADT row it came from) so Charlson has provenance for it too.
  const observations = inp.observations.some((o) => o.inputId === 'age') || inp.episode.age == null
    ? inp.observations
    : [...inp.observations, { inputId: 'age' as const, status: 'present' as const, value: inp.episode.age, source: 'BOOKING' as const }];

  const inputs = resolveInputs(observations, {
    includeExtracted: inp.includeExtracted,
    bookingEnumerated: inp.bookingEnumerated,
    confidenceFloor: inp.confidenceFloor,
  });
  const rcri = rcriFrom(inputs);
  const mfi5 = mfi5From(inputs);
  const charlson = charlsonFrom(inputs);

  const context: EpisodeContext = {
    pacFinalized: inp.pac.onFile && (inp.pac.status ?? '').toLowerCase() === 'final',
    daysToSurgery: inp.daysToSurgery,
    reviewed: inp.reviewed,
  };
  const tier = computeTier({ rcri, mfi5, charlson, context });

  const inputList = ALL_INPUT_IDS.map((id) => inputs[id]);
  const bookingOnly = inp.bookingOnly;
  const evidence: Record<string, { detail?: string | null }> = {};
  for (const r of inputList) if (r.detail) evidence[r.inputId] = { detail: r.detail };

  const lines = cardLines({ rcri, mfi5, charlson, tier, context, evidence, bookingOnly, age: resolvedAge(inputs) });

  const snap: Omit<PreopSnapshot, 'fingerprint'> = {
    episodeKey: inp.episode.episodeKey,
    engineVersion: inp.engineVersion,
    computedAt: inp.computedAt,
    rules: { instruments: PREOP_INSTRUMENTS_VERSION, tier: tier.ruleVersion, assemble: PREOP_ASSEMBLE_RULE_VERSION },
    episode: inp.episode,
    pac: inp.pac,
    context,
    inputs: inputList,
    rcri, mfi5, charlson, tier, lines, bookingOnly,
  };
  return { ...snap, fingerprint: snapshotFingerprint(snap) };
}

// ── the fingerprint (what "changed" means) ──────────────────────────────────────

/** Stable-key JSON, so a fingerprint depends on values and never on key insertion order. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** FNV-1a, 32-bit, hex — a short stable digest with no crypto import in a pure core. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * WHAT COUNTS AS A CHANGE — the single decision the whole versions rail turns on.
 *
 * IN: the resolved evidence (each input's status, winning source, value, detail and
 * conflict flag), the three instrument bounds, the composite tier and its escalations.
 * A new lab, a finalized PAC, a corrected comorbidity or a tier that escalates because
 * surgery came inside 72 h — all of these mint a version, and the timeline is exactly
 * the story the case page is built to tell.
 *
 * OUT, deliberately: `computedAt` (a sweep is not a change), `daysToSurgery` (it decays
 * every single day and would churn the rail into noise), and `needsReview` (a board
 * predicate recomputed at every sweep on the live row, not a fact about the snapshot).
 * The tier IS in, so the moment a decaying countdown actually changes the answer, the
 * change is recorded.
 */
export function snapshotFingerprint(s: Omit<PreopSnapshot, 'fingerprint'>): string {
  const material = {
    engine: s.engineVersion,
    rules: s.rules,
    pac: { onFile: s.pac.onFile, status: s.pac.status, reportUid: s.pac.reportUid, verdict: s.pac.verdict },
    inputs: s.inputs.map((i) => ({
      id: i.inputId, status: i.status, source: i.source, value: i.value ?? null,
      detail: i.detail ?? null, conflict: i.conflict,
    })),
    rcri: { kind: s.rcri.kind, lo: s.rcri.lo, hi: s.rcri.hi },
    mfi5: { kind: s.mfi5.kind, lo: s.mfi5.lo, hi: s.mfi5.hi },
    charlson: { kind: s.charlson.kind, lo: s.charlson.lo, hi: s.charlson.hi },
    tier: s.tier.tier,
    escalations: [...s.tier.escalations].sort(),
  };
  return fnv1a(canonicalJson(material));
}
