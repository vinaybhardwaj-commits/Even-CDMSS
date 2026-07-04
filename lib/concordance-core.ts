// Concordance — pure reasoning core (P0). No ./db, no ./llm imports here.
// Types, the single-shot prompt builder, the cannot-miss FLOOR, an output parser,
// and scoring helpers. Unit-testable under `node --experimental-strip-types`.

export type Verdict =
  | 'concordant'
  | 'discordant-likely-error'
  | 'discordant-likely-real'
  | 'indeterminate';

export type Branch = 'A' | 'B' | 'either' | 'none';

export const VERDICTS: Verdict[] = [
  'concordant',
  'discordant-likely-error',
  'discordant-likely-real',
  'indeterminate',
];

/** Which branch a verdict implies (for scoring the primary axis). */
export function branchForVerdict(v: Verdict): Branch {
  if (v === 'discordant-likely-error') return 'A';
  if (v === 'discordant-likely-real') return 'B';
  return 'none'; // concordant | indeterminate
}

// ── Cannot-miss FLOOR (§9.6 hybrid: encoded deterministic floor per in-scope analyte) ──
// Small, given the tight v1 scope. Keyed by an analyte token; `direction` narrows to the
// abnormal side that carries the danger. The floor GUARANTEES these Branch-B causes are
// surfaced/considered even when a pre-analytic error looks likely.
export interface FloorRule {
  analyte: string;         // canonical token
  match: string[];         // lowercase substrings that identify the analyte in result text
  direction: 'high' | 'low' | 'either';
  cannotMiss: string;      // the critical Branch-B diagnosis that must not be dismissed
}

export const CANNOT_MISS_FLOOR: FloorRule[] = [
  { analyte: 'potassium', match: ['potassium', 'k '], direction: 'high', cannotMiss: 'true hyperkalemia (cardiac arrhythmia / arrest risk)' },
  { analyte: 'calcium', match: ['calcium', 'ca '], direction: 'high', cannotMiss: 'primary hyperparathyroidism or malignancy hypercalcemia' },
  { analyte: 'sodium', match: ['sodium', 'na '], direction: 'low', cannotMiss: 'symptomatic hyponatremia / SIADH / adrenal insufficiency' },
  { analyte: 'sodium', match: ['sodium', 'na '], direction: 'high', cannotMiss: 'significant hypernatremia / dehydration' },
  { analyte: 'wbc', match: ['wbc', 'white cell', 'leuko'], direction: 'high', cannotMiss: 'acute leukemia / leukemoid process' },
  { analyte: 'wbc', match: ['wbc', 'white cell', 'leuko'], direction: 'low', cannotMiss: 'agranulocytosis / marrow failure' },
  { analyte: 'platelets', match: ['platelet', 'plt'], direction: 'low', cannotMiss: 'true severe thrombocytopenia (bleeding risk)' },
  { analyte: 'hemoglobin', match: ['hemoglobin', 'haemoglobin', 'hb '], direction: 'low', cannotMiss: 'severe anemia / active blood loss' },
  { analyte: 'ferritin', match: ['ferritin'], direction: 'high', cannotMiss: 'iron overload / hereditary hemochromatosis' },
  { analyte: 'alt', match: ['alt', 'ast', 'transaminase'], direction: 'high', cannotMiss: 'acute liver injury (drug-induced / viral hepatitis)' },
  { analyte: 'alp', match: ['alp', 'alkaline phosphatase', 'ggt'], direction: 'high', cannotMiss: 'biliary obstruction / pancreaticobiliary malignancy' },
  { analyte: 'thyroid', match: ['tsh', 'ft4', 'free t4', 'thyroid'], direction: 'either', cannotMiss: 'central hypothyroidism or true thyrotoxicosis' },
];

/** Floor rules that apply to a result string (matched by analyte token). Direction is not
 *  strictly enforced (we do not re-parse numeric direction here — the model is handed the
 *  applicable cannot-miss items and told to address them). */
export function floorFor(resultText: string): FloorRule[] {
  const t = ` ${resultText.toLowerCase()} `;
  const seen = new Set<string>();
  const out: FloorRule[] = [];
  for (const r of CANNOT_MISS_FLOOR) {
    if (r.match.some((m) => t.includes(m))) {
      const key = `${r.analyte}:${r.direction}`;
      if (!seen.has(key)) { seen.add(key); out.push(r); }
    }
  }
  return out;
}

// ── Single-shot prompt builder ──
export interface Prompt { system: string; user: string; }

