/**
 * lib/learning-core.ts — PURE core for the OPD-audit → CDMSS learning loop (LL.1/LL.2-v1).
 *
 * Mines accumulated OPD note-quality audit FINDINGS into candidate low-value-care RULE
 * proposals for the human review queue. PURE + unit-testable under
 * `node --experimental-strip-types` (data injected). NOTHING here touches the live engine,
 * the corpus, or `lvc_recommendations` — it only produces candidate proposals; applying an
 * approved proposal is a separate, gated step (LL.2b).
 *
 * v1 clustering is DETERMINISTIC (normalised-subject signature) — high precision, groups the
 * near-verbatim recurring findings the auditor LLM tends to emit. Merging paraphrases via a
 * Flash canonicalisation pass is the LL.2 enhancement; this first cut stays dependency-free.
 *
 * Two gates before a cluster becomes a proposal (locked 30 Jun):
 *   • volume   — ≥ minOccurrences AND across ≥ minDoctors distinct doctors
 *   • evidence — ≥ 1 corpus citation supporting it ("evidence over frequency", non-negotiable)
 */

export type ProposalType = 'lvc_rule' | 'harvest_article' | 'calibration';
export type ProposalStatus = 'proposed' | 'approved' | 'rejected' | 'superseded';
export type SuggestedReviewer = 'pharmacy_ams' | 'dept_lead' | 'owner';

/** Minimal finding shape read from opd_note_audits.findings (jsonb). */
export interface AuditFindingLite {
  subject: string;
  verdict: string;          // low-value | context-dependent | high-value | uncertain
  domain: string;           // appropriateness | prescribing_safety
  rationale?: string;
  citation_ids?: number[];
  source?: string;          // 'llm' | 'deterministic'
  informational?: boolean;
}
/** Minimal source shape from opd_note_audits.sources (jsonb). */
export interface AuditSourceLite {
  n: number;
  source?: string; book?: string; chapter?: string | null;
  item_number?: string | null; url?: string | null; preview?: string;
}
export interface AuditRowLite {
  id: string;
  doctor_uid: string | null;
  consult_type: string | null;
  findings: AuditFindingLite[];
  sources: AuditSourceLite[];
}

export interface MineThresholds { minOccurrences: number; minDoctors: number; requireCitation: boolean }
export const DEFAULT_THRESHOLDS: MineThresholds = { minOccurrences: 15, minDoctors: 3, requireCitation: true };
// Harvest-gap gate (LL.4): high-volume practices the corpus could NOT support (uncited). Lower
// stakes than a clinical rule (it only steers what literature the harvester fetches), so a
// modest volume floor; evidence is by definition absent (that's what makes it a gap).
export const DEFAULT_GAP_THRESHOLDS: MineThresholds = { minOccurrences: 10, minDoctors: 3, requireCitation: false };

export interface HarvestGapCandidate {
  type: 'harvest_topic';
  clusterKey: string;
  title: string;            // canonical clinical topic the corpus is thin on
  payload: { topic: string; query_terms: string };
  provenance: { nOccurrences: number; nUncited: number; nDoctors: number; depts: string[]; sampleSubjects: string[] };
  confidence: number;
  suggestedReviewer: SuggestedReviewer;
}
// A practice is a corpus GAP when the auditor flagged it often but the corpus could rarely support
// it. "Rarely" = at most this fraction of occurrences carried a citation; above it the corpus already
// covers the practice well enough that harvesting more adds little.
export const MAX_CITED_FRACTION = 0.5;

export interface RuleCandidate {
  type: 'lvc_rule';
  clusterKey: string;
  title: string;
  payload: {
    statement: string;
    action_type: 'avoid' | 'limit' | 'prefer';
    rationale: string;
    keywords: string[];
    provenance: 'EHRC-mined';
  };
  evidence: AuditSourceLite[];
  provenance: {
    nOccurrences: number;
    nDoctors: number;
    depts: string[];
    exampleAuditIds: string[];
    sampleSubjects: string[];
    dominantDomain: string;
  };
  confidence: number;
  suggestedReviewer: SuggestedReviewer;
}

const STOP = new Set(['for', 'of', 'a', 'an', 'the', 'with', 'and', 'in', 'to', 'on', 'use', 'using',
  'ordering', 'order', 'prescription', 'prescribing', 'prescribed', 'management', 'choice', 'likely', 'acute']);

