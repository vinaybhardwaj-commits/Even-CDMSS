/**
 * lib/architecture/manifests.ts — the central module-manifest registry (System Map Stage 1).
 * Seeded from docs/architecture/INVENTORY.md (the source of truth for planes/edges): the 6
 * governed modules, plus this directory itself as infra. STRUCTURAL-FIRST: `owner`,
 * `clinicianApprover` and `validationEvidence` are deliberately unassigned — the map renders
 * them as honest "unassigned" gaps rather than guessed names. `forbiddenImports` is also left
 * empty: the enforced edges live in scripts/architecture-check.mjs's RULES (the map projects
 * them from there), and duplicating them here would be a drift risk, not a fact.
 *
 * COVERAGE (enforced by `npm run architecture:check`): every top-level lib/ subsystem — see
 * listSubsystems() in scripts/lib/import-scan.mjs for the exact definition — must appear here
 * (via a manifest's `paths`) or in UNREGISTERED below. A new module cannot silently escape
 * the map.
 */

export type Plane =
  | 'pure-core'         // per-encounter clinical model — no app, no scores
  | 'spine'             // Plane-1 longitudinal patient projection
  | 'advisory'          // informational lane — never scores
  | 'score-arithmetic'  // the ONLY place score maths lives
  | 'audit-engine'      // extraction + finding assembly around the score core
  | 'ui'                // app/ and components/
  | 'infra';            // build/governance plumbing (this directory)

export type Lifecycle = 'implemented' | 'integrated' | 'validated' | 'released';

export interface ModuleManifest {
  id: string;                  // stable slug, e.g. 'member-state'
  title: string;               // plain-language name
  plane: Plane;
  paths: string[];             // globs the module owns (matched by the coverage rule)
  owner?: string;              // engineering owner — unassigned in Stage 1
  clinicianApprover?: string;  // where a clinical sign-off applies — unassigned in Stage 1
  validationEvidence?: string; // link/ref to the validation — unassigned in Stage 1
  lifecycle: Lifecycle;
  versionConst?: string;       // the *_VERSION export name, if any
  forbiddenImports?: string[]; // reserved — the checker's RULES are authoritative today
  changelog?: string;          // id of a registered ChangeEntry[] source (none registered yet)
}

export const MODULE_MANIFESTS: ModuleManifest[] = [
  {
    id: 'clinical-state',
    title: 'Clinical state (per-encounter patient model)',
    plane: 'pure-core',
    paths: ['lib/clinical-state/**'],
    lifecycle: 'integrated', // live consumers (DDx surface, care pages); audit-shadow adoption staged behind a default-off flag
    versionConst: 'CLINICAL_STATE_VERSION',
  },
  {
    id: 'member-state',
    title: 'Member state (Plane-1 longitudinal spine)',
    plane: 'spine',
    paths: ['lib/member-state/**'],
    lifecycle: 'integrated', // live on care surfaces + CCB; frozen fidelity baseline exists (member-bank/1.0), staged rollout continues
    versionConst: 'MEMBER_STATE_VERSION',
  },
  {
    id: 'opd-note-score-core',
    title: 'OPD note score arithmetic',
    plane: 'score-arithmetic',
    paths: ['lib/opd-note-score-core.ts'],
    lifecycle: 'released', // in production at opd-note-audit/0.81.8, drives the live dashboards
  },
  {
    id: 'opd-longitudinal',
    title: 'OPD longitudinal advisory lane',
    plane: 'advisory',
    paths: ['lib/opd-longitudinal*'],
    lifecycle: 'integrated', // wired post-INSERT + admin surfaces; 30-day backfill dark behind OPD_LONGITUDINAL_ENABLED
    versionConst: 'OPD_LONGITUDINAL_VERSION',
  },
  {
    id: 'opd-triage-core',
    title: 'OPD triage lane primitives (label-only)',
    plane: 'advisory',
    paths: ['lib/opd-triage-core.ts'],
    lifecycle: 'integrated', // consumed by the live triage queue/decide routes
  },
  {
    id: 'as-of-core',
    title: 'As-of temporal cut (pure leaf primitive)',
    plane: 'pure-core',
    paths: ['lib/as-of-core.ts'],
    lifecycle: 'integrated', // relocated in Slice 1 Part A; in the live member-state path
  },
  {
    id: 'architecture',
    title: 'Architecture governance data (manifests + generated map)',
    plane: 'infra',
    paths: ['lib/architecture/**'],
    lifecycle: 'integrated', // consumed by architecture:check and the CI staleness gate from day one
  },
];

/**
 * The honest gap list: top-level lib/ subsystems (per listSubsystems) that have NO manifest yet.
 * Every entry here is a visible "unregistered" row on the map — never hidden. Registering one
 * means writing its ModuleManifest above and deleting it from this list (the coverage rule
 * fails on stale entries in either direction).
 */
export const UNREGISTERED: string[] = [
  'calculators',            // clinical calculators (ABG, eGFR, hyponatremia, …)
  'care-call-core',         // care-call engine (ask-set/0.1, care-call/0.1)
  'ccb-brief-core',         // care-brief engine (care-brief/0.1)
  'ccb-dossier-cache-core', // dossier snapshot cache (schema v2)
  'ddx-eval-core',          // DDx frozen evaluator (ddx-eval/3, ddx-case-bank/1.0)
  'dose-limits',            // dose-limits reference table
  'mcp-server',             // MCP protocol surface
  'opd-note-audit',         // audit engine wrapper (mini engine)
  'opd-note-audit-core',    // the OPD audit engine (opd-note-audit/0.81.8)
  'prognosis-core',         // prognosis engine (prognosis/0.1)
  'proms',                  // PROMs catalog/scheduling/scoring
];
