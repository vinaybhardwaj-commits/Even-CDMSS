/**
 * lib/readmission-surface-core.ts — PURE presentation logic for /care/readmissions
 * (CDMSS-READMISSION-PHASE-2-CARE-SURFACE-PRD-v1.0, 6 Aug 2026).
 *
 * No DB, no model, no network, no React. Everything the surface DECIDES — which lane
 * a finding sits in and in what order, which findings count as "to review", and what
 * each badge/label says — lives here so it is unit-tested rather than eyeballed in a
 * rendered page. The route does IO; ReadmissionsBoard does markup; this file does the
 * judgement.
 *
 * READ-ONLY (decision 10). Nothing in this module writes, and nothing downstream of
 * it does either: v1 renders what the agent already stored and offers no action that
 * mutates a finding. Escalation is the next phase.
 *
 * TWO THINGS THE PRD/MOCKUP ASSUME THAT THE STORED SCHEMA DOES NOT CARRY — both
 * resolved here in the direction that cannot produce a wrong label:
 *
 *  1. medical / surgical. The mockup shows a Medical|Surgical chip and the kickoff
 *     says it comes "from tags", but PairTags (readmission-detect-core.ts:62) has
 *     only tight_7d / within_30d / structural_bounce / er_route / excluded_category.
 *     There is no such flag anywhere on the row. careLine() therefore derives it from
 *     the DEPARTMENT NAME and returns null on anything ambiguous — the chip is simply
 *     absent rather than guessed. It is a display hint; no count, filter or verdict
 *     reads it.
 *  2. lane 'other' (lane D). The kickoff enumerates er_routed → tight_bounce →
 *     structural_30d → out_of_network → excluded and does not place lane D, which the
 *     detector does emit (laneFor() falls through to 'other'). It is ordered after
 *     out_of_network and before the collapsed excluded block, so a lane-D finding is
 *     always visible and never silently dropped. Flagged for V.
 */

// ── Row shape (what the read route hands the board) ─────────────────────────────

/** One audited finding, as the surface renders it. Mirrors the readmission_findings
 *  columns the PRD §2 names, plus the two jsonb blobs and the display-only KX join.
 *  Every field is nullable because every one of them can be absent on a real row. */
export interface SurfaceFinding {
  dedupKey: string;
  /** R2 Addendum A3: the closed FindingClass union — `delayed_ssi` is compiler-enforced. */
  findingClass: FindingClass;
  lane: string;
  auditStatus: string;
  /** Display-only, joined from KX at render (decision 5). Never sent to a model. */
  patientName: string | null;
  uhid: string | null;
  ageGender: string | null;
  gapDays: number | null;
  indexDepartment: string | null;
  readmitDepartment: string | null;
  indexDoctor: string | null;
  readmitDoctor: string | null;
  indexDischargeAt: string | null;
  readmitAdmitAt: string | null;
  payerIndex: string | null;
  payerReadmit: string | null;
  cmNote: string | null;
  planned: string | null;
  sameCondition: string | null;
  avoidable: string | null;
  labTier: string | null;
  labTimingProfile: string | null;
  nOmissions: number | null;
  needsHumanReview: boolean | null;
  promotedToFull: boolean | null;
  notAuditableReason: string | null;
  /** The full de-identified reconciliation output (readmission_findings.finding). */
  finding: FindingBlob | null;
  /** readmission_findings.omission_evidence — the same omissions, as their own column. */
  omissionEvidence: FindingBlob['omissions'] | null;
  // ── R1 (CDMSS-READMISSIONS-R1-PRD v1.1) — additive, all optional so a pre-R1 caller or
  //    fixture is still a complete SurfaceFinding. The route always populates them. ──
  /** Stored advisory judgements (§5) — 'suspected' | 'not_suggested' | 'unknown' | null
   *  (null = written before R1 and not yet backfilled). */
  preventableInjury?: string | null;
  negligence?: string | null;
  judgementRuleVersion?: string | null;
  /** The bounded join to discharge_extracted_cases for the INDEX document (§6, decision
   *  4). null = no document id, no row at DOC_EXTRACT_VERSION, or the join failed —
   *  the card renders thinner and the chips say unknown. Never invented. */
  indexCase?: IndexCaseSummary | null;
  /** R3 (CDMSS-READMISSIONS-R3-PRD v1.0, R3-5/R3-6): the return stay's HOSPITAL BILL as a
   *  value object — computed fresh by the route on every read from kx_billing_records, never
   *  stored, and the encounter id itself stays off the client. Absent (pre-R3 caller /
   *  fixture) reads exactly like state 'unknown'. */
  returnBill?: ReturnBill | null;
}

/** R3-6 — the four states of the return-stay bill. `billed` = rows exist, netRs is the
 *  computed SUM(net_amt) (no floor, no rounding — R3-1); `not_finalised` = looked, no rows;
 *  `unknown` = the batch fetch faulted (or nobody looked); `na` = OON / delayed-SSI, where
 *  no Even bill for a return stay can exist. */
