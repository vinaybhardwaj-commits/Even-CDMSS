/**
 * lib/reasoning/manifest.ts — the hand-authored SIDECAR for the prompt registry (Reasoning
 * Observability Stage 0). The registry facts (id · hash · text · counts) are GENERATED from
 * code by scripts/reasoning-registry-gen.mjs; this file carries only the HUMAN metadata that
 * cannot be derived: owner, clinician approver, maturity, and the linked rubric/schema.
 *
 * STRUCTURAL-FIRST (mirrors lib/architecture/manifests.ts): `owner` and `clinicianApprover`
 * are deliberately unassigned today — the export renders them as honest blanks, never guessed
 * names. Every prompt starts at 'draft' at best; 'review'/'mature' are earned through the
 * maturity ladder (gold-gated from Stage 3).
 *
 * COVERAGE (enforced by lib/__tests__/reasoning-registry.test.ts): every generated prompt id
 * must appear here (PROMPT_MANIFESTS) or in UNREGISTERED_PROMPTS below. A new prompt const
 * cannot silently escape the registry — but an UNLISTED id at runtime merges as 'unregistered',
 * never a throw (the gate lives in the test, not in serving).
 */

export type Maturity = 'unregistered' | 'draft' | 'review' | 'mature';

export interface PromptManifest {
  id: string;                  // '<file-stem>/<CONST>' — must match a generated prompt id
  owner?: string;              // engineering owner — unassigned in Stage 0
  clinicianApprover?: string;  // clinical sign-off — unassigned in Stage 0
  maturity: Exclude<Maturity, 'unregistered'>;
  rubricId?: string;           // id of a rubric in the generated registry
  schemaId?: string;           // output-schema id — none registered yet (Stage 1+)
}

/**
 * Registered prompts: the six whose rubric linkage is an established fact (five embed their
 * rubric in the prompt text; doc-audit extraction reads the external NABH rubric's field
 * floors). All 'draft' — extracted + hashed, no recorded review yet.
 */
export const PROMPT_MANIFESTS: PromptManifest[] = [
  { id: 'ddx-hypothesis/HYPO_SYSTEM', maturity: 'draft', rubricId: 'cannot-miss discipline' },
  { id: 'doc-audit-core/EXTRACT_SYSTEM', maturity: 'draft', rubricId: 'nabh/6e' },
  { id: 'lvc-core/JUDGE_SYSTEM', maturity: 'draft', rubricId: 'applicability discipline' },
  { id: 'opd-note-audit-core/OPD_AUDIT_SYSTEM', maturity: 'draft', rubricId: 'PDQI-9 reasoning rubric' },
  { id: 'pathway-core/ENRICH_SYSTEM', maturity: 'draft', rubricId: 'evidence-hierarchy' },
  { id: 'rerank/JUDGE_SYSTEM', maturity: 'draft', rubricId: '0–10 scoring rubric' },
];

/**
 * The honest gap list: generated prompt ids with NO manifest entry yet. Every one renders as
 * 'unregistered' in the export — never hidden. Registering one means writing its PromptManifest
 * above and deleting it from this list (the coverage test fails on stale entries either way).
 */
export const UNREGISTERED_PROMPTS: string[] = [
  'concordance-core/SYSTEM',
  'doc-audit-core/ANALYZE_SYSTEM',
  'doc-audit-core/AUDIT_CRITIQUE_SYSTEM',
  'doc-audit-core/AUDIT_REVISE_SYSTEM',
  'doc-audit/IDENTITY_SYSTEM',
  'expand/SYSTEM',
  'extract/NORMALISE_SYSTEM',
  'extraction-eval-core/JUDGE_SYSTEM',
  'investigations/PARSE_SYSTEM',
  'learning-core/CANONICALIZE_SYSTEM',
  'lvc-core/CANDIDATE_SYSTEM',
  'lvc-value-core/VALUE_CRITIQUE_SYSTEM',
  'lvc-value-core/VALUE_REVISE_SYSTEM',
  'lvc-value-core/VALUE_SYSTEM',
  'pathway-core/ENRICH_CRITIQUE_SYSTEM',
  'pathway-core/ENRICH_REVISE_SYSTEM',
  'pathway-core/SKELETON_SYSTEM',
  'prognosis-core/PX_CRITIQUE_SYSTEM',
  'prognosis-core/PX_REVISE_SYSTEM',
  'prognosis-core/PX_SYSTEM',
  'right-care-ground-eval-core/PAIR_JUDGE_SYSTEM',
];
