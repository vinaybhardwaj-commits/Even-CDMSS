/**
 * Pure core for Right Care LVC rule identity (RIGHT-CARE-INDICATOR-PRD §5). NO db / Next imports.
 *   - engine stamp helper (stampLvcMetadata): called by the orchestrator after finding identity to
 *     add rule_ref (null — the OPD engine has no wired lvc_recommendations matcher) + lvc_category to
 *     every low-value, non-informational finding. signal_type:'low_value_care' is set in the pure
 *     stampFindingIdentity (it feeds finding_ref); category/rule_ref are additive, so they live here.
 *   - read-time fallback classifier: older-engine rows classify their low-value findings by verdict
 *     tier (authoritative) + subject text-match to the 29 lvc_recommendations rules (rule_ref null-safe).
 *   - precision gate: exclude findings whose rule_ref has a CURRENT 'suppress' ledger decision
 *     (cluster_key convention lvc:<rule_ref>). v1 default: nothing suppressed → all 29 count.
 */

export const LVC_CATEGORIES = ['antibiotic', 'imaging', 'supplement_polypharmacy', 'other'] as const;
export type LvcCategory = (typeof LVC_CATEGORIES)[number];

// Category heuristic (kept deliberately small; the engine stamp + the read-time fallback share it).
const ANTIBIOTIC_RE = /\bantibiotic|antimicrobial|amoxicillin|amoxyclav|azithromycin|cefixime|cefpodoxime|cefuroxime|ceftriaxone|ciprofloxacin|levofloxacin|ofloxacin|doxycycline|metronidazole|clarithromycin|augmentin|penicillin|cephalosporin|fluoroquinolone|nitrofurantoin\b/i;
const IMAGING_RE = /\b(x-?ray|radiograph|ct scan|\bct\b|mri|ultrasound|\busg\b|sonograph|imaging|neuroimaging|\bscan\b)\b/i;
const SUPPLEMENT_RE = /\b(supplement|multivitamin|nutraceutical|polypharmac|\bvitamin\b|\btonic\b|probiotic|nutritional|antioxidant|enzyme preparation)\b/i;

/** Classify an LVC finding into a coarse category from its text (antibiotic | imaging | supplement_polypharmacy | other). */
export function classifyLvcCategory(subject: string | undefined, rationale?: string | null): LvcCategory {
  const hay = `${subject || ''} ${rationale || ''}`.toLowerCase();
  if (ANTIBIOTIC_RE.test(hay)) return 'antibiotic';
  if (IMAGING_RE.test(hay)) return 'imaging';
  if (SUPPLEMENT_RE.test(hay)) return 'supplement_polypharmacy';
  return 'other';
}

/** The low-value verdict tier is the authoritative LVC signal (§5 / §8). */
export function isLowValueVerdict(verdict: unknown): boolean { return verdict === 'low-value'; }

// A structural finding shape — avoids a runtime import of OpdFinding (keeps this core dependency-free).
export type ClassifiableFinding = {
  verdict?: string; subject?: string; rationale?: string | null; informational?: boolean;
  signal_type?: string; rule_ref?: string | null; lvc_category?: string;
};

/**
 * Engine stamp (0.81.3): add rule_ref (null) + lvc_category to every low-value, non-informational
 * finding. Applied by the orchestrator AFTER neutralizeMetadataFindings so neutralised (informational)
 * findings are skipped. Additive only — never touches verdict/confidence/domain (score invariance).
 */
export function stampLvcMetadata<T extends ClassifiableFinding>(findings: T[]): T[] {
  return findings.map((f) => {
    if (f.informational || !isLowValueVerdict(f.verdict)) return f;
    return { ...f, rule_ref: f.rule_ref ?? null, lvc_category: classifyLvcCategory(f.subject, f.rationale) } as T;
  });
}

// A minimal lvc_recommendations shape for the read-time text-match fallback.
export type LvcRuleLite = { id: string; keywords?: string[] | null; statement?: string | null; category?: string | null };

export type LvcClassified = { is_lvc: boolean; rule_ref: string | null; lvc_category: LvcCategory; stamped: boolean };

const asCategory = (v: unknown): LvcCategory | null =>
  (LVC_CATEGORIES as readonly string[]).includes(String(v)) ? (v as LvcCategory) : null;

/** Text-match a finding to a rule by keyword containment (first hit wins). */
function matchRule(f: ClassifiableFinding, rules: LvcRuleLite[]): LvcRuleLite | null {
  const hay = `${f.subject || ''} ${f.rationale || ''}`.toLowerCase();
  for (const r of rules) {
    const kws = (r.keywords || []).map((k) => String(k).toLowerCase().trim()).filter(Boolean);
    if (kws.length && kws.some((k) => hay.includes(k))) return r;
  }
  return null;
}

/**
 * Read-time classify: is this finding LVC, and with what rule_ref + category? Verdict tier is
 * authoritative. Stamped rows (signal_type='low_value_care') pass their metadata through; older rows
 * fall back to a text-match against the provided rules, else the category heuristic + rule_ref null.
 */
export function classifyLvcFinding(f: ClassifiableFinding, rules: LvcRuleLite[] = []): LvcClassified {
  if (f.informational || !isLowValueVerdict(f.verdict)) {
    return { is_lvc: false, rule_ref: null, lvc_category: 'other', stamped: false };
  }
  if (f.signal_type === 'low_value_care') {
    const cat = asCategory(f.lvc_category) ?? classifyLvcCategory(f.subject, f.rationale);
    return { is_lvc: true, rule_ref: f.rule_ref ?? null, lvc_category: cat, stamped: true };
  }
  const rule = matchRule(f, rules);
  const cat = (rule && asCategory(rule.category)) ?? classifyLvcCategory(f.subject, f.rationale);
  return { is_lvc: true, rule_ref: rule ? rule.id : null, lvc_category: cat, stamped: false };
}

// ── precision gate (§5) ──────────────────────────────────────────────────────────
/**
 * The set of rule_refs suppressed by a CURRENT ledger decision. Pass the latest decision per
 * cluster_key (opd_feedback_adjudications); cluster_key convention is `lvc:<rule_ref>`.
 */
export function suppressedRuleRefs(ledger: Array<{ cluster_key?: string; decision?: string }> | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const row of ledger || []) {
    if (row?.decision === 'suppress' && typeof row.cluster_key === 'string' && row.cluster_key.startsWith('lvc:')) {
      const ref = row.cluster_key.slice(4).trim();
      if (ref) out.add(ref);
    }
  }
  return out;
}

/** Gate filter: drop classified findings whose rule_ref is suppressed. Findings with rule_ref null are kept. */
export function applyGate<T extends { rule_ref: string | null }>(classified: T[], suppressed: Set<string>): T[] {
  if (suppressed.size === 0) return classified;
  return classified.filter((c) => !(c.rule_ref && suppressed.has(c.rule_ref)));
}
