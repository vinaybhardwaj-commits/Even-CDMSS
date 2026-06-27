/**
 * lib/charge-master-core.ts — EHRC charge-master matching CORE (pure, dependency-free).
 * The JSON-backed wrappers live in lib/charge-master.ts. Unit-testable in isolation.
 */

export interface TariffRow { code: string; dept: string; item: string; general: number; private: number; suite: number; }
export interface TariffMatch extends TariffRow { score: number; matched_on: string; }

// Anatomical SIDE (right/left) is dropped; procedure LATERALITY (unilateral/bilateral) is kept.
const STOP = new Set([
  'the', 'a', 'an', 'of', 'for', 'and', 'or', 'with', 'to', 'in', 'on', 'as',
  'package', 'pkg', 'procedure', 'surgery', 'operation', 'primary', 'elective', 'right', 'left',
]);

const SYNONYMS: Record<string, string> = {
  tkr: 'total knee replacement', tka: 'total knee replacement',
  thr: 'total hip replacement', tha: 'total hip replacement',
};

export function normalizeTariffText(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function expand(q: string): string {
  let s = ` ${normalizeTariffText(q)} `;
  for (const [k, v] of Object.entries(SYNONYMS)) s = s.replace(new RegExp(`\\b${k}\\b`, 'g'), v);
  return s.trim();
}

function tokenize(s: string): string[] {
  return expand(s).split(' ').filter((t) => t.length > 2 && !STOP.has(t));
}

/** Best tariff row for `query` among `rows`, or null. Conservative: ≥2 shared tokens + score floor. */
export function matchTariffIn(query: string, rows: TariffRow[], opts: { min?: number } = {}): TariffMatch | null {
  const min = opts.min ?? 0.6;
  const qt = tokenize(query);
  if (qt.length === 0) return null;
  // Single-token queries (e.g. "adenoidectomy") need only a 1-token overlap, but a stricter
  // score floor so a vague token like "knee" can't confidently match "total knee replacement".
  const overlapNeeded = Math.min(2, qt.length);
  const effMin = qt.length === 1 ? Math.max(min, 0.85) : min;
  const qHasBilateral = /\bbilateral\b/.test(expand(query));
  let best: TariffMatch | null = null;
  for (const r of rows) {
    const it = tokenize(r.item);
    if (it.length === 0) continue;
    const itSet = new Set(it);
    const overlap = qt.filter((t) => itSet.has(t)).length;
    if (overlap < overlapNeeded) continue;
    const qFrac = overlap / qt.length;
    const iFrac = overlap / it.length;
    let score = qFrac * 0.6 + iFrac * 0.4;
    // Demote the bilateral variant when the query didn't ask for bilateral → unilateral wins.
    if (/\bbilateral\b/.test(normalizeTariffText(r.item)) && !qHasBilateral) score -= 0.2;
    if (score >= effMin && (!best || score > best.score)) {
      best = { ...r, score: Number(score.toFixed(3)), matched_on: query };
    }
  }
  return best;
}

export function formatINR(n: number): string {
  return '₹' + Number(n).toLocaleString('en-IN');
}

export function formatTariffForPrompt(m: TariffMatch): string {
  return `${m.item} (EHRC ${m.code}): ${formatINR(m.general)} general ward / ${formatINR(m.private)} private / ${formatINR(m.suite)} suite — authoritative EHRC inpatient package tariff (2025-26).`;
}
