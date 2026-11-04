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

## Deviations (recorded before the reruns)

1. First attempts of A and C (2026-11-03 08:44 / 08:49 UTC, commits c80fcb5 / 723b7bd) were lost to infrastructure: the SSH tunnels to the desktops dropped mid-run, captures failed, and the agents stopped. A had in fact built all sixteen plots, but could not observe or save them. C's director lost all sixteen desktops; the hand-off then started 48 per-surface sessions that could not reach the desktops either. Fixes:
   - tunnels re-establish themselves (tested by killing them mid-run: 4/4 completed);
   - reads retry while a tunnel reconnects (input is never retried);
   - arm C has no hand-off to per-surface agents, as specified above (the director owns its fleet).
   Both arms are rerun with the same seed; the failed attempts are kept in `.local/s1/*-fail1`.
2. Arm A's single desktop gets a whole server (8 vCPU, 16 GB) instead of 2 vCPU. One agent works on one computer, and building sixteen buildings in one scene with software rendering was too slow on 2 vCPU. B and C keep 2 vCPU per desktop.
3. Second attempts (09:12 UTC) were cut by per-session caps I had left at the runner's defaults (1M tokens, 96 calls per session), below the preregistered per-arm budget. C's director was stopped at 1.03M tokens with all sixteen buildings built (objective 48/48) but before review, save and declaration; A's single session was cut the same way; B was stopped mid-run so that all arms run under the same caps. Per-session caps are set equal to the arm budget (30M tokens, 1500 calls), and all three arms are rerun with the same seed (attempts kept in `.local/s1/*-fail2`).
4. Third attempts (09:34 UTC) ran into a degraded local path to the servers: the SOCKS proxy that carried the SSH tunnels failed intermittently (TLS handshakes through it failed two times in three), and two of the five servers became unreachable. C's captures timed out on many desktops. A, whose server was one of the unreachable two, reported Blender "unresponsive" while its screen could not be captured. These attempts are kept in `.local/s1/*-fail3`. All arms are rerun on five servers that the operator machine reaches directly, without the proxy; the experiment processes reach the model through the operator's local Codex route.
5. Fourth attempts (10:23 UTC, direct network path) showed a real behaviour: A's agent ran one large script for all sixteen plots, Blender stayed busy with a frozen screen, and after about three minutes the agent declared it unresponsive. To compare the arms on the work rather than on patience, all three arms are restarted (C had run for six minutes) with two additions common to every arm: the task text says that a long script can keep Blender busy for minutes and to wait before concluding it is unresponsive, and the per-desktop tools gain `desktop_wait` (up to 600 s without a screenshot). Attempts kept in `.local/s1/*-fail4`.
