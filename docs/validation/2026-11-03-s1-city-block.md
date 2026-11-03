# S1: building a city block — results (2026-11-03)

Preregistration: [2026-11-03-preregistration-s1.md](2026-11-03-preregistration-s1.md), including deviations 1–5. The four failed attempts (infrastructure, caps, a common busy-application note) are kept in `.local/s1/*-fail*` and excluded. Final runs: commit `bf8f991`, seed 9101 (block seed 1593497587), model `gpt-6-astra` medium, one block. Data: [`data/2026-11-03-s1-summary.json`](data/2026-11-03-s1-summary.json), [`data/2026-11-03-s1-judge.json`](data/2026-11-03-s1-judge.json).

## Results

| | A: one agent, one desktop | B: sixteen agents, sixteen desktops | C: one director, sixteen desktops |
|---|---:|---:|---:|
| Wall time | 5.6 min | 54.5 min (15 of 16 done by ~18 min) | 6.8 min |
| Tokens | 0.29M | 4.32M | 0.40M |
| Tool calls | 26 | 163 | 8 |
| Items declared done | 16 | 16 | 0 |
| Objective checks (built, on plot, height) | 47 / 48 | 48 / 48 | 48 / 48 |
| Blind quality, overall (1–10) | 4.67 | **8.13** | 4.88 |
| brief / craft / materials / soundness | 4.9 / 3.8 / 3.6 / 6.4 | 8.3 / 8.3 / 7.4 / 8.6 | 4.8 / 4.3 / 4.1 / 6.4 |

## Hypotheses

- **H1 (C faster than A): not supported.** C took 6.8 min, A 5.6 min.
- **H2 (C fewer tokens than B): supported.** C used 0.40M tokens, B 4.32M (10.8× fewer).
- **H3 (C quality ≥ A, and ≥ B − 0.5): supported against A** (4.88 vs 4.67, a small margin); **not supported against B** (4.88 vs 8.13).
- **H4 (C objective grade ≥ the others): supported** (48/48).

## What happened

- **Generation, with scripting allowed, is cheap.** Both A and C wrote one generic script that builds all sixteen buildings from the briefs. The machine work took minutes, so sixteen desktops bought C no time over A.
- **Quality comes from attention per building.** B gave each building its own agent. Each agent looked at its renders and fixed what it saw, and B scored 8.1 on 15 of 16 plots. The single scripts behind A and C produced simpler buildings (about 4.7–4.9).
- **C did not use its main tool.** C rendered all sixteen previews in parallel and reviewed them in one overview image. It judged several buildings incomplete against their briefs, and then ended its turn without refining any of them or declaring any done. The parallel look-and-fix loop, which is the reason for sixteen desktops, never ran.
- **A single desktop can block.** In B, the pagoda's agent wrote a script that kept Blender busy for about 40 minutes. This one surface took B's wall time from 18 to 54 minutes. Earlier attempts saw the same thing on A, which led to the busy-application note (deviation 5).

## Conclusion

In this setting, the harness did not show the advantage it was designed for:

- C matched A on time and quality, and cost about a tenth of B.
- But B's per-building attention produced much better buildings.
- The design question is now how to give each building that attention at C's cost: a shared base built once, then per-building refinement running in parallel and reviewed together. That design is not tested here.
