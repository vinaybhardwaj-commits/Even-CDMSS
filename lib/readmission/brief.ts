/**
 * lib/readmission/brief.ts — the PURE composer for the downloadable `.md` case brief
 * (CDMSS-READMISSIONS-R1-PRD v1.1 §7). Built client-side on button press from data we
 * already hold: the finding row the card shows, plus the index/readmit extract subsets
 * the case route returns. NO model call. NO write. NO network in here.
 *
 * PHI POSTURE (§7): this is the care-manager copy — patient and doctor names MAY appear.
 * Mobiles never: any run of ten or more digits inside free text is withheld before it is
 * written. Every claim is source-tagged. Missing renders `unknown`. Nothing is invented:
 * no rupees, no packages, no "clean intra-op".
 *
 * Deterministic on its input (the golden-file test pins the structure): the only clock is
 * the optional `generatedAt` the caller passes.
 */
import type { ExtractedCase } from '../doc-audit-core';
import {
  cardIdentityLine, chipText, coverageChips, isDelayedSsi, judgementLabel, justificationLabel, laneMeta,
  NEGLIGENCE_ADVISORY, returnStayBill, situationLine, type SurfaceFinding,
} from '../readmission-surface-core';

/** The subset of an ExtractedCase the brief reads (§6). Every field nullable — an older or
 *  partial extract simply contributes fewer lines. */
export interface ExtractSubset {
  diagnosis: string | null;
  indication: string | null;
  procedure: string | null;
  investigations: string[];
  treatments: string[];
  medications: string[];
  courseSummary: string | null;
  disposition: string | null;
  followUp: string | null;
  riskFactors: string[];
  patient: { age: number | null; sex: string | null };
}

const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((x): x is string => x != null) : []);

/** Shape a stored ExtractedCase (any vintage) into the bounded subset. Null in → null out. */
export function toExtractSubset(e: ExtractedCase | null | undefined): ExtractSubset | null {
  if (!e || typeof e !== 'object') return null;
  return {
    diagnosis: str(e.diagnosis), indication: str(e.indication), procedure: str(e.procedure),
    investigations: strs(e.investigations), treatments: strs(e.treatments), medications: strs(e.medications),
    courseSummary: str(e.courseSummary), disposition: str(e.disposition), followUp: str(e.followUp),
    riskFactors: strs(e.riskFactors),
    patient: {
      age: typeof e.patient?.age === 'number' && Number.isFinite(e.patient.age) ? e.patient.age : null,
      sex: str(e.patient?.sex),
    },
  };
}

export interface BriefInput {
  /** The card's row — identity already resolved by the list route (decision 13). */
  row: SurfaceFinding;
  indexExtract: ExtractSubset | null;
  readmitExtract: ExtractSubset | null;
  /** Optional ISO/IST stamp for the header line; omitted when absent (golden test). */
  generatedAt?: string | null;
  /** Whether the case route answered. False → the brief says so and stays thinner. */
  detailFetched?: boolean;
}

export interface Brief { filename: string; markdown: string }

// ── fixed sentences (§7, verbatim) ───────────────────────────────────────────────
export const BILL_SENTENCE_EVEN = 'Return stay bill not yet measured — no figure is available for this return.';
export const BILL_SENTENCE_OON = 'No other-hospital bill exists for this return.';
/** R2 delayed-SSI layout guard (constraint 11) — no producer of that class exists yet. */
export const BILL_SENTENCE_NO_SECOND_STAY = 'No second stay — no return bill.';
export const CANNOT_SAY_LINES: readonly string[] = [
  'No policy rule follows from n=1 — one case is a case, not a pattern.',
  'This is not a court or council finding; every judgement above is advisory and human-decided.',
  'Ratification of any low-value-care pattern belongs to the LVC board, not to this brief.',
];

// ── helpers ──────────────────────────────────────────────────────────────────────

const UNKNOWN = 'unknown';
const u = (v: string | number | null | undefined): string => (v == null || v === '' ? UNKNOWN : String(v));

/**
 * Mobiles never — PHONE-SHAPED, not size-shaped (PRD v1.1 Addendum A1). A candidate run of
 * digits with spaces/hyphens is withheld only when ALL hold:
 *   (a) stripped of non-digits it is exactly 10 digits, or 11 with a leading 0, or 12
 *       with a leading 91 (Indian mobile, trunk-prefixed, or country-prefixed);
 *   (b) the raw match does not span a newline (a pasted numeric block is not a number);
 *   (c) the raw match contains no date shape — `\d{4}[-/]\d{1,2}` or
 *       `\d{1,2}[-/]\d{1,2}[-/]\d{2,4}`, each anchored to digit-token boundaries — so
 *       adjacent dashed dates survive intact.
 * Anything else (labs, vitals, dates, ids) is left exactly as written.
 */
