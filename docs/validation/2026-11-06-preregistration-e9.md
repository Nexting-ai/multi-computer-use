# Preregistration E9: many cursors and skills, on clear references (2026-11-06)

Committed before any E9 run (runner and references at `3289257`). E9 repeats E7/E8 on the corrected reference pictures, so that accuracy can be compared too.

- **Task, grading, model, limits:** as in E7/E8.
  - Real Excalidraw; diagrams 701, 702, 703 with the new edge-to-edge arrows.
  - `gpt-6-astra` (medium), 20 min per run.
  - ≤ 8 actions per cursor per decision; a skill call counts as one.
- **Arms:** one (1 cursor); multi (12 cursors); skills (1 cursor + skills); skills-multi (12 cursors + skills).
- **Runs:** 12 in all, one at a time, with the arm order shuffled per diagram.

## Hypotheses

- **H1:** skills reaches 90% sooner than one (median).
- **H2:** skills' final score ≥ one's − 0.05 on every diagram.
- **H3:** skills-multi reaches 90% sooner than skills (median).
- **H4:** skills-multi's final score ≥ skills' − 0.05 on every diagram.
- **H5:** multi reaches 90% sooner than one (median). E7 found the opposite; repeated here on clear pictures.
- **Reported without a threshold:** tokens, decisions, and the split between thinking and execution.

Every result is reported as measured.