/** Normalised signature of a finding subject — clusters near-verbatim repeats (precision-first). */
export function subjectSignature(subject: string): string {
  const s = (subject || '').toLowerCase()
    .replace(/\(.*?\)/g, ' ')                                   // drop parentheticals
    .replace(/\b\d+(?:\.\d+)?\s?(?:mg|mcg|ug|g|gm|ml|iu|k|%|mmhg|mu\/l)?\b/g, ' ') // doses/numbers
    .replace(/[^a-z0-9 ]/g, ' ');
  const toks = s.split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t));
  return [...new Set(toks)].sort().join(' ').trim();
}

/** Keywords for the candidate rule (significant tokens, original order, deduped). */
export function subjectKeywords(subject: string): string[] {
  const s = (subject || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]/g, ' ');
  const out: string[] = [];
  for (const t of s.split(/\s+/)) if (t.length > 2 && !STOP.has(t) && !out.includes(t)) out.push(t);
  return out.slice(0, 12);
}

function uniqStr(a: string[]): string[] { return [...new Set(a.map((x) => x.trim()).filter(Boolean))]; }

interface Cluster {
  key: string;
  subjects: string[];
  labels: string[];
  rationales: string[];
  doctors: Set<string>;
  depts: Set<string>;
  auditIds: string[];
  domains: Record<string, number>;
  verdicts: Record<string, number>;
  evidence: Map<string, AuditSourceLite>;   // dedup by url|item|preview
  n: number;
}

export interface MineOpts {
  /** Maps a finding subject → a canonical low-value-practice label (LL.2 Flash canonicalisation).
   *  When omitted, clustering falls back to the deterministic subject signature (LL.2-v1). */
  canonicalLabel?: (subject: string) => string;
}

/** Findings eligible for low-value-care RULE mining: LLM clinical-judgment, low-value/context-
 *  dependent, appropriateness/prescribing. Excludes informational roll-ups + deterministic
 *  house-keeping (dosing/brand/formulary) + already-encoded rules (DDI/duplicate). */
export function isMineableFinding(f: AuditFindingLite): boolean {
  if (!f || f.informational) return false;
  if (f.source !== 'llm') return false;
  if (f.verdict !== 'low-value' && f.verdict !== 'context-dependent') return false;
  return f.domain === 'appropriateness' || f.domain === 'prescribing_safety';
}

/** Mine candidate low-value-care rules from audit rows. Pure. Clusters on the injected canonical
 *  label (paraphrases merge) or, absent one, the deterministic subject signature. */
