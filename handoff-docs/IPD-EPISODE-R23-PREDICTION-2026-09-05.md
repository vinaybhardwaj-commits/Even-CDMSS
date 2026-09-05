# Round 23 — prediction, stated before the eleven were read

Engine `ipd-episode-audit/0.1` at `d71fd70c`. Written 2026-09-05, after IP-1313 returned and
**before any of the other eleven results were opened**. The eleven were already running when this
was written; their output file was not read. This document exists so the claims can be scored
against the run rather than adjusted to it.

Prior figures are the round-22 cohort run (engine at `f84639c2`). Prior checkpoint counts are
computed, not remembered: the old plan was `min(losDays, 6) + 1` daily checkpoints plus the
episode-level one. Predicted checkpoint counts and anchor kinds are a **measured dry run** of
`checkpointPlanFromEvents` against the real assembled event list for each episode, not an estimate.

## What is being predicted, and why the direction is not obvious

Two changes push in opposite directions on the index, which is
`round(100 − 100 × penalty / (8 × expectations_evaluated))`:

- **Decision 44 removes penalty.** No resolver path can now return a divergent verdict, because
  every `absent_class_present` finding lacks a matched event. All surviving penalty comes from the
  diff and fidelity passes, which cite. This raises every index.
- **Decision 43 changes the denominator, and not always upward.** Long stays gain checkpoints they
  never had (IPNO-495 gains days 7, 8 and 10). Short stays *lose* them: where the pre-discharge
  anchor falls inside the first 24 hours, `first_24h` wins on priority and the two collapse into
  one. IP-1286 and IP-1392 drop from 4 checkpoints to 2, IP-1313 from 2 to 1. A smaller
  denominator makes each surviving divergent finding worth more index points, so a short stay could
  move *down* even while penalty falls.

The second effect is the one I am least confident about, and it is why the short-stay predictions
below are the ones most likely to be wrong.

## Per episode

| Episode | Prior index / band | Prior cps | Predicted index / band | Predicted cps and anchors | Why |
|---|---|---|---|---|---|
| **IP-1313** *(observed)* | 85 moderate | 2 | **97 — no divergence found** *(actual)* | **1** — `cp-episode:episode` | LOS 0. Both dated anchors fall at or past discharge, so only the episode-level checkpoint survives. Ran 01:09:46Z–01:11:26Z. Band uncertain, 28 findings. |
| IP-1286 | 88 minor | 4 | 94 — minor | 2 — `cp-d1:first_24h` `cp-episode:episode` | 9 divergent, penalty 41 over 42 expectations. Decision 44 should clear most of it, but the denominator halves, so the gain is smaller than the penalty drop suggests. |
| IPNO-416 | 89 minor | 5 | 94 — minor | 5 — `cp-d0:procedure` `cp-d1:first_24h` `cp-d2:pre_discharge` `cp-d3:procedure` `cp-episode:episode` | 11 divergent over 66 expectations. Count unchanged but composition changes: day 0 is now anchored to the procedure rather than the admission instant, so it retrieves instead of skipping. |
| IP-1483 | 91 minor | 8 | 95 — no divergence found | 8 — `cp-d0:procedure` `cp-d1:first_24h` `cp-d2:procedure_plus_2` `cp-d3..d5:procedure` `cp-d6:pre_discharge` `cp-episode:episode` | Largest expectation count in the cohort (98). Penalty 67 is mostly resolver-origin. |
| **IPNO-495** | **78 substantial** | 8 | **92 — minor** | 8 — `cp-d1:first_24h` `cp-d3,d5,d6,d7,d8:procedure` `cp-d10:pre_discharge` `cp-episode:episode` | The episode this round was built on. 22 of 29 divergent findings carry no evidence and 141 of 167 penalty points; decision 44 removes them. Days 7–11 held 115 of 414 events and produced nothing before — they now produce expectations, raising the denominator too. |
| IPNO-531 | 94 minor | 4 | 96 — no divergence found | 4 — `cp-d0:procedure` `cp-d1:first_24h` `cp-d2:procedure` `cp-episode:episode` | Only 4 divergent findings and 20 penalty points to begin with; little left to remove. |
| IPNO-573 | 87 moderate | 7 | 93 — minor | 7 — `cp-d0:procedure` `cp-d1:first_24h` `cp-d2,d3:procedure` `cp-d4:pre_discharge` `cp-d5:procedure` `cp-episode:episode` | 15 divergent, 74 penalty over 69 expectations — the second-largest resolver share after IPNO-495. Expect a non-zero `n_contradictions_downgraded` here. |
| IPNO-560 | 95 no divergence | 4 | 96 — no divergence found | 3 — `cp-d1:first_24h` `cp-d2:procedure` `cp-episode:episode` | Already at the top band; the only question is whether losing a checkpoint moves it at all. |
| IP-1392 | 89 minor | 4 | 94 — minor | 2 — `cp-d1:first_24h` `cp-episode:episode` | Same short-stay collapse as IP-1286, and the same caveat about the denominator. |
| IPNO-645 | 88 minor | 3 | 94 — minor | 3 — `cp-d0:pre_discharge` `cp-d1:first_24h` `cp-episode:episode` | LOS 1, so the pre-discharge anchor lands on day 0 and the first-24h anchor on day 1 — the only episode where pre-discharge precedes first_24h. Worth checking the blinding held. |
| IPNO-486 | 86 moderate | 5 | 93 — minor | 5 — `cp-d0:procedure` `cp-d1:first_24h` `cp-d2:pre_discharge` `cp-d3:procedure_plus_2` `cp-episode:episode` | Round 21's episode. 13 divergent, 73 penalty over 65 expectations. |
| IP-1435 | 89 minor | 4 | 94 — minor | 3 — `cp-d0:procedure` `cp-d1:first_24h` `cp-episode:episode` | 15 divergent but only 58 penalty — many are low-severity, so decision 44 removes count faster than it removes points. |

## Cohort-level

- **Six of twelve bands move, all upward, none downward**: IP-1313 moderate → no divergence
  (observed), IP-1483 minor → no divergence, IPNO-495 substantial → minor, IPNO-531 minor → no
  divergence, IPNO-573 moderate → minor, IPNO-486 moderate → minor. The other six hold their band.
- **No episode remains `substantial`, and none remains `moderate`.** After this round the cohort
  should be entirely minor or no-divergence.
- **All resolver-origin penalty goes to zero.** Every remaining penalty point should trace to the
  diff or fidelity pass. If any episode reports resolver-origin divergent findings, decision 44 is
  not doing what the code says it does.
- **`expectations_evaluated` rises on the long stays and falls on the short ones**, following the
  checkpoint counts above.
- **`n_contradictions_downgraded` is non-zero on at least IPNO-495 and IPNO-573.**
- **No episode returns `nothing_evaluable`.** IP-1313 was the most exposed to it, running on a
  single checkpoint, and it did not.

## What would falsify this

An episode that moves *down*, an episode that stays `substantial`, or any episode still reporting a
divergent verdict from the resolver. The first would mean the denominator effect of decision 43 is
larger than the penalty effect of decision 44 — which would be a real finding about short stays,
not a bug to paper over. A cohort that comes back uniformly at 95+ with almost nothing to say would
be the opposite failure, and is the one I am watching for: decision 44 was a deliberate removal of
the engine's ability to assert an unverified absence, and it may have removed too much.
