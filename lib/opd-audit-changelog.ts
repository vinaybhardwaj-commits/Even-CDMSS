/**
 * lib/opd-audit-changelog.ts — the OPD audit ENGINE CHANGELOG, surfaced in-product on
 * /admin/opd-audit/how-it-works. A living spec: EVERY change to a scoring rule, weight,
 * prompt behaviour or deterministic check gets an entry here (date, what, why) — whether
 * or not it bumped OPD_ENGINE_VERSION. Newest first.
 *
 * DISCIPLINE: if you touch opd-note-audit-core / opd-note-score-core / the audit prompt /
 * dose-limits, add an entry in the same commit. `scoring: true` = the numbers changed
 * (bump + dashboard refill); `scoring: false` = extraction/display/informational only.
 */

export interface EngineChange {
  engine: string | null;    // '0.8' … '0.1'; null = shipped without a version bump
  date: string;              // YYYY-MM-DD (IST)
  scoring: boolean;          // did stored scores change (engine bump / backfill)?
  title: string;
  points: string[];          // what changed, concretely
  why: string;               // the trigger — clinician feedback, mined prevalence, V ruling
  plain?: string;            // plain-language headline for the in-product timeline/changelog
                             // (clinician-readable); the detailed title/points/why sit below it.
}

export const OPD_AUDIT_CHANGELOG: EngineChange[] = [
  {
    engine: null, date: '2026-07-13', scoring: false,
    plain: 'Right Care now builds a structured clinical picture for every check, pathway, and record audit — and saves audited records for later linking to a member\'s history',
    title: 'Right Care × ClinicalState Slice 1 (not OPD audit) — construct · surface · persist across Order check / Care pathway / Record audit; advisory plane, additive + fail-open, dark behind RIGHT_CARE_CLINICAL_STATE',
    points: [
      'CONSTRUCT (DDx Phase-1a model): each mode builds a ClinicalState (clinical-state/1.2) from the PROVIDED input only — Order check + Care pathway via the pure deterministicExtract on surface \'appropriateness\' (optional CLINICAL_STATE_LLM span-verified enrichment on the mode\'s existing trace), Record audit by adapting the already-extracted de-identified case via extractedCaseToState (no new extraction pass). No member identity in any state; fail-open — a construction error leaves the mode\'s output unchanged; the state feeds NOTHING back into reasoning (grounding is Slice 2, parked behind a golden A/B per mode).',
      'SURFACE + PERSIST: the DDx ClinicalStatePanel moved verbatim to components/ClinicalStatePanel.tsx and renders in all three modes behind CLINICAL_STATE_UI (additive response field; off → byte-identical payload). Migration 0011: appropriateness_runs grows nullable clinical_state/clinical_state_version — save-run reconstructs the state SERVER-SIDE from the run\'s own de-identified input (never trusts a client blob); the doc-audit trace keeps its cardinal redaction rule (counts only, never the state).',
      'MEMBER LINKAGE (Record audit only, double-gated RECORD_AUDIT_LINK): a dedicated identity-ONLY document pass (untraced, separate from the de-identified content read) captures {uhid, mrn, name, dob} for linkage, stored in the new physically separate record_audit_member_links table (run_id FK, resolved_individual_uid NULL until the downstream identity bridge) — identity lives alongside, never inside, the clinical record; ExtractedCase/AuditReport/ClinicalState de-identification unchanged.',
    ],
    why: 'The Surface union declared \'appropriateness\'/\'doc_audit\' from day one but Right Care never constructed a state, so its outputs couldn\'t be compared, surfaced, or linked like every other surface\'s. Right Care × ClinicalState PRD (V, 13 Jul 2026): construct-from-input on the DDx model, member identity only at Record audit and only from the document, persisted with a separated linkage key.',
  },
  {
    engine: null, date: '2026-07-13', scoring: false,
    plain: 'Every diagnosis code now shows its medical name — powered by the full 98k-code ICD dictionary instead of a 100-code list',
    title: 'ICD Master Slice 1 — labels from the source of truth (icd-master/1.0 snapshot; display + LLM-digest label quality only)',
    points: [
      'Snapshotted the db13 icd_code master (98,571 unique ICD-10-CM codes with sentence-cased short_desc) into the committed, generated artifact lib/member-state/icd-master.generated.ts via scripts/icd-master-gen.mjs (npm run icd:master — manual, credentialed; CI never talks to db13; codes added to db13 after the snapshot degrade to the neutral fallback, never a wrong label).',
      'Resolver layering in icd-labels.ts, same exported API and the same V-ratified Decision-D order: record\'s own display text → curated ICD_LABEL_OVERRIDES (the former 100-code map — clinician phrasing wins) → ICD_MASTER exact code, then the bare 3-char category as an exact master key only → code + "(unmapped ICD-10 code)". Never a guess, never a truncation to a non-existent parent.',
      'Raises MemberState/ClinicalState problem-list and OPD-audit longitudinal-panel label quality AND the LLM-digest input quality (the digest previously read "(unmapped ICD-10 code)" for most coded diagnoses); ≥99.5% of live coded diagnosis volume now resolves to a real label. duration/is_high_risk ship in the artifact as the slice-2 payload (chronicity/complexity adoption deliberately parked behind golden A/B + clinician ratification).',
    ],
    why: 'MemberState surfaces rendered most diagnoses as "<code> (unmapped ICD-10 code)" because the bundled map hardcoded 100 labels while db13 already held the 98k-code master at 99.7% measured coverage of the 352k live coded diagnoses. ICD Master Slice 1 PRD (V, 13 Jul 2026); labels-only by decision.',
  },
  {
    engine: '0.81.8', date: '2026-07-12', scoring: true,
    plain: 'Fixes 10 issues from Dr Zaki\'s review, adds low-value-care sub-types, sorts the note list by patients with the most history, and fills in 30 days of history',
    title: 'Dr Zaki 10-bug batch (first scoring change since 0.81.2) + LVC `other` sub-categorisation + frequent-flier list surfacing + 30-day longitudinal backfill',
    points: [
      'UNIFIED 6/7/9 (the biggest lever, ~172 notes re-rate upward): `unverified_brand` is now INFORMATIONAL (a formulary-coverage limitation on our side, not a prescribing error — the LLM routinely resolves the molecule); `incomplete_dosing` is EXEMPT for off-formulary cosmetics/supplements/unresolved-proprietary (a cosmetic name heuristic + the unresolved-line guard) so one unresolved line never stacks both findings — a RESOLVED drug missing its dose STILL scores. All in prescribingChecks (opd-note-audit-core).',
      'Bug 1 (↓appropriateness): deterministic backstop for a xanthine/acebrophylline bronchodilator-mucolytic, or an antihistamine+montelukast combo, prescribed for an ACUTE URTI — context-GUARDED (never fires for a chronic-airways patient, J40–J47 / asthma / COPD). Bug 3 (↓prescribing): topical nasal decongestant (oxymetazoline/xylometazoline, ingredient-level) used >5 days → rhinitis-medicamentosa finding. Bug 8: route/formulation-aware duplication — a wash-off + leave-on pair, or topical + systemic, is no longer flagged a duplicate. (opd-note-audit.ts)',
      'Bug 2 (↑appropriateness): an institutional health-check / screening PACKAGE no longer has its protocol panel flagged as individually "unindicated / low-value" (context-gated allow-list). Bug 10 (↑appropriateness): a niche pre-analytic keyword omission (biotin before a thyroid/troponin immunoassay) → informational, not a note-quality gap (prompt + neutralizeMetadataFindings). Bug 5 (metadata): hyoscine-butylbromide + dicyclomine reclassed Antispasmodic/anticholinergic in the formulary (10 items) — proven DDI-invariant (the interaction tagger keys on molecule names + anticoagulant/antiplatelet/NSAID/aminoglycoside class substrings, none of which change). Bug 4 (grounding): the consult date is surfaced in opdCaseText with a historical-date guard.',
      'LVC `other` SUB-CATEGORISATION (metadata; score-invariant): classifyLvcCategory keeps its 3 authoritative base categories and now splits the residual `other` into 8 overuse sub-tags by priority order (therapeutic_duplication → systemic_steroid → gi_ppi_prokinetic → antihistamine_allergy → nsaid_analgesic → cough_cold_fdc → cough_expectorant → unindicated_investigation), with an omission guard that keeps missing-safety-net / dx-mismatch findings in `other`. Shared LVC_CATEGORY_LABELS wired into the 3 admin label maps + the mcp-tools audit_query enum. `?restamp=1` recomputes lvc_category over the stored corpus.',
      'FREQUENT-FLIER SURFACING (advisory; no score touch): the /admin/opd-audit note list carries prior-encounter + longitudinal-finding counts from the stored `longitudinal` block (no new SQL), adds an opt-in `frequent flier` sort (findings DESC → encounters DESC → block-no-findings → none → no-block), a context-tier left-border tint, and an "N prior · M find" badge — default sort unchanged. 30-DAY BACKFILL: an idempotent `?auto=1` cron (every 10 min, CRON_SECRET) drains the most-blocked active-30-day doctor\'s longitudinal-NULL notes via the frozen replayLongitudinal, `{done:true}` when empty — dark until OPD_LONGITUDINAL_ENABLED=1.',
    ],
    why: 'Dr Zaki\'s clinician-feedback batch (prevalence-mined + re-confirmed live 12 Jul on the post-Stage-3 corpus) — the first score-moving change since 0.81.2, almost all raising scores by removing false positives — combined with the LVC sub-cat, frequent-flier triage, and longitudinal backfill into one build. CDMSS-OPD-AUDIT-0.81.8-COMBINED-PRD v3.0 (12 Jul 2026); all decisions settled.',
  },
  {
    engine: null, date: '2026-07-12', scoring: false,
    title: 'PROMs 0.2a-2 (not OPD audit) — wired surgical-recovery tracker: detection (db13) · store (Neon) · scores→spine fold · PromsPanel, behind PROMS_ENABLED',
    plain: 'Separate feature (patient-history record / questionnaires / differential-diagnosis) — logged here for the record; not an audit-engine change',
    points: [
      'DETECTION lib/proms/schedule.ts (fetchSurgicalSeries, wired, fail-safe): two independent db13 entry points merged member-keyed — surgery_cases booking (NULLIF empties; latest non-cancelled; every-cancelled → clean exit) + the plan-of-management surgical-recommendation flag join (jsonb .surgery_or_procedure.name) — then classifyFamily (regex v1.1) → archetypeFor → instrumentsDue over the FROZEN catalog/compiler. Post-op windows anchor on the kx_billing discharge date via kx_uhid, falling back to planned_surgery_date (Decision D). Every db13 query is INFERRED (no live DB in-build), FAIL-SAFE (error → null, panel hides, never a 500), and listed verbatim in the build report; surgery_cases + the flag join are MEASURED recipes, the kx_billing/kx_uhid discharge SHAPE is inferred (Cowork validates live).',
      'STORE lib/proms/store.ts (Neon, pattern-matched to care-call-store): prom_series (one active series/member) + prom_responses (immutable raw + server-computed score/scale/escalations + versions + adhoc_set_ref); migrateProms() additive+idempotent (run after deploy); savePromResponse scores SERVER-SIDE via scoreInstrument (never trusts the client). SPINE FOLD (Decision E): pure lib/proms/proms-evidence.ts promResponsesToEncounter → one care_call EncounterEvidence per administration day, each scored instrument a dated InvestigationPoint (analyte prom:<id>, reporter patient_via_care_manager, trust patient_reported); getMemberSnapshot folds them when PROMS_ENABLED — additive, mirrors the Care-Call write-back loop. buildMemberState + the FROZEN MemberState core + the MemberStateSnapshot shape are byte-identical (scores ride the existing investigation series).',
      'SCORING: WHODAS-12 SIMPLE scoring (WHO — sum of the 12 item scores, 0..4 on None…Extreme; complete set required else honest null) added to scoreInstrument\'s validated branch; response anchors given verbatim in the PRD, scoring only. WHODAS-12 item TEXT (WHO-copyrighted) + PREM v0 8-item text were NOT available in-build → left pending (items stay []/text:null, panel shows "pending") and FLAGGED — not invented. UI components/care/PromsPanel.tsx per the approved mockup (schedule strip · due-this-call · verbatim administration · deterministic score + ⚠ escalation reuse · spine footer), mounted on /care/m/[uid] behind PROMS_ENABLED. API: GET proms/schedule, POST proms/response (server scoring), POST admin/migrate-proms (care/admin auth). No new deps. Catalog data (prom-catalog/0.1 + regex v1.1) + compiler unchanged except the WHODAS scoring branch.',
    ],
    why: 'Wire the verified pure PROMs engine (0.2a-1) live on the Care-Call surface: detect a member\'s surgical series, administer the due instruments, score deterministically, fold the scores into the MemberState spine — frozen core untouched. Care-Call 0.2 PROMs 0.2a-2 Wired PRD v1.0 (12 Jul 2026), mockup-gated.',
  },
  {
    engine: null, date: '2026-07-12', scoring: false,
    title: 'MemberState Stage 1 Phase 2 (not OPD audit) — ratified fix member-reconcile/0.3 + FROZEN fidelity baseline (member-bank/1.0 + member-state-baseline/1.0)',
    plain: 'Separate feature (patient-history record / questionnaires / differential-diagnosis) — logged here for the record; not an audit-engine change',
    points: [
      'member-reconcile/0.3 (the ONE V-ratified pre-freeze core edit, aggregate-core.ts): R1 — a versioned chronicity dictionary in deriveCourse so a CHRONIC concept re-documented across ≥2 encounters is `persistent` regardless of gap length (a yearly-documented chronic is persistent, not recurrent); episodic concepts keep present-gap-present ⇒ recurrent. R2 — a patient-reported `stopped` followed by a LATER fresh prescription keeps currentness `stopped` (a re-script never synthesizes taking) AND surfaces the re-prescription as a medication/temporal_conflict/review carrying both events + both provenances (for the Care-Call verify-loop), superseding the generic on/off status_conflict for that drug. MEMBER_RECONCILE_VERSION 0.2→0.3 (defined in aggregate-core; schema.ts frozen this phase, its RECONCILIATION_VERSION export superseded).',
      'FREEZE (no behaviour change): gold-seed.ts every case ratified:true, stamped member-bank/1.0; new baseline.ts = member-state-baseline/1.0 with the R4 floors — GATED false-merge=0 + conflict-recall=1.0; FLOORED ≥0.90 problem-status/course/med-currentness; HARD retention/provenance/trust-provenance=1.0, incorrect-resolution=0, invariants, reproducibility. The validate harness gains --baseline (exits 1 on any floor breach). Seed on the ratified core: ALL floors clear — course-accuracy 1.00, conflict-recall 1.00, worklist empty. This is the DDx-evaluator discipline applied to the patient record: freeze the test + thresholds; no consumer moves until it holds.',
      'Still no consumer, route, flag, or migration. Frozen byte-identical: member-state schema/normalize/assemble-core, member-state-shadow.mjs, all clinical-state/**, DDx cores, app/**, /api/ddx, retrieval, prompts. NEXT: Stage 2 (the CCB renders the validated snapshot) is a separate PRD + kickoff; a Stage-3 debt is booked (R5 — settable asOf for the OPD-auditor consumer). Logged here per the changelog discipline, same reasoning as the ClinicalState-family entries below.',
    ],
    why: 'Stage-1 ratification session (V, 11 Jul 2026, rulings R1–R9): adjudicate the accuracy worklist + the stratum-19 open question, apply the one scoped ratified core fix, then freeze the versioned fidelity baseline. MemberState-Stage1 PRD Phase 2 + the Ratification-Decisions doc.',
  },
  {
    engine: null, date: '2026-07-12', scoring: false,
    title: 'MemberState Stage 1 Phase 1 (not OPD audit) — validation infra (scoring core + gold seed + harness), frozen core UNTOUCHED, baseline UNFROZEN',
    plain: 'Separate feature (patient-history record / questionnaires / differential-diagnosis) — logged here for the record; not an audit-engine change',
    points: [
      'New pure lib/member-state/validation/**: score-core.ts (member-eval/0.1) — a MECHANICAL, deterministic comparator (structural concept/status/enum/discrepancy comparison; no DB/llm/inference/thresholds; scoreCase twice → deep-equal) returning a per-case CaseScore + a Part-C aggregate; gold-seed.ts — 20 de-identified synthetic strata (the validation contract\'s 14 + 6 patient-reported/trust from clinical-state/1.2), each MemberEvidence + ExpectedLabel, class invariant|accuracy, shipped ratified:false (UNFROZEN — no baseline/floor file; that is Phase 2 after V ratifies). New scripts/member-state-validate.mjs — labelled-seed scoring (no DB, hard-fails on any invariant violation / retention<100% / trust-provenance<100% / incorrect-resolution>0) + the Stage-0 mechanical db13 shadow re-listing the three SQL strings VERBATIM (keep-in-sync note; member-state-shadow.mjs untouched). ~30 tests.',
      'Seed result on the frozen core (0148b76): all HARD gates hold — source-event / provenance / trust-provenance retention 100%, incorrect-resolution 0, invariant-violations 0, false-merge 0, conflict-recall 1.00 (incl. the allergy trust-conflict). Two RATIFICATION-WORKLIST items for V (accuracy, NOT failures): (1) course — a yearly-documented chronic scores `recurrent` under the frozen gap>180d heuristic where the stratum intends `persistent` (candidate core-fix vs label-correction, the classic measurement-artifact question); (2) stratum 19 [TBD] — after a patient-reported `stopped`, a later fresh prescription: the core keeps `stopped` (patient-reported wins); does a re-script reset currentness? V decides. Per contract §1.C, problem-status/course/med-currentness are ACCURACY metrics (scored, never gated); only the safety metrics gate.',
      'VALIDATES + FREEZES; does NOT change the aggregation core. Zero change to lib/member-state/{schema,normalize-core,aggregate-core,assemble-core}.ts and scripts/member-state-shadow.mjs (frozen core + harness — type-only reuse / verbatim-copied SQL), all lib/clinical-state/**, the DDx cores, app/**, /api/ddx, retrieval, prompts, every *_VERSION. No consumer, no route, no flag, no migration. Phase 2 (V ratification → member-bank/1.0 + member-state-baseline/1.0 floors) is a separate kickoff. Logged here per the changelog discipline, same reasoning as the ClinicalState-family entries below.',
    ],
    why: 'The clinician-ratified accuracy gate for the longitudinal spine — build the validation apparatus (pure scoring core + labelled gold seed + scored harness), run it, and take disagreements to V before freezing a versioned fidelity baseline (the DDx-evaluator discipline). MemberState-Stage1 PRD v1.0 (Cowork per V delegation, 11 Jul 2026), written against the Stage-0/1 Validation Contract Parts A–E.',
  },
  {
    engine: null, date: '2026-07-12', scoring: false,
    title: 'ClinicalState 1.2 + MemberState 1.1 (not OPD audit) — patient-reported vocabulary + provenance trust axis + spine consumption, wired to nothing',
    plain: 'Separate feature (patient-history record / questionnaires / differential-diagnosis) — logged here for the record; not an audit-engine change',
    points: [
      'clinical-state/1.1→1.2 (schema.ts, additive): Provenance gains OPTIONAL reporter (clinician|patient_via_care_manager|system|unknown) + trust (structured_db|clinician_documented|patient_reported|inferred) — every existing provenance still validates. New canonical patient-reported vocabulary (verbatim from the Care-Call PRD §2 so the CCB return channel IMPORTS rather than duplicates): ComplaintStatus + ComplaintStatusAssertion, FollowUpAction + FollowUpAssertion, StopReason + MedicationAssertion.stopReason. zod extended (two optional Provenance enums; two exported assertion validators). emptyClinicalState unchanged (these are assertion types consumed at the member-state layer).',
      'member-state/1.0→1.1, member-reconcile/0.1→0.2 (schema.ts + aggregate-core.ts, additive): EncounterEvidence.kind gains care_call and optional complaintStatuses[]/followUps[]; MemberStateSnapshot gains followUps[]. buildMemberState ADDS four trust-aware consumption rules — (1) a ComplaintStatusAssertion resolved contributes a documented_resolved problem occurrence (explicit resolution replacing the silence→uncertain guess; invariant 1 intact), improving/unchanged/worse→active; (2) trust-weighted medication currentness — the most-recent patient_reported occurrence overrides the prescription default, else the existing latest-wins fallback (neutral when no patient-reported evidence), currentness never synthesized to reported_taking; (3) allergy reported/denied clash stays a safety_critical status_conflict (unconditional, back-compat) now recording each occurrence trust; (4) FollowUpAssertions carried onto snapshot.followUps (deduped by id, date-sorted) with NO care-coordination/open-loop overlay (Plane 3, later). Fully deterministic; NEUTRAL — no patient-reported evidence → identical to member-state/1.0 output plus empty followUps.',
      'This is the base infrastructure the CCB patient-reported return channel gels with (the CCB integration that PRODUCES these assertions is a separate thread — no CCB code, no care_call_outcomes table touched here). CONSUMED BY NO LIVE ENGINE: no route/UI/flag/migration. Zero change to clinical-state/{extract,format,ui-view,from-prescription,to-audit-family,audit-shadow-core,extraction-eval-core} (from-prescription just sees the extended Provenance type — logic byte-identical), member-state/{normalize,assemble}-core, app/**, /api/ddx, retrieval, prompts. Logged here per the changelog discipline, same reasoning as the ClinicalState-family entries below.',
    ],
    why: 'The db13 feasibility probe found medication currentness is unknowable from prescriptions (current_medication is dead), resolution comes only from silence, and documented-negatives are undated — exactly what a patient-reported Post-OPD call fills. Before that channel can gel with the spine, the canonical vocabulary + a provenance trust axis + the spine\'s consumption of them must exist. ClinicalState-1.2 Patient-Reported-Vocab PRD v1.0 (Cowork per V delegation, 11 Jul 2026).',
  },
  {
    engine: null, date: '2026-07-12', scoring: false,
    title: 'MemberState Stage 0 (not OPD audit) — pure Plane-1 longitudinal aggregation core + read-only shadow, wired to nothing',
    plain: 'Separate feature (patient-history record / questionnaires / differential-diagnosis) — logged here for the record; not an audit-engine change',
    points: [
      'New pure lib/member-state/** (member-state/1.0, normalization member-norm/0.1, reconciliation member-reconcile/0.1): schema.ts (MemberEvidence → MemberStateSnapshot: LongitudinalProblem/Medication/Allergy/Investigation + typed Discrepancy, zod, emptyMemberStateSnapshot); normalize-core.ts (a tiny CONSERVATIVE seed dictionary — exact/synonym only; broader/narrower NEVER auto-merged, e.g. diabetes ≠ type-2-diabetes, "rule out PE" ≠ PE; no hit → unresolved; matcher is a candidate signal only); aggregate-core.ts (buildMemberState — groups by normalized concept, derives problem status/course with the fact/inference split, reconciles allergies/meds/investigations, emits typed conflicts, never resolves); assemble-core.ts (already-fetched db13 individuals-prescriptions + labs rows → immutable identifier-free MemberEvidence, reuses from-prescription; fail-safe). Enforces the Stage-0/1 validation-contract invariants BY CONSTRUCTION: no resolution from silence, no cross-member merge, no concept merge without a versioned decision, total provenance, conflicts never discarded, reproducible (no Date.now/random — computedAt/asOf passed in), unresolved is valid data. ~38 unit tests over the 10 invariants + 14 strata (synthetic evidence) + normalize + real-shape db13 assemble fixtures.',
      'New read-only scripts/member-state-shadow.mjs (the audit-shadow precedent): reads a db13 member sample, assembles → builds → reports mechanical fidelity (source-event + provenance retention, reproducibility, merge-safety proxy, counts). WRITES NOTHING; fail-safe (a fetch error skips the member). CONSUMED BY NO LIVE ENGINE, no route, no UI, no flag — Stage 0 has no live surface (Managed Care = Stage 2, OPD Audit = Stage 3; open-loops/Plane-3 and trend/velocity are out of scope). No migration. Zero change to lib/clinical-state/** (type-only reuse), the DDx eval/matcher/extraction-eval cores, app/**, /api/ddx, retrieval, or prompts. Logged here per the changelog discipline, same reasoning as the ClinicalState-family entries below; this is a new pure infrastructure core, not an OPD note-audit engine change.',
    ],
    why: 'The first stone of the longitudinal spine (CDMSS-LONGITUDINAL-SPINE-NORTH-STAR-v2): a versioned, recomputable Plane-1 clinical projection aggregating a member\'s per-encounter evidence, built against the Stage-0/1 Validation Contract (10 invariants + 14 strata). MemberState-Stage0 PRD v1.0 (Cowork per V delegation, 11 Jul 2026). Success is redefined: aggregate encounter evidence without false merges, false resolutions, lost provenance, or silent conflict suppression.',
  },
  {
    engine: null, date: '2026-07-12', scoring: false,
    title: 'ClinicalState 1.1 (not OPD audit) — typed medication & allergy assertions: additive schema + pure db13 mapper, wired to nothing',
    plain: 'Separate feature (patient-history record / questionnaires / differential-diagnosis) — logged here for the record; not an audit-engine change',
    points: [
      'ClinicalState schema (lib/clinical-state/schema.ts) bumps clinical-state/1.0 → 1.1 and gains two ADDITIVE top-level fields: medicationAssertions[] (MedicationAssertion: status prescribed|reported_taking|administered|stopped|not_taking|unknown, medicationConcept {raw,brand,generic,normalizedConceptId:null}, dose/strength/frequency/route/duration/instruction, provenance, encounterRef) and allergyAssertions[] (AllergyAssertion: status reported_allergy|denied|historical|entered_in_error|unknown, substance {raw,normalized}, reaction/severity, provenance, encounterRef). Both default to [] in emptyClinicalState and the .strict() zod validator. The existing medications:string[] / riskFactors / findings / instability are UNCHANGED and byte-identical (medications is kept independent, not derived from the assertions — neutrality first).',
      'New PURE mapper lib/clinical-state/from-prescription.ts (no db/llm/io, type-only imports; the from-primitives/to-audit-family pattern) maps db13 individuals-prescriptions jsonb → typed assertions: each med line → a prescribed assertion (skip when brand+generic both empty; empty sub-fields → null; ids deterministic djb2 of concept|status); allergy free text → NKA notations ("No"/"nil"/"nka"/… case/quote/space-insensitive) → one denied fact, substantive text → one reported_allergy, null/empty → NO assertion (absence ≠ denied). Fail-safe: malformed input degrades to empty, never throws. CONSUMED BY NO LIVE ENGINE in 1.1 — Stage 0 (MemberState) wires it and fills encounterRef + normalizedConceptId. The /ddx extract path, the LLM extraction prompt, format.ts, ui-view.ts, and the panel are UNTOUCHED (no free-text med/allergy extraction, no UI render in 1.1). No migration (ClinicalState is computed/traced, not persisted). Logged here per the changelog discipline, same reasoning as the ClinicalState-family entries below; this is a schema/mapper change, not an OPD note-audit engine change.',
    ],
    why: 'Precursor in the longitudinal-spine plan (CDMSS-LONGITUDINAL-SPINE-NORTH-STAR-v2): MemberState reconciles meds/allergies across encounters and cannot reconcile on a bare medications:string[] (a prescription is not proof the patient is taking it). ClinicalState-1.1 Typed-Assertions PRD v1.0 (Cowork per V delegation, 11 Jul 2026). Lock the typed contract + prove it against real db13 data with zero live-surface risk.',
  },
  {
    engine: null, date: '2026-07-12', scoring: false,
    title: 'DDx surface (not OPD audit) — ClinicalState panel UI-integrity fixes: three-state instability + two copy corrections (advisory, differential-neutral)',
    plain: 'Separate feature (patient-history record / questionnaires / differential-diagnosis) — logged here for the record; not an audit-engine change',
    points: [
      'Instability becomes THREE-STATE on the /ddx ClinicalState panel (was two-state "unstable | stable"). Instability now carries assessment ∈ {unstable, no_instability_detected, not_assessable} plus assessedInputs[]/missingInputs[] (the 5 instability-relevant vital channels present/absent as display labels BP·HR·SpO₂·RR·T), derived deterministically in the extract.ts vitals branch. unstable/reasons are RETAINED and kept in sync (unstable === assessment==="unstable"); parseVitals + instabilityReasons thresholds/logic are UNCHANGED — only the assembly of the instability object changed. Fixes the overclaim where a note with NO vitals supplied rendered identically to one with genuinely normal vitals ("Stable — no instability criteria met"); no-vitals now renders amber "Instability not assessable from supplied data" with the missing channels itemised. Partial vitals (≥1 parsed read) = assessed (no_instability_detected). emptyClinicalState default is not_assessable / all 5 missing.',
      'Two copy corrections narrowing claims to what the system proves: the source-linkage badge "No fabrication · rejected_spans: N" → "All extracted findings are source-linked · N unverified spans"; the Absent-group heading "Absent — ruled out by stated negatives" → "Explicitly absent in the supplied record". Additive lucide-react HelpCircle icon for the amber not_assessable state. ZERO change to the /api/ddx differential, ordering, prompts, retrieval, the clinical_state_extracted trace, or lib/clinical-state/format.ts (the held D2 prompt formatter). Additive schema fields (required in the zod .strict() validator); no version bump, no migration — ClinicalState is computed/traced, not a persisted validated record. Logged here per the changelog discipline (same reasoning as the Build 1c entry below); this is a DDx-surface change, not an OPD note-audit engine change (opd-note-audit-core / opd-note-score-core untouched).',
    ],
    why: 'External-review §11 — two overclaims on the released /ddx ClinicalState panel ("No fabrication", "ruled out by stated negatives"), extended with the derivable third instability state (no-vitals ≠ stable). ClinicalState-Panel UI-Integrity-Fixes PRD v1.0 (V, 11 Jul 2026, mockup-approved). Advisory surface — an overclaim erodes clinician trust the first time a counterexample is found.',
  },
  {
    engine: null, date: '2026-07-12', scoring: false,
    title: 'DDx surface (not OPD audit) — ClinicalState clinician render (Build 1c): additive /api/ddx field, flag-gated, differential-neutral',
    plain: 'Separate feature (patient-history record / questionnaires / differential-diagnosis) — logged here for the record; not an audit-engine change',
    points: [
      'app/api/ddx/route.ts returns an ADDITIVE clinicalState field on the result ONLY when CLINICAL_STATE_UI=1 (default OFF). Off → the response is byte-identical to before (spreading {} adds nothing; asserted by a unit test). The field is a trimmed projection of the already-computed, already-traced ClinicalState (findings by present/absent/unknown, instability, investigations, temporality, provenance, counts, rejected_spans) — nothing is recomputed.',
      'The /ddx client renders a read-only "Clinical State" panel beside/above the differential (never replacing it) when that field is present. ZERO change to differential generation, ordering, prompts, retrieval, ddx-hypothesis/ddx-constraints, the self-critique loop, or the clinical_state_extracted trace insert. Logged here per the changelog discipline because it touches the /api/ddx response shape — though it is a DDx-surface change, not an OPD note-audit engine change (opd-note-audit-core / opd-note-score-core are untouched).',
    ],
    why: 'DDx Reasoning V2 UI/UX Build 1c — surface the reasoning substrate (the ClinicalState proven live in shadow) to clinicians, behind a default-off flag so the default-on product decision stays a later, conscious flip.',
  },
  {
    engine: null, date: '2026-07-12', scoring: false,
    title: 'ClinicalState shadow adoption (Platform B1) — dormant, output-neutral instrumentation',
    plain: 'Separate feature (patient-history record / questionnaires / differential-diagnosis) — logged here for the record; not an audit-engine change',
    points: [
      'A flag-gated shadow hook at the persist seam (lib/opd-audit-store.ts saveOpdAudit, AFTER the INSERT): when CLINICAL_STATE_AUDIT_SHADOW=1 it round-trips the persisted findings through the canonical ClinicalState model (lib/clinical-state) and traces a fidelity event (kind clinical_state_audit_shadow: {roundtrip_ok, lossy_fields, counts}). DEFAULT OFF — zero added work, and byte-identical persisted output when off. The shadow computation is pure and non-mutating (operates on a JSON clone), fail-open (any throw is caught), and read-only w.r.t. the audit, so it can never affect findings / note_quality_index / PDQI-9 / suggestions / completeness. No opd-note-audit-core or opd-note-score-core change.',
      'Fidelity shakedown (read-only harness scripts/clinical-state-audit-shadow.mjs, 12 Jul): 11,438 findings across 5,000 real audits spanning 16 engine versions (0.1→0.81.7) round-trip BYTE-LOSSLESS (100.0%), zero lossy fields — the canonical model losslessly represents real note-audit output; nothing blocks it becoming canonical for this surface on fidelity grounds.',
    ],
    why: 'ClinicalState Platform B1 — first increment of making ClinicalState the canonical CDMSS patient model. Shadow-only: prove lossless representation of real production audit output and install the dormant hook without touching the live engine.',
  },
  {
    engine: '0.81.7', date: '2026-07-09', scoring: false,
    plain: 'Data quality — who gets audited, phone-vs-in-person detection, daily specialty updates',
    title: 'v0.81.7 — Data-quality: intake eligibility + consult-channel classifier + daily specialty sync (inputs corrected; scores untouched)',
    points: [
      'Intake eligibility: the daily worker no longer admits house-account artefacts. The db13 fetch excludes a configurable doctor_uid list (app_settings audit_intake_doctor_exclusions, seeded with the 7 measured "Even Health" accounts) PLUS an unconditional name-rule (doctor_name_with_speciality NOT LIKE \'Even Health(%\'), so a future house account is caught with no settings edit. Retroactively, opd_note_audits gains excluded_reason: 167 existing house-account audits (health-check-up / underwriting memos — one was flagged by a reviewer in Review Mode, which is how the bug surfaced) are flagged \'house_account\' and EVERY clinical read surface filters them out (stewardship, Right Care, doctor pages, review queue, triage, governance feeds, exports, learning miner). The worker\'s already-audited watermark deliberately IGNORES the flag so an excluded uid can never be re-admitted as "new".',
      'Consult-channel classifier: the encounter channel (teleconsult vs in-person) previously derived ONLY from the prescription FORM type (GENERAL_PRACTITIONER → teleconsult; HOSPITAL_* → in-person) with the hands-on-exam downgrade. db13\'s consult_types purpose markers now take precedence: VISITING_HOSPITAL / EMERGENCY → in-person (these WIN over CHAT when both appear — a hospital visit with a chat follow-up purpose is in-person), CHAT → teleconsult, else the form-type default; the exam downgrade still applies last, unchanged. The audit context gains a "Consult purposes:" line. Measured: 93 form-vs-purpose contradictions in the 90-day db13 window (73 hospital-visit notes framed tele, 20 chat consults framed in-person); the 6 of them that had ever been audited were re-audited at 0.81.7 the same night (delete-then-insert, exactly one current row per uid, zero attached gold labels lost).',
      'Specialty: doctor_directory now syncs DAILY (was weekly Mon 04:30) on a 90-DAY modal label (was all-time) — a doctor whose role recently changed (18 doctors carry multiple specialty labels in db13) converges within a day instead of lagging their whole history. Registries were verified CORRECT for the reported case (a General Surgeon shown as "GP") — the misread was the notes-table "type" chip, which showed the prescription FORM type as if it were clinician identity. The chip now renders the classified channel first, form second ("In-person · Hosp GP"); the case header keeps showing directory specialty.',
      'SCORES UNCHANGED: opd-note-score-core is byte-identical — this bump reflects corrected audit INPUTS (corpus eligibility + channel framing), not changed arithmetic. Read family grows to {0.81.3, 0.81.4, 0.81.5, 0.81.6, 0.81.7}.',
    ],
    why: 'Data-quality PRD (9 Jul night) — V reported three field bugs: underwriting memos being audited, tele/OPD swaps, and a surgeon labelled GP. Measured before fixing: 166→167 house-account audits in the corpus (one more was admitted between measurement and deploy — the leak caught in the act), 93/90d channel contradictions, and specialty registries already correct (the chip was the misread). Verified same night: exclusion leak-through zero (Health Check Up dept: included 0 / excluded 26 on the family basis).',
  },
  {
    engine: '0.81.6', date: '2026-07-09', scoring: false,
    plain: 'Better matching of low-value-care guidelines',
    title: 'v0.81.6 — Right Care matcher v3 (OR-across-keywords) (metadata-only; scores untouched)',
    points: [
      'LVC rule matcher v3: keywords are now treated as ALTERNATIVE trigger phrases. A KEYWORD (phrase) matches when EVERY whitespace-split token of it is a whole word in the subject+rationale; a RULE matches when ANY of its keywords matches (v2 required ALL keywords, which was wrong for the corpus — the 28 Choosing-Wisely/NCG rules author keywords as alternatives, so ALL-keywords left 744 low_value_care findings unmatchable, only the CBP phrase-token rule ever matched). Specificity: the rule whose best-matching keyword has the MOST tokens (longest matched phrase) wins; tie → rule id ASC. Whole-word matching, special-char escaping, and zero-keyword-never-match all carry over. ONE implementation shared by the engine stamp, read-time fallback, and backfill. No LLM.',
      'Keyword DATA is corrected separately (Cowork, no code): the CBP rule is re-authored to a single phrase so it cannot over-match on bare "blood" under OR-semantics (26a), and the Choosing-Wisely keyword set is enriched behind a V precision review (26b). The lvc-ref-backfill ?restamp=1 lever re-attributes history afterwards.',
      'SCORES UNCHANGED: opd-note-score-core is byte-identical; this bump only changes which rule_ref a low-value finding is stamped with. Golden A/B (3 uids, &save=0) confirms identical domain scores. Read family grows to {0.81.3, 0.81.4, 0.81.5, 0.81.6}.',
    ],
    why: 'Right Care PRD §2.4 (decisions 25–26, 9 Jul EOD) — post-0.81.5 restamp verified only 30/774 findings attributed (all CBP) because v2 ALL-keywords is incompatible with alternative-phrase keyword authoring. Measured: matcher fix alone ~4%→~7% attribution; with keyword enrichment ~20%.',
    },
  {
    engine: '0.81.5', date: '2026-07-09', scoring: false,
    plain: 'More precise low-value-care matching, plus a dashboard fix',
    title: 'v0.81.5 — Right Care matcher v2 (whole-word, all-keyword) + read-filter family fix (metadata-only)',
    points: [
      'LVC rule matcher v2: a rule matches only when EVERY keyword appears as a WHOLE WORD (case-insensitive, word-boundary; special chars escaped) in the subject+rationale — fixing the 0.81.4 ANY-substring bug where one generic rule (keywords ["complete","blood","profile"]) claimed all 112 stamps ("incomplete" contains "complete"). Candidates are evaluated most-specific first (keyword count DESC, tie id ASC); zero-keyword rules never match. ONE implementation shared by the engine stamp, the read-time fallback, and the backfill.',
      'Read-filter FAMILY fix: the four /admin/opd-audit surfaces + lib/opd-audit-doctor.ts now read engine_version = ANY(current-engine family {0.81.3, 0.81.4, 0.81.5}) so a metadata-only bump no longer empties the doctors index / doctor / overview lists (0.81.4 emptied them). WRITE-side "already audited at current version" targeting keeps the exact OPD_ENGINE_VERSION — a family there would stop history re-scoring.',
      'Backfill ?restamp=1: re-evaluates ALL stored low_value_care findings and OVERWRITES rule_ref with the current matcher result (including → null), so a matcher revision propagates to history; default POST keeps its NULL-only fill. SCORES UNCHANGED: opd-note-score-core is byte-identical — metadata only.',
    ],
    why: 'Right Care PRD §2.3 (decisions 21–24, 9 Jul) — three prod-verified defects after the 0.81.4 ship (34c3c6d): the family bump emptied the doctors index, one over-generic rule took all 112 stamps, and the day tile\'s category split hardcoded today (zeros under an 8-Jul rate).',
  },
  {
    engine: '0.81.4', date: '2026-07-09', scoring: false,
    plain: 'Links each low-value finding to the specific guideline it relates to',
    title: 'v0.81.4 — Right Care LVC rule matcher (metadata-only; scores untouched)',
    points: [
      'LVC rule matcher wired into the engine: at stamp time a low-value finding is keyword-matched (deterministic containment over the active lvc_recommendations — subject+rationale haystack, first rule whose any-keyword hits wins) to stamp rule_ref:<rule id> + the rule\'s category. No matcher hit → rule_ref:null (0.81.3 behaviour). NO LLM; the single audit-path read of the rules is cached + 2s-timeout fail-safe (no rules → rule_ref:null, never blocks the audit).',
      'Companion one-shot backfill (/api/admin/lvc-ref-backfill) re-stamps rule_ref on EXISTING stored low_value_care findings by running the same matcher over the stored findings jsonb — idempotent UPDATE, no re-audit, NO engine-version change on those rows. The read-time fallback stays for pre-0.81.3 rows.',
      'SCORES UNCHANGED: opd-note-score-core is byte-identical; this bump adds rule_ref stamping only. Golden A/B (3 uids, &save=0) confirms identical domain scores. The current-engine READ family for Right Care aggregates is {0.81.3, 0.81.4}, so the validated 0.81.3 corpus is never orphaned by the bump.',
    ],
    why: 'Right Care Indicator PRD §2.2 decision 14 (9 Jul) — restores §5\'s original intent (Branch 1 shipped rule_ref:null everywhere because no matcher was wired), enabling per-rule Right Care attribution + the plain-language rule chips on the case view and the O/E stewardship surfaces.',
  },
  {
    engine: '0.81.3', date: '2026-07-08', scoring: false,
    plain: 'Low-value-care tracking, plus grading patients by complexity for fair comparison',
    title: 'v0.81.3 — Right Care LVC identity + case-mix complexity (metadata-only; scores untouched)',
    points: [
      'LVC identity: a finding on the low-value verdict tier now carries signal_type "low_value_care" (unifying the appropriateness/prescribing low-value buckets so the feedback loop + Right Care aggregates batch all low-value care together) plus lvc_category (antibiotic | imaging | supplement_polypharmacy | other) and rule_ref (null in the OPD engine — no lvc_recommendations matcher is wired here; the read-time classifier / backfill attach a rule id when it text-matches one of the 29 rules).',
      'Case-mix complexity: every audit is banded (NEW_TO_US | LOW | MODERATE | HIGH) from db13 history computed STRICTLY BEFORE the index encounter — distinct chronic-only ICDs (12m), abnormal-lab burden (12m), and utilisation (12m/24m). Stored as complexity_band + complexity_inputs on the audit row. If db13 is unreachable/slow (3s cap) the band is NULL ("unbanded", excluded from any rate) and never blocks the audit; a backfill endpoint fills NULLs.',
      'Circularity rule (first-class): no denominator input may be derivable from the prescribing behaviour under comparison in the window — hence chronic-ONLY ICDs, the index encounter excluded, and Even risk_category BANNED as an input (structural circularity — it is built largely from our own prescriptions).',
      'SCORES UNCHANGED: no scoring rule, weight, band cut-off, or PDQI logic was touched (opd-note-score-core is byte-identical). This bump stamps metadata + adds a complexity column only. Golden A/B (3 uids, &save=0) confirms identical domain scores.',
    ],
    why: 'Right Care Indicator PRD v1.0 (8 Jul) — promoting per-note low-value-care detection to a defined, case-mix-fair, comparable rate on Even\'s own payer-provider books. Advisory-first, admin-gated. Companion: CASE-MIX-DENOMINATOR-DATA-HOMEWORK-8-JUL-2026 (rev 2).',
  },
  {
    engine: '0.81.2', date: '2026-07-07', scoring: true,
    plain: 'Fixes from Dr Zaki\'s review: merged duplicate warnings, syrup dosing, supplement/label safeguards',
    title: 'v0.81.2 — clinician bug batch (Dr Zaki): matcher, cross-source consolidation, liquid dosing, supplement + metadata guardrails',
    points: [
      'BUG-0.8-15 (formulary matcher): a single molecule now wins its drug class over a combination that merely contains it (two-pass index). Fixes Pantoprazole shown as "Antibiotic" and Etodolac as "Muscle relaxant" — and any molecule whose first formulary occurrence was inside an FDC.',
      'BUG-0.8-12 (consolidation): "one decision, one finding" is enforced in CODE, not just the prompt — a deterministic NSAID interaction and the LLM therapeutic-duplication for the same oral+topical NSAID pair merge into ONE finding (no more double penalty). DDI is route-aware: a topical NSAID is not treated as a full systemic one.',
      'BUG-0.8-13 (liquid dosing): a syrup dosed "10ml (2 tsp)" is no longer mis-read as 10 tablets — fixed the volumetric-guard regex (matched "10 ml" but not "10ml") + tsp/cc/syrup-form detection; a volume is never a tablet count. Removes fabricated ceiling breaches (phenylephrine 150 -> 30 mg/day).',
      'BUG-0.8-14 (supplements): nutraceuticals/supplements no longer receive an "incomplete dosing" penalty (a proprietary supplement has no meaningful strength) — fixes the same product penalised on one note and exempt on another.',
      'BUG-0.8-16 (metadata guardrail): a finding about an "inaccurate drug class in the record" is now NON-scoring — the class tags are CDMSS own formulary metadata, so the clinician is never penalised for our data error. Prompt guard + deterministic neutralisation.',
      'BUG-0.8-10 (Q): concurrent-NSAID detection is now INGREDIENT-level and formulary-independent — a combination/topical whose parsed primary is a non-NSAID (e.g. Methyl Salicylate over Diclofenac) still counts as an NSAID for the overlap.',
      'BUG-0.8-11 (R): the muscle-relaxant-FDC appropriateness objection is now a DETERMINISTIC fixed-tier (context-dependent) finding instead of an LLM one that swung run-to-run; the prompt + consolidation suppress the volatile LLM version.',
      'Part 1 (coding relocation): a pure ICD/coding-completeness gap is now NON-scoring (chart metadata, not a care decision) — shares the non-scoring lane with 0.8-16.',
    ],
    why: 'Six clinician bug reports (Dr Zaki, 5-7 Jul) on live 0.81.1 audits; three traced to one formulary-matcher bug. Full analysis in AUDIT-ENGINE-v0.81.2-UPGRADE-PRD.md Part 4.',
  },
  {
    engine: null, date: '2026-07-04', scoring: false,
    title: 'Backfill: engine-upgrade pivot + live version label',
    plain: 'Background re-audit restarts cleanly after a version change',
    points: [
      'The prod mini-backfill now RESTARTS its backward sweep from the upgrade date whenever OPD_ENGINE_VERSION changes, so a new engine re-scores ALL history and never leaves a gap of already-audited recent days. The Gemini worker independently takes new notes forward.',
      'Fixed the stale \'prod 0.6\' state label — it now shows the live prod engine version.',
    ],
    why: 'After the 0.81.x cutover the backfill cursor had already walked past the most recent days, so they would not have been re-scored to the new engine without a manual reset.',
  },
  {
    engine: '0.81.1', date: '2026-07-04', scoring: true,
    plain: 'Better clinical reasoning and more reliable reading of notes (Zaki/Aravind fixes, part 2)',
    title: 'v0.81.1 — reasoning recalibration + prompt/extraction hardening (Zaki/Aravind bug batch, part 2)',
    points: [
      'Reasoning rubric (P1): PDQI thorough/synthesized/useful are judged against what the presentation requires, not raw sparseness — a fully and correctly addressed low-risk complaint rates 4-5; low scores are reserved for a genuine reasoning gap (missing red-flag screen/differential, or an assessment that ignores documented findings). Fixes the ~85 percent thorough/synth floor.',
      'Drug-indication (P): systematic per-drug indication check — a drug contradicted by an explicit negative history (e.g. an antihistamine with \'No cold\') is an appropriateness low-value finding.',
      'Coding gap (O): a diagnosis documented in words without a resolved ICD code is a code-mapping gap, not a missing diagnosis — no appropriateness penalty.',
      'Verify-before-flagging-an-absence (F): a fact present in ANY section counts; a documented hands-on exam means in-person and is never an impossible-teleconsult contradiction.',
      'One decision, one finding (N): duplicate findings for the same drug pair / clinical decision are consolidated.',
      'Capture all diagnoses (D): nested + dpipe diagnosis sources are merged, so a coded diagnosis is no longer dropped when only one was extracted.',
      'Presentation-aware vitals (K): an in-person febrile note with no documented vitals now shows a documentation gap.',
    ],
    why: 'System Audit Reports (Dr Zaki, Dr Aravind U): false-positive penalties (modality, coding gap, double-count) and false negatives (unindicated drug, missing vitals) plus the reasoning-score floor. Prompt/extraction fixes validated by the live Gemini golden A/B (5/6 direct + D closing the 6th); deterministic parts unit-tested (31/31).',
  },
  {
    engine: '0.81.0', date: '2026-07-04', scoring: true,
    plain: 'Accuracy and fair-scoring fixes (Dr Zaki / Dr Aravind review)',
    title: 'v0.81.0 — fidelity + scoring-hygiene core (Dr Zaki / Dr Aravind bug batch)',
    points: [
      'BUG-0.8-04 (modality): only GENERAL_PRACTITIONER defaults to teleconsult; HOSPITAL_* are in-person. HOSPITAL_GP/_INVESTIGATION_REFERRAL had mislabelled ~178 in-person hospital OPD notes as teleconsult (consult_type is null corpus-wide). Added a hands-on-exam override: a documented palpation/auscultation finding downgrades a teleconsult classification.',
      'BUG-0.8-05/07 (aggregation): domain score now combines finding penalties with diminishing returns, not a flat additive sum — one low-value ~55 (unchanged), two ~30, three ~17 — so a stack no longer collapses a domain to an unfair 0.',
      'BUG-0.8-03 (continuity): a formal onward referral satisfies follow-up / continuity even without a calendar date.',
      'BUG-0.8-01 (dosing): a parenteral concentration (mg/ml) is no longer accepted as a documented dose — an injectable with no explicit amount is flagged incomplete.',
    ],
    why: 'System Audit Reports (Dr Zaki, Dr Aravind U) surfaced false-positive penalties (modality, flat-0 collapse, referral continuity) and a dose-masking false-negative. Deterministic + unit-tested (26/26). Prompt-level recalibration, drug-indication and absence-verification follow as v0.81.1 behind the live golden A/B.',
  },
  {
    engine: '0.8', date: '2026-07-03', scoring: true,
    plain: 'Stopped double-counting advice and follow-up across two areas',
    title: 'Score each field once — Continuity / Documentation de-overlap',
    points: [
      'Advice + follow-up are EXCLUDED from the Documentation coverage denominator; they remain on the completeness checklist (display, missing-fields, mandatory tracking) but are scored only in the Continuity domain (weight 0.10).',
      'Documentation completeness now = presenting complaint · diagnosis · complete dosing · examination (in-person only).',
      'Fixed the patientCentred code comment that falsely claimed red-flags were part of Continuity (they never were — it is exactly advice + follow-up).',
    ],
    why: 'Before 0.8 advice/follow-up counted twice — as 2 of 5–6 completeness items (×0.25) AND as the whole Continuity domain (×0.10) — so two fields silently carried ~18–20% of the headline while diagnosis carried ~4%.',
  },
  {
    engine: '0.7', date: '2026-07-03', scoring: true,
    plain: 'Fixes from clinician feedback, checked across 934 notes',
    title: 'Clinician-feedback fix batch (#cdss_feedback, prevalence-mined over 934 notes)',
    points: [
      'B2 (the bump): a blank/UNKNOWN follow-up type no longer counts as a documented follow-up — only a real disposition (IF_REQUIRED, MANDATORY_FOLLOW_UP, …) or an explicit date does. ~26% of notes were being credited.',
      'B4: the audit is specialty-aware — the case card shows the doctor_directory speciality (not the prescription type) and the prompt judges against that specialty\'s standards. 62% of notes were specialist-as-GP.',
      'B3: "Fields present · content thin" advisory flag when NABH fields are complete (doc ≥90) but PDQI thoroughness/synthesis ≤2 — completeness ≠ adequacy. 56% prevalence; scores unchanged (flag only).',
      'Prompt pass — B1: prescribing findings scoped to CURRENT meds, explicit zero-medication line, deterministic drop of prescribing findings on 0-med notes (ghost prescribing). B5: chronic drug vs acute dx reframed to "indication not documented". B6: diagnosis–complaint concordance check. B9: suggestions must be consistent with what the note documents; med-stop context.',
    ],
    why: 'Doctors (Zaki, Aravind, Mohsin) reported specific wrong findings; prevalence mining via audit_query flipped the priority — the loudest complaint (ghost prescribing) was the rarest (~6 notes), while the quiet ones covered half the corpus.',
  },
  {
    engine: null, date: '2026-07-03', scoring: false,
    title: 'Molecule-level daily-dose aggregation',
    plain: 'Adds up a drug\'s daily dose across combination products',
    points: [
      'Total daily dose per MOLECULE aggregated across combination products (paracetamol in Dolo + a cold combo), OD/BD/TDS/SOS parsing, checked against per-molecule ceilings in data/dose-limits.json.',
      'Volumetric/liquid formulations (mg/ml, ml dosing — paediatric syrups) excluded from the adult tablet-ceiling model.',
    ],
    why: 'Cumulative-overdose risk across combos was invisible to per-line checks (care-manager consult flagship ask).',
  },
  {
    engine: '0.6', date: '2026-07-02', scoring: true,
    plain: 'Understands teleconsults and referrals',
    title: 'Encounter context — teleconsult + referral aware',
    points: [
      'Referral and teleconsult encounters ingested as first-class context; an onward referral satisfies the plan item (a handoff\'s plan IS the referral).',
      'Auto-templated patient-education LEAFLET split out of clinician advice (the engine was grading the template as the doctor\'s counselling).',
      'Physical examination not scored on teleconsults (N/A, not "missing"); the prompt no longer praises omissions that are actually a correct handoff.',
    ],
    why: 'A teleconsult ortho REFERRAL note scored a false Band-A 98 (found by Dr Zaki / Mohsin); re-audit after the fix: 75, Band B.',
  },
  {
    engine: null, date: '2026-07-01', scoring: true,
    title: 'Dosing-completeness calibration (deterministic backfill, no LLM)',
    plain: 'Fewer false \'incomplete dosing\' flags — reads the note more carefully',
    points: [
      'A dose counts as documented if it is in the dose field, the strength field, OR embedded in the drug name ("Cefix 200mg Tab" — the strength field is empty on ~36% of lines).',
      'Route read from the field OR inferred from the dosage form (tab→oral, inj→parenteral, …); null only when truly ambiguous. Blank-but-inferable routes (~17%) no longer flag.',
      'Deterministic re-score of all stored rows (kept LLM findings + PDQI-9): "incomplete dosing" fell 26.9% → 12.4%.',
    ],
    why: 'Reading the EMR fields literally false-flagged ~1/3 of complete notes — the information was present but misfiled.',
  },
  {
    engine: '0.5', date: '2026-06-30', scoring: true,
    plain: 'Every finding now backed by a reference or clearly labelled as reasoning',
    title: 'First-class corpus grounding — cite-or-label',
    points: [
      'Every LLM finding is badged: Grounded in CDMSS corpus (CITED [n] chips) vs General clinical reasoning vs Deterministic rule; retrieval hits persisted as sources jsonb with PubMed links.',
      'Richer retrieval query (readable dx names + complaints + resolved molecules, not just ICD codes).',
    ],
    why: 'Recommendations were flowing from the model alone — retrieval ran but grounding was invisible and unenforced.',
  },
  {
    engine: '0.4', date: '2026-06-30', scoring: true,
    plain: 'Looks up the generic drug from the brand name',
    title: 'Formulary-aware — brand→generic resolution',
    points: [
      'Tiered brand→generic matcher over the 2,174-row hospital formulary; ~90% of med lines now resolve to a molecule (was 64%).',
      'Duplicate detection dedupes on the RESOLVED generic (brand-only duplicates finally caught); DDI runs over confident matches.',
      'Formulary safety facts surfaced: ISMP high-alert, Schedule X, LASA look-alike/sound-alike pairs, off-formulary brands (informational findings, confidence 0 — they never penalise).',
    ],
    why: '36% of OPD med lines arrive brand-only — molecule, class and interactions could not be verified.',
  },
  {
    engine: '0.3', date: '2026-06-29', scoring: true,
    plain: 'Cleaner reading of the complaint, diagnosis and plan',
    title: 'Hybrid dpipe source',
    points: [
      'Clean presenting complaint (text + HOPI), diagnosis names+codes and plan pulled from the dpipe prescription pipeline (99.8% complete); the source row\'s nested fields became the fallback.',
    ],
    why: 'The raw prescription row\'s nested fields were sparse/inconsistent — the audit was judging notes on data it could not see.',
  },
  {
    engine: '0.2', date: '2026-06-29', scoring: true,
    plain: 'Fix to how notes are read',
    title: 'Extraction fix',
    points: [
      'Nested general_practitioner_prescription__* fields read correctly; dashboards filter to the current engine version.',
    ],
    why: 'First-pass extraction missed the nested GP fields — completeness was scored against empty data.',
  },
  {
    engine: '0.1', date: '2026-06-29', scoring: true,
    plain: 'First version',
    title: 'First engine',
    points: [
      'The 5-domain OPD Note-Quality score: deterministic NABH completeness + LLM findings (appropriateness / prescribing) + PDQI-9 note-quality rating + the shared penalty/band model. Daily worker over db13 + /admin/opd-audit dashboard.',
    ],
    why: 'Genesis — audit every non-draft medical OPD note daily, advisory, never a clinician scorecard.',
  },
];
