// Deterministic drug–drug interaction leg for the audit surface.
// Curated EHRC reserve/high-risk rules first (instant, auditable), then
// RxLabelGuard (FDA SPL) for the long tail. The existing /api/drugs/interactions
// LLM+PubChem+RAG engine remains the explainer; this leg gives the audit a fast,
// citable answer that auto-feeds parameter #12 (drug–drug interactions).

import { rxlgInteractions, type DdiPair } from './rxlabelguard';

// Curated high-risk pairs. Each side is a lowercase substring matched against the
// normalized molecule name (handles brand/strength suffixes and combos). Keep this
// list short and defensible — pharmacy/AMS owns it; the long tail goes to RxLabelGuard.
interface Rule { a: string; b: string; severity: DdiPair['severity']; mechanism: string; recommendation: string }
export const CURATED_RULES: Rule[] = [
  { a: 'enoxaparin', b: 'ketorolac', severity: 'major', mechanism: 'Additive bleeding risk (LMWH + NSAID).', recommendation: 'Avoid; if unavoidable, monitor for bleeding.' },
  { a: 'enoxaparin', b: 'diclofenac', severity: 'major', mechanism: 'Additive bleeding risk (LMWH + NSAID).', recommendation: 'Avoid; monitor for bleeding.' },
  { a: 'enoxaparin', b: 'aspirin', severity: 'major', mechanism: 'Additive bleeding risk (anticoagulant + antiplatelet).', recommendation: 'Use only with explicit indication; monitor.' },
  { a: 'heparin', b: 'enoxaparin', severity: 'major', mechanism: 'Duplicate anticoagulation.', recommendation: 'Do not co-administer; choose one agent.' },
  { a: 'warfarin', b: 'ketorolac', severity: 'major', mechanism: 'Markedly increased bleeding risk.', recommendation: 'Avoid; monitor INR and for bleeding.' },
  { a: 'vancomycin', b: 'amikacin', severity: 'major', mechanism: 'Additive nephro- and ototoxicity.', recommendation: 'Monitor renal function and drug levels.' },
  { a: 'vancomycin', b: 'piperacillin', severity: 'moderate', mechanism: 'Increased risk of acute kidney injury.', recommendation: 'Monitor serum creatinine.' },
  { a: 'colist', b: 'amikacin', severity: 'major', mechanism: 'Additive nephrotoxicity.', recommendation: 'Avoid; monitor renal function closely.' },
  { a: 'colist', b: 'vancomycin', severity: 'major', mechanism: 'Additive nephrotoxicity.', recommendation: 'Monitor renal function closely.' },
  { a: 'linezolid', b: 'tramadol', severity: 'major', mechanism: 'Serotonin syndrome risk (MAO inhibition + serotonergic).', recommendation: 'Avoid combination.' },
  { a: 'linezolid', b: 'fentanyl', severity: 'moderate', mechanism: 'Possible serotonin syndrome.', recommendation: 'Monitor for serotonergic toxicity.' },
  { a: 'propofol', b: 'fentanyl', severity: 'moderate', mechanism: 'Additive respiratory depression and hypotension.', recommendation: 'Titrate carefully; monitor haemodynamics.' },
  { a: 'tramadol', b: 'ondansetron', severity: 'moderate', mechanism: 'Reduced analgesia + serotonergic load.', recommendation: 'Prefer an alternative antiemetic if possible.' },
  { a: 'ciprofloxacin', b: 'ondansetron', severity: 'moderate', mechanism: 'Additive QT prolongation.', recommendation: 'Avoid in patients at QT risk; consider ECG.' },
];

const norm = (s: string) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

export function curatedInteractions(drugs: string[]): DdiPair[] {
  const out: DdiPair[] = [];
  for (let i = 0; i < drugs.length; i++) {
    for (let j = i + 1; j < drugs.length; j++) {
      const A = norm(drugs[i]); const B = norm(drugs[j]);
      const r = CURATED_RULES.find((ru) =>
        (A.includes(ru.a) && B.includes(ru.b)) || (A.includes(ru.b) && B.includes(ru.a)));
      if (r) out.push({ drug_a: drugs[i], drug_b: drugs[j], severity: r.severity, mechanism: r.mechanism, recommendation: r.recommendation, source: 'EHRC curated rule' });
    }
  }
  return out;
}

const SEV_RANK: Record<string, number> = { contraindicated: 5, major: 4, moderate: 3, minor: 2, unknown: 1, none: 0 };
function pairKey(a: string, b: string): string {
  const x = norm(a), y = norm(b);
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

// Deterministic interactions = curated (trusted, instant) merged with RxLabelGuard
// (FDA SPL). On conflict, keep the higher-severity record; curated wins ties.
export async function deterministicInteractions(drugs: string[]): Promise<DdiPair[]> {
  const clean = drugs.map((d) => d.trim()).filter(Boolean);
  if (clean.length < 2) return [];
  const curated = curatedInteractions(clean);
  const rxlg = await rxlgInteractions(clean);

  const byKey = new Map<string, DdiPair>();
  for (const p of [...curated, ...rxlg]) {
    const k = pairKey(p.drug_a, p.drug_b);
    const prev = byKey.get(k);
    if (!prev || SEV_RANK[p.severity] > SEV_RANK[prev.severity]) byKey.set(k, p);
  }
  return [...byKey.values()].filter((p) => p.severity !== 'none')
    .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);
}
