/**
 * lib/readmission-ask-core.ts — PURE decisions for R4.3 "ask the agent" (CDMSS-READMISSIONS-R4.3-PRD
 * v1.0, R43-1..R43-8): the case MATERIAL the model may see (stored artefacts only), the caps
 * (question length, history turns, history size), and the answer verdict (citations enforced by
 * the same validator that guards narratives). No DB, no model, no clock.
 *
 * THE FENCE (the memo's rule): the conversation's whole world is this case's STORED material — the
 * evidence ledger, the agent's account, the judgements, the coverage, the two bills. Nothing new
 * enters the case through the ask-box.
 *
 * R9 (CDMSS-READMISSIONS-R9-DUAL-CONTRACT PRD, GO 27 Aug 2026, D12/D13/D14 + O1/O2 + T6) moves ONE
 * half of that last clause. The fence against inventing KX facts STANDS, unchanged: an agent claim
 * about the record still dies without a resolvable ledger citation. The fence against storing the
 * REVIEWER goes: a care manager's own stated clinical judgement is now persisted, beside the agent's
 * `avoidable` and never on top of it.
 *   · Turns persist per (dedup_key, engine_version, turn_index) and the SERVER is the thread's truth
 *     (O1) — the model window is the last ASK_HISTORY_MAX_TURNS turns, then the same token trim.
 *   · `gateOverlay` (§12.4) is the ONLY door to a `clinical_review` write, and it is a pure function
 *     so it can be argued with in a test rather than in production: assertion turn, `stated === true`,
 *     a closed-set decision, a quote that is REALLY a substring of what he typed, every other enum in
 *     its closed set. Anything else persists the turn, skips the overlay, and never 500s (T6).
 *   · What the overlay may never do (D14): touch `avoidable` / `planned` / `same_condition` /
 *     `preventable_injury` / `negligence`, or reach the incidence aggregator. Incidence is identical
 *     with the overlay present or absent (acceptance #6).
 */
import { validateCitations, type CitationVerdict } from './readmission-narrative-core';

// ── caps (R43-4 / R43-7) ─────────────────────────────────────────────────────────────────

/** Question length cap (chars). O2 — 2,000: 500 was too small for real pushback. */
export const ASK_QUESTION_MAX_CHARS = 2_000;
/** O1 — the model window: the last N turns (a turn = one question + its answer), read from the DB. */
export const ASK_HISTORY_MAX_TURNS = 20;
/** Token cap on the history — chars/4 as the estimate; oldest turns drop first. Raised with the turn
 *  window (O1 says "raised cap" without a number; 12,000 is the builder's figure, flagged in the R9
 *  report): 20 turns cannot fit inside the R4.3 cap of 3,000, so leaving it would have trimmed the
 *  window straight back to a handful of turns and made the raise cosmetic. */
export const ASK_HISTORY_MAX_TOKENS = 12_000;
/** Per-page-load question limit. O1 keeps it CLIENT-side as a soft brake; server-side spend ceilings
 *  are a later ship. */
export const ASK_PER_LOAD_LIMIT = 8;
/** The model call: one try, low temperature, ~90 s (R43-2). */
export const ASK_BUDGET_MS = 90_000;
export const ASK_MAX_TRIES = 1;
export const ASK_TEMPERATURE = 0.1;
export const ASK_MAX_TOKENS = 1_500;

export const ASK_WITHHELD_COPY = "The agent's answer failed its citation check and was not shown — try rephrasing the question.";
export const ASK_WORKING_COPY = 'The agent is reading the case — this takes about half a minute';
export const ASK_SUGGESTIONS: readonly string[] = ['Why was this case flagged?', 'What does the operative note show?', 'Why is negligence unknown?'] as const;
/** R9 §12.3 — the advisory FLIPS. The old sentence ended "nothing you ask changes the case", which is
 *  no longer true: what he STATES is now saved. It is still true that nothing he says moves the lead
 *  number, and that is the sentence's new job. */
export const ASK_ADVISORY = 'Advisory — answers cite this case\'s stored evidence, checked by code before they are shown; your stated judgement is saved as clinical review; it does not change incidence.';
export const ASK_THREAD_UNAVAILABLE_COPY = 'the earlier conversation could not be loaded — ask again and this turn will still be saved';

// ── the material (R43-1 / R43-8) ─────────────────────────────────────────────────────────

export interface AskLedgerItem { id: string; source: string; side: string | null; at: string | null; weight: string; text: string }
export interface AskBill { ok: boolean; groups: Array<{ serviceType: string; netRs: number; lines: number }>; totalRs: number; lines: number }

