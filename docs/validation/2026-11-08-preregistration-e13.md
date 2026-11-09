# Preregistration E13: sequential single-desktop operation versus one director over four Odoo desktops (2026-11-08)

The machine-readable preregistration was created locally at **2026-11-09T02:46:20Z**, before any E13 model run. This public version preserves the design and evidence boundaries used at that time.

## Arms

- **P-V, conventional per-desktop visual Computer Use:** four independent same-model sessions, one desktop per session, strictly sequential with `workset_size=1` and `workset_parallel=1`. No accessibility text is supplied to the model. This is not described as one continuous agent session or as one cursor.
- **F, fleet director:** one director controls four Odoo desktops with fleet policies, fleet overview, and per-desktop visual tools. No per-desktop helper agents are dispatched. The existing runner may continue an unfinished director in a new session, preserving desktop state and counting all time and tokens.

Both arms use `gpt-6-astra` (medium), four companies, a 6M total token budget, 600 calls, and a one-hour deadline per arm. Provisioning, browser setup, and grading are excluded from measured operation time by the existing runner.

## Paired blocks

| Block | Scenario seed | Order       | Shared environment snapshot |
| ----- | ------------: | ----------- | --------------------------- |
| 1     |         13013 | P-V, then F | `b1-env.json`               |
| 2     |         23023 | F, then P-V | `b2-env.json`               |

Each block uses a new seed not used by E12. Both arms in a pair reset the same seeded environment before running. E13 uses a separate local Colima profile so the stopped E12 profile, containers, and databases are not reprovisioned or deleted.

## Task and grading

Real Odoo 17, English, isolated local Docker, with only real GUI input available to the agent. Database access is reserved for setup and independent grading. Every company must finish with:

1. exactly one correct confirmed sales order;
2. exactly one completed delivery for the ordered products and quantities;
3. exactly one posted invoice with the exact products, quantities, and prices;
4. exactly one posted full payment reconciled to that invoice.

The four fixed cases are a normal order, a missing customer to create as a company, an existing order to reuse without duplication, and a changed form layout with a delayed maintenance notice. The grader also checks duplicate records and distinguishes incomplete work from wrong records.

## Outcomes

- **Primary:** `result.elapsed_ms` for all four companies, compared within each pair and by the median of two pairs.
- **Secondary:** independently verified companies, wrong and duplicate records, total tokens including cached input (with input, cached input, and output separated), sessions, inferences, tool calls, stop reasons, and incomplete companies.
- **Descriptive ratio:** baseline elapsed time divided by fleet elapsed time. Two pairs are a small repeated benchmark, not a universal effect-size or cost proof. A budget-stopped run is not a same-completion time.

## Recording and validity

- Every arm records read-only JPEG screenshots from its dedicated Chrome targets at a nominal two frames per second per desktop. Click indicators in the film come only from timestamped `input_ack` journal entries.
- The film uses one shared wall-clock axis. When an arm finishes, its final real frame stays visible with its measured completion time.
- **Block 1 is selected for the main film before results are known.** No run is replaced because of poor agent performance.
- An infrastructure failure before valid model operation may be retried only as an additional labelled attempt. A poor or incomplete agent result is never replaced.
- The corrected E12 scorer and its tests are frozen before E13. Original result files are never rewritten. Independent post-run grades are stored separately.
- Only synthetic company data may appear. No personal browser profile, personal account, other project, or private Nexting session is recorded.

The preregistered source was HEAD `0a5c8187b683426f25d42f8f96110eecc051650c` plus the measured E12 working-tree changes. The following SHA-256 values bind the task, runner, and scorer used at that point:

| File                               | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| `lab/virtual-screen/eval-run.ts`   | `0daca5f2c1bb2eedad13120c1d34444a103dc523ef06d084bd36697eee8cf4f3` |
| `lab/workloads/odoo/cash-grade.ts` | `7c5eff3e9531fee37e2384e42e89eec8d02da62fec1d0e1681046574332376f8` |
| `lab/workloads/odoo/env.ts`        | `119d4b4e4c37584f2f63c87eaf241a7c7e97bb563fc74ee6f0bc143d44763ad0` |
| `lab/workloads/odoo/scenario.ts`   | `84155e00cb3084d133c999d954e82cb4845986f37768cf8b94c6a3b0ae632e81` |
| `lab/workloads/odoo/workload.ts`   | `cd7f94a5b3c84f8711f5f1371d3e05adc619f224674a84a149070a4f25960c74` |

The final analysis independently checks these source hashes in every run's frozen `plan.json`.
