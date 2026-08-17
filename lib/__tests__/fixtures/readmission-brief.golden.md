# Readmission case brief — Asha Khan · UH-77812 · 58F

Care-manager copy · advisory throughout · dedup key `IP-2026-0101|IP-2026-0342`

## Part 1 — Intern presentation

### Why this case
- Lane: Clearest signal · fast bounce — fast return to the same team [finding row]
- Finding class: Even → Even [finding row]
- Gap: 4.0 days [finding row]
- Situation · Unplanned return [audit finding]

### Index stay
- Department: Orthopaedics [finding row]
- Treating doctor: Dr R Menon [finding row]
- Discharge date: 1 Jun 2026 [finding row]
- Payer: Even [finding row]
- Diagnosis: Fracture neck of femur (L) [index DS, extracted]
- Indication: Displaced intracapsular fracture [index DS, extracted]
- Procedure: Cemented hemiarthroplasty [index DS, extracted]
- Course: Uneventful stay; mobilised day 2; wound clean at discharge. [index DS, extracted]
- Investigations: Hb 10.2; CRP 48 [index DS, extracted]
- Treatments: IV cefuroxime 48h [index DS, extracted]
- Medications: Enoxaparin 40 mg OD; Paracetamol 650 mg TDS [index DS, extracted]
- Risk factors: T2DM [index DS, extracted]
- Disposition: Home [index DS, extracted]
- Follow-up: OPD in 2 weeks [index DS, extracted]

### Interval
- 4.0 days between index discharge (1 Jun 2026) and return (5 Jun 2026) [finding row]

### Return
- Department: Orthopaedics [finding row]
- Treating doctor: Dr S Iyer [finding row]
- Admit date: 5 Jun 2026 [finding row]
- Payer: Even [finding row]
- POST_IPD form held: Patient called on day 3 — fever and wound discharge; advised to return. Contact [number withheld]. [POST_IPD form, patient-reported]
- Diagnosis: Superficial SSI [readmit DS, extracted]
- Course: Wound opened and washed; culture-directed antibiotics. [readmit DS, extracted]
- Investigations: CRP 132; Wound swab: MRSA [readmit DS, extracted]
- Treatments: IV vancomycin [readmit DS, extracted]

### Artefacts
| Artefact | State |
|---|---|
| Index DS | present |
| Readmit DS | present |
| Labs | present |
| OT | present |
| PAC | absent |
| Progress | empty |
| POST_IPD | present |
| Bill | unknown |

### Assessment
- Medical justification: Needs adjudication [audit finding]
  - Reason: passes agree on the label but cite disjoint evidence [audit finding]
- Preventable injury: Suspected (rule readmit-judgement/1) [audit finding]
  - Omission: surgical site infection — late culture, wound discharge — moderate danger, moderate confidence [audit finding]
- Negligence: Unknown — advisory — not a court or council finding [audit finding]
  - Exculpatory: patient non-adherent to dressing advice — uncorroborated [audit finding]
- Stability at discharge: contradicted · evidence track: lab_corroborated · lab tier: tier1 [audit finding]
- Return stay bill: unknown — not yet measured [finding row]

### Looked for and not found
- pac_note — no row in db13 for this stay/window [audit finding]
- progress_note — 3 row(s) exist but none carries usable text [audit finding]

## Part 2 — Actuarial / low-value-care

- Payer: Even–Even (index Even → return Even) [finding row]
- Bill: Return stay bill not yet measured — no figure is available for this return.
- Candidate pattern: Unplanned same-condition return after Cemented hemiarthroplasty with 1 documentation omission(s) — candidate for Even Adjudicated LVC review.
- What we cannot say:
  - No policy rule follows from n=1 — one case is a case, not a pattern.
  - This is not a court or council finding; every judgement above is advisory and human-decided.
  - Ratification of any low-value-care pattern belongs to the LVC board, not to this brief.