/** What the model may see. Assembled by the route from STORED artefacts + the two bills the case
 *  page already reads. No patient name, no UHID, no encounter id (R43-8). */
export interface AskMaterial {
  ledger: AskLedgerItem[];
  /** The VALID stored account, or null (an invalid / absent account is not shown to the model either). */
  account: string | null;
  judgements: { planned: string | null; sameCondition: string | null; justification: string; preventableInjury: string; negligence: string; findingClass: string; lane: string; gapDays: number | null };
  coverage: Array<{ label: string; state: string }>;
  bills: { index: AskBill | null; readmit: AskBill | null; returnCell: string };
  refusals: Array<{ lookedFor: string; note?: string }>;
}

export interface AskTurn { question: string; answer: string }

/** PURE: trim, cap, reject empty / over-long / control-character questions. */
export function normaliseQuestion(raw: unknown): { ok: true; question: string } | { ok: false; error: string } {
  const q = typeof raw === 'string' ? raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim() : '';
  if (!q) return { ok: false, error: 'question required' };
  if (q.length > ASK_QUESTION_MAX_CHARS) return { ok: false, error: `question too long — ${ASK_QUESTION_MAX_CHARS} characters at most` };
  return { ok: true, question: q };
}

/** PURE: the last ≤ ASK_HISTORY_MAX_TURNS well-formed turns, then oldest-first drop until the
 *  chars/4 estimate fits ASK_HISTORY_MAX_TOKENS. Junk turns are skipped, never a throw. */
export function capHistory(raw: unknown): AskTurn[] {
  const arr = Array.isArray(raw) ? raw : [];
  const turns: AskTurn[] = [];
  for (const t of arr) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const q = typeof o.question === 'string' ? o.question.trim() : '';
    const a = typeof o.answer === 'string' ? o.answer.trim() : '';
    if (!q || !a) continue;
    turns.push({ question: q.slice(0, ASK_QUESTION_MAX_CHARS), answer: a.slice(0, 4_000) });
  }
  let kept = turns.slice(-ASK_HISTORY_MAX_TURNS);
  const tokens = (ts: AskTurn[]) => Math.ceil(ts.reduce((n, t) => n + t.question.length + t.answer.length, 0) / 4);
  while (kept.length && tokens(kept) > ASK_HISTORY_MAX_TOKENS) kept = kept.slice(1);
  return kept;
}

// ── the answer verdict (R43-3) ───────────────────────────────────────────────────────────

export interface AskParsed { answer: string; answerable: boolean }

/** PURE: parse the model's reply — strict JSON {answer, answerable} preferred; a bare-text reply is
 *  taken as the answer with answerable:true (so it must cite). Empty → null. */
export function parseAskReply(text: string | null | undefined): AskParsed | null {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  if (start >= 0) {
    for (let end = cleaned.lastIndexOf('}'); end > start; end = cleaned.lastIndexOf('}', end - 1)) {
      try {
        const o = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
        if (o && typeof o === 'object' && !Array.isArray(o)) {
          // A JSON object IS the reply: an empty / missing answer is an empty reply, never bare text.
          const ans = typeof o.answer === 'string' ? o.answer.trim() : '';
          return ans ? { answer: ans, answerable: o.answerable !== false } : null;
        }
        break;
      } catch { /* keep shrinking */ }
    }
  }
  const t = cleaned.trim();
  return t ? { answer: t, answerable: true } : null;
}

export interface AskVerdict { ok: boolean; answer: string; citedIds: string[]; invalidIds: string[]; reason: CitationVerdict['reason'] }

/**
 * PURE — CODE DECIDES (R43-3): every marker in the answer must resolve to a stored ledger id, via
 * the SAME validator that guards narratives. The one deliberate difference from the narrative rule
 * (flagged in the R4.3 report): an answer the model marked `answerable:false` — "the case record
 * does not show this" — may carry NO markers, because there is no fact to cite; it must still
 * carry no UNRESOLVED marker. Everything else: unresolved id → withheld; no markers on an
 * answerable answer → withheld; empty → withheld.
 */
export function askVerdict(parsed: AskParsed | null, ledgerIds: Iterable<string>): AskVerdict {
  if (!parsed) return { ok: false, answer: '', citedIds: [], invalidIds: [], reason: 'empty' };
  const v = validateCitations(parsed.answer, ledgerIds);
  if (v.valid) return { ok: true, answer: parsed.answer, citedIds: v.citedIds, invalidIds: [], reason: 'none' };
  if (v.reason === 'no_citations' && parsed.answerable === false) return { ok: true, answer: parsed.answer, citedIds: [], invalidIds: [], reason: 'none' };
  return { ok: false, answer: parsed.answer, citedIds: v.citedIds, invalidIds: v.invalidIds, reason: v.reason };
}

