/**
 * lib/ipd-episode/resolve-core.ts — the DETERMINISTIC omission resolver (PRD decision 33,
 * V, 2026-09-02). Pure: no db, no model, no Next.
 *
 * ⚠️ WHY THIS FILE EXISTS. Three runs of IP-1286 scored 96, 100 and 80 on byte-identical
 * checkpoints, and across all three ZERO findings had an empty `evidence_basis` and ZERO rested on
 * a Tier C source — yet the judge returned 0, 12 and 11 `unassessable` verdicts, ten of them on
 * Tier A evidence. The model was not reporting that the mirror could not answer; it was declining
 * to commit. And the question it was declining on — did the expected thing happen — is not a
 * judgement at all. It is a lookup.
 *
 * DECISION 33: whether an expected action happened is a DATABASE QUESTION. Code decides it. The
 * model proposes what to expect, and its severity, while it is still blinded; this module answers
 * whether it happened. Nothing here can waver between runs, because nothing here asks an opinion.
 *
 * The four outcomes, and the one that is deliberately narrow:
 *
 *   PRESENT                 a matching event exists at or after the entry's by_day → concordant
 *   ABSENT, class present   the data class IS represented in this episode, so the absence is real
 *                           → divergent, at the severity proposed at generation time
 *   ABSENT, class missing   the class is not represented at all (no lab rows anywhere; vitals and
 *                           radiology are not in this mirror) → unassessable. THE ONLY PATH THAT
 *                           MAY PRODUCE unassessable.
 *   AMBIGUOUS               the class exists but cannot settle THIS question — a package bill can
 *                           hide a dispensed drug, a panel can hide an analyte → context_dependent
 *
 * Every finding records which path produced it, in `resolution`, together with the matcher that
 * resolved it. A validator can re-derive the whole omission set from the stored course and the
 * stored events without running a model.
 */

import type { EpisodeEvent } from './assemble-core';

// ── the matcher (emitted by the checkpoint model at generation time, item 1) ─────────────────

export const MATCHER_KINDS = ['lab', 'drug', 'imaging', 'procedure', 'note', 'vitals', 'other'] as const;
export type MatcherKind = (typeof MATCHER_KINDS)[number];

export interface ExpectationMatcher {
  kind: MatcherKind;
  /** Lower-cased search terms. A match on ANY term is a match. */
  terms: string[];
}

