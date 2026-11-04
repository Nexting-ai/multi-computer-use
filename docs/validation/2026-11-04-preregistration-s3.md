# Preregistration S3: one design, many variations (2026-11-04)

Committed before any S3 run. S1 and S2 showed that buildings which all differ need one agent's attention each, so the harness saved no tokens there. S3 tests the harness's intended case: polish one design once, then apply it to many variations.

## Task

- A street of 32 houses of one design, a Scandinavian timber house: steep gable roof with deep eaves, vertical board cladding, white window frames, a door under a canopy, a chimney and a stone plinth.
- Each house differs only in its row's parameters: width, floors, cladding colour, door colour, roof material and balcony (`lab/workloads/studio.ts`, `street()`, seed 9301).
- Each house stands on a 20 × 20 m plot. Agents may use the Blender interface and Blender's Python, as in S1.

## Arms

| Arm | Setup |
|---|---|
| **B**, per-house agents | 32 agents in parallel, one desktop each (`P-V`, `workset_parallel 32`) |
| **A**, one agent | 1 desktop with all 32 plots (`street.blend`), 8 vCPU |
| **M**, the harness | 1 director, 32 desktops (2 vCPU each). Polishes the design on W01 with per-desktop tools, broadcasts it with one `type` fleet policy (inputs = the row's parameters), renders previews everywhere, reviews them with `fleet_overview`, fixes by broadcast or per desktop, then declares. |

Common settings:
- Model: `gpt-6-astra`, medium effort.
- Per arm: 3 h deadline, 30M tokens, 1 h per session.
- Desktops spread over 8 directly reachable servers; A on its own server.

## Measures

The same as S1:
- wall time;
- tokens and tool calls;
- objective checks: built, on plot, height within 25% of floors × 3 + 5 m;
- blind comparative judging per plot with Claude Sonnet 5.5;
- a film per arm.

## Hypotheses

- **H8:** M's blind overall score ≥ B's − 1.0.
- **H9:** M's tokens ≤ 20% of B's.
- **H10:** M's wall time ≤ B's.
- **Reported without a threshold:** A against M (a single agent can also loop one script over 32 plots).

Every result is reported as measured.
