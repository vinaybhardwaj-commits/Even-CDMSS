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
}

export const OPD_AUDIT_CHANGELOG: EngineChange[] = [
  {
    engine: '0.81.1', date: '2026-07-04', scoring: true,
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
    points: [
      'Total daily dose per MOLECULE aggregated across combination products (paracetamol in Dolo + a cold combo), OD/BD/TDS/SOS parsing, checked against per-molecule ceilings in data/dose-limits.json.',
      'Volumetric/liquid formulations (mg/ml, ml dosing — paediatric syrups) excluded from the adult tablet-ceiling model.',
    ],
    why: 'Cumulative-overdose risk across combos was invisible to per-line checks (care-manager consult flagship ask).',
  },
  {
    engine: '0.6', date: '2026-07-02', scoring: true,
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
    points: [
      'A dose counts as documented if it is in the dose field, the strength field, OR embedded in the drug name ("Cefix 200mg Tab" — the strength field is empty on ~36% of lines).',
      'Route read from the field OR inferred from the dosage form (tab→oral, inj→parenteral, …); null only when truly ambiguous. Blank-but-inferable routes (~17%) no longer flag.',
      'Deterministic re-score of all stored rows (kept LLM findings + PDQI-9): "incomplete dosing" fell 26.9% → 12.4%.',
    ],
    why: 'Reading the EMR fields literally false-flagged ~1/3 of complete notes — the information was present but misfiled.',
  },
  {
    engine: '0.5', date: '2026-06-30', scoring: true,
    title: 'First-class corpus grounding — cite-or-label',
    points: [
      'Every LLM finding is badged: Grounded in CDMSS corpus (CITED [n] chips) vs General clinical reasoning vs Deterministic rule; retrieval hits persisted as sources jsonb with PubMed links.',
      'Richer retrieval query (readable dx names + complaints + resolved molecules, not just ICD codes).',
    ],
    why: 'Recommendations were flowing from the model alone — retrieval ran but grounding was invisible and unenforced.',
  },
  {
    engine: '0.4', date: '2026-06-30', scoring: true,
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
    title: 'Hybrid dpipe source',
    points: [
      'Clean presenting complaint (text + HOPI), diagnosis names+codes and plan pulled from the dpipe prescription pipeline (99.8% complete); the source row\'s nested fields became the fallback.',
    ],
    why: 'The raw prescription row\'s nested fields were sparse/inconsistent — the audit was judging notes on data it could not see.',
  },
  {
    engine: '0.2', date: '2026-06-29', scoring: true,
    title: 'Extraction fix',
    points: [
      'Nested general_practitioner_prescription__* fields read correctly; dashboards filter to the current engine version.',
    ],
    why: 'First-pass extraction missed the nested GP fields — completeness was scored against empty data.',
  },
  {
    engine: '0.1', date: '2026-06-29', scoring: true,
    title: 'First engine',
    points: [
      'The 5-domain OPD Note-Quality score: deterministic NABH completeness + LLM findings (appropriateness / prescribing) + PDQI-9 note-quality rating + the shared penalty/band model. Daily worker over db13 + /admin/opd-audit dashboard.',
    ],
    why: 'Genesis — audit every non-draft medical OPD note daily, advisory, never a clinician scorecard.',
  },
];