const SYSTEM = `You are Concordance, a clinical lab-result concordance reasoner for a hospital decision-support system. You are given a lab result (or panel) plus the clinical context of the patient in front of the clinician. Deterministic QC (reference range, indices, delta checks) has ALREADY been done by the lab — do NOT re-derive it. Your job is the clinical-concordance reasoning the LIS cannot do: does this result make sense for THIS patient, and is it safe to release?

Reason in TWO branches and keep them separate:
- BRANCH A — the result is WRONG (pre-analytic/analytic error: hemolysis, contamination, wrong tube/unit, transit, interference, line draw). If likely, verify/repeat before acting.
- BRANCH B — the result is RIGHT and reveals something unevaluated (an unsuspected diagnosis). If plausible, do not dismiss; pursue the next step.

Rules:
1. Commit to ONE verdict. Do not output multiple verdicts.
2. When the context strongly implies a pre-analytic error (difficult draw, tourniquet, EDTA/tube contamination, lipemia, delayed transit, biotin, line draw) AND the patient is asymptomatic with no corroborating findings, the correct verdict is usually discordant-likely-error — say so; do not hedge into "real" out of caution.
3. ALWAYS surface a cannot-miss Branch-B cause even when Branch-A looks likely. Never let a benign/error explanation mask a serious real one.
4. ANTI-ANCHORING: the stated context must NOT push you to dismiss a genuinely dangerous result. The same value can be an artifact in one patient and a critical real finding in another (e.g. symptoms, ECG changes, or a missed dialysis session make a high potassium real and urgent).
5. Name the single DECISIVE GAP — the one unknown that would most change releasability — and a short VoI ledger. Surface the cheapest high-value action first (e.g. a hemolysis index on the existing sample BEFORE a re-draw).
6. Confidence is capped by high-value unknowns. State the cap reason.
7. Scope honesty: you reason about concordance, not analytic truth — you cannot catch a wrong result that is internally consistent and clinically plausible (e.g. a wrong-patient panel). Say so when relevant.
8. Advisory only — a "concordant" verdict is NOT authorization to release; the clinician decides.

Output in EXACTLY this structure, one label per line:
VERDICT: <concordant | discordant-likely-error | discordant-likely-real | indeterminate>  (exactly one)
CONFIDENCE: <low | moderate | high> — <why it is capped>
BRANCH A (error): <most plausible pre-analytic/analytic causes for THIS result + evidence for/against>
BRANCH B (real): <most plausible true causes + the mandatory cannot-miss cause + evidence for/against>
DECISIVE GAP: <the single most decision-changing unknown>
VoI LEDGER: <bullets — gap · who-knows(report/you/lab) · how-to-resolve · impact · worth-chasing?>
NEXT STEP: <the single recommended action: repeat / which test / release / urgent-treat>
GROUNDING: <cite guideline/corpus where used, else label as clinical-reasoning>`;

export function buildConcordancePrompt(result: string, context: string): Prompt {
  const floor = floorFor(result);
  const floorLine = floor.length
    ? `\n\nCANNOT-MISS FLOOR for this analyte (you MUST explicitly address whether each is excluded, in Branch B): ${floor.map((f) => f.cannotMiss).join('; ')}.`
    : '';
  const user = `RESULT: ${result}\nCONTEXT: ${context}${floorLine}`;
  return { system: SYSTEM, user };
}

// ── Output parser ──
export interface ParsedConcordance {
  verdict: Verdict | null;
  multipleVerdicts: boolean;
  confidence: 'low' | 'moderate' | 'high' | null;
  confidenceCapped: boolean;
  branchAText: string;
  branchBText: string;
  decisiveGap: string;
  voiText: string;
  nextStep: string;
  grounding: string;
  branch: Branch;      // derived from verdict
  raw: string;
}

function section(text: string, label: RegExp, next: RegExp[]): string {
  const start = text.search(label);
  if (start < 0) return '';
  const after = text.slice(start).replace(label, '');
  let end = after.length;
  for (const n of next) {
    const i = after.search(n);
    if (i >= 0 && i < end) end = i;
  }
  return after.slice(0, end).trim();
}

const HEADERS = {
  verdict: /VERDICT\s*:/i,
  confidence: /CONFIDENCE\s*:/i,
  branchA: /BRANCH\s*A[^:]*:/i,
  branchB: /BRANCH\s*B[^:]*:/i,
  decisive: /DECISIVE\s*GAP\s*:/i,
  voi: /VoI\s*LEDGER\s*:/i,
  next: /NEXT\s*STEP\s*:/i,
  grounding: /GROUNDING\s*:/i,
};

