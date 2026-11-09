# Preregistration E11: text-state handoff and an E10 repetition (2026-11-08)

Committed before any E11 model run (runner at `a5c07fd`). No model smoke run was made with the new arm. The only pre-run checks were unit tests, typecheck and a scripted no-model dry-run.

## Why

E10 found that twelve cursors with skills finished sooner than one, but a fresh one-cursor finisher made the result reliable at the cost of re-reading the reference and board. E11 tests whether a compact text handoff removes that overhead. It also repeats every E10 arm instead of relying only on comparisons with the earlier round.

## Arms

| Arm | Setup |
|---|---|
| **one** | 1 agent, 1 cursor (the baseline), unchanged from E10 |
| **skills-multi** | 1 agent, 12 cursors, skills, unchanged from E10 |
| **skills-shift** | E10's shift arm: bulk with 12 cursors, then a fresh one-cursor finisher starting from pictures |
| **skills-handoff** | The same bulk phase and fresh one-cursor finisher, but the finisher's initial prompt also contains the reference diagram and current board as text |

The two shift arms have identical bulk prompts and tools. Both finishers inherit the bulk agent's note and skills. The text handoff lists reference labels, positions and directed arrows, plus live board labels, positions, bindings and unbound arrow coordinates. It does not contain the grader's missing-item or wrong-item lists. The text finisher may still call `reference` or `look` if the text is insufficient.

## Conditions and runs

Exactly as in E10:

| Condition | Diagrams | Pause after each action | Limit |
|---|---|---|---|
| **base** | 701, 702, 703 (24 boxes) | 120 ms | 20 min |
| **big** | 801, 802, 803 (48 boxes, 8 × 6) | 120 ms | 30 min |
| **slow** | 701, 702, 703 | 600 ms | 30 min |

- **Model and limits:** `gpt-6-astra` (medium), ≤ 8 actions per cursor per decision; all other grading, token and call limits are unchanged from E10.
- **Runs:** 36 in all (4 arms × 9 diagrams), one at a time, with the arm order shuffled per diagram.
- **Repetition:** the diagrams and settings are deliberately the same as E10. This estimates run-to-run variation on these tasks; it is not a new-diagram generalization test. E10/E11 pooled summaries, if shown, are descriptive rather than preregistered confirmatory tests.
- No run is replaced because of a poor agent result. An infrastructure failure that prevents a valid measurement is reported; any retry is additional and labelled.

## Outcomes and hypotheses

The primary endpoint is time from the start of the bulk phase to 100% (`t100`), with median taken over all nine diagrams. A run that never completes counts as never, ordered after every finite time.

- **H1:** skills-handoff reaches 100% sooner than skills-shift (median over all nine).
- **H2:** skills-handoff completes at least as many diagrams as one.
- **H3:** skills-handoff reaches 100% sooner than one (median over all nine).
- **H4 (E10 repetition):** skills-multi reaches 100% sooner than one (median over all nine).
- **H5 (mechanism):** among runs where the bulk agent called `finish_phase`, skills-handoff has a shorter finisher wall time (`elapsed_ms - shift_ms`) than skills-shift (median).
- **H6:** skills-handoff uses fewer total model tokens than skills-shift (median over all nine).

Reported without a threshold: per-condition results, `t50`, `t90`, score at fixed times, decisions, tool calls, shift rate and time, finisher tokens, and the finisher's `reference`/`look` calls. With three diagrams per condition and nine per arm, these are repeated measurements on a small benchmark, not proof of a universal effect size.

Every result is reported as measured.