// ── R9 — the clinical_review overlay (§6, D13, D14, §12.4 / T6) ──────────────────────────

export const CLINICAL_REVIEW_VERSION = 'clinical_review/1';
/** The reviewer's verdict. `null` = unreviewed / question-only, and it is NOT a member of this set:
 *  a decision the gate did not accept never becomes a stored `null`, it becomes no write at all. */
export const CLINICAL_REVIEW_DECISIONS = ['justified', 'not_justified', 'insufficient'] as const;
export type ClinicalReviewDecision = (typeof CLINICAL_REVIEW_DECISIONS)[number];
export const CLINICAL_REVIEW_CLOCK_CLASSES = ['lt24h', 'd1_30', 'd31_90'] as const;
export type ClinicalReviewClockClass = (typeof CLINICAL_REVIEW_CLOCK_CLASSES)[number];
export const CLINICAL_REVIEW_LT24H_KINDS = ['paper_admin', 'deferred_staged', 'medical'] as const;
export type ClinicalReviewLt24hKind = (typeof CLINICAL_REVIEW_LT24H_KINDS)[number];
export const CLINICAL_REVIEW_EXCLUSION_CLAIMS = ['none', 'onco', 'obgyn', 'neonate', 'ophthal'] as const;
export type ClinicalReviewExclusionClaim = (typeof CLINICAL_REVIEW_EXCLUSION_CLAIMS)[number];
/** §6 — the quote is capped in the same place it is validated, so no caller can store a long one. */
export const CLINICAL_REVIEW_QUOTE_MAX_CHARS = 400;

/** The plain-words label for each decision — the case-page chip and the board filter share it. */
export const CLINICAL_REVIEW_DECISION_LABEL: Readonly<Record<ClinicalReviewDecision, string>> = {
  justified: 'Reviewer: justified',
  not_justified: 'Reviewer: not justified',
  insufficient: 'Reviewer: not enough to say',
};
/** D14 — shown BESIDE the agent's proposal, never instead of it. */
export const CLINICAL_REVIEW_CHIP_NOTE = 'clinical review by a care manager · the agent proposal above is unchanged';

/** What the gate accepts and what the store writes. `stated` is always true by construction: an
 *  inferred overlay never survives the gate, so it is never a stored value. */
export interface ClinicalReview {
  decision: ClinicalReviewDecision;
  clockClass: ClinicalReviewClockClass | null;
  lt24hKind: ClinicalReviewLt24hKind | null;
  exclusionClaim: ClinicalReviewExclusionClaim | null;
  quote: string;
}
/** The overlay as it is READ back (the stored columns plus their provenance). */
export interface StoredClinicalReview extends ClinicalReview {
  actor: string | null;
  at: string | null;
  turnId: string | null;
  model: string | null;
}

/**
 * PURE — is the user's turn an ASSERTION rather than a lone question (§12.4 rule 1)?
 *
 * Code decides, not the model: a lone question must never be able to write a clinical judgement just
 * because the model felt one was implied. The rule is deliberately conservative — a turn is an
 * assertion when it contains at least one sentence that does NOT end in a question mark. "Why was
 * this flagged?" is not an assertion; "Why was this flagged? It was a planned staged stent." is.
 */
export function isAssertionTurn(text: string | null | undefined): boolean {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return false;
  const sentences = t.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  if (!sentences.length) return false;
  return sentences.some((x) => !x.endsWith('?'));
}

/** Whitespace-insensitive substring test — the model re-types a quote with its own spacing far more
 *  often than it invents one, and rejecting on a double space would only teach it to quote less. */
function containsQuote(haystack: string, needle: string): boolean {
  const norm = (x: string) => x.replace(/\s+/g, ' ').trim().toLowerCase();
  const h = norm(haystack), n = norm(needle);
  return n !== '' && h.includes(n);
}

export type OverlayGate =
  | { ok: true; overlay: ClinicalReview }
  | { ok: false; reason: 'absent' | 'not_an_assertion' | 'not_stated' | 'bad_decision' | 'bad_quote' | 'bad_enum' };

