/**
 * lib/stay-library/contamination.ts — the template-contamination guard
 * (CDMSS-STAY-LIBRARY-HARDENING-PRD-v1.0-29-AUG-2026, H2 / H-D3 / H-D4).
 *
 * WHAT WENT WRONG. R10 found a cholecystectomy operative note printed word for word inside a
 * hernioplasty discharge summary — the hospital's template had carried another patient's operative
 * text through. The discharge line was therefore VERBATIM, which is exactly what P4's trust gate
 * checks: a contaminated procedure with a real span passes condition 3 and promotes the wrong
 * operation onto a member's longitudinal record. Today the only thing standing between us and that
 * is that discharge span coverage is usually poor, which is luck, not a guard.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT (H-D3). It is DETERMINISTIC and CODE-SIDE: no model call, no
 * engine finding, no engine version bump, and no effect on CVI. It compares two strings the stay
 * already holds — the OT row's structured `surgery_name` and the discharge extract's `procedure` —
 * and answers one question: do they share any substantive word at all? It is NOT a claim that the
 * discharge is wrong. It is a claim that the two documents do not agree about what was done, and
 * that a fact that cannot be corroborated by the stay's own theatre record must not reach the spine.
 *
 * IT ERRS TOWARD NOT FLAGGING, AND THAT DIRECTION IS DELIBERATE (H-D4). A false flag suppresses a
 * true procedure from the spine; a missed flag is the status quo. One shared substantive token is
 * enough to clear the whole comparison, approach and laterality words are thrown away before the
 * comparison runs so "LAPAROSCOPIC" cannot make two different operations look related, and short
 * tokens are dropped because acronyms (TAPP, TEP, LSCS) collide across specialities.
 *
 * PURE: no DB, no model, no clock, no I/O. Same-stay comparison ONLY — cross-stay matching is
 * explicitly out of scope (H-D12), for the same reason R10 scoped it out: two stays may legitimately
 * share nothing.
 */

/**
 * H-D4's stoplist, verbatim. Every word here describes HOW an operation was done, WHICH SIDE it was
 * done on, or is a document noun — none of them distinguishes one operation from another, and
 * leaving them in would let a cholecystectomy and a hernioplasty "agree" on the word LAPAROSCOPIC.
 */
export const CONTAMINATION_STOPLIST: ReadonlySet<string> = new Set([
  'LAPAROSCOPIC', 'OPEN', 'BILATERAL', 'UNILATERAL', 'LEFT', 'RIGHT', 'PRIMARY', 'SURGERY',
  'PROCEDURE', 'OPERATION', 'NOTE', 'NOTES', 'REPAIR', 'WITH', 'AND',
]);

/** H-D4 — alphabetic tokens shorter than this are dropped. Surgical acronyms live below it (TAPP,
 *  TEP, LSCS, TURP), and an acronym match is not evidence two operations are the same one. */
export const MIN_TOKEN_LENGTH = 5;

/**
 * PURE — one procedure title → its SIGNIFICANT tokens, per H-D4: uppercase, strip punctuation, drop
 * the stoplist, keep alphabetic tokens of length ≥ 5. Sorted and de-duplicated so a stored token set
 * is comparable across two readings of the same stay.
 *
 * Punctuation becomes a SPACE rather than being deleted: deleting it would fuse "HERNIA/REPAIR" into
 * one token that matches nothing, which is a silent way to manufacture a zero-overlap flag.
 */
export function significantTokens(title: string | null | undefined): string[] {
  const cleaned = String(title ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ');
  const kept = new Set<string>();
  for (const token of cleaned.split(' ')) {
    if (token.length < MIN_TOKEN_LENGTH) continue;
    if (!/^[A-Z]+$/.test(token)) continue;          // alphabetic only — a code is not a word
    if (CONTAMINATION_STOPLIST.has(token)) continue;
    kept.add(token);
  }
  return [...kept].sort();
}

/**
 * PURE — H-D4's rule. TRUE when this stay's OT note and its discharge summary name operations that
 * share ZERO substantive words, which is what a template that carried another patient's operative
 * text looks like.
 *
 * BOTH SIDES MUST HAVE SOMETHING TO COMPARE. When either significant set comes back empty — a
 * discharge that says only "TAPP", an OT row whose `surgery_name` is "OPEN SURGERY" — this returns
 * FALSE. H-D4's literal sentence is "share ZERO tokens ⇒ suspect", and an empty set does share zero
 * tokens; but H-D4's own closing rule is that it errs toward not flagging, and flagging on a
 * comparison that carried no information is the opposite of that. Nothing was learned, so nothing is
 * claimed. Flagged to the orchestrator as the one reading H-D4 does not settle outright.
 */
export function contaminationSuspect(
  otSurgery: string | null | undefined,
  dischargeProcedure: string | null | undefined,
): boolean {
  const ot = significantTokens(otSurgery);
  const discharge = significantTokens(dischargeProcedure);
  if (!ot.length || !discharge.length) return false;
  return !discharge.some((t) => ot.includes(t));
}

/** What a suspect stamp carries, for auditability (§2: "plus both normalized token sets"). A
 *  reviewer who disagrees with the flag can see exactly which words were compared. */
export interface ContaminationNotice {
  suspect: true;
  /** The OT row's structured `surgery_name`, as stored. */
  otSurgery: string;
  /** The discharge extract's `procedure`, as stored. */
  dischargeProcedure: string;
  otTokens: string[];
  dischargeTokens: string[];
}

/**
 * PURE — the one line the stay panel renders (§2), in the words the PRD fixes. Kept here rather
 * than in the component so the copy and the rule that produces it cannot drift apart, and so a test
 * can pin the sentence.
 */
export const CONTAMINATION_COPY =
  'possible template contamination: the discharge names a procedure that shares no terms with this stay’s OT note.';

/**
 * PURE — the notice for ONE stay, or null.
 *
 * MULTIPLE OT NOTES. A stay can have several operative notes (the substrate caps at 20). The
 * discharge is compared against EVERY one of them and is suspect only if it shares nothing with
 * ALL of them — a discharge that matches the second of three operations is a discharge that agrees
 * with this stay's theatre record. This follows H-D4's stated direction rather than inventing one;
 * flagged in the report because the PRD's worked examples are single-OT.
 *
 * `otSurgery` on the returned notice names the FIRST OT title, which is the one a reviewer sees
 * first on the panel; every compared token is in `otTokens`.
 */
export function contaminationNotice(
  otSurgeries: ReadonlyArray<string | null | undefined>,
  dischargeProcedure: string | null | undefined,
): ContaminationNotice | null {
  const titles = otSurgeries.map((t) => String(t ?? '').trim()).filter(Boolean);
  const discharge = String(dischargeProcedure ?? '').trim();
  if (!titles.length || !discharge) return null;
  // Clean the moment ANY operative note agrees with the discharge.
  if (!titles.every((t) => contaminationSuspect(t, discharge))) return null;
  const otTokens = [...new Set(titles.flatMap(significantTokens))].sort();
  const dischargeTokens = significantTokens(discharge);
  if (!otTokens.length || !dischargeTokens.length) return null;
  return { suspect: true, otSurgery: titles[0], dischargeProcedure: discharge, otTokens, dischargeTokens };
}
