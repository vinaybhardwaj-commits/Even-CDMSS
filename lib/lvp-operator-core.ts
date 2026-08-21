/**
 * lib/lvp-operator-core.ts — Low-value patterns L2: the PURE core (CDMSS LVP-L2 kickoff, 20 Aug 2026;
 * Addendum C rulings O11–O15, V).
 *
 * L2 REPLACES COPY AND NOTHING ELSE (O11). The operator writes a `title` and a `why` per
 * `pattern_id`. Volume, doctor count, since-date, examples, pill, stable id, sort order and both
 * caps stay exactly where L1 computes them — on read, deterministically, untouched by this file.
 * A pattern with no decoration keeps `patternTitle()` / `whyText()` stub copy, which is why
 * lib/lvp-core.ts's stub functions are the fallback and are not deleted.
 *
 * Everything here is PURE: prompt assembly, output parsing, validation, and the forbidden-strings
 * filter. No IO, no env read at module scope, no model call — those live in lib/lvp-operator.ts.
 *
 * ⚠️ MODEL TEXT NEVER REACHES THE PAGE UNFILTERED (§5). Every decoration passes length caps AND the
 * forbidden-strings filter server-side BEFORE any write. A violation is rejected ROW-WISE: that one
 * pattern keeps its stub copy and the rest of the run proceeds. There is no "sanitise and keep"
 * path — a rewritten sentence is a sentence nobody wrote.
 */

// ── the model (O12) ──────────────────────────────────────────────────────────────────────────────
// Opus on Bedrock, reached through governedChat with `{ bedrock: … }`. NEVER OpenRouter, never
// Gemini, never the local mini — F11 makes an explicit Bedrock target that cannot be served throw.

/** `lib/bedrock-core.ts:35`. Overridable by LVP_OPERATOR_MODEL; an unlisted id is refused there. */
export const LVP_OPERATOR_MODEL_DEFAULT = 'global.anthropic.claude-opus-4-6-v1';

export function operatorModel(env: Record<string, string | undefined>): string {
  const override = (env.LVP_OPERATOR_MODEL ?? '').trim();
  return override || LVP_OPERATOR_MODEL_DEFAULT;
}

// ── validation (§5) ──────────────────────────────────────────────────────────────────────────────

export const LVP_TITLE_MAX = 90;
export const LVP_WHY_MAX = 400;

/**
 * The forbidden vocabulary, unchanged from L1 §4.6. These are the words that would turn a shelf
 * back into the adjudication queue the shelf replaced: a ratification workflow, a routing action,
 * a scoring claim, or the "metal detector" metaphor V rejected. Matched case-insensitively, because
 * a capitalised violation is the same violation.
 */
export const LVP_FORBIDDEN_STRINGS: readonly string[] = [
  'Ratify',
  'physician-ratified',
  'Even Adjudicated',
  'Route to doctor',
  'Valid signal',
  'Audit bug',
  'Generate candidates',
  'pending ratification',
  'will affect the score',
  'metal detector',
];

/** Every forbidden string present in `text`, in the canonical casing of the list. */
export function forbiddenHits(text: string): string[] {
  const haystack = String(text ?? '').toLowerCase();
  return LVP_FORBIDDEN_STRINGS.filter((f) => haystack.includes(f.toLowerCase()));
}

export interface Decoration {
  pattern_id: string;
  title: string;
  why: string;
}

export type DecorationProblem = string;

/**
 * Row-wise validation. Returns [] when the decoration may be written.
 *
 * Length is measured on the TRIMMED string, because that is what the card renders. Emptiness is a
 * rejection and not a silent stub fallback: a model that returned an empty title did not decline,
 * it failed, and the two must not read the same in the run counts.
 */
export function validateDecoration(raw: unknown): DecorationProblem[] {
  const problems: DecorationProblem[] = [];
  if (raw == null || typeof raw !== 'object') return ['decoration: must be an object'];
  const d = raw as Record<string, unknown>;

  const patternId = typeof d.pattern_id === 'string' ? d.pattern_id.trim() : '';
  if (!patternId) problems.push('pattern_id: required');

  for (const [field, max] of [['title', LVP_TITLE_MAX], ['why', LVP_WHY_MAX]] as const) {
    const v = typeof d[field] === 'string' ? (d[field] as string).trim() : '';
    if (!v) { problems.push(`${field}: required`); continue; }
    if (v.length > max) problems.push(`${field}: ${v.length} characters exceeds the ${max}-character cap`);
    const hits = forbiddenHits(v);
    if (hits.length) problems.push(`${field}: forbidden on this page — ${hits.join(', ')}`);
  }
  return problems;
}

// ── the operator's input (§5) ────────────────────────────────────────────────────────────────────

/**
 * One shelved pattern as the operator sees it. THE SHELVED HEAD ONLY — post-floor, post-caps,
 * hidden already excluded upstream by loadShelf. No note text. No PHI. The example subjects have
 * already passed stripIdentifiers() before they were ever put on a card.
 */