/**
 * PURE — §12.4 / T6: the ONLY door to a `clinical_review` write. Every failure mode is the same
 * outcome for the caller: persist the turn, skip the overlay, answer 200.
 *
 *   1. the user turn is an assertion, not a lone question   (code, not the model — isAssertionTurn)
 *   2. `stated === true`                                    (D13: inferred never writes)
 *   3. `decision` is in the closed set                      (null / unknown → no write)
 *   4. `quote` is really a substring of the user turn       (empty ⇒ reject; this is the anchor that
 *                                                            keeps the stored words HIS words)
 *   5. every other enum is null or in its closed set        (a junk enum fails the whole overlay
 *                                                            rather than being silently nulled —
 *                                                            a half-read judgement is not a judgement)
 */
export function gateOverlay(raw: unknown, userTurn: string): OverlayGate {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'absent' };
  const o = raw as Record<string, unknown>;
  if (!isAssertionTurn(userTurn)) return { ok: false, reason: 'not_an_assertion' };
  if (o.stated !== true) return { ok: false, reason: 'not_stated' };
  const decision = typeof o.decision === 'string' ? o.decision.trim() : '';
  if (!(CLINICAL_REVIEW_DECISIONS as readonly string[]).includes(decision)) return { ok: false, reason: 'bad_decision' };
  const quote = typeof o.quote === 'string' ? o.quote.trim() : '';
  if (!quote || !containsQuote(userTurn, quote)) return { ok: false, reason: 'bad_quote' };
  const closed = <T extends string>(v: unknown, set: readonly T[]): T | null | undefined => {
    if (v == null || v === '') return null;
    const x = typeof v === 'string' ? v.trim() : '';
    return (set as readonly string[]).includes(x) ? (x as T) : undefined;   // undefined = out of set
  };
  const clockClass = closed(o.clock_class ?? o.clockClass, CLINICAL_REVIEW_CLOCK_CLASSES);
  const lt24hKind = closed(o.lt24h_kind ?? o.lt24hKind, CLINICAL_REVIEW_LT24H_KINDS);
  const exclusionClaim = closed(o.exclusion_claim ?? o.exclusionClaim, CLINICAL_REVIEW_EXCLUSION_CLAIMS);
  if (clockClass === undefined || lt24hKind === undefined || exclusionClaim === undefined) return { ok: false, reason: 'bad_enum' };
  return {
    ok: true,
    overlay: { decision: decision as ClinicalReviewDecision, clockClass, lt24hKind, exclusionClaim, quote: quote.slice(0, CLINICAL_REVIEW_QUOTE_MAX_CHARS) },
  };
}

/** PURE: lift the `overlay` object out of the model's reply, if it sent one. Deliberately separate
 *  from `parseAskReply` so the R4.3 answer path is byte-for-byte what it was: an overlay that cannot
 *  be found or cannot be parsed is simply absent, and absent fails the gate harmlessly. */
export function parseAskOverlay(text: string | null | undefined): unknown {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  for (let end = cleaned.lastIndexOf('}'); end > start; end = cleaned.lastIndexOf('}', end - 1)) {
    try {
      const o = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        const ov = o.overlay;
        return ov && typeof ov === 'object' && !Array.isArray(ov) ? ov : null;
      }
      break;
    } catch { /* keep shrinking */ }
  }
  return null;
}

// ── R9 — the persisted thread (O1 / D12) ─────────────────────────────────────────────────

export const ASK_TURN_ROLES = ['user', 'agent'] as const;
export type AskTurnRole = (typeof ASK_TURN_ROLES)[number];

/** One stored turn, as the thread reads back. `content` is already de-identified (R43-8 stands: the
 *  de-id rule now covers STORED turn content as well as model material). */
export interface AskThreadTurn {
  turnIndex: number;
  role: AskTurnRole;
  content: string;
  actor: string | null;
  withheld: boolean;
  at: string | null;
}

/**
 * PURE — fold the stored thread into the {question, answer} pairs the prompt builder takes. A user
 * turn opens a pair; the next agent turn closes it. A WITHHELD agent turn closes the pair and the
 * pair is DROPPED: the model must not be shown an answer that failed its own citation check, and it
 * must not be shown a dangling question either. Then the existing cap applies (last N turns, token
 * trim, oldest first) — one code path for the window, exactly as R4.3 had it.
 */
export function threadToHistory(turns: readonly AskThreadTurn[]): AskTurn[] {
  const pairs: AskTurn[] = [];
  let open: string | null = null;
  for (const t of [...turns].sort((a, b) => a.turnIndex - b.turnIndex)) {
    if (t.role === 'user') { open = typeof t.content === 'string' ? t.content.trim() : ''; continue; }
    if (open) {
      const answer = typeof t.content === 'string' ? t.content.trim() : '';
      if (!t.withheld && answer) pairs.push({ question: open, answer });
      open = null;
    }
  }
  return capHistory(pairs);
}
