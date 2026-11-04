# Preregistration S4: a rainforest airport — try several ideas at once (2026-11-04)

Committed before any S4 run. Smoke runs on 2–4 pieces (seed 9400, not the S4 seed) are reported below and are not part of the results.

S1–S3 showed two things:
- When every piece needs its own decisions, quality comes from an agent's attention per piece.
- When the pieces are variations of one design, one agent could also loop a single script over all of them.

S4 uses a task that cannot be looped: sixteen different pieces. It asks whether more machines per agent buy better work, not just cheaper work. An agent with three desktops tries three ideas in one decision, compares them in one image and keeps the best.

## Task

A rainforest airport made of sixteen different pieces (`lab/workloads/studio.ts`, `AIRPORT`, seed 9401): an airliner, a control tower, a giant kapok tree, a waterfall cliff, a moored airship, a toucan statue, a temple ruin, and so on.

- Each piece stands on a 20 × 20 m plot.
- Every arm reads the same task text. It says that the pieces form one scene, and it asks the agent to keep improving each piece until it fully meets the brief and looks finished.
- Agents may use the Blender interface and Blender's Python, as in S1–S3.

## Arms

| Arm | Setup |
|---|---|
| **A**, one agent | 1 desktop holding all 16 plots (`city.blend`), 8 vCPU (`P-V`) |
| **B**, one agent per piece | 16 agents in parallel, one desktop each (`P-V`, `workset_parallel 16`) |
| **X**, the harness | 16 agents in parallel, one per piece, each with **3 desktops** (`variants 3`, 48 desktops) |

How arm X works, in passes:
1. In one `fleet_run`, the agent sends each of its desktops its own complete build script (`assign`).
2. It renders all three previews in one `fleet_run`.
3. It compares them in one `fleet_overview`.
4. It keeps the best design and sends three improved variations of it in the next pass.

At the end, the agent declares the one desktop that holds its final piece. That desktop is graded and judged.

Common settings:
- **Model:** `gpt-6-astra`, medium effort.
- **Session limits:**
  - per piece (B, X): 40 min per session, continued at most twice if the piece is not yet declared;
  - A: one 3 h session;
  - every arm: 60M tokens.
- **Desktops:** 2 vCPU and 4 GB (A: 8 vCPU, 16 GB), on directly reachable servers.
- **Order:** X runs first on 12 servers, then B and A.

## Runtime changes made for S4, before any S4 run

All are general and available to every arm that uses the tools.
- **`assign`:** per-surface values for a policy's inputs, written by the model.
- **Optional post-conditions in free tasks:** the result is reported as delivered and checked by looking.
- **Key names:** case-insensitive, with common aliases.
- **Safe input retry:** `/execute` can be retried after a dropped connection, because the desktop agent runs each `operation_id` at most once.
- **Desktop identity on every request:** this fixes a smoke-test fault in which two concurrent runs shared local tunnel ports.
- **Director sessions continue like worksets:** an unfinished session is continued at most twice.
- **Shared task text:** a note that Escape closes Blender's render window, and the "keep improving" sentence.

## Measures

- **Wall time, tokens, tool calls.**
- **Objective checks per piece:** built, on its plot, height within 25% of the brief.
- **Blind per-piece judging:** the S3 method, on equal-size standard photos, with Claude Sonnet.
- **Blind whole-scene judging:** the same four frames of each arm's film are scored blind for coherence, craft, richness and overall. The surroundings are identical in every arm.
- **A film per arm.**

## Hypotheses

- **H11 (quality):** X's per-piece overall ≥ B's + 0.5.
- **H12 (scene):** X's whole-scene overall > B's.
- **H13 (time):** X's wall time ≤ 1.25 × B's.
- **H14 (against one agent):** X's per-piece overall ≥ A's + 1.5.
- **Reported without a threshold:** tokens. X is expected to use more than B, because each pass writes three scripts.

## Smoke runs before this preregistration (seed 9400, not results)

- **R, one director in rounds over all desktops:** on 4 pieces, 1.23M tokens against B's 2.26M, but blind per-piece quality was 5.2 against B's 7.9. One director's attention spread over many pieces was too thin, so R was not run.
- **X with 4 desktops per piece, on 2 pieces:** quality 8.75 against B's 7.38 and R's 4.75, but 4.04M tokens and 32 min, against about 1.1M and 18 min for B.
- **That X smoke was not like-for-like.** Only X's prompt asked it to keep improving, so the sentence is now in the shared task text for every arm.
- **Invalid early smokes, discarded:** two concurrent smokes shared local tunnel ports, so some B agents worked on R's desktops. This led to the desktop-identity check above.

Every result is reported as measured.
