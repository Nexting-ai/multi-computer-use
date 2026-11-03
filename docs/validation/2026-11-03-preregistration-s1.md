# Preregistration S1: building a city block (2026-11-03)

Committed before any S1 model run. This experiment replaces the D1 design (docs/validation/2026-11-02-preregistration-d1-es.md), which compared fleets on pristine identical desktops: there, a recorded macro could do the same at almost no cost, so D1 could not show what the harness adds. E-S is dropped, because its curve follows from E1 and E1-P.

## Question

An agent builds something large and visual with Computer Use: a city block of sixteen different buildings in Blender. Does directing sixteen desktops through the harness finish faster and cheaper, at equal or better quality, than one agent on one desktop, or than sixteen independent agents?

## Task

- 16 building briefs (`lab/workloads/studio.ts`, seed 9101). Each brief gives a style, a target height and features, for example "pagoda, 30 m, five tiers with upturned red eaves…".
- Each building stands on a 20 × 20 m plot.
- The agents may use the Blender interface and Blender's own Python (text editor or console) through the screen. No other applications, add-ons or downloads.
- Each building is one item. The agent declares an item done once the building is finished and saved.

## Arms

| Arm | Agents and desktops | Tools |
|---|---|---|
| **A**, one agent | 1 session, 1 desktop, `city.blend` with all 16 plots | per-desktop screenshots and input (`P-V`) |
| **B**, sixteen agents | 16 sessions in parallel, one desktop each, `studio.blend` | per-desktop screenshots and input (`P-V`, `workset_parallel 16`) |
| **C**, the harness | 1 director session, 16 desktops | fleet policies with `type` steps (one script, per-desktop inputs), `fleet_overview` (one image of all desktops), per-desktop tools for what differs (arm `F`) |

Common settings:
- Desktops: 2 vCPU, 4 GB, 1600 × 1000, spread over 4 servers.
- Model: `gpt-6-astra`, medium effort.
- Per arm: 3 h deadline, 30M tokens, 1 h per session.

## Measures

- **Time:** from the first session start to the last item declared, plus total wall time.
- **Cost:** tokens, model calls, images sent to the model.
- **Objective grade**, from each saved file (`grade_module.py`): built, inside the plot, height within 25% of the brief.
- **Quality, blind** (`lab/workloads/judge.ts`):
  - Every building is rendered with the same camera, light and engine.
  - Per plot, the three arms' photos are shuffled under random letters.
  - Claude Sonnet 5.5 scores each photo 1–10 on brief, craft, materials and soundness. The judge sees no arm names.
- **Film:** the same assembly and 10 s orbit for each arm (`assemble.py`, `film.ts`). This is presentation only.

## Hypotheses (one block; directional, reported as measured)

- **H1:** C finishes faster than A.
- **H2:** C uses fewer tokens than B.
- **H3:** C's mean blind overall score ≥ A's, and ≥ B's − 0.5.
- **H4:** C's objective grade ≥ the other arms' objective grades.

Every result is reported as observed. A run interrupted by infrastructure before any input is rerun with the same seed and recorded.