export type ReturnBillState = 'billed' | 'not_finalised' | 'unknown' | 'na';
export interface ReturnBill { state: ReturnBillState; netRs: number | null; lines: number | null }

/** What the list route carries from the index extract (§6): the three clinical fields
 *  the path line shows, plus age/sex — used ONLY when the KX join has none (decision 13). */
export interface IndexCaseSummary {
  diagnosis: string | null;
  indication: string | null;
  procedure: string | null;
  age: number | null;
  sex: string | null;
}

/** The renderable subset of ReadmissionFinding (lib/readmission-reconcile-core.ts).
 *  Restated structurally rather than imported so this core stays free of the engine:
 *  the surface must keep rendering a row written by an OLDER engine version whose blob
 *  is missing fields the current type requires. Everything here is optional for that
 *  reason — a stored blob is data, not a type guarantee. */
export interface FindingBlob {
  findingClass?: string;
  verdictScope?: string;
  planned?: { verdict?: string; confidence?: number; evidenceIds?: string[]; enforcement?: string } | null;
  sameCondition?: { verdict?: string; confidence?: number; basis?: string; bundles?: string[] } | null;
  omissions?: Array<{ claim?: string; danger?: string; confidence?: string; caveat?: string; source?: string }> | null;
  exculpatory?: Array<{ claim?: string; corroborated?: boolean }> | null;
  /** `confidence` is FORWARD-COMPATIBLE, not current: the engine stores a confidence on
   *  `planned` and `sameCondition` but not on the money verdict (reconcile-core:506).
   *  Read here so a later engine that adds one renders it without a surface change —
   *  see verdictConfidence(), which falls back to the evidence track rather than
   *  borrowing a different verdict's number. */
  avoidable?: { verdict?: string; reason?: string; evidenceIds?: string[]; confidence?: number } | null;
  labProfile?: string;
  labTier?: string;
  labSourceProvenance?: Record<string, unknown> | null;
  /** R2 §3.4 — five-state coverage per template source. Absent on pre-R2 / tier-3 rows
   *  (never looked) → the chip reads `unknown`. Every field optional: a stored blob is data. */
  templateCoverage?: { ot?: { status?: string; count?: number } | null; pac?: { status?: string; count?: number } | null; progress?: { status?: string; count?: number } | null } | null;
  stabilityAssessment?: string;
  corroborationTrack?: string;
  provenance?: { interested?: number; disinterested?: number; ratio?: number; needsHumanReview?: boolean } | null;
  weakestStep?: string | null;
  refusalRecord?: Array<{ lookedFor?: string; found?: boolean; note?: string }> | null;
  readmitFactsPatientReported?: boolean;
  identityResolved?: boolean;
  promoteToFull?: boolean;
}

// ── Lanes ───────────────────────────────────────────────────────────────────────

/**
 * Clearest signal first (kickoff). The order IS the review protocol: a care manager
 * works top-down and the lanes that carry the strongest signal are the ones they reach
 * while they still have attention. 'excluded' is last and collapsed — it is the
 * sample-only lane (oncology / dialysis / obstetric), expected by design.
 */
export const LANE_ORDER = ['er_routed', 'tight_bounce', 'structural_30d', 'out_of_network', 'other', 'excluded'] as const;

/** Lanes whose findings are IN SCOPE to review (PRD §3 tile 3: "Lanes A + B"). */
export const REVIEW_LANES = ['er_routed', 'tight_bounce', 'structural_30d'] as const;

export interface LaneMeta {
  /** The care manager's words, not the engine's identifier. */
  title: string;
  /** The one-line "what is this lane" the mockup puts beside the heading. */
  blurb: string;
  /** Tailwind text colour for the lane bar — the mockup's severity ramp. */
  bar: string;
  /** Collapsed by default (the excluded sample). */
  collapsed?: boolean;
}

export const LANE_META: Record<string, LaneMeta> = {
  er_routed: { title: 'Clearest signal · ER-routed', blurb: 'came back through the ER · reviewed first', bar: 'bg-red-700' },
  tight_bounce: { title: 'Clearest signal · fast bounce', blurb: 'fast return to the same team', bar: 'bg-red-700' },
  structural_30d: { title: 'Second look', blurb: 'same team, within 30 days', bar: 'bg-amber-700' },
  out_of_network: { title: 'Out-of-network', blurb: 'readmitted at another hospital · our discharge reviewed only', bar: 'bg-brand' },
  other: { title: 'Other readmissions', blurb: 'condition pass only — promoted to a full review when the condition matches', bar: 'bg-slate-400' },
  excluded: { title: 'Held out by design', blurb: 'oncology, dialysis and obstetric returns — expected, not a signal', bar: 'bg-slate-300', collapsed: true },
};

