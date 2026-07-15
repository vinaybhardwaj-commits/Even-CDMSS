// lib/inquiry/inquiry-core.ts — Inquiry engine (inquiry/0.1): pure candidate generation,
// Gemini-output validation and assembly (Inquiry PRD §5–§6). ADVISORY PLANE — a selection layer
// ABOVE the frozen care-call floor, never a fork of it: candidates are typed to the 5 existing
// ask families, ids stay `${family}:${slug(subject)}`, and every assembly guarantee of
// ask-set/0.1 §3.3 (high-alert first, cap 5, overflow preserved) survives verbatim.
//
// PURE: no LLM client, no I/O — the governed call is injected (deps.generate), so the route
// wires governedChat and the bench script wires its own arm. Any failure (throw, timeout,
// invalid JSON, zero valid picks) ⇒ buildAskSet verbatim (ask-set/0.1, deterministic_fallback).
//
// Import discipline (architecture rule 5): intra-inquiry references are 'import type' only; the
// sole value dependency is the frozen care-call floor (not a scored core). slug is deliberately
// duplicated from care-call-core (not exported there; the frozen floor is never edited).

import type { UnknownItem, UnknownKind } from './unknowns-core';
import { buildAskSet, ASK_SET_VERSION } from '../care-call-core';
import type { AskItem, AskKeys, OverflowItem } from '../care-call-core';
import type { DeidOpdCase } from '../opd-ingest-core';

export const INQUIRY_VERSION = 'inquiry/0.1' as const;
export const INQUIRY_ASK_SET_VERSION = 'ask-set/0.2' as const;

// ── the registered standing prompt (Stage-0 registry extracts *_SYSTEM template literals) ──
export const INQUIRY_SELECT_SYSTEM = `You help a care manager decide which few questions are most worth asking a patient on a post-visit phone call.

You are given a numbered list of CANDIDATE questions (each with an id, family, subject, why it matters, and criticality) plus a short clinical context summary. Every candidate is already clinically legal — your job is ONLY to choose and phrase, never to invent.

Rules:
- Pick the AT MOST 3 candidates most worth asking FIRST, ordered by importance.
- You may rewrite each pick's question text to be warmer and more specific, and its "why" — nothing else. The question MUST still name the candidate's subject, be a single question, and stay under 160 characters.
- NEVER invent a question that is not in the candidate list. NEVER change a candidate's family, subject or id.
- Prefer safety-critical unknowns (stopped high-alert medicines, contradictions, severely abnormal stale results) over routine ones.
- If nothing beats the baseline candidates, pick the best baseline candidates.

Respond with JSON ONLY, exactly this shape:
{"picks":[{"id":"<candidate id>","question":"<the question to ask>","why":"<one short line for the care manager>"}],"rationale":"<optional, one line>"}`;

// ── shapes ──
export interface CandidateAsk extends AskItem { unknownIds: string[]; why: string }
export interface SelectionPick { id: string; question: string; why?: string }
export interface AskMetaItem { askId: string; unknownIds: string[]; why: string }
export interface InquiryAskSet {
  asks: AskItem[];
  overflow: OverflowItem[];
  ask_set_version: string;                      // 'ask-set/0.2' | 'ask-set/0.1' (fallback)
  source: 'inquiry' | 'deterministic_fallback';
  askMeta: AskMetaItem[];
}