export function mineRuleCandidates(rows: AuditRowLite[], thresholds: MineThresholds = DEFAULT_THRESHOLDS, opts: MineOpts = {}): RuleCandidate[] {
  const clusters = new Map<string, Cluster>();

  for (const row of rows || []) {
    const sources = row.sources || [];
    const byN = new Map(sources.map((s) => [s.n, s]));
    for (const f of row.findings || []) {
      if (!isMineableFinding(f)) continue;
      const rawLabel = opts.canonicalLabel ? (opts.canonicalLabel(f.subject) || '') : '';
      const key = rawLabel ? normalizeLabel(rawLabel) : subjectSignature(f.subject);
      if (!key || key.length < 4) continue;

      let c = clusters.get(key);
      if (!c) {
        c = { key, subjects: [], labels: [], rationales: [], doctors: new Set(), depts: new Set(), auditIds: [], domains: {}, verdicts: {}, evidence: new Map(), n: 0 };
        clusters.set(key, c);
      }
      c.n += 1;
      c.subjects.push(f.subject);
      if (rawLabel) c.labels.push(rawLabel);
      if (f.rationale) c.rationales.push(f.rationale);
      if (row.doctor_uid) c.doctors.add(row.doctor_uid);
      if (row.consult_type) c.depts.add(row.consult_type);
      if (c.auditIds.length < 20) c.auditIds.push(row.id);
      c.domains[f.domain] = (c.domains[f.domain] || 0) + 1;
      c.verdicts[f.verdict] = (c.verdicts[f.verdict] || 0) + 1;
      for (const cid of f.citation_ids || []) {
        const src = byN.get(cid);
        if (src) { const k = src.url || src.item_number || src.preview || `${src.n}`; if (!c.evidence.has(k)) c.evidence.set(k, src); }
      }
    }
  }

  const out: RuleCandidate[] = [];
  for (const c of clusters.values()) {
    const nDoctors = c.doctors.size;
    const hasEvidence = c.evidence.size > 0;
    if (c.n < thresholds.minOccurrences) continue;
    if (nDoctors < thresholds.minDoctors) continue;
    if (thresholds.requireCitation && !hasEvidence) continue;

    const title = mode(c.labels) || mode(c.subjects);
    const dominantDomain = mode(Object.entries(c.domains).flatMap(([d, n]) => Array(n).fill(d)));
    const dominantVerdict = (c.verdicts['low-value'] || 0) >= (c.verdicts['context-dependent'] || 0) ? 'low-value' : 'context-dependent';
    const action_type: RuleCandidate['payload']['action_type'] = dominantVerdict === 'low-value' ? 'avoid' : 'limit';
    const evidence = [...c.evidence.values()].slice(0, 4);
    // confidence: evidence-gated, scaled by volume + breadth, capped.
    const volScore = Math.min(0.4, (c.n - thresholds.minOccurrences) / 200 + 0.1);
    const breadthScore = Math.min(0.2, nDoctors / 50);
    const confidence = Math.min(0.9, 0.4 + volScore + breadthScore);

    out.push({
      type: 'lvc_rule',
      clusterKey: c.key,
      title,
      payload: {
        statement: `${action_type === 'avoid' ? 'Avoid' : 'Limit'}: ${title}`,
        action_type,
        rationale: mode(c.rationales) || c.rationales[0] || '',
        keywords: subjectKeywords(title),
        provenance: 'EHRC-mined',
      },
      evidence,
      provenance: {
        nOccurrences: c.n,
        nDoctors,
        depts: uniqStr([...c.depts]),
        exampleAuditIds: c.auditIds.slice(0, 8),
        sampleSubjects: uniqStr(c.subjects).slice(0, 5),
        dominantDomain,
      },
      confidence: Math.round(confidence * 100) / 100,
      suggestedReviewer: dominantDomain === 'prescribing_safety' ? 'pharmacy_ams' : (c.depts.size === 1 ? 'dept_lead' : 'owner'),
    });
  }
  // highest-signal first
  return out.sort((a, b) => b.provenance.nOccurrences - a.provenance.nOccurrences || b.confidence - a.confidence);
}

/** Build a PubMed query from a canonical topic label — significant terms AND-joined. Conservative;
 *  always human-reviewed before it is ever written to ingest_topics. */
export function harvestQuery(title: string): string {
  const kw = subjectKeywords(title);
  if (kw.length >= 2) return kw.slice(0, 6).join(' AND ');
  return (title || '').trim();
}

/** LL.4 — mine HARVEST-GAP candidates: high-volume mineable practices the corpus could NOT
 *  support (every occurrence uncited) → proposed harvest TOPICS. Pure. Clusters exactly like
 *  mineRuleCandidates but keeps only the fully-uncited clusters — i.e. the clusters the rule miner
 *  rejected for lack of evidence. Any corpus support at all → it's a rule's job, not a gap. */