export function laneMeta(lane: string): LaneMeta {
  return LANE_META[lane] ?? { title: lane, blurb: 'unrecognised lane — shown so it is never dropped', bar: 'bg-slate-300' };
}

/** Position in LANE_ORDER; an unknown lane sorts after every known one EXCEPT
 *  'excluded', which stays last so a new lane is never buried in the collapsed block. */
export function laneRank(lane: string): number {
  const i = LANE_ORDER.indexOf(lane as (typeof LANE_ORDER)[number]);
  if (i >= 0) return i;
  return LANE_ORDER.length - 1.5;   // between 'other' and 'excluded'
}

// ── Ordering ────────────────────────────────────────────────────────────────────

const ts = (s: string | null | undefined): number => {
  if (!s) return -Infinity;   // undated sorts last under a descending compare
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(s) ? s.replace(' ', 'T') : s);
  return Number.isFinite(t) ? t : -Infinity;
};

/**
 * Within a lane: needs_human_review first, then most recent readmission first
 * (kickoff). The flag wins over recency deliberately — an old finding the engine
 * refused to decide alone is still the one a human is needed for.
 */
export function sortWithinLane<T extends Pick<SurfaceFinding, 'needsHumanReview' | 'readmitAdmitAt'>>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ar = a.needsHumanReview === true ? 0 : 1;
    const br = b.needsHumanReview === true ? 0 : 1;
    if (ar !== br) return ar - br;
    return ts(b.readmitAdmitAt) - ts(a.readmitAdmitAt);
  });
}

export interface LaneGroup extends LaneMeta {
  lane: string;
  rows: SurfaceFinding[];
}

/** Group into the ordered lane sections the page renders. Empty lanes are omitted —
 *  a lane header with nothing under it reads as a bug, not as an empty queue. */
export function groupByLane(rows: SurfaceFinding[]): LaneGroup[] {
  const byLane = new Map<string, SurfaceFinding[]>();
  for (const r of rows) {
    const l = r.lane || 'other';
    const bucket = byLane.get(l);
    if (bucket) bucket.push(r); else byLane.set(l, [r]);
  }
  return [...byLane.entries()]
    .sort((a, b) => laneRank(a[0]) - laneRank(b[0]))
    .map(([lane, list]) => ({ lane, ...laneMeta(lane), rows: sortWithinLane(list) }));
}

// ── The review-count predicate ──────────────────────────────────────────────────

/**
 * The chooser badge and the "in review" tile count the SAME thing (PRD §3): an audited
 * finding whose money verdict is not 'justified'. A row still 'detected', or one the
 * agent cleared, is not work. Kept as one function so the badge and the page can never
 * disagree — two copies of this predicate is how a "6 to review" badge opens a page
 * showing 4.
 */
export function isReviewFinding(row: Pick<SurfaceFinding, 'auditStatus' | 'avoidable'>): boolean {
  return row.auditStatus === 'audited' && (row.avoidable === 'avoidable' || row.avoidable === 'needs_adjudication');
}

export function countReview(rows: Array<Pick<SurfaceFinding, 'auditStatus' | 'avoidable'>>): number {
  return rows.reduce((n, r) => n + (isReviewFinding(r) ? 1 : 0), 0);
}

// ── Verdict + badges ────────────────────────────────────────────────────────────

export type Tone = 'red' | 'amber' | 'emerald' | 'sky' | 'slate';

export interface VerdictLabel {
  label: string;
  /** The consequence, in the reviewer's terms — "for review" / "no review needed". */
  sub: string;
  tone: Tone;
}

/**
 * The money verdict, in words a care manager acts on. Out-of-network never carries an
 * avoidable verdict by design (decision 13 — we hold no record of the other hospital),
 * so it gets its own honest label rather than being shown as an absent verdict.
 */
export function verdictLabel(row: Pick<SurfaceFinding, 'avoidable' | 'findingClass' | 'auditStatus'>): VerdictLabel {
  // The held-out sample (Phase 2.1, decision 3). These rows are never audited, so they
  // carry no verdict at all — and they must NOT fall through to "No verdict / condition
  // pass only", which is lane-D language and would read as an audit that came back
  // empty. This one says what actually happened: we chose not to audit it.
  if (row.auditStatus === 'excluded') return { label: 'Held out', sub: 'expected by design', tone: 'slate' };
  if (row.auditStatus === 'not_auditable') return { label: 'Not auditable', sub: 'no discharge record to read', tone: 'slate' };
  if (row.findingClass === 'out_of_network') {
    return { label: 'Our discharge: review', sub: 'other hospital not audited', tone: 'amber' };
  }
  switch (row.avoidable) {
    case 'avoidable': return { label: 'Likely avoidable', sub: 'for review', tone: 'red' };
    case 'needs_adjudication': return { label: 'Needs adjudication', sub: 'for review', tone: 'amber' };
    case 'justified': return { label: 'Plausibly justified', sub: 'no review needed', tone: 'slate' };
    default: return { label: 'No verdict', sub: 'condition pass only', tone: 'slate' };
  }
}

