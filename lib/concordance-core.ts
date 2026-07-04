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
  note?: string;           // deterministic analyte-specific reasoning hint (injected into the prompt)
}

export const CANNOT_MISS_FLOOR: FloorRule[] = [
  { analyte: 'potassium', match: ['potassium', 'k '], direction: 'high', cannotMiss: 'true hyperkalemia (cardiac arrhythmia / arrest risk)' },
  { analyte: 'calcium', match: ['calcium', 'ca '], direction: 'high', cannotMiss: 'primary hyperparathyroidism or malignancy hypercalcemia', note: 'For calcium, ALWAYS assess albumin-corrected calcium BEFORE judging. High albumin (dehydration / hemoconcentration) or a raised total protein can elevate TOTAL calcium while the albumin-corrected (ionised) calcium is normal — that is concordant, NOT hypercalcemia. Only call it real hypercalcemia if the corrected value is genuinely high.' },
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

The four verdicts mean EXACTLY:
- concordant = the result fits this patient AND there is neither a likely pre-analytic/analytic error NOR an unevaluated/serious diagnosis to pursue → nothing to flag. NOTE: a result that "fits" a SEVERE clinical picture (e.g. a genuinely high potassium in a patient who missed dialysis) is NOT concordant — it is real and needs action, so it is discordant-likely-real.
- discordant-likely-error = the result is probably WRONG (a plausible, analyte-appropriate pre-analytic/analytic mechanism) → verify/repeat.
- discordant-likely-real = the result is probably TRUE and either reveals an unsuspected diagnosis OR confirms a dangerous state that needs action → pursue/treat. A dangerous but genuine result is ALWAYS discordant-likely-real, never concordant.
- indeterminate = you cannot separate error from real without a decisive piece of information.

Rules:
1. Commit to ONE verdict. Do not output multiple verdicts.
2. When the context strongly implies a pre-analytic error (difficult draw, tourniquet, EDTA/tube contamination, lipemia, delayed transit, biotin, line draw) AND the patient is asymptomatic with no corroborating findings, the correct verdict is usually discordant-likely-error — say so; do not hedge into "real" out of caution.
3. Pre-analytic error explanations MUST be mechanistically appropriate to the specific analyte. Do NOT reflexively invoke "hemolysis" or a generic artifact. Hemolysis raises potassium, LDH, and phosphate; it does NOT meaningfully raise calcium, sodium, ALP, TSH, or ferritin. If no analyte-appropriate pre-analytic mechanism fits the result and context, Branch A is weak and the verdict should lean real.
4. ALWAYS surface a cannot-miss Branch-B cause even when Branch-A looks likely. Never let a benign/error explanation mask a serious real one.
5. ANTI-ANCHORING: the stated context must NOT push you to dismiss a genuinely dangerous result. The same value can be an artifact in one patient and a critical real finding in another (e.g. symptoms, ECG changes, or a missed dialysis session make a high potassium real and urgent → discordant-likely-real).
6. Name the single DECISIVE GAP — the one unknown that would most change releasability — and a short VoI ledger. Surface the cheapest high-value action first (e.g. a hemolysis index on the existing sample BEFORE a re-draw). The decisive gap must be relevant to THIS analyte (do not propose a hemolysis index for calcium).
7. Confidence is capped by high-value unknowns. State the cap reason.
8. Scope honesty: you reason about concordance, not analytic truth — you cannot catch a wrong result that is internally consistent and clinically plausible (e.g. a wrong-patient panel). Say so when relevant.
9. Advisory only — a "concordant" verdict is NOT authorization to release; the clinician decides.

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
  const notes = floor.map((f) => f.note).filter(Boolean);
  const notesLine = notes.length ? `\n\nANALYTE RULES (deterministic — apply before judging): ${notes.join(' ')}` : '';
  const user = `RESULT: ${result}\nCONTEXT: ${context}${floorLine}${notesLine}`;
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

// ─────────────────────────────────────────────────────────────────────────────
// P1 — adaptive interview loop (pure core: state, stopping rule, prompt builders,
// parsers, transcript→context). All LLM-touching wrappers live in concordance.ts.
// ─────────────────────────────────────────────────────────────────────────────

export type WhoKnows = 'report' | 'you' | 'lab';

export interface BeliefItem { cause: string; branch: 'A' | 'B'; weight: number; }
export interface InterviewTurn { question: string; whoKnows: WhoKnows; why: string; options: string[]; answer: string; }
export interface OpenGap { gap: string; whoKnows: WhoKnows; voiImpact: 'high' | 'med' | 'low'; }

export interface InterviewState {
  result: string;
  context0: string;
  belief: BeliefItem[];
  turns: InterviewTurn[];
  openGaps: OpenGap[];
  status: 'seeding' | 'asking' | 'stopped';
  askedCount: number;
  leadConfidence: number;   // confidence in the leading explanation given answers so far (0-1)
  unknownStreak: number;    // consecutive "I don't have this" answers
}

export interface InterviewOpts {
  cap: number;              // hard ceiling on questions
  stopThreshold: number;    // stop once leadConfidence clears this
  maxUnknownStreak: number; // stop when this many answers in a row are "I don't have this" (info-starved)
}
export const DEFAULT_INTERVIEW_OPTS: InterviewOpts = { cap: 6, stopThreshold: 0.7, maxUnknownStreak: 2 };

export function initInterview(result: string, context0: string): InterviewState {
  return { result, context0, belief: [], turns: [], openGaps: [], status: 'seeding', askedCount: 0, leadConfidence: 0, unknownStreak: 0 };
}

export function normalizeBelief(items: BeliefItem[]): BeliefItem[] {
  const sum = items.reduce((s, i) => s + (i.weight > 0 ? i.weight : 0), 0);
  if (sum <= 0) return items.map((i) => ({ ...i, weight: items.length ? 1 / items.length : 0 }));
  return items.map((i) => ({ ...i, weight: Math.max(i.weight, 0) / sum }));
}

export function topBelief(b: BeliefItem[]): BeliefItem | null {
  if (!b.length) return null;
  return [...b].sort((a, c) => c.weight - a.weight)[0];
}

/** An answer that means "I don't have this" — first-class, never stalls.
 *  Tolerant of "don't"/"do not" and "not have/known/measured/available/recorded". */
export function isUnknownAnswer(answer: string): boolean {
  return /^\s*(unknown|i (don'?t|do not) have|(don'?t|do not) have|not (available|measured|known|recorded|have|sure|documented)|n\/?a|no data|(don'?t|do not) know)\b/i.test(answer);
}

export interface NextQuestion { stop: boolean; question: string; whoKnows: WhoKnows; why: string; options: string[]; confidence?: number; }

/** Deterministic stop (the economy levers): cap reached, the leading explanation clears the
 *  confidence threshold, or the interview is info-starved (a run of "I don't have this").
 *  The LLM's explicit STOP token is handled by the driver; this is the deterministic net. */
export function shouldStop(state: InterviewState, opts: InterviewOpts = DEFAULT_INTERVIEW_OPTS): boolean {
  if (state.status === 'stopped') return true;
  if (state.askedCount >= opts.cap) return true;
  if (state.leadConfidence >= opts.stopThreshold) return true;
  if (state.unknownStreak >= opts.maxUnknownStreak) return true;
  const top = topBelief(state.belief);
  return !!top && top.weight >= opts.stopThreshold;
}

/** Record an answered turn; an "I don't have this" answer becomes a high-VoI open gap and
 *  extends the unknown streak. The question's self-reported confidence updates leadConfidence. */
export function recordTurn(state: InterviewState, nq: NextQuestion, answer: string, newBelief?: BeliefItem[]): InterviewState {
  const turn: InterviewTurn = { question: nq.question, whoKnows: nq.whoKnows, why: nq.why, options: nq.options, answer };
  const unknown = isUnknownAnswer(answer);
  const openGaps = unknown
    ? [...state.openGaps, { gap: nq.question, whoKnows: nq.whoKnows, voiImpact: 'high' as const }]
    : state.openGaps;
  const belief = newBelief && newBelief.length ? normalizeBelief(newBelief) : state.belief;
  const leadConfidence = typeof nq.confidence === 'number' && !Number.isNaN(nq.confidence) ? nq.confidence : state.leadConfidence;
  return {
    ...state,
    turns: [...state.turns, turn],
    askedCount: state.askedCount + 1,
    openGaps,
    belief,
    leadConfidence,
    unknownStreak: unknown ? state.unknownStreak + 1 : 0,
  };
}

/** Transcript → the context string handed to the P0 verdict engine at stop. */
export function toVerdictContext(state: InterviewState): string {
  const lines: string[] = [state.context0.trim()];
  const answered = state.turns.filter((t) => !isUnknownAnswer(t.answer));
  if (answered.length) {
    lines.push('', 'Interview findings (established facts — weight these):');
    for (const t of answered) lines.push(`- ${t.question} -> ${t.answer}`);
  }
  if (state.openGaps.length) {
    lines.push('', 'Asked but not available. Judge on the evidence PRESENT; a suggestive established finding can justify a verdict on its own. Only cap confidence for a gap that is genuinely decision-critical and unresolved:');
    for (const g of state.openGaps) lines.push(`- ${g.gap} (ask: ${g.whoKnows})`);
  }
  return lines.join('\n');
}

// ── Prompt builders + parsers (pure) ──
export function buildSeedPrompt(result: string, context: string): Prompt {
  const floor = floorFor(result);
  const floorLine = floor.length ? ` Ensure these cannot-miss TRUE (branch B) causes appear: ${floor.map((f) => f.cannotMiss).join('; ')}.` : '';
  const system = `You are Concordance, seeding a cause differential for a lab result BEFORE an adaptive interview. List the most plausible causes that this result is (A) WRONG — a pre-analytic/analytic error that must be mechanistically appropriate to the analyte — or (B) RIGHT and revealing/confirming something. Assign each a prior weight 0-1 (they need not sum to 1).${floorLine}
Output ONLY one cause per line, pipe-separated: the branch letter (A or B), then the weight, then the cause. Example:
B|0.5|primary hyperparathyroidism
A|0.2|EDTA contamination
Give 4-8 lines. No headers, no prose.`;
  return { system, user: `RESULT: ${result}\nCONTEXT: ${context}` };
}

/** Tolerant of field order and a stray leading label (e.g. "BRANCH|B|0.4|cause"). */
export function parseSeed(raw: string): BeliefItem[] {
  const out: BeliefItem[] = [];
  for (const ln of raw.split('\n')) {
    if (!ln.includes('|')) continue;
    const parts = ln.split('|').map((s) => s.trim()).filter(Boolean);
    const branch = parts.find((p) => /^[AB]$/i.test(p));
    const wStr = parts.find((p) => /^[0-9]*\.?[0-9]+$/.test(p));
    if (!branch || !wStr) continue;
    const cause = parts
      .filter((p) => p !== branch && p !== wStr && !/^branch$/i.test(p))
      .sort((a, b) => b.length - a.length)[0];
    if (!cause) continue;
    out.push({ branch: branch.toUpperCase() as 'A' | 'B', weight: parseFloat(wStr), cause });
  }
  return normalizeBelief(out);
}

export function buildNextQuestionPrompt(state: InterviewState): Prompt {
  const beliefStr = state.belief.map((b) => `${b.branch}|${b.weight.toFixed(2)}|${b.cause}`).join('\n') || '(unseeded)';
  const asked = state.turns.map((t) => `- ${t.question} -> ${t.answer}`).join('\n') || '(none yet)';
  const floorNote = floorFor(state.result).map((f) => f.note).filter(Boolean).join(' ');
  const system = `You are running an ADAPTIVE clinical interview to decide whether a lab result is concordant/releasable. Choose the SINGLE next question that best DISCRIMINATES among the current candidate causes (maximise information gain) — never generic history.
Prioritise the TOP 1-2 causes in CURRENT BELIEF: ask the question whose answer would most confirm or exclude the single most likely cause first. If the top cause is a pre-analytic error (branch A), ask the specific sample/draw question that would reveal it (e.g. was the ven-puncture difficult, is there a hemolysis/lipemia index, was the right tube used) — do not skip to rare causes while the leading one is untested.
Do NOT re-ask anything already answered or already stated in the context, and do NOT ask a second question about a theme you already probed (sample handling / pre-analytic processing counts as ONE theme — ask it once).${floorNote ? ' ' + floorNote : ''}
Tag whoKnows: report (already knowable from the report or order) | you (the clinician at the bedside) | lab (sample provenance / pre-analytic). Give a one-line why (which causes it separates) and 2-4 quick answer options.
Output the single word STOP as the QUESTION when ANY of these hold: (a) you are already confident in the leading explanation; (b) the recent answers have been "I don't have this" and another question won't change releasability — it is better to return a verdict with the open gap than to keep asking; (c) every high-value discriminator has been asked.
Also report CONFIDENCE: your probability (0-1) in the single leading explanation GIVEN THE ANSWERS SO FAR.
Output EXACTLY, one per line:
QUESTION: <one question, or the word STOP>
WHOKNOWS: <report|you|lab>
WHY: <one line>
OPTIONS: <opt1 | opt2 | opt3>
CONFIDENCE: <0-1>`;
  return { system, user: `RESULT: ${state.result}\nCONTEXT: ${state.context0}\nCURRENT BELIEF:\n${beliefStr}\nALREADY ASKED:\n${asked}` };
}

export function parseNextQuestion(raw: string): NextQuestion {
  const heads = [HEADERS_Q.q, HEADERS_Q.wk, HEADERS_Q.why, HEADERS_Q.opt, HEADERS_Q.conf];
  const q = section(raw, HEADERS_Q.q, heads).trim();
  const confRaw = section(raw, HEADERS_Q.conf, heads).match(/[0-9]*\.?[0-9]+/);
  const confidence = confRaw ? Math.min(1, Math.max(0, parseFloat(confRaw[0]))) : undefined;
  if (!q || /^stop\b/i.test(q)) return { stop: true, question: '', whoKnows: 'you', why: '', options: [], confidence };
  const wk = section(raw, HEADERS_Q.wk, heads).toLowerCase();
  const whoKnows: WhoKnows = wk.includes('report') ? 'report' : wk.includes('lab') ? 'lab' : 'you';
  const why = section(raw, HEADERS_Q.why, heads).trim();
  const options = section(raw, HEADERS_Q.opt, heads).split('|').map((s) => s.trim()).filter(Boolean).slice(0, 4);
  return { stop: false, question: q, whoKnows, why, options, confidence };
}

const HEADERS_Q = {
  q: /QUESTION\s*:/i,
  wk: /WHOKNOWS\s*:/i,
  why: /WHY\s*:/i,
  opt: /OPTIONS\s*:/i,
  conf: /CONFIDENCE\s*:/i,
};

// ─────────────────────────────────────────────────────────────────────────────
// P2 — capture-and-wall run record (pure, de-identified). No identifiers, no raw
// context/answers, no per-patient key. This is Track-2 registry material only.
// ─────────────────────────────────────────────────────────────────────────────

export const CONCORDANCE_ENGINE = 'concordance/0.2';

export interface ConcordanceRunRecord {
  analytes: string[];
  verdict: Verdict | null;
  branch: Branch;
  confidence: 'low' | 'moderate' | 'high' | null;
  askedCount: number;
  unknownCount: number;
  whoReport: number;
  whoYou: number;
  whoLab: number;
  ageBand: string | null;
  sex: 'F' | 'M' | null;
  mode: 'interview' | 'single-shot';
  engine: string;
}

/** Coarse, de-identified demographics from the intake context (best-effort; null when unsure). */
export function extractDemographics(context: string): { ageBand: string | null; sex: 'F' | 'M' | null } {
  const compact = context.match(/\b(\d{1,3})\s*(?:-?\s*year[s-]*old\s*)?([MF])\b/i); // "56F", "44 M", "70-year-old F"
  const ageWord = context.match(/\b(\d{1,3})\s*(?:years?\b|yo\b|y\/o\b|-year-old)/i);
  const sexWord = context.match(/\b(female|woman|male|man)\b/i);
  let age: number | null = compact ? parseInt(compact[1], 10) : ageWord ? parseInt(ageWord[1], 10) : null;
  if (age !== null && (age < 0 || age > 120)) age = null;
  let sex: 'F' | 'M' | null = compact ? (compact[2].toUpperCase() as 'F' | 'M') : null;
  if (!sex && sexWord) sex = /female|woman/i.test(sexWord[1]) ? 'F' : 'M';
  const ageBand = age === null ? null : `${Math.floor(age / 10) * 10}-${Math.floor(age / 10) * 10 + 9}`;
  return { ageBand, sex };
}

/** Build the walled, de-identified run record from an interview state (or a single-shot). */
export function buildRunRecord(
  result: string,
  context: string,
  parsed: ParsedConcordanceLike,
  mode: 'interview' | 'single-shot',
  interview?: InterviewState,
): ConcordanceRunRecord {
  const analytes = Array.from(new Set(floorFor(result).map((f) => f.analyte)));
  const { ageBand, sex } = extractDemographics(context);
  const turns = interview?.turns ?? [];
  const who = { report: 0, you: 0, lab: 0 };
  for (const t of turns) who[t.whoKnows] += 1;
  return {
    analytes,
    verdict: parsed.verdict,
    branch: parsed.verdict ? branchForVerdict(parsed.verdict) : 'none',
    confidence: parsed.confidence,
    askedCount: interview?.askedCount ?? 0,
    unknownCount: interview?.openGaps.length ?? 0,
    whoReport: who.report,
    whoYou: who.you,
    whoLab: who.lab,
    ageBand,
    sex,
    mode,
    engine: CONCORDANCE_ENGINE,
  };
}

/** Minimal shape needed from a parsed verdict (ParsedConcordance satisfies this). */
export interface ParsedConcordanceLike { verdict: Verdict | null; confidence: 'low' | 'moderate' | 'high' | null; }
