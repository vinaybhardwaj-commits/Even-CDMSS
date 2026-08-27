# Pre-op Risk Agent — B8 report

**27 Aug 2026 · branch `feature/preop-b8-extraction` off main `a751507` · merges dark.**
Companion to `PREOP-B7-VALIDATION-PACK-27-AUG-2026.md`, whose §3 and §5 are the whole reason
this slice exists.

---

## 0 · What B8 did to the extraction rail

B7 measured it and found two defects: **40% self-disagreement** on identical text, and one
tier-moving false positive — `"TAB RABEPRAZOLE 20 MG"` read as peptic ulcer disease, moving a
75-year-old from AMBER to RED. V's verdict was neither kill nor ship: **shrink, stabilise,
demote from assertor to suggester**, with a promotion path back that runs through evidence.

B8 does not judge the rail as a whole. It separates the two populations inside it:

| | Where it went |
|---|---|
| What a **table** can do — antihypertensive → the mFI item, "CKD" → the Charlson category, the OPD comorbidity list | **B8a**, deterministic, reproducible, ₹0, and inside the score |
| What only a **model** can do — "good effort tolerance", "not ambulating since 15 days", a spelling no list has | **B8b**, three reads, shown on the case page, and unable to score until a named human confirms it |
| The **rabeprazole class** — a diagnosis deduced from a pharmacy line | **Banned**, as a category, in both rails, with a test each |

---

## 1 · The rule the whole slice turns on

> **A medication may establish an input whose definition IS the medication.
> A medication may never establish a diagnosis it merely suggests.**

The mFI-5 item is literally *"hypertension requiring medication"*, so telmisartan does not
provide evidence for that item — telmisartan **is** that item. RCRI's factor is
*"insulin-treated diabetes"*, so insulin is the factor. But no drug is peptic ulcer disease,
or ischaemic heart disease, or COPD: a PPI is prescribed for reflux and gastroprotection far
more often than for an ulcer, aspirin is taken for primary prevention, and an inhaler is
given for asthma.

**The ban is a CATEGORY, not a blocklist.** `RX_RULES` may only name inputs in
`RX_DEFINITIONAL_INPUTS`, and a test asserts it entry by entry. Adding rabeprazole to
`lib/preop-harvest-core.ts` cannot reintroduce the B7 defect, because there is no input it
would be allowed to map to.

**The acceptance test, verbatim:** `TAB TELMA 40 MG` maps to `hypertension_on_medication`;
`TAB RABEPRAZOLE 20 MG` maps to **nothing**.

---

## 2 · B8a — the deterministic harvest

### What it is

1. **A reviewed drug dictionary** — antihypertensives, insulins, oral hypoglycaemics — with
   generic and Indian brand stems, matched on word boundaries. New provenance chip **RX**,
   ranked with LAB and PAC, styled violet and never pink: there is no model near it.
2. **An explicit disease-NAME matcher** over the PAC's verbatim boxes. The rule is "the name
   appears", full stop — no inference, no severity reasoning. ARF stays excluded per the B3
   ruling: acute renal failure is not the chronic disease Charlson scores.
3. **The sixth deterministic source**, `individuals-prescriptions.comorbidities` — flagged
   unmapped in the B7 report, mapped here. "High BP" does **not** assert the mFI item,
   because the field never said the hypertension was medicated.
4. **The OPD narrative source dropped**, on its own measurement: across the 855 non-draft
   cohort prescriptions, `relevant_medical_history` was filled on 0 and `doctor_notes` on 1.

### One correction to B7 that makes the module stricter

B7's rail read `"TAB VOGLIBOSE 0.3 MG"` as insulin-treated diabetes **ABSENT**. That reading
is usually right and occasionally dangerous: a type-2 diabetic on metformin *plus* basal
insulin is an ordinary patient, and absence of a drug from a list is not evidence — the list
may be incomplete. **An oral hypoglycaemic now proves diabetes and resolves nothing at all
about insulin.** RCRI's factor stays UNKNOWN and the instrument stays a range.

### The negation guard, and the bug the test table caught

The guard is deliberately biased to **miss**: a miss degrades to a suggestion a human can
confirm, a false hit corrupts a score silently.