/** 0–1 model confidence → the mockup's three words. Out-of-band or missing → null,
 *  so the chip is absent rather than claiming a confidence nobody stated. */
export function confidenceBand(n: number | null | undefined): 'high' | 'medium' | 'low' | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) return null;
  if (n >= 0.75) return 'high';
  if (n >= 0.5) return 'medium';
  return 'low';
}

export interface Badge { text: string; tone: Tone }

/**
 * The chip under the verdict. The mockup shows "confidence high", and the kickoff asks
 * for "the finding's confidence" — but NO confidence is stored against the money
 * verdict today (only against `planned` and `sameCondition`, which are different
 * questions). Borrowing one of those numbers would put a precise-looking figure under
 * a verdict it does not describe, which is the worst available option on a card a
 * reviewer trusts.
 *
 * So: use a real avoidable-confidence when a future engine writes one, and otherwise
 * show the strength-of-evidence the schema DOES carry — whether the verdict rests on a
 * disinterested lab or on prose alone (corroborationTrack). Same slot, same visual
 * weight, a claim that is actually backed.
 */
export function verdictConfidence(blob: FindingBlob | null | undefined): Badge | null {
  const band = confidenceBand(blob?.avoidable?.confidence);
  if (band) return { text: `confidence ${band}`, tone: band === 'high' ? 'emerald' : band === 'medium' ? 'amber' : 'slate' };
  if (blob?.corroborationTrack === 'lab_corroborated') return { text: 'lab-corroborated', tone: 'emerald' };
  if (blob?.corroborationTrack === 'prose_only') return { text: 'prose only', tone: 'amber' };
  return null;
}

/** Planned / unplanned. 'unknown' shows nothing: the temporal-provenance rule
 *  (reconcile rule 2) refusing to call it planned is not the same as calling it
 *  unplanned, and the chip must not blur the two. */
export function plannedBadge(planned: string | null | undefined): Badge | null {
  if (planned === 'planned') return { text: 'Planned', tone: 'slate' };
  if (planned === 'unplanned') return { text: 'Unplanned', tone: 'red' };
  return null;
}

export function conditionBadge(same: string | null | undefined): Badge | null {
  if (same === 'same') return { text: 'Same condition', tone: 'slate' };
  if (same === 'different') return { text: 'Different condition', tone: 'slate' };
  return null;
}

/** The coverage tier, named as what it MEANS for the evidence rather than "tier1". */
export function tierBadge(tier: string | null | undefined): Badge | null {
  switch (tier) {
    case 'tier1': return { text: 'Lab-backed', tone: 'emerald' };
    case 'tier2': return { text: 'Summary-only', tone: 'amber' };
    case 'tier3': return { text: 'Not auditable', tone: 'slate' };
    default: return null;
  }
}

export function gapBadge(gapDays: number | null | undefined): Badge | null {
  if (typeof gapDays !== 'number' || !Number.isFinite(gapDays)) return null;
  return { text: `gap ${gapDays < 10 ? gapDays.toFixed(1) : Math.round(gapDays)} d`, tone: 'slate' };
}

// STEMS, anchored at the START of a word only. A trailing \b would break every one of
// them: `\burolog\b` cannot match "Urology" because the 'y' is a word character. The
// short tokens that need to be whole words (`ortho`, `ent`) carry their own \b.
const SURGICAL = /\b(?:surg|orthopa?edic|ortho\b|urolog|neurosurg|cardiothoracic|ctvs|plastic\b|otorhinolaryngolog|ophthalmolog|gynae?colog|obstetric|bariatric|ent\b)/i;
const MEDICAL = /\b(?:medicine\b|medical\b|cardiolog|nephrolog|neurolog|gastroenterolog|pulmonolog|respiratory|endocrinolog|rheumatolog|ha?ematolog|infectious|geriatric|paediatric|pediatric|dermatolog|psychiatr)/i;

/**
 * The mockup's Medical|Surgical chip. NOT a stored flag (see the module docblock) —
 * derived from the department name, and only when the name is unambiguous. A
 * department matching both patterns ("Surgical Gastroenterology") or neither returns
 * null and the chip is omitted: on a card a reviewer uses to judge a real discharge,
 * an absent hint costs nothing and a wrong one costs trust.
 */
export function careLine(department: string | null | undefined): Badge | null {
  if (!department) return null;
  const s = SURGICAL.test(department);
  const m = MEDICAL.test(department);
  if (s === m) return null;   // both or neither — ambiguous
  return { text: s ? 'Surgical' : 'Medical', tone: 'slate' };
}

/** Every chip on a finding card, in the mockup's order. Nulls are dropped, so a
 *  sparse row simply shows fewer chips. */
