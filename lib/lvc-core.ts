/**
 * lib/lvc-core.ts — Appropriateness / Low-Value-Care matcher CORE (CW.2).
 *
 * PURE, dependency-free logic so the conditional gate is unit-testable without DB/LLM.
 * The wired orchestrator (lib/lvc.ts) imports this + db/llm/retrieve/trace.
 * See CDMSS-CHOOSING-WISELY-LOW-VALUE-CARE-PRD-v1.1.md §6.
 *
 * Cardinal rules encoded here:
 *  - A flag fires ONLY when the applicability judge says APPLIES *and* clears the
 *    surface's confidence floor. INSUFFICIENT-INFO and DOES-NOT-APPLY never fire.
 *  - Two-tier floor: high (0.75) for the unsolicited auto-flag path, medium (0.5)
 *    for the opt-in dedicated surface (§12-Q5).
 */

export type Region = 'US' | 'CA' | 'IN';
export type ActionType =
  | 'imaging' | 'lab' | 'medication' | 'procedure'
  | 'screening' | 'monitoring' | 'referral' | 'other';
/** 'surface' = opt-in /appropriateness page; 'autoflag' = unsolicited DDx/Ask advisory. */
export type Surface = 'surface' | 'autoflag';
export type Verdict = 'applies' | 'does_not_apply' | 'insufficient_info';

export interface LvcRecommendation {
  id: string;
  region: Region;
  society: string;
  specialty: string | null;
  statement: string;
  precondition: string | null;
  action_type: ActionType | string | null;
  consider_instead: string | null;
  rationale: string | null;
  keywords: string[];
  citation_doi: string | null;
  citation_pmid: string | null;
  citation_url: string | null;
  source_release_year: number | null;
  status?: string;
}

export interface Candidate {
  name: string;
  action_type?: ActionType | string;
}

export interface JudgedRec {
  rec: LvcRecommendation;
  verdict: Verdict;
  confidence: number; // 0..1
  why: string;
  consider_instead: string | null;
}

