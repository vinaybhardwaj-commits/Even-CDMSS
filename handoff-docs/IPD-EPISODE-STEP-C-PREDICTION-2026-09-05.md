# Step C — prediction, stated before the sixteen were read

Engine `ipd-episode-audit/0.1` at `05ce5537` (decision 47: `MAX_FINDINGS_PER_PASS` 30 → 80).
Written 2026-09-05 before any Step C run. Checkpoint plans for the thirteen come from a **read-only
local dry run** of `checkpointPlanFromEvents` over each episode's real assembled event list: it
fetched extractions and db13 rows, made **no model calls and wrote nothing**.

## The three re-runs

The cap trims the parsed list, so the recovered findings are ones A1 already wrote and the engine
threw away, tail-first. The prompt orders most-consequential-first, so what comes back should be
the *least* consequential material — more findings, mostly minor, and a denominator that grows
faster than the penalty. I therefore expect indices to move little, and to move **down** rather than
up only where the recovered tail contains genuine divergences.

| Episode | Prior trunc → pred | Prior div → pred | Prior ctx → pred | Prior idx → pred | Why |
|---|---|---|---|---|---|
| IP-1483 | 18 → **0** | 3 → **8** | 16 → **22** | 96 → **93** | Lost the most. Eighteen A1 findings return; at ~40% divergent in its A1 output that is roughly five more divergences against a denominator up by ~18. |
| IPNO-486 | 10 → **0** | 4 → **7** | 22 → **28** | 97 → **95** | Ten return. It already carries the cohort's largest context-dependent count, so most of the tail should land there rather than as penalty. |
| IPNO-495 | 6 → **0** | 5 → **7** | 15 → **19** | 95 → **94** | Only six return, on the largest denominator in the cohort (73), so the index should barely move. |

## The thirteen new episodes

Checkpoint plans are measured. `procEv` is the count of events that satisfy decision 46
(`ot_note`, or an order with `service_type = Surgery`).

| Episode | Speciality | LOS | Events | procEv | Plan |
|---|---|---|---|---|---|
| IP-1380 | General Surgery | 11 | 585 | 0 | `cp-d1:first_24h` `cp-d10:pre_discharge` `cp-episode` |
| IPNO-617 | Pediatrics | 9 | 205 | 0 | `cp-d1:first_24h` `cp-d8:pre_discharge` `cp-episode` |
| IPNO-363 | Cardiology | 10 | 541 | 2 | `cp-d0:procedure` `cp-d1:first_24h` `cp-d2:procedure_plus_2` `cp-d4:procedure_plus_4` `cp-d9:pre_discharge` `cp-episode` |
| IPNO-471 | Obstetrics & gynaecology | 7 | 359 | 14 | `cp-d1:first_24h` `cp-d3:procedure_plus_2` `cp-d5:procedure` `cp-d6:pre_discharge` `cp-d7:procedure_plus_2` `cp-episode` |
| IPNO-611 | Obstetrics & gynaecology | 4 | 202 | 7 | `cp-d1:first_24h` `cp-d3:pre_discharge` `cp-episode` |
| IP-1535 | Obstetrics & gynaecology | 1 | 20 | 1 | `cp-d0:pre_discharge` `cp-d1:first_24h` `cp-episode` |
| IPNO-741 | Obstetrics & gynaecology | 0 | 22 | 0 | `cp-episode` |
| IP-1362 | Intervention Radiology | 1 | 19 | 0 | `cp-d0:pre_discharge` `cp-d1:first_24h` `cp-episode` |
| IPNO-430 | Laparoscopic & General Surgery | 1 | 40 | 0 | `cp-d0:pre_discharge` `cp-d1:first_24h` `cp-episode` |
| IP-1497 | Orthopedics | 6 | 47 | 1 | `cp-d1:first_24h` `cp-d5:pre_discharge` `cp-episode` |
| IP-1324 | Radiation Oncology | 0 | 31 | 0 | `cp-episode` |
| IPNO-629 | Urology | 6 | 167 | 0 | `cp-d1:first_24h` `cp-d5:pre_discharge` `cp-episode` |
| IP-1469 | Internal Medicine | 4 | 210 | 3 | `cp-d1:first_24h` `cp-d2:procedure` `cp-d3:pre_discharge` `cp-d4:procedure_plus_2` `cp-episode` |

What I expect to dominate the findings, one line each:

- **IP-1380** (Gen Surg, LOS 11, 585 events — the largest in anything run so far): monitoring and
  serial-labs expectations across a long stay compressed into three checkpoints, so most days go
  unexamined; expect a high unassessable count and a thin divergent list.
- **IPNO-617** (Paediatrics, LOS 9): weight-based dosing and growth/feeding monitoring, none of
  which this mirror carries — expect unassessable to dominate heavily.
- **IPNO-363** (Cardiology, LOS 10, 541 events, a real procedure with both follow-ups): serial
  troponin/ECG and antiplatelet continuation; the richest plan in the cohort and the likeliest to
  produce evidenced divergences.
- **IPNO-471** (Obs-gyn, LOS 7, 14 procedure events): post-operative wound and lochia monitoring,
  plus antibiotic duration; two separate procedures, hence two `+2` anchors.
- **IPNO-611** (Obs-gyn, LOS 4, 7 procedure events but **no procedure anchor** — see flag):
  post-delivery monitoring and anti-D/haemoglobin checks.
- **IP-1535**, **IPNO-741** (Obs-gyn, LOS 1 and 0, ~20 events each): near-nothing to audit; expect
  small find counts dominated by unassessable, and these two are the `nothing_evaluable` risk.
- **IP-1362** (Intervention Radiology, LOS 1, 19 events): post-procedure observation and access-site
  checks, almost none of it in the mirror.
- **IPNO-430** (Lap & Gen Surg, LOS 1): day-case cholecystectomy shape — analgesia, early feeding,
  discharge criteria.
- **IP-1497** (Orthopedics, LOS 6, only 47 events on a six-day stay): VTE prophylaxis and
  weight-bearing/physio orders; the sparse record should make most expectations unassessable.
- **IP-1324** (Radiation Oncology, LOS 0): a single-day admission for treatment delivery; expect
  almost nothing chargeable.
- **IPNO-629** (Urology, LOS 6): catheter management and urine culture follow-up.
- **IP-1469** (Internal Medicine, LOS 4, a procedure on day 2): the classic medical admission —
  serial labs, antibiotic de-escalation, and the most likely source of an evidenced omission.

## Cohort claims

1. **Three of the thirteen have a procedure-family anchor**: IPNO-363, IPNO-471, IP-1469. The other
   ten have none — including IPNO-611 with 7 qualifying procedure events and IP-1497 with 1.
2. **None of the sixteen truncates at 80.** `JUDGE_MAX_TOKENS` can carry ~61 findings, below the
   new cap, so `n_findings_truncated` should be 0 everywhere. If any episode truncates, the cap is
   not the binding constraint I claimed it was.
3. **None scores `nothing_evaluable`**, including IPNO-741 and IP-1324 on a single checkpoint each.
4. Two of the three re-runs move by 3 points or less; none moves by more than 5.

## What would falsify this

Any `n_findings_truncated` above 0; a procedure anchor on an episode outside claim 1; a
`nothing_evaluable`; or a re-run index moving more than 5, which would mean the discarded tail was
carrying material penalty rather than the low-consequence remainder the ordering contract promises.
