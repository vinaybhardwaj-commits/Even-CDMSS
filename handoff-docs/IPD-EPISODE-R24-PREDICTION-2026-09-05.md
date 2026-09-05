# Round 24 — prediction, stated before the twelve were read

Engine `ipd-episode-audit/0.1` at `8e234cdd` (decisions 45 and 46, band off the worklist). Written
2026-09-05 before any episode was re-run. Prior figures are the round-23 cohort run at `d71fd70c`
/ `2b6bc47a`.

Checkpoint plans below are a **read-only local dry run** of `checkpointPlanFromEvents` over each
episode's real assembled event list, as permitted for this file. It read `DATABASE_URL` to fetch
extractions and db13 rows and **wrote nothing** — no audit row, no model call, no mutation of any
kind. Everything else in this file is a claim, not a measurement.

## The two mechanisms, which pull in opposite directions

**Decision 45 raises indices.** The index divides penalty by `8 × expectations_evaluated`, and
`expectations_evaluated` counts *emitted findings whose verdict is not unassessable*. Putting
`resolution` back in the key splits groups, so the same expectations emit MORE findings. Penalty
comes only from divergent findings, which the resolver can no longer produce at all — so splitting
enlarges the denominator while leaving the numerator alone.

**Decision 46 lowers them.** Removing 13 of 20 procedure anchors shrinks eight of the twelve plans,
and fewer checkpoints means fewer expectations and a smaller denominator. The diff and fidelity
passes, which are where all remaining penalty comes from, do NOT shrink with the checkpoint count —
they read the whole real course either way. Less denominator, same numerator, lower index.

Episodes whose plan is unchanged feel only the first effect. Episodes that lose half their
checkpoints feel both, and I expect the second to win there.

## Per episode

Prior columns: checkpoints, resolver findings ("pass contribution: resolver N"), index.
`div` = divergent, `ctx` = context-dependent.

| Episode | Prior cps → predicted cps and anchors | Prior resolver → pred | Pred div | Pred ctx | Prior idx → pred | Why |
|---|---|---|---|---|---|---|
| IP-1313 | 1 → **1** `cp-episode:episode` | 12 → 14 | 1 | 3 | 97 → **97** | Plan unchanged, largest group was 2, so decision 45 has almost nothing to split. |
| IP-1286 | 2 → **2** `cp-d1:first_24h` `cp-episode` | 19 → 23 | 2 | 5 | 98 → **98** | Plan unchanged; a few groups split, denominator grows slightly, already at the ceiling. |
| IPNO-416 | 5 → **4** `cp-d0:procedure` `cp-d1:first_24h` `cp-d2:pre_discharge` `cp-episode` | 20 → 21 | 5 | 4 | 90 → **90** | Loses one anchor of five and keeps a real procedure. The two effects roughly cancel. |
| IP-1483 | 8 → **4** `cp-d1:first_24h` `cp-d4:procedure` `cp-d6:pre_discharge` `cp-episode` | 41 → 27 | 4 | 10 | 94 → **91** | Halves. Five of its six procedure anchors were billing lines. Biggest denominator loss in the cohort. |
| IPNO-495 | 8 → **6** `cp-d1:first_24h` `cp-d5:procedure` `cp-d7:procedure_plus_2` `cp-d9:procedure_plus_4` `cp-d10:pre_discharge` `cp-episode` | 38 → 38 | 5 | 10 | 97 → **94** | Loses three spurious procedure days and **gains the cohort's only `procedure_plus_4`** — the window decision 43 was written to add and decision 46 finally made room for. |
| IPNO-531 | 4 → **2** `cp-d1:first_24h` `cp-episode` | 22 → 14 | 3 | 3 | 95 → **92** | All three procedure anchors were billing lines; nothing procedural survives. |
| IPNO-573 | 7 → **5** `cp-d1:first_24h` `cp-d3:procedure` `cp-d4:pre_discharge` `cp-d5:procedure_plus_2` `cp-episode` | 38 → 35 | 4 | 8 | 97 → **94** | Keeps one real procedure and gains its +2 follow-up; loses two spurious days. |
| IPNO-560 | 3 → **2** `cp-d1:first_24h` `cp-episode` | 23 → 20 | 3 | 4 | 96 → **94** | Its one procedure anchor was a billing line. |
| IP-1392 | 2 → **2** `cp-d1:first_24h` `cp-episode` | 21 → 26 | 3 | 7 | 93 → **95** | Plan unchanged, so only decision 45 applies: more findings, same penalty, higher rate. |
| IPNO-645 | 3 → **3** `cp-d0:pre_discharge` `cp-d1:first_24h` `cp-episode` | 15 → 20 | 4 | 7 | 88 → **91** | Plan unchanged and it had a `group_size` 6 to split — the cohort's lowest index and the one episode that did not move at all last round. |
| IPNO-486 | 5 → **3** `cp-d1:first_24h` `cp-d2:pre_discharge` `cp-episode` | 29 → 23 | 2 | 10 | 98 → **95** | Both procedure anchors were billing lines; it had 10 `absent_class_present`, the cohort's most, so its context-dependent count should stay high. |
| IP-1435 | 3 → **2** `cp-d1:first_24h` `cp-episode` | 25 → 22 | 3 | 6 | 96 → **94** | Its one procedure anchor was a billing line. |

## Cohort claims

1. **Eight of twelve plans change.** Unchanged: IP-1313, IP-1286, IP-1392, IPNO-645.
2. **Seven procedure-family anchors remain, down from twenty** — IPNO-416 ×1, IP-1483 ×1,
   IPNO-495 ×3 (`procedure`, `+2`, `+4`), IPNO-573 ×2 (`procedure`, `+2`). The other eight episodes
   have none.
3. **A `procedure_plus_4` checkpoint exists for the first time**, on IPNO-495 day 9.
4. **No index moves by more than 5.** Largest predicted move is 3 (IP-1483, IPNO-495, IPNO-531,
   IPNO-573, IPNO-486). This is the claim most likely to fail, and the direction of a failure tells
   us which mechanism dominates: a large FALL means the diff pass's penalty is fixed while the
   denominator shrinks with the plan; a large RISE means decision 45's splitting matters more than
   the lost checkpoints.
5. **Every index stays at or above 88** and no episode returns to `moderate` or worse.
6. **Total divergent findings across the cohort fall**, from 39 to roughly 34, because eight
   episodes now generate fewer expectations for the diff pass to measure against.
7. **No episode returns `nothing_evaluable`**, including the four now running on two checkpoints.

## What would falsify this

An index moving more than 5 points; a procedure anchor surviving on any episode not in claim 2; a
plan changing on one of the four listed as unchanged; or a resolver finding count that FALLS on an
episode whose plan did not change, which would mean decision 45 is not splitting what it should.
