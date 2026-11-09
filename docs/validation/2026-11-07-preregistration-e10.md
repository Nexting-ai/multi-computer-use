# Preregistration E10: shifting down to finish, bigger diagrams, slower software (2026-11-07)

Committed before any E10 run (runner at `389bf59`).

## Why

In E9, twelve cursors reached 90% about 1.6× sooner than one but did not finish sooner. The last fixes were slow, because every review decision about all twelve cursors makes the model think longer. E10 tests three things:
1. **Shifting down for the finish.**
2. **Bigger tasks**, where the bulk weighs more than the finish.
3. **A slower application**, where executing each action takes longer.

## Arms

| Arm | Setup |
|---|---|
| **one** | 1 agent, 1 cursor (the baseline) |
| **skills-multi** | 1 agent, 12 cursors, skills (as in E9) |
| **skills-shift** | as skills-multi, plus a `finish_phase` tool. The agent calls it when the bulk is done; the harness then ends that session and starts a fresh one-cursor session, with the skills and the agent's note, to check and finish. |

## Conditions (3 diagrams each)

| Condition | Diagrams | Pause after each action |
|---|---|---|
| **base** | 701, 702, 703 (24 boxes) | 120 ms |
| **big** | 801, 802, 803 (48 boxes, 8 × 6) | 120 ms |
| **slow** | 701, 702, 703 | 600 ms (an application that responds slowly) |

Common settings:
- **Unchanged from E9:** grading, model (`gpt-6-astra`, medium), ≤ 8 actions per cursor per decision, and the reference style (edge-to-edge arrows).
- **Limits:** 20 min per run (30 min in big and slow).
- **Runs:** 27 in all, one at a time, with the arm order shuffled per diagram.

## Hypotheses

- **H1:** skills-shift reaches 100% sooner than skills-multi (median over all 9 diagrams; a run that never completes counts as never).
- **H2:** skills-shift reaches 100% sooner than one (median over all 9).
- **H3 (big):** skills-multi reaches 90% at least 2× sooner than one (median over 801–803).
- **H4 (slow):** skills-multi reaches 90% at least 2.5× sooner than one (median over the slow runs).
- **H5:** skills-shift completes at least as many diagrams as one.
- **Reported without a threshold:** tokens, decisions, and when the shift happened.

Every result is reported as measured.