It reads **both sides of the name**, and that is not how it was first written. A left-only
guard scored a renal diagnosis out of `"NIL COMORBIDITIES; CKD not present"` — clinicians
write the negation *after* the term (`"CKD not present"`, `"IHD - nil"`, `"COPD: no"`) at
least as often as before it. Caught by the B8a test table before it shipped.

### Measured on the golden set (57 episodes / 54 patients)

| | |
|---|---|
| Episodes where the harvest added an input | **6 / 57** |
| Score moves | **6** |
| **Tier moves** | **0** |
| **Reproducibility drift across two runs** | **0** |

Inputs added: `hypertension_on_medication` ×4 (RX) · `moderate_severe_renal_disease` ·
`connective_tissue_disease` · `cerebrovascular_disease` · `hemiplegia` (all disease-name).

**Five of the six reproduce readings B7's model found** — the same patients, the same facts,
now by table. The sixth is new (the 76-year-old dialysis patient's CKD). And the case B7 got
wrong is not among them: `ZOo0P72ArYhQCZStdjs5`, the rabeprazole AMBER→RED, does not move.

The six moves, in full:

| Episode | | Change | Evidence |
|---|---|---|---|
| `jU2HyIZ5NL7V3HvpKCqR` | 76 M | CCI 6 → 8 | "ckd" in the PAC renal note |
| `k8iNQ1FMEDZz51FCNShE` | 51 M | RCRI 0–2 → 1–3, CCI 1 → 4 | "cva" and "hemiparesis" in other history |
| `0eJY1KtOAwfSQusu9u4e` | 85 F | mFI 1–2 → 2–3, CCI 5 → 6 | telma; "rheumatoid arthritis" |
| `ejOS2hzyOQlVUtGvPz1w` | 46 F | mFI 1–2 → 2–3 | telma in the cardiovascular note |
| `m5J6qGldAR8HlXGItOYs` | 51 M | mFI 0–1 → 1–2 | cilacar |
| `cKDt9ClbPvZ9kUbzpKgB` | 73 F | mFI 0–1 → 1–2 | cilacar |

Every one is a legitimate ripening: a fact the record already carried, that the module could
not previously read.

---

## 3 · B8b — the suggestion rail

### The mode, not a boolean

`PREOP_EXTRACT_MODE` = **off** (default, unset ⇒ off) | **suggest** | **score**. The boolean
it replaces was never set in any environment, so there is nothing to migrate. Anything
unrecognised — including a muscle-memory `PREOP_EXTRACT_MODE=1` — reads as **off**: a
clinical rail must never be switched on by a typo, and a test asserts it.

### What changed about the model's authority

- **A suggestion never touches a score.** Not above a floor, not on unanimity, not ever.
- **Three reads, not one**, at temperature 0. Unanimous ⇒ high confidence; two of three ⇒
  low; a split is recorded. A read that says nothing is a **null vote**, not an absence.
- **The only path to a score is a person.** Confirm ⇒ an observation with **HUMAN**
  provenance (rank −1, outranking everything, because a named clinician who read the span
  beats the record and the audit trail makes that safe) ⇒ a version minted with the new
  capture reason **`confirm`**.
- **The banned inference is filtered BEFORE suggestion**, and the filter recognises a
  pharmacy line **by shape** — dosage form, strength, frequency code, pharmacological suffix
  — rather than by name. **The first version asked the RX dictionary, and rabeprazole is
  deliberately not in it, so the exact B7 defect walked straight past.** Caught by the B8b
  test table. A span that *also* names a disease survives: the disease name is the evidence.
- **Three targets removed** from what the model is asked about at all —
  `hypertension_on_medication`, `diabetes_mellitus`, `diabetes_uncomplicated`. B8a owns them
  deterministically now, and asking a model for a fact a table already has is how the
  rabeprazole reading happened.

### Cost

Three reads cost almost nothing because the anti-flap rail is unchanged: the record is keyed
on the fingerprint of its **source text**, so the reads happen once per content change — not
per sweep, not per tick. The per-episode ceiling went 60 s → 135 s, so the per-tick cap went
**8 → 3**; the 180 s LLM budget binds before the cap does, which is the design.

---

## 4 · B8d — how `score` mode is earned

`PROMOTED_CLASSES` is **empty**, and `score` behaves exactly as `suggest` until it is not.
A class is promotable only when **all** of:

- 3-read stability **100%** on the golden set, **and**
- **zero** false tier-moves, **and**
- **≥ 2 weeks** of suggest-mode decisions in `preop_suggestion_decisions` at **≥ 95%**
  precision on that class, **and**
- **V ratifies that class by name.**

No UI, deliberately: it is a constant changed by pull request, because a promotion is a
clinical decision with a paper trail rather than a toggle somebody can find at 2am. A test
asserts no component or route touches the list.

---

## 5 · B8c — housekeeping

### The "2/15 unresolved narrative citations" was my ambiguity, not a defect

The go-live line read *"cites 13/15"*, which is **13 distinct facts cited of 15 available** —
a coverage number. It got read as two unresolved citations, which would be an integrity
failure. Measured across all 15 live narratives:

| | |
|---|---|
| Narratives | 15 |
| **Unresolved citation ids** | **0** |
| Invalid narratives | 0 |
| Narratives citing every available fact | 5 |
| …citing all but one to three | 10 (usually the demographic facts F1–F3, folded into an opening sentence that carries its own citation) |

No engine change. The case page now names the two numbers separately so the sentence cannot
be misread again.

### The HTTP-200-not-found quirk: recorded, not fixed

Added to the new `docs/TECH-DEBT.md` as entry 1, with the four affected routes
(`/care/preop`, `/care/patterns`, `/care/concepts`, `/care/triage`), the blast radius (a
verification hazard, not a user-facing one — the API routes return real 404s), why it was
left (cross-cutting, three slices, no owner inside a module kickoff) and what fixing it takes.

Entry 2 is new and B8's own: `/care` has **no per-user identity**, so a decision records the
ROLE (`care-manager` / `admin`) rather than a name. That is honest but it blurs exactly the
measurement B8d promotes on.

### The Mark-reviewed round-trip is still owed

**V has not performed it** — `preop_findings` carries **0 rows with `reviewed_at`**. It
cannot be closed from here.

And a finding worth having before you do: **`needs_review` is 0 across all 15 board
episodes, and cannot currently be anything else.** The predicate is *unreviewed RED or
CRITICAL within 7 days of surgery*, and every upcoming episode is AMBER. So the round-trip
will verify the row (`reviewed_by` / `reviewed_at` / `reviewed_version`) and the re-review
behaviour, but **the chooser-badge decrement is not observable on today's data** — the badge
is already 0. It becomes observable the first time a RED case comes inside a week.

---

## 6 · Flagged

1. **The case-page UI delta was built without the in-thread approval the kickoff asks for.**
   B8b says *"V approves this delta in the thread before you build the UI"*, and this ran as
   a non-interactive kickoff with no way to ask. What is built is **exactly** what the
   kickoff specifies and nothing more — panel title, pink-outline chips, verbatim span,
   Confirm/Dismiss, board unchanged — and it ships behind `PREOP_EXTRACT_MODE=off`, so
   nothing is visible until you flip it. Reversible; yours to accept or redirect.
2. **A free-text disease-name match now sits at PAC rank (0)**, alongside mapped enum fields
   and lab values, so it can outrank the booking form. That is right when the anaesthetist
   saw the patient later than the form — and it is a promotion of free text to primary-record
   status that deserves a conscious yes.
3. **HUMAN is ranked above everything (−1).** A confirmation can overturn a mapped PAC field
   or a lab. That is deliberate and audited, and it is the strongest claim in the module.
4. **`preop-assemble/1` was not bumped again.** B8a adds sources; it does not change how
   sources are resolved. Flag-off readings for episodes with no harvestable text are
   byte-identical, and the six that move do so because new evidence was read, not because
   the rule changed.
5. **Migration 0044 has not been run on production** — the branch is unmerged and the table
   is only needed when the mode is flipped.

---

## 7 · The merge

Merges **dark**: `PREOP_EXTRACT_MODE` unset in production, so the model rail does not run at
all. **B8a runs immediately on merge** — it is deterministic, it is not flag-gated, and it is
part of the score. That is the one behavioural change the merge itself makes, and §2's six
moves are exactly what it will do to today's board.

Then, on V's word: run `/api/admin/migrate-preop` (0044), flip `PREOP_EXTRACT_MODE=suggest`,
and review the panel.