export interface LvcFlag {
  id: string;
  statement: string;
  society: string;
  region: Region;
  specialty: string | null;
  rationale: string | null;
  consider_instead: string | null;
  why_it_applies: string;
  confidence: number;
  citation: { url: string | null; doi: string | null; pmid: string | null; year: number | null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Confidence floor (two-tier) + the conditional gate
// ─────────────────────────────────────────────────────────────────────────────

export const AUTOFLAG_FLOOR = 0.75;
export const SURFACE_FLOOR = 0.5;

export function confidenceFloorFor(surface: Surface): number {
  return surface === 'autoflag' ? AUTOFLAG_FLOOR : SURFACE_FLOOR;
}

/** The gate: only APPLIES above the surface floor fires. INSUFFICIENT-INFO / DOES-NOT-APPLY never fire. */
export function passesFloor(j: { verdict: Verdict; confidence: number }, surface: Surface): boolean {
  if (j.verdict !== 'applies') return false;
  return j.confidence >= confidenceFloorFor(surface);
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyword recall (deterministic leg)
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeForMatch(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A rec matches if any of its keywords appears as a substring of the haystack
 * (scenario + candidate names), both normalized. Keywords are authored lowercase;
 * matching is substring on a normalized string so "lumbar mri" matches
 * "...ordered an MRI of the lumbar spine...". Short keywords (<3 chars) are ignored.
 */
export function keywordRecall(
  scenario: string,
  candidates: Candidate[],
  recs: LvcRecommendation[],
): LvcRecommendation[] {
  const hay = normalizeForMatch(`${scenario} ${candidates.map((c) => c.name).join(' ')}`);
  if (!hay) return [];
  const out: LvcRecommendation[] = [];
  for (const r of recs) {
    const hit = (r.keywords || []).some((k) => {
      const kk = normalizeForMatch(k);
      return kk.length >= 3 && hay.includes(kk);
    });
    if (hit) out.push(r);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Union / ordering / assembly
// ─────────────────────────────────────────────────────────────────────────────

export function dedupeById<T extends { id: string }>(...lists: T[][]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const list of lists) {
    for (const item of list) {
      if (item && !seen.has(item.id)) { seen.add(item.id); out.push(item); }
    }
  }
  return out;
}

const regionRank = (region: Region, prefer?: Region): number => {
  if (prefer && region === prefer) return 0;
  // Default tilt: India-local first, then Canada (live), then US (archived).
  return ({ IN: 1, CA: 2, US: 3 } as Record<Region, number>)[region] ?? 4;
};

/**
 * Apply the gate, then sort surviving flags by confidence (desc), tiebreak by
 * region preference then recency. Returns the renderable flag objects.
 */
export function assembleFlags(
  judged: JudgedRec[],
  surface: Surface,
  opts: { preferRegion?: Region } = {},
): LvcFlag[] {
  return judged
    .filter((j) => passesFloor(j, surface))
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      const rr = regionRank(a.rec.region, opts.preferRegion) - regionRank(b.rec.region, opts.preferRegion);
      if (rr !== 0) return rr;
      return (b.rec.source_release_year ?? 0) - (a.rec.source_release_year ?? 0);
    })
    .map((j) => ({
      id: j.rec.id,
      statement: j.rec.statement,
      society: j.rec.society,
      region: j.rec.region,
      specialty: j.rec.specialty,
      rationale: j.rec.rationale,
      consider_instead: j.consider_instead ?? j.rec.consider_instead,
      why_it_applies: j.why,
      confidence: j.confidence,
      citation: {
        url: j.rec.citation_url,
        doi: j.rec.citation_doi,
        pmid: j.rec.citation_pmid,
        year: j.rec.source_release_year,
      },
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate extraction (Flash) — prompt + parser
// ─────────────────────────────────────────────────────────────────────────────

export const CANDIDATE_SYSTEM = `You extract the diagnostic tests, imaging, lab orders, medications, procedures, screening and monitoring that a clinician is PROPOSING or IMPLYING for a patient. Return ONLY the orders/actions being considered — not the diagnosis, not findings already obtained.

Return ONLY a JSON array, no prose:
[{"name": "<short order/action>", "action_type": "imaging|lab|medication|procedure|screening|monitoring|referral|other"}]

Rules:
- Use the common clinical name (e.g. "MRI lumbar spine", "PSA test", "CT pulmonary angiogram", "broad-spectrum antibiotics").
- 0 items is valid (return []) if no order/action is proposed.
- Max 12 items.`;

export function buildCandidateUser(scenario: string): string {
  return `Clinical scenario / proposed plan:\n${scenario.trim()}`;
}

/** Tolerant parse of the candidate-extraction response into Candidate[]. */
export function parseCandidates(text: string): Candidate[] {
  const arr = extractJsonArray(text);
  if (!Array.isArray(arr)) return [];
  const out: Candidate[] = [];
  for (const x of arr) {
    if (x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string') {
      const name = ((x as { name: string }).name || '').trim();
      if (!name) continue;
      const at = (x as { action_type?: unknown }).action_type;
      out.push({ name, action_type: typeof at === 'string' ? at : undefined });
    } else if (typeof x === 'string' && x.trim()) {
      out.push({ name: x.trim() });
    }
  }
  return out.slice(0, 12);
}

// ─────────────────────────────────────────────────────────────────────────────
// Applicability judge (Pro/Flash) — batched prompt + parser
// ─────────────────────────────────────────────────────────────────────────────

export const JUDGE_SYSTEM = `You are a careful clinical appropriateness reviewer. For each candidate recommendation, decide whether it APPLIES to THIS patient — i.e. whether the patient's situation satisfies the recommendation's stated precondition, such that the flagged test/treatment would be low-value or potentially harmful here.

For each recommendation return one of:
- "applies": the precondition is met for this patient and the flagged action would be low-value/harmful here.
- "does_not_apply": the precondition is NOT met (e.g. the patient has the red-flag/exception that makes the action appropriate).
- "insufficient_info": you cannot tell from the information given.

Be conservative: if the patient has any feature that is an exception to the recommendation (red flags, an evidence-based indication, a contraindication to the alternative), choose "does_not_apply". If key facts are missing, choose "insufficient_info" — do NOT guess "applies".

Return ONLY a JSON array, one object per recommendation, no prose:
[{"id":"<rec id>","verdict":"applies|does_not_apply|insufficient_info","confidence":0.0-1.0,"why":"<one sentence specific to this patient>","consider_instead":"<short alternative or null>"}]`;

export function buildJudgeUser(
  ctx: { scenario: string; patient?: { age?: number; sex?: string } },
  recs: LvcRecommendation[],
): string {
  const pt = ctx.patient
    ? `Patient: ${ctx.patient.age != null ? `${ctx.patient.age}y` : 'age unknown'}${ctx.patient.sex ? `, ${ctx.patient.sex}` : ''}\n`
    : '';
  const list = recs
    .map((r, i) =>
      `${i + 1}. id=${r.id} [${r.region}/${r.society}]\n   STATEMENT: ${r.statement}\n   PRECONDITION: ${r.precondition || '(none stated)'}`)
    .join('\n');
  return `${pt}Clinical scenario / proposed plan:\n${ctx.scenario.trim()}\n\nCandidate recommendations to judge:\n${list}`;
}

const VERDICTS = new Set<Verdict>(['applies', 'does_not_apply', 'insufficient_info']);

/** Tolerant parse of the judge response. Any rec not returned → insufficient_info (never fires). */
export function parseJudgeResponse(text: string, recs: LvcRecommendation[]): JudgedRec[] {
  const byId = new Map(recs.map((r) => [r.id, r]));
  const result = new Map<string, JudgedRec>();
  const arr = extractJsonArray(text);
  if (Array.isArray(arr)) {
    for (const x of arr) {
      if (!x || typeof x !== 'object') continue;
      const o = x as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id : '';
      const rec = byId.get(id);
      if (!rec) continue;
      let verdict = String(o.verdict ?? '').toLowerCase().trim() as Verdict;
      if (!VERDICTS.has(verdict)) verdict = 'insufficient_info';
      let confidence = Number(o.confidence);
      if (!Number.isFinite(confidence)) confidence = 0;
      confidence = Math.max(0, Math.min(1, confidence));
      // A non-"applies" verdict never fires, so its confidence is irrelevant; null it to 0 for clarity.
      if (verdict !== 'applies') confidence = 0;
      const why = typeof o.why === 'string' ? o.why.trim() : '';
      const ci = typeof o.consider_instead === 'string' && o.consider_instead.trim()
        ? o.consider_instead.trim()
        : null;
      result.set(id, { rec, verdict, confidence, why, consider_instead: ci });
    }
  }
  // Default any unjudged rec to insufficient_info.
  return recs.map((r) => result.get(r.id) ?? {
    rec: r, verdict: 'insufficient_info' as Verdict, confidence: 0, why: '', consider_instead: null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// shared JSON extraction (tolerant of ```json fences and surrounding prose)
// ─────────────────────────────────────────────────────────────────────────────

export function extractJsonArray(text: string): unknown {
  let t = (text || '').trim();
  if (!t) return null;
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('[');
  const b = t.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(t.slice(a, b + 1));
  } catch {
    return null;
  }
}
