# Preregistration E8: skills, one action for a repeated sequence (2026-11-06)

Committed before any E8 run with a model (runner at `48db819`).

## Why

E7 found that the bottleneck in Computer Use on a responsive application is the model writing each action, not the hands carrying them out. More cursors did not help: the model still had to write every action.

E8 tests whether cutting the number of actions the model writes makes the same agent faster and cheaper, through the same UI and with the same perception.

**Skills** are a general harness capability, not specific to Excalidraw:
- The agent defines a named, parameterised sequence of its UI actions (keys, clicks, drags, typing; coordinates may be arithmetic on parameters).
- It then calls the skill as one action. The harness expands it into real mouse and keyboard input.
- Nothing is pre-defined: the agent decides what to turn into a skill, and checks it on the board.

## Task, grading, model, limits

As in E7 (`lab/board`):
- The task and grading are unchanged: recreate the reference diagrams 701, 702 and 703 in the real Excalidraw editor, graded from the board's elements.
- **Model:** `gpt-6-astra`, medium effort.
- **Limits:** 20 min per run; up to 8 actions per cursor per decision (a skill call counts as one); 120 ms between actions.

## Arms

| Arm | Cursors | Skills |
|---|---:|---|
| **one** | 1 | no (E7's baseline, run again today) |
| **skills** | 1 | yes |
| **skills-multi** | 12 | yes |

There are 9 runs, one at a time, with the arm order shuffled per diagram.

## Hypotheses

- **H1:** skills reaches 90% at least 1.5× sooner than one (median over the three diagrams).
- **H2:** skills' tokens ≤ 0.7× one's (median).
- **H3:** skills' final score ≥ one's − 0.05 on every diagram.
- **H4:** skills-multi reaches 90% sooner than skills (median).
- **H5:** skills-multi's final score ≥ skills' − 0.05 on every diagram.

## Scripted validation (no model; not results)

| Run | Score | Decisions |
|---|---|---|
| 1 cursor with two skills (box, arrow) | 100% | 7 (26 without skills) |
| 12 cursors with the same skills | 98% (1 binding lost to concurrent edits) | 2 |

Every result is reported as measured.
