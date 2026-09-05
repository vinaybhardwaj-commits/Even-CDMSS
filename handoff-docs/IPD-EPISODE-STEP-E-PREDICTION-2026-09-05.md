# Step E — prediction, stated before the twelve were re-read

Engine `ipd-episode-audit/0.1` at the decision 49/50/51/52 build. Written 2026-09-05 before any
Step E run. Plans are a **read-only local dry run** of `checkpointPlanFromEvents` (decision 54):
reads only, no model calls, nothing written.

## What should move, and why

Two changes touch the numbers. **Decision 49** withdraws `d-1`, and I checked which rows carry it:
**eight of the twelve do** — IP-1435, IP-1483, IPNO-416, IPNO-486, IPNO-495, IPNO-531, IPNO-560,
IPNO-645. Each loses exactly one `major` divergent finding worth 8 penalty points, so each should
drop one divergence and gain index. IP-1313, IP-1286, IP-1392 and IPNO-573 do not carry it and lose
nothing. **Decision 52** reshapes the plans: IPNO-495 gains a four-day post-operative run, IP-1483
gains one day, and several short stays are relabelled without changing their cutoffs.

⚠️ **Against Step C's measured variance this is a small signal.** IPNO-486 moved 76→69 findings and
22→16 context-dependent between two runs of identical code. Any per-episode prediction below is
inside that noise band, and I expect the *direction* to hold better than the values.

## Per episode

Baseline is each episode's current stored row (Step C for the three re-run there, round 24 otherwise).

| Episode | Predicted plan | Prior div → pred | Prior ctx → pred | Note |
|---|---|---|---|---|
| IP-1313 | `cp-episode:episode` | 0 → **0** | 12 → 12 | Unchanged plan, no `d-1`. Nothing should move. |
| IP-1286 | `cp-d1:procedure` `cp-episode` | 1 → **1** | 13 → 13 | Day 1 relabelled `procedure` (decision 52); the cutoff is identical, so only the name changes. |
| IPNO-416 | `cp-d0:procedure` `cp-d1:procedure` `cp-d2:pre_discharge` `cp-episode` | 8 → **7** | 12 → 13 | Loses `d-1`. `first_24h` loses day 1 to a procedure label. |
| IP-1483 | `cp-d1:first_24h` `cp-d4:procedure` `cp-d5:procedure_day_1` `cp-d6:pre_discharge` `cp-episode` | 3 → **2** | 16 → 18 | Loses `d-1`, gains one post-operative day (4 → 5 checkpoints). |
| IPNO-495 | `cp-d1:first_24h` `cp-d5:procedure` `cp-d6..d9:procedure_day_1..4` `cp-d10:pre_discharge` `cp-episode` | 3 → **2** | 18 → 22 | The largest reshape: a four-day post-operative run replaces two sampled follow-ups, 6 → 8 checkpoints. |
| IPNO-531 | `cp-d1:first_24h` `cp-episode` | 2 → **1** | 12 → 12 | Loses `d-1`; plan unchanged. |
| IPNO-573 | `cp-d1:first_24h` `cp-d3:procedure` `cp-d4:pre_discharge` `cp-episode` | 5 → **5** | 7 → 8 | No `d-1`. Loses `procedure_plus_2` — the run stops at the pre-discharge day, one day after the procedure. 5 → 4 checkpoints. |
| IPNO-560 | `cp-d1:first_24h` `cp-episode` | 1 → **0** | 19 → 19 | Loses `d-1`, leaving nothing divergent. |
| IP-1392 | `cp-d1:procedure` `cp-episode` | 5 → **5** | 8 → 8 | No `d-1`. Mortuary discharge; day 1 relabelled `procedure`. |
| IPNO-645 | `cp-d0:pre_discharge` `cp-d1:first_24h` `cp-episode` | 3 → **2** | 17 → 17 | Loses `d-1`; plan unchanged. |
| IPNO-486 | `cp-d1:first_24h` `cp-d2:pre_discharge` `cp-episode` | 4 → **3** | 16 → 16 | Loses `d-1`; plan unchanged. |
| IP-1435 | `cp-d1:first_24h` `cp-episode` | 2 → **1** | 24 → 24 | Loses `d-1`; plan unchanged. |

## Cohort claims

1. **Eight episodes lose exactly one divergent finding**, the eight carrying `d-1`. Total divergent
   across the twelve falls from 37 to **29**.
2. **`d-1` appears nowhere** in any stored row after this run.
3. **Only three plans change size**: IPNO-495 6 → 8, IP-1483 4 → 5, IPNO-573 5 → 4. The other nine
   keep their checkpoint count; three of them change a label without changing a cutoff.
4. **IPNO-495 is the only episode with a post-procedure run longer than one day**, and it hits the
   cap exactly: first_24h + procedure + four run days + pre_discharge + episode = 8.
5. **No episode drops below 30 evaluated expectations that was not already below it**, so decision
   51's "insufficient record" marker should appear on the same rows as before.

## What would falsify this

`d-1` surviving anywhere; a plan changing on one of the nine listed as unchanged; a divergent count
falling by more than one on an episode carrying `d-1`, which would mean decision 52's reshape is
also removing findings rather than only relocating the questions.
