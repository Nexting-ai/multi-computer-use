# Preregistration S2: director with parallel refiners (2026-11-03)

Committed before any S2 run. Follows from S1 ([results](2026-11-03-s1-city-block.md)): sixteen independent agents (B) reached much higher quality than one generic script (A, C), at 10.8× C's tokens. S2 tests whether a director plus parallel refiners keeps most of B's quality at a fraction of its cost.

## Arm H (new)

1. **Base.** One director session builds a base version of every building with one shared script (fleet `type` step with per-desktop inputs), renders previews everywhere, reviews them in one overview image, and writes one concrete refinement note per desktop (`refine_plan`).
2. **Refine.** One refiner agent per planned desktop works in parallel. It gets its brief, the director's note and the existing base, and its budget is capped: 400k tokens, 24 tool calls, 20 min. Refiners cannot declare.
3. **Review.** A new director session reviews all desktops in one overview image and declares the finished ones. It may plan one more refine round.

At most two refine rounds; the final review declares.

## Comparison

- Same task, seed (9101) and fleet shape as S1: 16 desktops, 2 vCPU each, on 4 directly reachable servers. The model is `gpt-6-astra` medium.
- H is compared with S1's A, B and C runs (commit `bf8f991`).
- The blind judge is rerun over all four arms together, so that every plot's photos are scored in one comparison.

## Hypotheses

- **H5:** H's blind overall score ≥ B's − 1.0.
- **H6:** H's tokens ≤ 50% of B's.
- **H7:** H's wall time ≤ B's.
- **Secondary:** H's quality > C's; objective checks 48/48.

All results are reported as measured. Infrastructure failures before any input are rerun with the same seed and recorded.