export function badgesFor(row: SurfaceFinding): Badge[] {
  const out: Array<Badge | null> = [];
  if (row.findingClass === 'out_of_network') {
    out.push({ text: 'Patient-reported', tone: 'slate' });
    if (row.cmNote) out.push({ text: 'Care-manager note', tone: 'sky' });
    out.push({ text: 'index side only', tone: 'slate' });
  }
  out.push(plannedBadge(row.planned), conditionBadge(row.sameCondition), careLine(row.indexDepartment), tierBadge(row.labTier), gapBadge(row.gapDays));
  if (row.promotedToFull) out.push({ text: 'promoted to full review', tone: 'sky' });
  return out.filter((b): b is Badge => b != null);
}

// ── Summary tiles (PRD §3) ──────────────────────────────────────────────────────

export interface SurfaceTiles {
  /** Readmissions within 30 days ÷ IP discharges in the window. Null when the
   *  denominator is unavailable — the tile shows "—", never a rate built on a
   *  guessed denominator. */
  thirtyDayRate: number | null;
  readmissionCount: number;
  inReviewLanes: number;
  outOfNetwork: number;
}

/**
 * `ipDischarges` is the db13 denominator, read best-effort by the route. It is the ONLY
 * input here that does not come from the findings table, and it is the only reason a
 * tile can be null.
 */
export function computeTiles(
  rows: Array<Pick<SurfaceFinding, 'lane' | 'findingClass' | 'gapDays' | 'auditStatus' | 'avoidable'>>,
  ipDischarges: number | null,
): SurfaceTiles {
  const pairs = rows.filter((r) => r.findingClass !== 'out_of_network');
  const within30 = pairs.filter((r) => typeof r.gapDays === 'number' && r.gapDays <= 30).length;
  return {
    thirtyDayRate: typeof ipDischarges === 'number' && ipDischarges > 0 ? within30 / ipDischarges : null,
    readmissionCount: pairs.length,
    inReviewLanes: rows.filter((r) => (REVIEW_LANES as readonly string[]).includes(r.lane)).length,
    outOfNetwork: rows.filter((r) => r.findingClass === 'out_of_network').length,
  };
}

// ── Small display helpers (shared by the board so formatting is tested once) ────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "7 Apr" in IST. Returns null on anything unparseable rather than "Invalid Date". */
export function shortDate(iso: string | null | undefined): string | null {
  const t = ts(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + 5.5 * 3_600_000);   // render in IST, the clinic's clock
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** The identity line: name first (decision 5), UHID as the secondary identifier, and
 *  the UHID ALONE when the KX join found nothing — a failed join must never render a
 *  blank card. */
export function identityLine(row: Pick<SurfaceFinding, 'patientName' | 'uhid' | 'ageGender'>): string {
  const parts = [row.patientName, row.uhid, row.ageGender].filter((p): p is string => !!p && p.trim() !== '');
  return parts.length ? parts.join(' · ') : 'Unidentified patient';
}

// ── R2: the finding-class union incl. the delayed-SSI LAYOUT GUARD (constraints 6-12) ──
//
// 'delayed_ssi' = index IP + a later wound/SSI signal with NO second KX IP stay. Not OON,
// not Even→Even. R2 ships NO detector and NO producer of this class — only the pure guards
// below, so the card, chips, judgement cells and brief already survive it the day a later
// ruling adds detection. Nothing on live data reaches this branch in R2.
export type FindingClass = 'even_even' | 'out_of_network' | 'delayed_ssi';
export const FINDING_CLASSES: readonly FindingClass[] = ['even_even', 'out_of_network', 'delayed_ssi'];
/** Addendum A3: the ONE narrowing from the stored text column to the closed union. An
 *  unrecognised value (a stored row is data, not a type guarantee) falls back to
 *  'even_even' — the layout that hides nothing: no cell goes n/a, no side is dropped, every
 *  chip reads unknown at worst. It never guesses OON or delayed-SSI structure. */
export function toFindingClass(v: unknown): FindingClass {
  return (FINDING_CLASSES as readonly unknown[]).includes(v) ? (v as FindingClass) : 'even_even';
}
export const DELAYED_SSI_CLASS: FindingClass = 'delayed_ssi';
export const isDelayedSsi = (row: Pick<SurfaceFinding, 'findingClass'>): boolean => row.findingClass === DELAYED_SSI_CLASS;

// ── R1: the case card (CDMSS-READMISSIONS-R1-PRD v1.1 §3/§4, ratified 17 Aug 2026) ────
// Everything below is additive. The lane helpers above stay (the route payload is still
// lane-grouped, decision 11); the board flattens client-side and uses these.

/** Decision 2 — the rows the default view hides behind one toggle: the held-out sample
 *  (`excluded` lane / status) and the not-auditable rows. The badge predicate
 *  (isReviewFinding) is NOT touched by this. */
export function isHeldOut(row: Pick<SurfaceFinding, 'lane' | 'auditStatus'>): boolean {
  return row.lane === 'excluded' || row.auditStatus === 'excluded' || row.auditStatus === 'not_auditable';
}

/**
 * §3 order for the flat list: rows matching the review predicate first, then the other
 * audited rows, then everything else (detected / not-auditable / held-out); newest
 * readmit first within each group. Stable on ties.
 */
export function sortForCardList<T extends Pick<SurfaceFinding, 'auditStatus' | 'avoidable' | 'readmitAdmitAt'>>(rows: T[]): T[] {
  const rank = (r: T): number => (isReviewFinding(r) ? 0 : r.auditStatus === 'audited' ? 1 : 2);
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const d = rank(a.r) - rank(b.r);
      if (d !== 0) return d;
      const t = ts(b.r.readmitAdmitAt) - ts(a.r.readmitAdmitAt);
      return t !== 0 ? t : a.i - b.i;
    })
    .map((x) => x.r);
}

