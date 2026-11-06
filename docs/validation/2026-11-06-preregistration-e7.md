# Preregistration E7: one agent, many cursors, real software (2026-11-06)

Committed before any E7 run with a model. Scripted runs (no model) that validated the setup are listed at the end and are not results.

## Question

Does giving one Computer Use agent many cursors on the same page make it better at a large task in real software? "Better" here means it finishes more of the task within a time limit, sooner, at a comparable cost and quality. The canvas runs (2026-11-06) showed the gain depends on how long actions take compared with decisions. E7 tests it where a real application, real perception and a standard look–act loop all apply.

## Task

Recreate a reference diagram in the real Excalidraw editor (0.18.1, MIT; `lab/board`).
- **The board:** every cursor is its own browser session on one shared board (a thin sync layer, `lab/board/server.ts`). Every session sees the others' cursors as Excalidraw collaborator pointers.
- **The reference:** an image of 24 labelled boxes and 25–29 arrows, rendered by the same editor (`lab/board/diagram.ts`, seeds 701, 702, 703). Agents get it only as an image (`reference` tool) and must read it.
- **The work:** draw each box, type its label, and drag each arrow so both ends attach, using real mouse and keyboard input (click, double-click, drag, type, keys).
- **Grading:** reads the board's elements. Score = (boxes with the exact label, exactly once + arrows bound to the right two boxes in the right direction) / (boxes + arrows); complete = everything right, nothing extra.

## Arms (same model, prompt and tools; only cursors and actions per decision differ)

| Arm | Agents | Cursors | Actions per decision |
|---|---:|---:|---|
| **one** | 1 | 1 | ≤ 8 |
| **one-wide** | 1 | 1 | ≤ 96 (the same action budget per decision as multi) |
| **multi** | 1 | 12 | ≤ 8 per cursor, run in parallel |
| **swarm** | 12 | 1 each | ≤ 8; each owns 2 boxes and their outgoing arrows |

Common settings:
- **Model:** `gpt-6-astra`, medium effort.
- **Limits:** 20 min per run.
- **Pacing:** 120 ms between one cursor's actions; a 400 ms settle before each screenshot.
- **Status line:** after each decision the tool reports how many boxes and arrows currently match. Every arm sees the same line.
- **Runs:** one run per arm per diagram, 12 runs in all. They run one at a time on this Mac, arms in random order per diagram.

## Measures

- Score at 5, 10 and 20 min; time to 50%, 90% and 100%; final score; complete or not.
- Tokens, decisions, wall time.
- Films and exact replays from the board logs.

## Hypotheses

- **H1 (speed):** multi reaches 90% at least 2× sooner than one (median over the three diagrams).
- **H2 (more done in time):** at 5 min, multi's score exceeds one's on all three diagrams.
- **H3 (cost against one):** multi's tokens ≤ 1.5× one's (median).
- **H4 (cost against many agents):** multi's tokens ≤ 0.5× swarm's (median).
- **H5 (quality):** multi's final score ≥ one's − 0.05 on every diagram.
- **H6 (it is the cursors, not the action budget):** multi reaches 90% sooner than one-wide (median).

## Known effects, stated in advance

- **Concurrent binding edits:** when two sessions attach arrows to the same box at the same moment, the editor's merge can drop one binding. A scripted 12-cursor run lost 3 of 29 bindings this way; the 1-cursor run lost none. Agents see this in the status line and on the board, and can redraw. It is a real cost of concurrency, kept in.
- **Style panel:** a selected shape opens a style panel over the left 220 px; the reference sits to its right. The prompt says how to clear it.

## Scripted validation (no model; not results)

| Run | Score | Time |
|---|---|---|
| 1 cursor, known-good plan | 100% (24/24 boxes, 29/29 arrows) | 65 s |
| 12 cursors, same plan split | 94% (24/24 boxes, 26/29 arrows) | 8 s |

Every result is reported as measured.
