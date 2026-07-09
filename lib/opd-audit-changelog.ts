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
    engine: '0.81.5', date: '2026-07-09', scoring: false,
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
    points: [
      'The prod mini-backfill now RESTARTS its backward sweep from the upgrade date whenever OPD_ENGINE_VERSION changes, so a new engine re-scores ALL history and never leaves a gap of already-audited recent days. The Gemini worker independently takes new notes forward.',
      'Fixed the stale \'prod 0.6\' state label — it now shows the live prod engine version.',
    ],
    why: 'After the 0.81.x cutover the backfill cursor had already walked past the most recent days, so they would not have been re-scored to the new engine without a manual reset.',
  },
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