/** §3 — the plain-text counts line under the list header. */
export function countsLine(reviewCount: number, pendingCount: number): string {
  return `${reviewCount} to review · ${pendingCount} pending audit`;
}

// ── identity (decision 13: KX-first) ─────────────────────────────────────────────

const sexInitial = (sex: string | null | undefined): string | null => {
  if (!sex) return null;
  const c = sex.trim().charAt(0).toUpperCase();
  return c === 'M' || c === 'F' ? c : sex.trim();
};

/** Age/sex for the identity line: the KX `ageGender` ALWAYS wins; the extract fills it
 *  only when KX has none, and renders as "34/M" so it cannot be mistaken for the KX
 *  string. Null when neither knows. */
export function ageSexForCard(row: Pick<SurfaceFinding, 'ageGender' | 'indexCase'>): string | null {
  if (row.ageGender && row.ageGender.trim() !== '') return row.ageGender;
  const c = row.indexCase;
  if (!c) return null;
  const parts = [typeof c.age === 'number' && Number.isFinite(c.age) ? String(c.age) : null, sexInitial(c.sex)]
    .filter((p): p is string => !!p);
  return parts.length ? parts.join('/') : null;
}

/** Zone 1: `Name · UHID · age/sex` from the KX join, extract age/sex only as the
 *  fallback above; name unresolved → UHID alone; never a blank card. */
export function cardIdentityLine(row: Pick<SurfaceFinding, 'patientName' | 'uhid' | 'ageGender' | 'indexCase'>): string {
  return identityLine({ patientName: row.patientName, uhid: row.uhid, ageGender: ageSexForCard(row) });
}

// ── situation line (decision 15) ─────────────────────────────────────────────────

/** Directly under the path, ONLY when true: unplanned AND same-condition (R1). Not a
 *  judgement, not stored. Reads the scalar columns first, the blob as the fallback. */
export function situationLine(row: Pick<SurfaceFinding, 'planned' | 'sameCondition' | 'finding' | 'findingClass'>): string | null {
  // R2 constraint 7: the delayed-SSI class has its own line and NEVER also fires
  // "Unplanned return" — that line is the IP–IP pair's only.
  if (isDelayedSsi(row)) return 'Situation · Delayed SSI';
  const planned = row.planned ?? row.finding?.planned?.verdict ?? null;
  const same = row.sameCondition ?? row.finding?.sameCondition?.verdict ?? null;
  return planned === 'unplanned' && same === 'same' ? 'Situation · Unplanned return' : null;
}

// ── coverage chips (§3 zone 3) ───────────────────────────────────────────────────

/** R2 (constraints 13-16): five states. `unknown` = never looked OR the fetch faulted;
 *  `absent` = looked, no row; `empty` = looked, rows but no usable text. Every state string
 *  is user-visible copy (see chipText). */
export type ChipState = 'present' | 'empty' | 'absent' | 'unknown' | 'n/a';
export interface CoverageChip { key: string; label: string; state: ChipState }

/** templateCoverage status → chip state. `fetch_failed` and an absent object are BOTH
 *  `unknown` (constraint 13: a fault is never `absent`); anything unrecognised is `unknown`. */
export function templateChipState(entry: { status?: string | null } | null | undefined): ChipState {
  switch (entry?.status) {
    case 'present': return 'present';
    case 'empty': return 'empty';
    case 'absent': return 'absent';
    default: return 'unknown';   // 'fetch_failed', missing, unrecognised
  }
}

/** The chip's copy per state (constraints §4b): present solid, `empty` → "OT empty",
 *  `absent` → "OT none", `unknown` → bare label (the R1 look), `n/a` → "OT n/a" greyed. */
export function chipText(c: Pick<CoverageChip, 'label' | 'state'> & { key?: string }): string {
  switch (c.state) {
    case 'empty': return `${c.label} empty`;
    // R3 §3.3 — the ONE documented divergence from the ratified `<label> none` copy: an
    // absent bill is almost always billing that has not been finalised yet, not a permanent
    // absence, so the Bill chip's `absent` reads `Bill pending`. Every other chip is unchanged.
    case 'absent': return c.key === 'bill' ? `${c.label} pending` : `${c.label} none`;
    case 'n/a': return `${c.label} n/a`;
    default: return c.label;   // present, unknown — the style tells them apart
  }
}