export function parseConcordance(raw: string): ParsedConcordance {
  const all = Object.values(HEADERS);
  const verdictLine = section(raw, HEADERS.verdict, all);
  const found = VERDICTS.filter((v) => verdictLine.toLowerCase().includes(v));
  // "discordant-likely-error" contains "...-error"; ensure exact-ish detection order
  const verdict = (found[0] as Verdict) || null;
  const multipleVerdicts = found.length > 1;

  const confText = section(raw, HEADERS.confidence, all);
  const cl = confText.toLowerCase();
  const confidence = cl.includes('high') ? 'high' : cl.includes('moderate') || cl.includes('medium') ? 'moderate' : cl.includes('low') ? 'low' : null;
  const confidenceCapped = /cap|unknown|pending|await|limit/i.test(confText);

  return {
    verdict,
    multipleVerdicts,
    confidence,
    confidenceCapped,
    branchAText: section(raw, HEADERS.branchA, all),
    branchBText: section(raw, HEADERS.branchB, all),
    decisiveGap: section(raw, HEADERS.decisive, all),
    voiText: section(raw, HEADERS.voi, all),
    nextStep: section(raw, HEADERS.next, all),
    grounding: section(raw, HEADERS.grounding, all),
    branch: verdict ? branchForVerdict(verdict) : 'none',
    raw,
  };
}

// ── Scoring ──
export interface CaseExpectation {
  id: string;
  category: 'branchA' | 'branchB' | 'control' | 'edge';
  expectedVerdict: Verdict;
  expectedBranch: Branch;
  decisiveGapKeywords: string[];   // any-of match against decisiveGap+voi+nextStep
  cannotMissKeywords?: string[];   // any-of match against branchB text
}

export interface CaseScore {
  id: string;
  verdictMatch: boolean;
  branchMatch: boolean;
  decisiveGapHit: boolean;
  cannotMissCovered: boolean | null;
  overFlagged: boolean;           // control marked discordant
  committedSingleVerdict: boolean;
  notes: string[];
}

function anyKeyword(hay: string, keys: string[]): boolean {
  const h = hay.toLowerCase();
  return keys.some((k) => h.includes(k.toLowerCase()));
}

export function scoreCase(exp: CaseExpectation, p: ParsedConcordance): CaseScore {
  const notes: string[] = [];
  const verdictMatch = p.verdict === exp.expectedVerdict;
  const branchMatch = p.branch === exp.expectedBranch;
  const gapHay = `${p.decisiveGap}\n${p.voiText}\n${p.nextStep}`;
  const decisiveGapHit = anyKeyword(gapHay, exp.decisiveGapKeywords);
  const cannotMissCovered = exp.cannotMissKeywords && exp.cannotMissKeywords.length
    ? anyKeyword(p.branchBText, exp.cannotMissKeywords)
    : null;
  const overFlagged = exp.category === 'control' && (p.verdict === 'discordant-likely-error' || p.verdict === 'discordant-likely-real');

  if (!verdictMatch) notes.push(`verdict ${p.verdict ?? 'NONE'} ≠ expected ${exp.expectedVerdict}`);
  if (p.multipleVerdicts) notes.push('emitted multiple verdicts');
  if (cannotMissCovered === false) notes.push('cannot-miss cause not surfaced in Branch B');
  if (overFlagged) notes.push('control OVER-FLAGGED');

  return {
    id: exp.id,
    verdictMatch,
    branchMatch,
    decisiveGapHit,
    cannotMissCovered,
    overFlagged,
    committedSingleVerdict: !p.multipleVerdicts && p.verdict !== null,
    notes,
  };
}

export interface BankSummary {
  n: number;
  verdictAccuracy: number;
  branchAccuracy: number;
  decisiveGapHitRate: number;
  cannotMissCoverage: number;   // over cases that specify cannotMissKeywords
  controlOverFlagRate: number;  // over controls
  committedRate: number;
}

export function summarize(scores: CaseScore[]): BankSummary {
  const n = scores.length || 1;
  const controls = scores.filter((s) => s.overFlagged !== undefined && s.id.startsWith('C'));
  const cmScored = scores.filter((s) => s.cannotMissCovered !== null);
  const controlsAll = scores.filter((s) => s.id.startsWith('C'));
  return {
    n: scores.length,
    verdictAccuracy: scores.filter((s) => s.verdictMatch).length / n,
    branchAccuracy: scores.filter((s) => s.branchMatch).length / n,
    decisiveGapHitRate: scores.filter((s) => s.decisiveGapHit).length / n,
    cannotMissCoverage: cmScored.length ? cmScored.filter((s) => s.cannotMissCovered).length / cmScored.length : 1,
    controlOverFlagRate: controlsAll.length ? controls.filter((s) => s.overFlagged).length / controlsAll.length : 0,
    committedRate: scores.filter((s) => s.committedSingleVerdict).length / n,
  };
}