export const RESOLUTIONS = ['present', 'absent_class_present', 'absent_class_missing', 'ambiguous_confounded'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

// ── class availability ──────────────────────────────────────────────────────────────────────

/**
 * Is this data class represented in the episode at all?
 *
 * ⚠️ TWO CLASSES ARE NEVER REPRESENTED, AND THAT IS A FACT ABOUT THE MIRROR, NOT THIS EPISODE.
 * `vitals` has no table in the KX mirror at all (the Even-native `chart_*` layer holds observations
 * but its encounter namespace does not join — reference §2, overlap measured at zero). `imaging` is
 * effectively absent: `kx_radiology_reports` reaches 24 encounters by uhid and 1 by visit_id, and
 * `chart_radiology_report` has zero rows — the reference's own instruction is "treat radiology as
 * unavailable". An expectation of either therefore resolves `unassessable` on EVERY episode, which
 * is the honest answer: this pipeline cannot tell you whether a chest film was done.
 */
export function classIsRepresented(kind: MatcherKind, events: readonly EpisodeEvent[]): boolean {
  switch (kind) {
    case 'lab':
      return events.some((e) => e.event_type === 'lab_order');
    case 'drug':
      return events.some((e) => e.event_type === 'order' && detail(e, 'service_type') === 'Pharmacy');
    case 'procedure':
      return events.some((e) => e.event_type === 'ot_note')
        || events.some((e) => e.event_type === 'order' && detail(e, 'service_type') !== 'Pharmacy');
    case 'note':
      return events.some((e) => e.event_type === 'note' || e.event_type === 'initial_assessment'
        || e.event_type === 'handover');
    case 'imaging':
    case 'vitals':
      return false;
    case 'other':
    default:
      // Not a class this engine can look up. It is never "absent" in the checkable sense.
      return false;
  }
}

// ── the confounds, enumerated (item 2) ──────────────────────────────────────────────────────
//
// These are the cases where the class EXISTS but a negative lookup does not mean the thing did not
// happen. They are written out here, in code, precisely so the model is not asked to weigh them.

/** A billing line that bundles its contents — a package, a kit, a bundled procedure charge. A drug
 *  dispensed inside one of these never appears under its own `ordered_item_name`. */
const PACKAGE_HINT = /\b(package|bundle|bundled|kit|combo|scheme|surgery charge|ot charge|procedure charge|day care)\b/i;

/** A lab ordered as a profile or panel: the constituent analyte has no row of its own. */
const PANEL_HINT = /\b(profile|panel|screen|screening|series|complete blood count|cbc|lft|rft|kft|electrolytes|coagulation)\b/i;

export interface Confound { kind: MatcherKind; reason: string }

/**
 * Does something in this episode make a NEGATIVE lookup unsafe for this class? Returns the reason
 * when it does, so the stored finding can say WHY it is context_dependent rather than divergent.
 */
export function confoundFor(kind: MatcherKind, events: readonly EpisodeEvent[]): Confound | null {
  if (kind === 'drug') {
    const pkg = events.find((e) => e.event_type === 'order'
      && PACKAGE_HINT.test(`${detail(e, 'service_item_name')} ${detail(e, 'ordered_item_name')} ${detail(e, 'department')}`));
    if (pkg) {
      return { kind, reason: `a bundled billing line (${detail(pkg, 'service_item_name') || detail(pkg, 'ordered_item_name') || 'package'}) can hide a dispensed drug` };
    }
  }
  if (kind === 'lab') {
    const panel = events.find((e) => e.event_type === 'lab_order' && PANEL_HINT.test(detail(e, 'service_name')));
    if (panel) {
      return { kind, reason: `a panel order (${detail(panel, 'service_name')}) can contain the analyte without naming it` };
    }
  }
  if (kind === 'procedure') {
    // An OT note's procedure detail is free text; a step performed inside an operation is not
    // separately recorded anywhere.
    if (events.some((e) => e.event_type === 'ot_note')) {
      return { kind, reason: 'an operative step performed within a recorded procedure is not separately billed or noted' };
    }
  }
  return null;
}

// ── matching ────────────────────────────────────────────────────────────────────────────────

const detail = (e: EpisodeEvent, key: string): string => {
  const v = (e.detail as Record<string, unknown>)?.[key];
  return v == null ? '' : String(v);
};

/** The text a matcher is tested against, per event kind. Deliberately narrow: an event's whole
 *  JSON would match almost anything, which would turn every expectation into a false PRESENT. */
export function haystackFor(e: EpisodeEvent): string {
  switch (e.event_type) {
    case 'lab_order':
      return `${detail(e, 'service_name')} ${detail(e, 'sub_department')}`;
    case 'order':
      return `${detail(e, 'ordered_item_name')} ${detail(e, 'service_item_name')} ${detail(e, 'service_type')} ${detail(e, 'department')}`;
    case 'ot_note':
      return `${detail(e, 'surgery_name')} ${e.summary}`;
    default:
      return e.summary;
  }
}

/** Which event types a matcher kind may match against — so a `drug` expectation cannot be
 *  satisfied by the word appearing in a progress note. */
export function eventTypesFor(kind: MatcherKind): readonly EpisodeEvent['event_type'][] {
  switch (kind) {
    case 'lab': return ['lab_order'];
    case 'drug': return ['order'];
    case 'procedure': return ['ot_note', 'order'];
    case 'note': return ['note', 'initial_assessment', 'handover'];
    default: return [];
  }
}

const norm = (s: string) => s.toLowerCase();

/** A term matches when it appears in the haystack, whole-word where the term is a single word.
 *  Terms shorter than 3 characters are ignored — "iv" would match everything. */
export function termMatches(term: string, haystack: string): boolean {
  const t = norm(term).trim();
  if (t.length < 3) return false;
  const h = norm(haystack);
  if (!/\s/.test(t)) {
    return new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(h);
  }
  return h.includes(t);
}

export interface MatchHit { event: EpisodeEvent; term: string }

/**
 * Find an event satisfying this expectation at or after `byDay`.
 *
 * "At or after" is deliberate: an expectation stated as "by day 1" is met by an action on day 1 or
 * day 2, and an action BEFORE the expectation was formed also counts — the checkpoint could only
 * expect what had not yet happened, so an earlier occurrence means the course was already ahead of
 * it. Narrowing this to an exact day would manufacture omissions out of timing.
 */
export function findMatch(
  matcher: ExpectationMatcher, byDay: number | null, events: readonly EpisodeEvent[],
): MatchHit | null {
  const types = eventTypesFor(matcher.kind);
  if (!types.length) return null;
  for (const e of events) {
    if (!types.includes(e.event_type)) continue;
    if (byDay != null && e.day_index < byDay) {
      // An earlier event still counts (see above) — day only bounds the "not yet" direction.
    }
    const hay = haystackFor(e);
    for (const term of matcher.terms) {
      if (termMatches(term, hay)) return { event: e, term };
    }
  }
  return null;
}

// ── the resolver ────────────────────────────────────────────────────────────────────────────

export interface ResolvableEntry {
  /** `<checkpoint-id>/<section>/<n>` — the same ref the diff pass would have used. */
  ref: string;
  checkpointId: string;
  dayIndex: number;
  section: string;
  item: string;
  rationale: string;
  byDay: number | null;
  citationIds: number[];
  matcher: ExpectationMatcher | null;
  proposedSeverity: 'minor' | 'moderate' | 'major';
}

export interface ResolvedOutcome {
  resolution: Resolution;
  verdict: 'concordant' | 'divergent' | 'unassessable' | 'context_dependent';
  severity: 'minor' | 'moderate' | 'major';
  statement: string;
  matchedEvent: EpisodeEvent | null;
  matchedTerm: string | null;
  confound: string | null;
}

/**
 * Resolve ONE expected entry against the assembled event list. Total and deterministic: the same
 * entry and the same events give the same answer, every time, with no model in the loop.
 *
 * An entry with no matcher resolves `ambiguous_confounded` — the model failed to say what would
 * count as satisfying it, so code cannot check it and will not guess. That is a defect in the
 * generation, and it is recorded as one rather than scored as an omission.
 */
export function resolveEntry(entry: ResolvableEntry, events: readonly EpisodeEvent[]): ResolvedOutcome {
  const m = entry.matcher;
  if (!m || !m.terms.length) {
    return {
      resolution: 'ambiguous_confounded',
      verdict: 'context_dependent',
      severity: entry.proposedSeverity,
      statement: `Expected: ${entry.item}. This engine cannot check it — the expectation carried no machine-checkable matcher, so its presence or absence was never established.`,
      matchedEvent: null, matchedTerm: null,
      confound: 'no matcher was emitted for this expectation',
    };
  }

  const hit = findMatch(m, entry.byDay, events);
  if (hit) {
    return {
      resolution: 'present',
      verdict: 'concordant',
      severity: entry.proposedSeverity,
      statement: `Expected: ${entry.item}. The record shows it: ${hit.event.event_type} on day ${hit.event.day_index} matching "${hit.term}".`,
      matchedEvent: hit.event, matchedTerm: hit.term, confound: null,
    };
  }

  if (!classIsRepresented(m.kind, events)) {
    return {
      resolution: 'absent_class_missing',
      verdict: 'unassessable',
      severity: entry.proposedSeverity,
      statement: `Expected: ${entry.item}. This pipeline cannot answer whether it happened: no ${m.kind} data is represented for this admission${m.kind === 'vitals' || m.kind === 'imaging' ? ' — this class is absent from the mirror entirely' : ''}.`,
      matchedEvent: null, matchedTerm: null,
      confound: `no ${m.kind} data in this episode`,
    };
  }

  const confound = confoundFor(m.kind, events);
  if (confound) {
    return {
      resolution: 'ambiguous_confounded',
      verdict: 'context_dependent',
      severity: entry.proposedSeverity,
      statement: `Expected: ${entry.item}. No matching ${m.kind} record was found, but ${confound.reason}, so the absence cannot be read as the action not happening.`,
      matchedEvent: null, matchedTerm: null,
      confound: confound.reason,
    };
  }

  return {
    resolution: 'absent_class_present',
    verdict: 'divergent',
    severity: entry.proposedSeverity,
    statement: `Expected: ${entry.item}. No matching ${m.kind} record exists for this admission, and ${m.kind} data IS recorded for it — so the absence is real.`,
    matchedEvent: null, matchedTerm: null, confound: null,
  };
}

/** Resolve every entry. Order is stable (the order the entries were generated in). */
export function resolveAll(
  entries: readonly ResolvableEntry[], events: readonly EpisodeEvent[],
): { entry: ResolvableEntry; outcome: ResolvedOutcome }[] {
  return entries.map((entry) => ({ entry, outcome: resolveEntry(entry, events) }));
}

/** Counts by resolution, for the audit row and for the report. */
export function resolutionCounts(
  resolved: readonly { outcome: ResolvedOutcome }[],
): Record<Resolution, number> {
  const out: Record<Resolution, number> = {
    present: 0, absent_class_present: 0, absent_class_missing: 0, ambiguous_confounded: 0,
  };
  for (const r of resolved) out[r.outcome.resolution]++;
  return out;
}