export function mineHarvestGaps(rows: AuditRowLite[], thresholds: MineThresholds = DEFAULT_GAP_THRESHOLDS, opts: MineOpts = {}): HarvestGapCandidate[] {
  const clusters = new Map<string, { key: string; subjects: string[]; labels: string[]; doctors: Set<string>; depts: Set<string>; cited: number; n: number }>();
  for (const row of rows || []) {
    for (const f of row.findings || []) {
      if (!isMineableFinding(f)) continue;
      const rawLabel = opts.canonicalLabel ? (opts.canonicalLabel(f.subject) || '') : '';
      const key = rawLabel ? normalizeLabel(rawLabel) : subjectSignature(f.subject);
      if (!key || key.length < 4) continue;
      let c = clusters.get(key);
      if (!c) { c = { key, subjects: [], labels: [], doctors: new Set(), depts: new Set(), cited: 0, n: 0 }; clusters.set(key, c); }
      c.n += 1;
      c.subjects.push(f.subject);
      if (rawLabel) c.labels.push(rawLabel);
      if (row.doctor_uid) c.doctors.add(row.doctor_uid);
      if (row.consult_type) c.depts.add(row.consult_type);
      if ((f.citation_ids || []).length > 0) c.cited += 1;
    }
  }
  const out: HarvestGapCandidate[] = [];
  for (const c of clusters.values()) {
    const uncited = c.n - c.cited;
    const citedFrac = c.n ? c.cited / c.n : 0;
    if (uncited < thresholds.minOccurrences) continue;   // ≥N occurrences the corpus could NOT support
    if (c.doctors.size < thresholds.minDoctors) continue;
    if (citedFrac > MAX_CITED_FRACTION) continue;        // corpus already covers it well enough → not a gap
    const title = mode(c.labels) || mode(c.subjects);
    const query_terms = harvestQuery(title);
    if (!title || !query_terms) continue;
    const volScore = Math.min(0.4, (uncited - thresholds.minOccurrences) / 200 + 0.1);
    const breadthScore = Math.min(0.2, c.doctors.size / 50);
    out.push({
      type: 'harvest_topic',
      clusterKey: c.key,
      title,
      payload: { topic: title, query_terms },
      provenance: { nOccurrences: c.n, nUncited: uncited, nDoctors: c.doctors.size, depts: uniqStr([...c.depts]), sampleSubjects: uniqStr(c.subjects).slice(0, 5) },
      confidence: Math.round(Math.min(0.9, 0.4 + volScore + breadthScore) * 100) / 100,
      suggestedReviewer: 'owner',
    });
  }
  return out.sort((a, b) => b.provenance.nUncited - a.provenance.nUncited || b.confidence - a.confidence);
}

/** Stable cluster key from a canonical label — collapses minor wording/case drift across runs. */
export function normalizeLabel(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── LL.2 Flash canonicalisation: map varied finding subjects → one canonical practice label ──
export const CANONICALIZE_SYSTEM = `You group clinical-audit finding labels into canonical LOW-VALUE-CARE PRACTICES so that different wordings of the SAME underlying practice collapse to ONE label.

Given a numbered list of auditor finding "subjects", output for EACH a short canonical practice label (≤ 8 words) naming the underlying practice in GENERAL terms — drug class / test / procedure + indication where relevant — so paraphrases of the same practice get the IDENTICAL label.

Rules:
- Merge paraphrases: "Antibiotic for likely viral URTI", "Cefpodoxime for acute pharyngitis (viral)", "Antibiotic for acute URI" → all "Antibiotic for viral upper respiratory infection".
- Keep clinically distinct practices separate (different drug class, test, or indication → different label).
- Use generic molecule/class + indication; never brand names or doses.
- One entry per input index, covering every index exactly once.

Return ONLY JSON, no prose: {"map":[{"i":1,"label":"…"},{"i":2,"label":"…"}]}`;

export function buildCanonicalizeUser(subjects: string[]): string {
  return 'FINDING SUBJECTS:\n' + subjects.map((s, i) => `${i + 1}. ${s}`).join('\n');
}

function extractJson(text: string): unknown {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { if (--depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/** Parse the canonicalisation response → { subject: canonicalLabel }. Unmapped subjects omitted. */
export function parseCanonicalMap(text: string, subjects: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const obj = extractJson(text) as { map?: unknown } | null;
  const arr = obj && Array.isArray(obj.map) ? obj.map : [];
  for (const e of arr) {
    const o = (e && typeof e === 'object' ? e : {}) as { i?: unknown; label?: unknown };
    const idx = Math.round(Number(o.i)) - 1;
    const label = typeof o.label === 'string' ? o.label.trim() : '';
    if (idx >= 0 && idx < subjects.length && label) out[subjects[idx]] = label;
  }
  return out;
}

/** Most frequent string in an array (first-seen tiebreak). */
function mode(arr: string[]): string {
  const counts = new Map<string, number>();
  let best = ''; let bestN = 0;
  for (const x of arr) {
    if (!x) continue;
    const n = (counts.get(x) || 0) + 1; counts.set(x, n);
    if (n > bestN) { bestN = n; best = x; }
  }
  return best;
}
