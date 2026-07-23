/**
 * lib/normative-grounding.ts — the deterministic retrieval-backed matcher for post-hoc normative
 * grounding. Reads a stored low-value finding, does a RESTRICTED vector retrieve (skipExpand, no
 * reranker, no BM25 — vector cosine only, so the result is byte-stable run-to-run and NO LLM is on the
 * path), gates via normative-grounding-core, and returns the accepted citations. SOFT-FAILS to "no
 * citation" — never throws, never blocks. It reads stored findings; it is NOT on the audit-generation
 * path and it changes no verdict/score/lvc_category.
 */
import { retrieve, type RetrieveOptions } from './retrieve';
import type { Source } from './citations-core';
import {
  CW_SOURCE, GUIDELINE_SOURCES, NORMATIVE_TAU,
  cwCandidateAccepted, guidelineCandidateAccepted, hitToSource, mergeNormativeCitations,
  type NormativeHit,
} from './normative-grounding-core';

export type GroundingFinding = { subject?: string; rationale?: string | null; lvc_category?: string; verdict?: string; informational?: boolean };
export type GroundingResult = { cw: Source | null; guideline: Source | null; citations: Source[] };
export type GroundingDeps = { retrieveFn?: typeof retrieve };
/** Selection controls (backfill/inspection ONLY — they never change the match/gate MATH):
 *  - legs: which leg(s) to run ('both' default). - categories: if set, ground ONLY findings whose
 *  lvc_category is in the list ([]/undefined = all). - tau: cosine threshold (default NORMATIVE_TAU).
 *  Defaults reproduce today's behaviour byte-identically. */
export type GroundingOptions = { legs?: 'cw' | 'guideline' | 'both'; categories?: string[]; tau?: number };

/** Deterministic retrieval config: vector cosine only — no expansion, no reranker, no BM25, no source
 *  weighting. So hits[0].similarity is the raw cosine the gate reads, and the match is reproducible. */
const CW_OPTS: RetrieveOptions = { source: CW_SOURCE, topK: 1, skipExpand: true, useReranker: false, useSourceWeights: false, hybrid: false };
const GUIDELINE_OPTS: RetrieveOptions = { restrictSources: [...GUIDELINE_SOURCES], topK: 1, skipExpand: true, useReranker: false, useSourceWeights: false, hybrid: false };

/** Ground ONE finding against CW (category-gated) + the guideline sources (τ-gated). Returns the
 *  accepted citations (n=0 placeholder — the backfill assigns the real append index). Soft-fail.
 *  `options` selects legs/categories/tau for backfill/inspection; default = today's behaviour exactly
 *  (both legs, all categories, NORMATIVE_TAU) — the match/gate MATH is unchanged. */
export async function groundFinding(finding: GroundingFinding, deps: GroundingDeps = {}, options: GroundingOptions = {}): Promise<GroundingResult> {
  const retrieveFn = deps.retrieveFn ?? retrieve;
  const tau = options.tau ?? NORMATIVE_TAU;
  const legs = options.legs ?? 'both';
  const cats = options.categories;
  const empty: GroundingResult = { cw: null, guideline: null, citations: [] };

  // Category selection (backfill only): if a list is given, ground ONLY those lvc_categories.
  if (cats && cats.length && !cats.includes(String(finding.lvc_category ?? ''))) return empty;

  const q = `${finding.subject ?? ''} ${finding.rationale ?? ''}`.trim();
  if (!q) return empty;

  let cw: Source | null = null;
  let guideline: Source | null = null;

  if (legs === 'cw' || legs === 'both') {
    try {
      const r = await retrieveFn(q, CW_OPTS);
      const top = r.hits?.[0] as NormativeHit | undefined;
      if (top && cwCandidateAccepted(finding.lvc_category, top, tau)) cw = hitToSource(top, 0);
    } catch (e) { console.warn('[normative-grounding] CW leg failed', (e as Error).message); }
  }

  if (legs === 'guideline' || legs === 'both') {
    try {
      const r = await retrieveFn(q, GUIDELINE_OPTS);
      const top = r.hits?.[0] as NormativeHit | undefined;
      if (top && guidelineCandidateAccepted(top, tau)) guideline = hitToSource(top, 0);
    } catch (e) { console.warn('[normative-grounding] guideline leg failed', (e as Error).message); }
  }

  return { cw, guideline, citations: mergeNormativeCitations([cw, guideline]) };
}