/** R3-7 (constraint 22, fulfilled): the Bill chip is driven by the same returnBill state the
 *  cell reads — billed → present · not_finalised → absent (copy `Bill pending`) · unknown /
 *  absent object → unknown · the class rules → n/a. */
export function billChipState(row: Pick<SurfaceFinding, 'findingClass' | 'returnBill'>): ChipState {
  if (row.findingClass === 'out_of_network' || isDelayedSsi(row)) return 'n/a';
  switch (row.returnBill?.state) {
    case 'billed': return 'present';
    case 'not_finalised': return 'absent';
    case 'na': return 'n/a';
    default: return 'unknown';   // 'unknown', missing object (pre-R3 caller / fixture)
  }
}

/** The eight chips, in the mockup's order. Missing is `unknown`, never "uneventful".
 *  OT / PAC / Progress read the R2 templateCoverage; Bill reads the R3 returnBill (n/a on
 *  OON / no-second-stay). */
export function coverageChips(row: Pick<SurfaceFinding, 'findingClass' | 'cmNote' | 'finding' | 'indexCase' | 'returnBill'>): CoverageChip[] {
  const oon = row.findingClass === 'out_of_network';
  const noSecondStay = isDelayedSsi(row);   // R2 guard: Readmit DS and Bill are structurally n/a
  // labSourceProvenance is typed as an open record on the blob — narrow each field.
  const p = row.finding?.labSourceProvenance ?? null;
  const indexCaseProv = typeof p?.indexCase === 'string' && p.indexCase !== '';
  const readmitCaseProv = typeof p?.readmitCase === 'string' && p.readmitCase !== '';
  const labs = typeof p?.structuredLabCount === 'number' && p.structuredLabCount > 0;
  const heldForm = typeof row.cmNote === 'string' && row.cmNote.trim() !== '';   // a form was held — LEAD or OON
  const cov = row.finding?.templateCoverage ?? null;
  return [
    { key: 'index_ds', label: 'Index DS', state: indexCaseProv || row.indexCase != null ? 'present' : 'unknown' },
    { key: 'readmit_ds', label: 'Readmit DS', state: noSecondStay ? 'n/a' : readmitCaseProv ? 'present' : oon ? 'n/a' : 'unknown' },
    { key: 'labs', label: 'Labs', state: labs ? 'present' : 'unknown' },
    { key: 'ot', label: 'OT', state: templateChipState(cov?.ot) },
    { key: 'pac', label: 'PAC', state: templateChipState(cov?.pac) },
    { key: 'progress', label: 'Progress', state: templateChipState(cov?.progress) },
    { key: 'post_ipd', label: 'POST_IPD', state: heldForm ? 'present' : 'unknown' },
    { key: 'bill', label: 'Bill', state: billChipState(row) },
  ];
}

// ── judgements + bill (§3 zone 4, §4 display mapping) ────────────────────────────

/** Medical justification — a DISPLAY mapping of the stored money verdict, not stored
 *  itself (§4). Null on an audited row reads as "Needs adjudication". */
export function justificationLabel(row: Pick<SurfaceFinding, 'avoidable'>): string {
  switch (row.avoidable) {
    case 'justified': return 'Justified';
    case 'needs_adjudication': return 'Needs adjudication';
    case 'avoidable': return 'Not justified';
    default: return 'Needs adjudication';
  }
}

/** The CARD's Medical-justification cell (PRD v1.1 Addendum A2): out-of-network rows read
 *  `Index side only` — no justification verdict is ever made on the other hospital's stay
 *  (§5a), and the cell must not imply one. Even–Even rows keep the §4 mapping verbatim. */
export function justificationCell(row: Pick<SurfaceFinding, 'avoidable' | 'findingClass'>): string {
  if (isDelayedSsi(row)) return 'n/a';   // R2 constraint 10: no return stay to justify
  return row.findingClass === 'out_of_network' ? 'Index side only' : justificationLabel(row);
}

/** The stored judgement values, in words. Anything unrecognised (incl. a pre-R1 NULL) is
 *  `Unknown` — the honest reading of "not derived yet". */
export function judgementLabel(v: string | null | undefined): 'Suspected' | 'Not suggested' | 'Unknown' {
  if (v === 'suspected') return 'Suspected';
  if (v === 'not_suggested') return 'Not suggested';
  return 'Unknown';
}

// ── R3: the return-stay bill (CDMSS-READMISSIONS-R3-PRD v1.0 §3.2 / §3.3) ───────────────

