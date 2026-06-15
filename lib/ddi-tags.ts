// Formulary-scoped, high-risk interaction engine (Khatija's idea, V's framing:
// "within our formulary" + "narrow to high-risk"). Rather than scrape millions of
// pairs, we tag each drug with the interaction-relevant properties it carries
// (anticoagulant, QT-prolonging, serotonergic, nephrotoxic, …) from its name +
// EHRC formulary class, then fire a small set of well-established MECHANISM rules
// over those tags. Deterministic, instant, and every alert is traceable to a rule.
//
// This is a clinical safety NET, not an exhaustive database — pharmacy/AMS should
// review the tag lists and rules below and extend them as testing surfaces gaps.

import type { DdiPair } from './rxlabelguard';
import type { DrugClass } from './ddi';

export type Tag =
  | 'anticoagulant' | 'antiplatelet' | 'nsaid' | 'qt' | 'serotonergic'
  | 'nephrotoxic' | 'cns_depressant' | 'ace_arb' | 'k_sparing' | 'potassium'
  | 'aminoglycoside' | 'loop_diuretic' | 'statin' | 'macrolide' | 'azole'
  | 'sulfonylurea' | 'insulin' | 'methotrexate';

const has = (s: string, ...keys: string[]) => keys.some((k) => s.includes(k));

// Map a drug (generic name + formulary major/minor grouping) to its interaction tags.
export function tagsFor(name: string, major: string, minor: string): Set<Tag> {
  const n = (name || '').toLowerCase();
  const mj = (major || '').toLowerCase();
  const t = new Set<Tag>();

  if (mj.includes('anticoagulant') || has(n, 'warfarin', 'heparin', 'enoxaparin', 'dalteparin', 'fondaparinux', 'rivaroxaban', 'dabigatran', 'apixaban', 'edoxaban', 'acenocoumarol', 'nadroparin')) t.add('anticoagulant');
  if (mj.includes('antiplatelet') || has(n, 'aspirin', 'acetylsalicylic', 'clopidogrel', 'prasugrel', 'ticagrelor', 'dipyridamole', 'cilostazol')) t.add('antiplatelet');
  if (mj.includes('nsaid') || has(n, 'diclofenac', 'ibuprofen', 'ketorolac', 'aceclofenac', 'naproxen', 'etoricoxib', 'mefenamic', 'indomethacin', 'piroxicam', 'lornoxicam', 'meloxicam', 'etodolac', 'aspirin')) t.add('nsaid');
  if (has(n, 'amiodarone', 'sotalol', 'haloperidol', 'quetiapine', 'ondansetron', 'domperidone', 'azithromycin', 'clarithromycin', 'erythromycin', 'ciprofloxacin', 'levofloxacin', 'moxifloxacin', 'ofloxacin', 'gemifloxacin', 'norfloxacin', 'fluconazole', 'citalopram', 'escitalopram', 'hydroxychloroquine', 'chloroquine', 'prochlorperazine', 'levosulpiride')) t.add('qt');
  if (has(n, 'linezolid', 'tramadol', 'tapentadol', 'fentanyl', 'pethidine', 'methylene blue', 'sertraline', 'fluoxetine', 'escitalopram', 'citalopram', 'paroxetine', 'fluvoxamine', 'duloxetine', 'venlafaxine', 'amitriptyline', 'imipramine', 'nortriptyline', 'mirtazapine', 'ondansetron', 'metoclopramide', 'selegiline', 'rasagiline')) t.add('serotonergic');
  if (mj.includes('aminoglycoside') || has(n, 'amikacin', 'gentamicin', 'gentamycin', 'netilmic', 'tobramycin', 'streptomycin')) { t.add('aminoglycoside'); t.add('nephrotoxic'); }
  if (has(n, 'vancomycin', 'colistin', 'colistimethate', 'polymyxin', 'amphotericin', 'tacrolimus', 'cyclosporine', 'ciclosporin', 'cisplatin', 'foscarnet')) t.add('nephrotoxic');
  if (has(n, 'morphine', 'fentanyl', 'tramadol', 'tapentadol', 'buprenorphine', 'pentazocine', 'nalbuphine', 'codeine', 'pethidine', 'oxycodone', 'midazolam', 'diazepam', 'lorazepam', 'alprazolam', 'clonazepam', 'zolpidem', 'phenobarbit', 'propofol', 'thiopent', 'etomidate', 'dexmedetomidine', 'dexmeditomidine', 'ketamine', 'pregabalin', 'gabapentin', 'baclofen', 'tizanidine')) t.add('cns_depressant');
  if (has(n, 'ramipril', 'enalapril', 'lisinopril', 'perindopril', 'captopril', 'benazepril', 'losartan', 'telmisartan', 'olmesartan', 'valsartan', 'candesartan', 'irbesartan', 'azilsartan', 'sacubitril')) t.add('ace_arb');
  if (has(n, 'spironolactone', 'eplerenone', 'amiloride', 'triamterene')) t.add('k_sparing');
  if (has(n, 'potassium chloride', 'potassium citrate', 'potassium bicarbonate', 'kcl')) t.add('potassium');
  if (has(n, 'furosemide', 'frusemide', 'torsemide', 'torasemide', 'bumetanide')) t.add('loop_diuretic');
  if (has(n, 'atorvastatin', 'rosuvastatin', 'simvastatin', 'pravastatin', 'fluvastatin', 'lovastatin', 'pitavastatin')) t.add('statin');
  if (has(n, 'azithromycin', 'clarithromycin', 'erythromycin', 'roxithromycin')) t.add('macrolide');
  if (has(n, 'fluconazole', 'itraconazole', 'ketoconazole', 'voriconazole', 'posaconazole', 'isavuconazole')) t.add('azole');
  if (has(n, 'glimepiride', 'gliclazide', 'glipizide', 'glibenclamide', 'glyburide')) t.add('sulfonylurea');
  if (n.includes('insulin')) t.add('insulin');
  if (n.includes('methotrexate')) t.add('methotrexate');
  return t;
}