// local copies (deliberate duplication — see header)
const slug = (s: string): string =>
  (s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'x';
const clip = (s: string, n = 80): string => (s.length > n ? s.slice(0, n).trim() : s).trim();

/** Does the question mention at least one meaningful token of its subject? (generic suppression). */
export function questionMentionsSubject(subject: string, question: string): boolean {
  const toks = (subject || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 4);
  if (!toks.length) return true;   // subjectless families (ALLERGY_CONFIRM / OUTSIDE_RECORDS) are exempt
  const q = (question || '').toLowerCase();
  return toks.some((t) => q.includes(t));
}

// ── §5 candidate generation (pure) ──
const SKELETONS: Partial<Record<UnknownKind, (u: UnknownItem) => { family: AskItem['family']; question: string } | null>> = {
  med_contradiction: (u) => ({ family: 'MED_STATUS', question: clip(`Last time you said you'd stopped ${u.subject} — how is it now, are you taking it?`, 160) }),
  unknown_finding: (u) => ({ family: 'COMPLAINT_STATUS', question: clip(`How is ${u.subject} now?`, 160) }),
  missing_critical: (u) => ({ family: 'COMPLAINT_STATUS', question: clip(`How is ${u.subject} now?`, 160) }),
  care_gap: (u) => ({ family: 'FOLLOWUP_ACTION', question: clip(`Your ${u.subject} was ${clip(u.detail, 60)} — shall I help you book a repeat test?`, 160) }),
  followup_open: (u) => ({ family: 'FOLLOWUP_ACTION', question: clip(`Doctor advised ${clip(u.subject)} — shall I help you book it now?`, 160) }),
  allergy_unconfirmed: () => ({ family: 'ALLERGY_CONFIRM', question: 'Before I go — any medicine allergies we should have on file?' }),
  // instability_input / anything unmappable → no candidate (recorded as dropped in the persist payload)
};

/**
 * Each UnknownItem maps to ≤1 CandidateAsk typed to an EXISTING family (D10). The ask-set/0.1
 * deterministic asks (from the frozen buildAskSet) are ALSO candidates (`why: 'baseline'`) —
 * Gemini chooses among the union, so the deterministic floor competes rather than disappearing.
 */
export function candidatesFromUnknowns(unknowns: UnknownItem[], episode: DeidOpdCase, keys: AskKeys): CandidateAsk[] {
  const out: CandidateAsk[] = [];
  const byId = new Map<string, CandidateAsk>();
  const add = (c: CandidateAsk) => {
    const existing = byId.get(c.id);
    if (existing) {  // same deterministic id → merge derivation, keep the first phrasing
      existing.unknownIds = [...new Set([...existing.unknownIds, ...c.unknownIds])];
      if (existing.why === 'baseline' && c.why !== 'baseline') existing.why = c.why;
      return;
    }
    byId.set(c.id, c);
    out.push(c);
  };

  for (const a of buildAskSet(episode, keys).asks) add({ ...a, unknownIds: [], why: 'baseline' });

  for (const u of unknowns) {
    const sk = SKELETONS[u.kind]?.(u) ?? null;
    if (!sk) continue;
    const subject = sk.family === 'ALLERGY_CONFIRM' ? '' : u.subject;
    add({
      id: `${sk.family}:${slug(subject)}`,
      family: sk.family,
      subject,
      question: sk.question,
      unknownIds: [u.id],
      why: u.detail,
    });
  }
  return out;
}

/** Unknowns that produced no candidate — persisted as `dropped` (PRD §5/§8). */
export function droppedUnknowns(unknowns: UnknownItem[], candidates: CandidateAsk[]): UnknownItem[] {
  const mapped = new Set(candidates.flatMap((c) => c.unknownIds));
  return unknowns.filter((u) => !mapped.has(u.id));
}

/** User-message builder for the governed call (registered by the Stage-0 builder scan).
 *  Clinical content only — uid/uhid/patient identity NEVER enter the prompt (PRD §17). */
export function buildInquirySelectUser(candidates: CandidateAsk[], contextSummary: string): string {
  const lines = candidates.map((c, i) =>
    `${i + 1}. id=${c.id} · family=${c.family} · subject=${c.subject || '(none)'} · high-alert=${c.meta?.highAlert ? 'yes' : 'no'} · why=${clip(c.why, 120)} · question="${c.question}"`);
  return `CONTEXT (de-identified):\n${contextSummary || '(no additional context)'}\n\nCANDIDATES:\n${lines.join('\n')}\n\nPick at most 3, JSON only.`;
}

/** Parse the model output → picks, or null on any structural failure (⇒ fallback). */
export function parseSelection(raw: string): SelectionPick[] | null {
  try {
    const m = String(raw ?? '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]) as { picks?: unknown };
    if (!Array.isArray(j.picks)) return null;
    const picks: SelectionPick[] = [];
    for (const p of j.picks) {
      if (!p || typeof p !== 'object') return null;
      const { id, question, why } = p as Record<string, unknown>;
      if (typeof id !== 'string' || typeof question !== 'string') return null;
      picks.push({ id, question, why: typeof why === 'string' ? why : undefined });
    }
    return picks;
  } catch {
    return null;
  }
}

/**
 * Deterministic validation (§6): every pick id ∈ candidates; ≤3 picks; no duplicate ids;
 * question non-empty and ≤160 chars (else the pick is rejected); family/subject/id ALWAYS come
 * from the candidate — Gemini may rewrite `question` and `why` only; a generic question (no
 * subject token) is replaced by the candidate's skeleton phrasing.
 */
export function validateSelection(picks: SelectionPick[], candidates: CandidateAsk[]): { ask: AskItem; meta: AskMetaItem }[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const valid: { ask: AskItem; meta: AskMetaItem }[] = [];
  for (const p of picks ?? []) {
    if (valid.length >= 3) break;
    const c = byId.get(p.id);
    if (!c || seen.has(p.id)) continue;                       // foreign or duplicate id → rejected
    const q = String(p.question ?? '').trim();
    if (!q || q.length > 160) continue;                       // over-length / empty → rejected
    const question = questionMentionsSubject(c.subject, q) ? q : c.question;   // generic → skeleton
    seen.add(p.id);
    valid.push({
      ask: { id: c.id, family: c.family, subject: c.subject, question, meta: c.meta },
      meta: { askId: c.id, unknownIds: c.unknownIds, why: (p.why ?? '').trim() || c.why },
    });
  }
  return valid;
}

/** The byte-identical deterministic fallback (D11): buildAskSet verbatim, ask-set/0.1. */
export function fallbackAskSet(episode: DeidOpdCase, keys: AskKeys): InquiryAskSet {
  const base = buildAskSet(episode, keys);
  return {
    asks: base.asks,
    overflow: base.overflow,
    ask_set_version: ASK_SET_VERSION,
    source: 'deterministic_fallback',
    askMeta: base.asks.map((a) => ({ askId: a.id, unknownIds: [], why: 'baseline' })),
  };
}

/**
 * Assembly (§6) — the ask-set/0.1 §3.3 hard guarantees preserved: every high-alert MED_STATUS
 * ask is ALWAYS included first regardless of Gemini's picks; then the validated picks in order;
 * then deterministic follow-up/allergy asks if slots remain; total cap stays 5; everything else
 * → overflow. Zero valid picks ⇒ deterministic fallback verbatim.
 */
export function assembleInquiryAskSet(
  episode: DeidOpdCase, keys: AskKeys,
  candidates: CandidateAsk[], validPicks: { ask: AskItem; meta: AskMetaItem }[],
): InquiryAskSet {
  if (!validPicks.length) return fallbackAskSet(episode, keys);
  const base = buildAskSet(episode, keys);
  const metaFor = new Map(validPicks.map((v) => [v.ask.id, v.meta]));
  const candById = new Map(candidates.map((c) => [c.id, c]));

  const asks: AskItem[] = [];
  const included = new Set<string>();
  const take = (a: AskItem) => {
    if (asks.length >= 5 || included.has(a.id)) return;
    included.add(a.id);
    asks.push(a);
  };

  for (const a of base.asks) if (a.meta?.highAlert) take(a);            // 1. high-alert MED_STATUS, always first
  for (const v of validPicks) take(v.ask);                               // 2. validated picks, in order
  for (const a of base.asks) {                                           // 3. deterministic follow-up/allergy if room
    if (a.family === 'FOLLOWUP_ACTION' || a.family === 'ALLERGY_CONFIRM') take(a);
  }

  const overflow: OverflowItem[] = [];
  const overflowSeen = new Set<string>();
  const spill = (family: AskItem['family'], subject: string) => {
    const k = `${family}:${slug(subject)}`;
    if (included.has(k) || overflowSeen.has(k)) return;
    overflowSeen.add(k);
    overflow.push({ family, subject });
  };
  for (const a of base.asks) spill(a.family, a.subject);
  for (const o of base.overflow) spill(o.family, o.subject);
  for (const c of candidates) spill(c.family, c.subject);

  const askMeta: AskMetaItem[] = asks.map((a) =>
    metaFor.get(a.id)
    ?? { askId: a.id, unknownIds: candById.get(a.id)?.unknownIds ?? [], why: candById.get(a.id)?.why ?? 'baseline' });

  return { asks, overflow, ask_set_version: INQUIRY_ASK_SET_VERSION, source: 'inquiry', askMeta };
}

// ── the injected-generation orchestration (still pure: the model call comes in via deps) ──
export interface InquirySelectDeps {
  /** One governed model call: (system, user) → raw model text. The route wires governedChat. */
  generate: (system: string, user: string) => Promise<string>;
  /** Compact de-identified member/episode summary for the prompt (optional). */
  contextSummary?: string;
  /** Hard budget for the model call; exceeded ⇒ deterministic fallback. */
  timeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error('inquiry-select timeout')), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
}

/**
 * The full selection: candidates → one governed call → parse → validate → assemble.
 * NEVER throws: any failure (generate throw, timeout, invalid JSON, zero valid picks)
 * returns buildAskSet verbatim as ask-set/0.1 with source 'deterministic_fallback'.
 */
export async function runInquirySelection(
  episode: DeidOpdCase, keys: AskKeys, unknowns: UnknownItem[], deps: InquirySelectDeps,
): Promise<InquiryAskSet & { candidateCount: number; dropped: UnknownItem[] }> {
  const candidates = candidatesFromUnknowns(unknowns, episode, keys);
  const dropped = droppedUnknowns(unknowns, candidates);
  const decorate = (s: InquiryAskSet) => ({ ...s, candidateCount: candidates.length, dropped });
  try {
    const raw = await withTimeout(
      deps.generate(INQUIRY_SELECT_SYSTEM, buildInquirySelectUser(candidates, deps.contextSummary ?? '')),
      deps.timeoutMs ?? 20_000,
    );
    const picks = parseSelection(raw);
    if (!picks) return decorate(fallbackAskSet(episode, keys));
    return decorate(assembleInquiryAskSet(episode, keys, candidates, validateSelection(picks, candidates)));
  } catch {
    return decorate(fallbackAskSet(episode, keys));
  }
}