/** Rupees, null-honest: NEVER called with null — the states handle absence (charge-master's
 *  formatINR renders ₹0 for null, which is exactly the lie R3-6 forbids). `en-IN` grouping
 *  (₹1,84,000); the value renders as computed — no floor, no rounding rule (R3-1). Fraction
 *  digits are capped at the paise (a currency has two decimals — that is not rounding). */
export function formatBillRs(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/** The ONE mapping from what the route learned to the value object it emits (R3-6):
 *  OON / delayed-SSI → na · batch fault (`ok:false`) → unknown · no readmit encounter id
 *  (nothing could be looked up) → unknown · id absent from the totals → not_finalised ·
 *  present → billed with the computed sum. Pure; both routes call it. */
export function returnBillFor(input: {
  findingClass: FindingClass;
  readmitEncounterId: string | null;
  ok: boolean;
  total: { netRs: number; lines: number } | null | undefined;
}): ReturnBill {
  if (input.findingClass === 'out_of_network' || input.findingClass === DELAYED_SSI_CLASS) return { state: 'na', netRs: null, lines: null };
  if (!input.ok || !input.readmitEncounterId) return { state: 'unknown', netRs: null, lines: null };
  const t = input.total;
  if (!t || !Number.isFinite(t.netRs)) return { state: 'not_finalised', netRs: null, lines: null };
  return { state: 'billed', netRs: t.netRs, lines: t.lines };
}

/** The `Return stay bill` cell (R3-6): `n/a` on OON / delayed-SSI · billed → the rupee figure ·
 *  not_finalised → `bill not finalised` · anything else (unknown, na-by-state, no object at
 *  all) → the R1 `unknown — not yet measured`. */
export function returnStayBill(row: Pick<SurfaceFinding, 'findingClass' | 'returnBill'>): string {
  if (row.findingClass === 'out_of_network' || isDelayedSsi(row)) return 'n/a';
  const b = row.returnBill;
  if (b?.state === 'billed' && typeof b.netRs === 'number' && Number.isFinite(b.netRs)) return formatBillRs(b.netRs);
  if (b?.state === 'not_finalised') return 'bill not finalised';
  return 'unknown — not yet measured';
}

/** The small line under a BILLED cell only (§3.3); undefined otherwise. */
export const BILL_CELL_SUB = 'hospital bill · net of refunds · fresh at load';
export function returnStayBillSub(row: Pick<SurfaceFinding, 'findingClass' | 'returnBill'>): string | undefined {
  if (row.findingClass === 'out_of_network' || isDelayedSsi(row)) return undefined;
  return row.returnBill?.state === 'billed' && typeof row.returnBill.netRs === 'number' ? BILL_CELL_SUB : undefined;
}

/** The board's quiet notice when the batch bill fetch faulted (§3.3, `billsResolved === false`). */
export const BILLS_UNAVAILABLE_NOTICE = 'Bill amounts are unavailable right now — cells show unknown';

/** Small permanent text under the negligence cell. */
export const NEGLIGENCE_ADVISORY = 'advisory — not a court or council finding';

// ── path line (§3 zone 2) ────────────────────────────────────────────────────────

/**
 * `{index_department} → {readmit side}` · dates · gap · payer(s) · diagnosis · indication ·
 * procedure — as ordered display segments; the board joins them. Any null segment is
 * DROPPED, never rendered as "null". OON: readmit side is `out of network`. The layout
 * does not assume a second admission: no readmit department and no admit date renders
 * `no second IP stay`; a dated return with no department renders `unknown`.
 */
export function pathSegments(row: Pick<SurfaceFinding, 'findingClass' | 'indexDepartment' | 'readmitDepartment' | 'indexDischargeAt' | 'readmitAdmitAt' | 'gapDays' | 'payerIndex' | 'payerReadmit' | 'indexCase'>): string[] {
  const oon = row.findingClass === 'out_of_network';
  const readmitSide = oon ? 'out of network'
    : row.readmitDepartment ?? (row.readmitAdmitAt ? 'unknown' : 'no second IP stay');
  const out: string[] = [`${row.indexDepartment ?? 'unknown'} → ${readmitSide}`];
  const from = shortDate(row.indexDischargeAt);
  const to = shortDate(row.readmitAdmitAt);
  if (from || to) out.push(`${from ? `discharged ${from}` : ''}${from && to ? ' → ' : ''}${to ? (oon ? `readmitted elsewhere ~${to}` : `readmitted ${to}`) : ''}`);
  const gap = gapBadge(row.gapDays);
  if (gap) out.push(gap.text);
  const payers = [row.payerIndex, row.payerReadmit].filter((p): p is string => !!p);
  if (payers.length) out.push(payers[0] === payers[1] ? payers[0] : payers.join(' / '));
  if (row.indexCase?.diagnosis) out.push(row.indexCase.diagnosis);
  if (row.indexCase?.indication) out.push(row.indexCase.indication);
  if (row.indexCase?.procedure) out.push(row.indexCase.procedure);
  return out;
}