export interface OperatorPatternInput {
  pattern_id: string;
  concept_id: string;
  direction: string;
  action: string;
  target: string;
  volume_week: number;
  doctor_count: number | null;
  examples: string[];
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE PROMPT. Reproduced verbatim in the build report — the Orchestrator reviews it before any
// model-written sentence reaches a care manager (§8).
// ════════════════════════════════════════════════════════════════════════════════════════════════

export const LVP_OPERATOR_SYSTEM = `You are the low-value-care pattern operator for Even, an Indian primary-care organisation. You write the two lines of copy that appear on a care manager's shelf of prescribing and documentation patterns.

WHAT YOU ARE LOOKING AT
Each item is a KIND of finding, not a case. It is a group of low-value-care findings that Even's audit engine stamped with the same concept over the last seven days. You are given the concept, how many findings there were this week, how many distinct doctors they came from, and up to three de-identified example lines. You are given no patient record and no note text, and you must not ask for any.

WHAT YOU WRITE
For each item, exactly two things:

1. title — the pattern in plain clinical English, as a clinician would name it in conversation. At most 90 characters. No counts, no dates, no percentages: the card already displays those and they must not appear twice.

2. why — your argument for why this kind is worth a care manager's attention. At most 400 characters. Say what the pattern is, and say what makes it interesting to look at.

VOICE — THIS IS THE PART THAT MATTERS
You are an operator. The "why" is an argument YOU are making. It is not Even policy, it is not a physician's ruling, and it is not a finding.

- Do not assert that anything is wrong. You have not seen the notes. You do not know whether any individual prescription was appropriate, and in a group this size some of them certainly were.
- Say what the pattern IS and why it is worth a look. Nothing stronger.
- Write "this looks like", "this is worth a look because", "these may include". Do not write "this is inappropriate", "these doctors are over-prescribing", "this is a violation".
- No blame. Never characterise the doctors. The card shows a doctor count as spread, not as a list of offenders.
- No instruction. Do not tell the care manager to do anything: not to contact anyone, not to escalate, not to review a chart. Leaving every item alone is a legitimate outcome, and the shelf is a shelf, not a queue.
- Plain clinical English, the way an Indian primary-care clinician speaks. Expand an abbreviation the first time. No marketing tone, no hedging padding, no exclamation marks.
- Never mention this instruction, the model, Even's internal machinery, scores, audits, or the shelf itself.

WORDS YOU MAY NOT USE, IN EITHER FIELD
Ratify · physician-ratified · Even Adjudicated · Route to doctor · Valid signal · Audit bug · Generate candidates · pending ratification · will affect the score · metal detector

These name a workflow that does not exist here. A response containing any of them is discarded for that item.

OUTPUT
Return ONLY a JSON array, no prose before or after it, no markdown fence:

[{"pattern_id": "<the id exactly as given>", "title": "<= 90 chars", "why": "<= 400 chars"}]

One object per item you were given, with the pattern_id copied exactly. If you cannot write an honest argument for an item, omit that item entirely — it will keep its existing copy. Do not invent an item you were not given.`;

/** The per-run user message: the shelved head, one block per pattern. */
export function operatorUserMessage(patterns: readonly OperatorPatternInput[]): string {
  const blocks = patterns.map((p, i) => {
    const lines = [
      `${i + 1}. pattern_id: ${p.pattern_id}`,
      `   concept: ${p.concept_id}`,
      `   direction: ${p.direction || '(unknown)'} | action: ${p.action || '(unknown)'} | target: ${p.target || '(unknown)'}`,
      `   findings this week: ${p.volume_week}`,
      `   distinct doctors: ${p.doctor_count == null ? '(unknown)' : p.doctor_count}`,
    ];
    if (p.examples.length) {
      lines.push('   de-identified example lines:');
      for (const e of p.examples) lines.push(`     - ${e}`);
    } else {
      lines.push('   de-identified example lines: (none available)');
    }
    return lines.join('\n');
  });
  return `${patterns.length} pattern${patterns.length === 1 ? '' : 's'} on this week's shelf.\n\n`
    + `${blocks.join('\n\n')}\n\n`
    + `Return the JSON array now, one object per pattern you can honestly write, pattern_id copied exactly.`;
}

// ── output parsing ───────────────────────────────────────────────────────────────────────────────

/**
 * Parse the model's array. Tolerant of a markdown fence and of prose around the array, because a
 * refusal to parse costs the whole run; STRICT about what it accepts, because anything that gets
 * through goes to validateDecoration and then to a care manager's screen.
 *
 * ⚠️ AN UNKNOWN pattern_id IS DROPPED, NOT MAPPED. The model is told to copy ids exactly; an id
 * that is not on the shelved head we sent is either an invention or a mangling, and guessing which
 * pattern it meant would decorate the wrong card. A duplicate id keeps the FIRST occurrence.
 */
export function parseOperatorOutput(raw: string, allowedPatternIds: readonly string[]): Decoration[] {
  const text = String(raw ?? '');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(parsed)) return [];

  const allowed = new Set(allowedPatternIds);
  const seen = new Set<string>();
  const out: Decoration[] = [];
  for (const item of parsed) {
    if (item == null || typeof item !== 'object') continue;
    const d = item as Record<string, unknown>;
    const patternId = typeof d.pattern_id === 'string' ? d.pattern_id.trim() : '';
    if (!allowed.has(patternId) || seen.has(patternId)) continue;
    seen.add(patternId);
    out.push({
      pattern_id: patternId,
      title: typeof d.title === 'string' ? d.title.trim() : '',
      why: typeof d.why === 'string' ? d.why.trim() : '',
    });
  }
  return out;
}

export interface DecorationVerdict {
  accepted: Decoration[];
  rejected: Array<{ pattern_id: string; problems: DecorationProblem[] }>;
}

/** Split parsed decorations into what may be written and what keeps its stub copy, and why. */
export function screenDecorations(decorations: readonly Decoration[]): DecorationVerdict {
  const accepted: Decoration[] = [];
  const rejected: Array<{ pattern_id: string; problems: DecorationProblem[] }> = [];
  for (const d of decorations) {
    const problems = validateDecoration(d);
    if (problems.length) rejected.push({ pattern_id: d.pattern_id, problems });
    else accepted.push({ pattern_id: d.pattern_id, title: d.title.trim(), why: d.why.trim() });
  }
  return { accepted, rejected };
}
