# Preregistration D1 and E-S (2026-11-02)

Committed before any D1 or E-S model run. Grading never reads the runtime's own reports.

## D1: desktop applications (Blender, KiCad)

**Question.** On real desktop applications whose interface is drawn by the application itself (no accessibility tree), does one fleet decision still replace per-machine agents? The text channel here is OCR of the captured frame.

**Fleet.**
- 16 desktops: 4 servers (DigitalOcean s-8vcpu-32gb-amd, sfo3) × 4 desktops.
- Each desktop is its own container: 2 vCPU, 4 GB, 1600×1000 Xvfb display, openbox, one application, and the desktop agent.
- Images are built from `packages/desktop` at the frozen commit.

**Workloads.**

| Workload | Items per surface | Graded from the saved file |
|---|---|---|
| Blender city (`lab/workloads/blender.ts`) | 4: dimensions, location, colour, save | dimensions, location, colour (3 items) |
| KiCad badges (`lab/workloads/kicad.ts`) | 3: name, role, save | name and role (2 items), plus `kicad-cli` DRC = 0 for success |

- The task table is seeded per block. Every arm sees it in the task text.
- Only the fleet arm receives the table as `inputs`. The per-machine arm reads it from the task text, which is the conventional way to give an agent its data.

**Arms.** Random order within each block.

- **P-V×16** (per-machine Computer Use): one agent per desktop, 16 sessions in parallel (`workset_size 1`, `workset_parallel 16`), screenshots only. This is the fastest per-machine configuration.
- **B-T** (fleet harness): one model session; the runtime uses OCR text, task-table inputs, canary-first broadcast and per-surface verification.

**Design.**
- 2 blocks per workload.
- Model: `gpt-6-astra`, medium effort.
- Budget per arm: 3 h deadline, 20 min per session, 14M tokens.

**Hypotheses.**
- **H-D1, cost:** B-T total tokens ≤ 20% of P-V×16, in each workload.
- **H-D2, correctness:** B-T correct items ≥ P-V×16 correct items − 2% of total items, summed per workload. Zero duplicate commits in both arms.
- **H-D3, time (secondary, no threshold):** report total wall time for each arm, and time to the last delivery.

Each failure is reported as observed, and no rerun may overturn a result. Interruptions with no input are rerun under the same seed and recorded.

## E-S: equal model-session budget (web form, 100 desktops)

**Question.** E1-P showed that wall time is a tie against 13 parallel per-machine agents. How does the comparison change when both sides get the same number of concurrent model sessions?

**Design.**
- Same workload, fleet and seeds as E1 and E1-P (100 server desktops × 3 items, `seed 3010`, 3 blocks).
- Arms: **P-V×4** (4 parallel per-machine sessions) and **B-T**.
- Together with E1 (P-V×1, sequential) and E1-P (P-V×13), this gives wall time as a function of the per-machine arm's concurrent sessions, against the fleet arm's single session.

**Reported.**
- Per block: wall time, tokens and correct items.
- The ratio B-T / P-V×k for k ∈ {1, 4, 13}, with each ratio taken from its own experiment's paired B-T runs.
- No threshold; the curve is reported as measured.