const PHONE_CANDIDATE = /\+?\d[\d\s-]{8,}\d/g;
// Anchored to digit-token boundaries: a year is a 4-digit TOKEN. Unanchored, `\d{4}[-/]\d{1,2}`
// matches inside "98765-43210" and the mandated `+91 98765-43210` case would survive.
const DATE_SHAPES = [/(?<!\d)\d{4}[-/]\d{1,2}(?!\d)/, /(?<!\d)\d{1,2}[-/]\d{1,2}[-/]\d{2,4}(?!\d)/];
export function isPhoneShaped(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  const a = digits.length === 10 || (digits.length === 11 && digits.startsWith('0')) || (digits.length === 12 && digits.startsWith('91'));
  if (!a) return false;
  if (/\n/.test(raw)) return false;
  return !DATE_SHAPES.some((rx) => rx.test(raw));
}
export function withholdNumbers(text: string): string {
  return text.replace(PHONE_CANDIDATE, (m) => (isPhoneShaped(m) ? '[number withheld]' : m));
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** §7 filename rule. */
export function briefFilename(row: Pick<SurfaceFinding, 'uhid' | 'patientName' | 'dedupKey'>): string {
  const uhid = row.uhid ? slug(row.uhid) : '';
  if (!uhid) return `${slug(row.dedupKey) || 'case'}-readmission-brief.md`;
  const tokens = (row.patientName ?? '').trim().split(/\s+/).filter(Boolean);
  const surname = tokens.length ? slug(tokens[tokens.length - 1]) : '';
  return surname ? `${uhid}-${surname}-readmission-brief.md` : `${uhid}-readmission-brief.md`;
}

/** "7 Apr 2026" in IST; unknown when unparseable. */
function longDate(iso: string | null | undefined): string {
  if (!iso) return UNKNOWN;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(iso) ? iso.replace(' ', 'T') : iso);
  if (!Number.isFinite(t)) return UNKNOWN;
  const d = new Date(t + 5.5 * 3_600_000);
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${M[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const gapText = (g: number | null | undefined): string =>
  typeof g === 'number' && Number.isFinite(g) ? `${g < 10 ? g.toFixed(1) : Math.round(g)} days` : UNKNOWN;

const T_ROW = '[finding row]';
const T_INDEX = '[index DS, extracted]';
const T_READMIT = '[readmit DS, extracted]';
const T_FORM = '[POST_IPD form, patient-reported]';
const T_AUDIT = '[audit finding]';

function extractLines(x: ExtractSubset | null, tag: string): string[] {
  const out: string[] = [];
  if (!x) return out;
  const line = (k: string, v: string | null) => { if (v) out.push(`- ${k}: ${withholdNumbers(v)} ${tag}`); };
  line('Diagnosis', x.diagnosis);
  line('Indication', x.indication);
  line('Procedure', x.procedure);
  line('Course', x.courseSummary);
  if (x.investigations.length) out.push(`- Investigations: ${withholdNumbers(x.investigations.join('; '))} ${tag}`);
  if (x.treatments.length) out.push(`- Treatments: ${withholdNumbers(x.treatments.join('; '))} ${tag}`);
  if (x.medications.length) out.push(`- Medications: ${withholdNumbers(x.medications.join('; '))} ${tag}`);
  if (x.riskFactors.length) out.push(`- Risk factors: ${withholdNumbers(x.riskFactors.join('; '))} ${tag}`);
  line('Disposition', x.disposition);
  line('Follow-up', x.followUp);
  return out;
}

// ── the composer ─────────────────────────────────────────────────────────────────

export function composeBrief(input: BriefInput): Brief {
  const { row } = input;
  const oon = row.findingClass === 'out_of_network';
  const audited = row.auditStatus === 'audited';
  const blob = row.finding;
  const omissions = row.omissionEvidence ?? blob?.omissions ?? [];
  const situation = situationLine(row);
  const lane = laneMeta(row.lane);
  const L: string[] = [];

  L.push(`# Readmission case brief — ${cardIdentityLine(row)}`);
  L.push('');
  L.push(`Care-manager copy · advisory throughout · dedup key \`${row.dedupKey}\``);
  if (input.generatedAt) L.push(`Generated ${input.generatedAt} (IST)`);
  if (input.detailFetched === false) L.push('Case detail could not be fetched — this brief is built from the card row alone.');
  L.push('');

  // ── Part 1 ──
  L.push('## Part 1 — Intern presentation');
  L.push('');
  L.push('### Why this case');
  L.push(`- Lane: ${lane.title} — ${lane.blurb} ${T_ROW}`);
  L.push(`- Finding class: ${oon ? 'out of network (readmitted at another hospital; our discharge reviewed only)' : 'Even → Even'} ${T_ROW}`);
  L.push(`- Gap: ${gapText(row.gapDays)} ${T_ROW}`);
  if (situation) L.push(`- ${situation} ${T_AUDIT}`);
  L.push('');

  L.push('### Index stay');
  L.push(`- Department: ${u(row.indexDepartment)} ${T_ROW}`);
  if (row.indexDoctor) L.push(`- Treating doctor: ${row.indexDoctor} ${T_ROW}`);
  L.push(`- Discharge date: ${longDate(row.indexDischargeAt)} ${T_ROW}`);
  L.push(`- Payer: ${u(row.payerIndex)} ${T_ROW}`);
  const idx = extractLines(input.indexExtract, T_INDEX);
  if (idx.length) L.push(...idx);
  else if (row.indexCase && (row.indexCase.diagnosis || row.indexCase.indication || row.indexCase.procedure)) {
    // The case route did not answer but the card carried the summary — use what we hold.
    if (row.indexCase.diagnosis) L.push(`- Diagnosis: ${withholdNumbers(row.indexCase.diagnosis)} ${T_INDEX}`);
    if (row.indexCase.indication) L.push(`- Indication: ${withholdNumbers(row.indexCase.indication)} ${T_INDEX}`);
    if (row.indexCase.procedure) L.push(`- Procedure: ${withholdNumbers(row.indexCase.procedure)} ${T_INDEX}`);
  } else L.push(`- Diagnosis / indication / procedure: ${UNKNOWN} — no index extract available`);
  L.push('');

  L.push('### Interval');
  L.push(`- ${gapText(row.gapDays)} between index discharge (${longDate(row.indexDischargeAt)}) and return (${longDate(row.readmitAdmitAt)}) ${T_ROW}`);
  L.push('');

  L.push('### Return');
  if (oon) {
    L.push(`- Department: out of network — no second IP stay at Even ${T_ROW}`);
    L.push(`- Reported readmit date: ${longDate(row.readmitAdmitAt)} ${T_FORM}`);
    L.push(`- Payer: ${u(row.payerReadmit)} ${T_ROW}`);
    L.push(row.cmNote
      ? `- POST_IPD form held: ${withholdNumbers(row.cmNote)} ${T_FORM}`
      : `- POST_IPD form: ${UNKNOWN} — no form text held ${T_ROW}`);
  } else {
    L.push(`- Department: ${u(row.readmitDepartment)} ${T_ROW}`);
    if (row.readmitDoctor) L.push(`- Treating doctor: ${row.readmitDoctor} ${T_ROW}`);
    L.push(`- Admit date: ${longDate(row.readmitAdmitAt)} ${T_ROW}`);
    L.push(`- Payer: ${u(row.payerReadmit)} ${T_ROW}`);
    if (row.cmNote) L.push(`- POST_IPD form held: ${withholdNumbers(row.cmNote)} ${T_FORM}`);
    const rd = extractLines(input.readmitExtract, T_READMIT);
    if (rd.length) L.push(...rd);
  }
  L.push('');

  L.push('### Artefacts');
  L.push('| Artefact | State |');
  L.push('|---|---|');
  // Addendum A2 (+ amendment): empty / absent print the ratified chip copy (`OT empty` /
  // `OT none`); present / unknown print the words `present` / `unknown` — the card tells
  // them apart by style, the brief has no style; `n/a` as-is. Brief only; the card is unchanged.
  for (const c of coverageChips(row)) L.push(`| ${c.label} | ${c.state === 'empty' || c.state === 'absent' ? chipText(c) : c.state} |`);
  L.push('');

  L.push('### Assessment');
  if (!audited) {
    L.push(`- Not yet audited${row.auditStatus === 'not_auditable' && row.notAuditableReason ? ` — ${row.notAuditableReason}` : row.auditStatus === 'excluded' ? ' — held out by design' : ''} ${T_ROW}`);
  } else {
    // §4 display mapping verbatim; an OON row carries no avoidable verdict by design (§5a),
    // so the null rule reads "Needs adjudication" — the qualifier says why.
    L.push(`- Medical justification: ${justificationLabel(row)}${oon ? ' (no avoidable verdict is made on the other hospital)' : ''} ${T_AUDIT}`);
    if (blob?.avoidable?.reason) L.push(`  - Reason: ${withholdNumbers(blob.avoidable.reason)} ${T_AUDIT}`);
    L.push(`- Preventable injury: ${judgementLabel(row.preventableInjury)} (rule ${u(row.judgementRuleVersion)}) ${T_AUDIT}`);
    if (omissions.length) {
      for (const o of omissions) {
        L.push(`  - Omission: ${withholdNumbers(u(o.claim))} — ${u(o.danger)} danger, ${u(o.confidence)} confidence${o.source === 'derived' ? ', from the numbers' : ''} ${T_AUDIT}`);
      }
    } else L.push(`  - No omission recorded ${T_AUDIT}`);
    L.push(`- Negligence: ${judgementLabel(row.negligence)} — ${NEGLIGENCE_ADVISORY} ${T_AUDIT}`);
    const ex = blob?.exculpatory ?? [];
    if (ex.length) {
      for (const e of ex) L.push(`  - Exculpatory: ${withholdNumbers(u(e.claim))} — ${e.corroborated ? 'corroborated' : 'uncorroborated'} ${T_AUDIT}`);
    } else L.push(`  - No exculpatory claim recorded ${T_AUDIT}`);
    L.push(`- Stability at discharge: ${u(blob?.stabilityAssessment)} · evidence track: ${u(blob?.corroborationTrack)} · lab tier: ${u(row.labTier)} ${T_AUDIT}`);
    L.push(`- Return stay bill: ${returnStayBill(row)} ${T_ROW}`);
  }
  L.push('');

  L.push('### Looked for and not found');
  const refusals = (blob?.refusalRecord ?? []).filter((r) => r.found === false);
  if (refusals.length) for (const r of refusals) L.push(`- ${u(r.lookedFor)}${r.note ? ` — ${withholdNumbers(r.note)}` : ''} ${T_AUDIT}`);
  else L.push(`- ${audited ? 'Nothing recorded as looked-for-and-absent' : UNKNOWN} ${T_AUDIT}`);
  L.push('');

  // ── Part 2 ──
  L.push('## Part 2 — Actuarial / low-value-care');
  L.push('');
  L.push(`- Payer: ${oon ? `out of network (index payer ${u(row.payerIndex)})` : `Even–Even (index ${u(row.payerIndex)} → return ${u(row.payerReadmit)})`} ${T_ROW}`);
  L.push(`- Bill: ${isDelayedSsi(row) ? BILL_SENTENCE_NO_SECOND_STAY : oon ? BILL_SENTENCE_OON : BILL_SENTENCE_EVEN}`);
  L.push(`- Candidate pattern: ${candidatePattern(row, input.indexExtract, omissions.length)}`);
  L.push('- What we cannot say:');
  for (const c of CANNOT_SAY_LINES) L.push(`  - ${c}`);
  L.push('');

  return { filename: briefFilename(row), markdown: L.join('\n') };
}

/** One deterministic sentence from the judgements (§7). Never asserts a pattern that the
 *  situation line does not already support. */
export function candidatePattern(
  row: Pick<SurfaceFinding, 'planned' | 'sameCondition' | 'finding' | 'auditStatus' | 'indexCase' | 'findingClass'>,
  indexExtract: ExtractSubset | null,
  nOmissions: number,
): string {
  if (row.auditStatus !== 'audited') return 'None — not yet audited.';
  // Only the IP–IP situation asserts this pattern; the delayed-SSI line (R2 guard) does not.
  if (situationLine(row) === 'Situation · Unplanned return') {
    const after = indexExtract?.procedure ?? row.indexCase?.procedure ?? indexExtract?.diagnosis ?? row.indexCase?.diagnosis ?? 'the index stay';
    return `Unplanned same-condition return after ${withholdNumbers(after)} with ${nOmissions} documentation omission(s) — candidate for Even Adjudicated LVC review.`;
  }
  const planned = row.planned ?? row.finding?.planned?.verdict ?? UNKNOWN;
  const same = row.sameCondition ?? row.finding?.sameCondition?.verdict ?? UNKNOWN;
  return `None asserted — planned: ${planned}, condition: ${same}, ${nOmissions} documentation omission(s).`;
}