interface TagRule { a: Tag; b: Tag; severity: DdiPair['severity']; mechanism: string; rec: string }

// Well-established high-risk interaction mechanisms. Pharmacy/AMS owns this list.
export const TAG_RULES: TagRule[] = [
  { a: 'anticoagulant', b: 'anticoagulant', severity: 'major', mechanism: 'Two anticoagulants — duplicate/additive anticoagulation, high bleeding risk.', rec: 'Avoid concurrent anticoagulants; use a single agent unless deliberately bridging with monitoring.' },
  { a: 'anticoagulant', b: 'antiplatelet', severity: 'major', mechanism: 'Anticoagulant + antiplatelet — additive bleeding risk.', rec: 'Co-prescribe only with a clear indication; monitor for bleeding.' },
  { a: 'anticoagulant', b: 'nsaid', severity: 'major', mechanism: 'Anticoagulant + NSAID — increased bleeding risk.', rec: 'Avoid; prefer paracetamol for analgesia.' },
  { a: 'antiplatelet', b: 'antiplatelet', severity: 'moderate', mechanism: 'Dual antiplatelet therapy — increased bleeding risk.', rec: 'Use only when dual antiplatelet therapy is indicated.' },
  { a: 'antiplatelet', b: 'nsaid', severity: 'moderate', mechanism: 'Antiplatelet + NSAID — increased GI bleeding risk.', rec: 'Avoid; add gastroprotection if unavoidable.' },
  { a: 'nsaid', b: 'nsaid', severity: 'moderate', mechanism: 'Two NSAIDs — additive GI and renal toxicity.', rec: 'Avoid concurrent NSAIDs.' },
  { a: 'qt', b: 'qt', severity: 'major', mechanism: 'Two QT-prolonging drugs — additive QT prolongation, risk of torsades de pointes.', rec: 'Avoid; if essential, monitor ECG and correct electrolytes (K, Mg).' },
  { a: 'serotonergic', b: 'serotonergic', severity: 'major', mechanism: 'Two serotonergic drugs — serotonin syndrome risk.', rec: 'Avoid combination; monitor for serotonergic toxicity.' },
  { a: 'nephrotoxic', b: 'nephrotoxic', severity: 'major', mechanism: 'Two nephrotoxic agents — additive nephrotoxicity.', rec: 'Monitor renal function and drug levels; avoid if possible.' },
  { a: 'cns_depressant', b: 'cns_depressant', severity: 'moderate', mechanism: 'Two CNS depressants — additive sedation and respiratory depression.', rec: 'Use lowest effective doses; monitor sedation and respiration.' },
  { a: 'ace_arb', b: 'k_sparing', severity: 'major', mechanism: 'ACE-I/ARB + potassium-sparing diuretic — hyperkalaemia risk.', rec: 'Monitor serum potassium and renal function.' },
  { a: 'ace_arb', b: 'potassium', severity: 'major', mechanism: 'ACE-I/ARB + potassium supplement — hyperkalaemia risk.', rec: 'Avoid routine potassium; monitor serum potassium.' },
  { a: 'aminoglycoside', b: 'loop_diuretic', severity: 'moderate', mechanism: 'Aminoglycoside + loop diuretic — additive oto- and nephrotoxicity.', rec: 'Monitor renal function, hearing, and drug levels.' },
  { a: 'statin', b: 'macrolide', severity: 'major', mechanism: 'Statin + macrolide — raised statin levels, rhabdomyolysis risk.', rec: 'Hold the statin during the macrolide course, or use azithromycin.' },
  { a: 'statin', b: 'azole', severity: 'major', mechanism: 'Statin + azole antifungal — raised statin levels, rhabdomyolysis risk.', rec: 'Hold or reduce the statin during azole therapy.' },
  { a: 'nsaid', b: 'ace_arb', severity: 'moderate', mechanism: 'NSAID + ACE-I/ARB — reduced renal perfusion, AKI risk (worse if also on a diuretic — “triple whammy”).', rec: 'Avoid the NSAID; monitor renal function.' },
  { a: 'methotrexate', b: 'nsaid', severity: 'major', mechanism: 'Methotrexate + NSAID — reduced methotrexate clearance, toxicity risk.', rec: 'Avoid NSAIDs with methotrexate.' },
  { a: 'sulfonylurea', b: 'sulfonylurea', severity: 'moderate', mechanism: 'Two sulfonylureas — additive hypoglycaemia.', rec: 'Avoid duplication; monitor blood glucose.' },
  { a: 'insulin', b: 'sulfonylurea', severity: 'moderate', mechanism: 'Insulin + sulfonylurea — additive hypoglycaemia risk.', rec: 'Monitor blood glucose closely.' },
];

const SEV: Record<string, number> = { contraindicated: 5, major: 4, moderate: 3, minor: 2, unknown: 1, none: 0 };

// One DdiPair per interacting drug pair, carrying the highest-severity mechanism.
export function tagInteractions(items: DrugClass[]): DdiPair[] {
  const tagged = items.map((i) => ({ name: i.name, tags: tagsFor(i.name, i.major, i.minor) }));
  const out: DdiPair[] = [];
  for (let i = 0; i < tagged.length; i++) {
    for (let j = i + 1; j < tagged.length; j++) {
      const A = tagged[i], B = tagged[j];
      if (A.name.toLowerCase() === B.name.toLowerCase()) continue;
      let best: DdiPair | null = null;
      for (const r of TAG_RULES) {
        const hit = (A.tags.has(r.a) && B.tags.has(r.b)) || (A.tags.has(r.b) && B.tags.has(r.a));
        if (!hit) continue;
        if (!best || SEV[r.severity] > SEV[best.severity]) {
          best = { drug_a: A.name, drug_b: B.name, severity: r.severity, mechanism: r.mechanism, recommendation: r.rec, source: 'EHRC class rule' };
        }
      }
      if (best) out.push(best);
    }
  }
  return out;
}
