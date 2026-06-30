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
  rationales: string[];
  doctors: Set<string>;
  depts: Set<string>;
  auditIds: string[];
  domains: Record<string, number>;
  verdicts: Record<string, number>;
  evidence: Map<string, AuditSourceLite>;   // dedup by url|item|preview
  n: number;
}

/** Mine candidate low-value-care rules from audit rows. Pure + deterministic. */
export function mineRuleCandidates(rows: AuditRowLite[], thresholds: MineThresholds = DEFAULT_THRESHOLDS): RuleCandidate[] {
  const clusters = new Map<string, Cluster>();

  for (const row of rows || []) {
    const sources = row.sources || [];
    const byN = new Map(sources.map((s) => [s.n, s]));
    for (const f of row.findings || []) {
      // Only mine genuine low-value / context-dependent CLINICAL practices (not informational
      // roll-ups, not high-value/uncertain, not deterministic dosing/formulary house-keeping).
      if (f.informational) continue;
      if (f.verdict !== 'low-value' && f.verdict !== 'context-dependent') continue;
      if (f.domain !== 'appropriateness' && f.domain !== 'prescribing_safety') continue;
      const key = subjectSignature(f.subject);
      if (!key || key.length < 4) continue;

      let c = clusters.get(key);
      if (!c) {
        c = { key, subjects: [], rationales: [], doctors: new Set(), depts: new Set(), auditIds: [], domains: {}, verdicts: {}, evidence: new Map(), n: 0 };
        clusters.set(key, c);
      }
      c.n += 1;
      c.subjects.push(f.subject);
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

    const title = mode(c.subjects);
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
