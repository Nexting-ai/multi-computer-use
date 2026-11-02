# Computer Use Fleet

**One decision, many computers.** A harness that lets one Computer Use model operate a fleet of desktops through a single decision per screen layout, instead of one agent loop per machine.

By Nexting AI.

## The idea

Ordinary Computer Use runs one screenshot→think→click loop per computer. With 100 computers, that means 100 loops and roughly 100× the model calls.

Most fleets repeat the same screen: the same back office in many accounts, or the same form across many tickets. This harness treats the set of computers as a third axis (Z), similar to a batch dimension in vectorized code:

1. The model looks at **one** example screen and writes a policy. The policy names the stable template area, the fields whose values differ per machine, the steps to take, and the post-condition that proves success.
2. The runtime applies that policy to **every** computer independently:
   - locates the template on each screen;
   - reads each machine's values through the accessibility text channel, so the model never transcribes data;
   - checks that each click lands on the same element as in the example;
   - executes, then verifies the post-condition on that machine.
3. A **canary** runs first. If the policy is wrong, at most one machine is affected. Machines that do not match are left untouched and grouped by appearance, so the model can handle each group with one more decision.

Every input is written to a durable ledger before it is sent. An input whose outcome is uncertain is never replayed. It is closed only when fresh evidence shows the effect happened.

## Results

All experiments were preregistered before they ran. Grading reads server-side business records (or MiniWoB's own reward), never the runtime's own report. Failures and deviations are kept in the reports. Model: `gpt-6-astra` (medium) unless noted.

**100 desktops × 3 items × 3 blocks.** Baseline: conventional per-machine Computer Use running **13 agents in parallel**.

| | Fleet harness | Per-machine, 13 in parallel |
|---|---|---|
| Model tokens | **0.17M** | 15.17M (**~90× more**) |
| Concurrent model sessions | **1** | 13 |
| Items correct | **900 / 900** | 896 / 900 |
| Wall time (3 blocks) | 312 s | 312 s |

Speed is a tie. An earlier version of these results reported large speedups; those came from a baseline that ran one agent at a time, and they have been withdrawn ([E1-P report](docs/validation/2026-10-31-e1p-parallel-baseline.md)). **The gain is cost and concurrency:** the same throughput and accuracy for about 1% of the tokens, from a single model session.

**Other findings**

- **Model calls stop growing with N.** Three runs of 300 items took 12 inferences in total; the per-machine baseline took 580.
- **Ablation: the savings and the accuracy come from different mechanisms.** Broadcasting gives the cost reduction. Machine-read values give the accuracy: when the model transcribed 100 values from images, 8.4% were wrong, versus 0 when values were read from the text channel. Even a strong "let the model write a batch script" baseline used 3× the tokens.
- **The results hold for a second model.** Claude Sonnet 5.5 used ~100× fewer tokens on the same tasks, with identical correctness.
- **Heterogeneity costs about one decision per distinct layout.** With 20 layout classes, a run still used 0.69M tokens, against 5–7M for per-machine operation. When every machine looks different (K = 100), the advantage disappears; correctness does not drop.
- **Safety under fault injection: zero misrouted inputs and zero duplicates.** The suite has 22 deterministic scenarios in real Chrome, each with the safeguard switched on and off:
  - a wrong policy is contained by the canary;
  - lost replies are closed only from evidence;
  - controls that moved, reordered labels and occluded buttons are caught;
  - unbound clicks and truncated values are refused before any input. These last scenarios replay the model's own failing policies from the held-out runs.

**Where it does not yet work: general web tasks.** On third-party MiniWoB++ tasks the team had never seen, three preregistered rounds missed the non-inferiority bar: 581, 507 and 560 of 600, against 600 for per-machine operation. The 152 broadcast errors fall into four mechanisms; all four now have fixes with on/off controls in the fault suite. A fourth held-out round ([F3](docs/validation/2026-10-31-preregistration-f3.md)) is preregistered but has not run. **Current claim: fleets that share a screen layout. No claim yet for arbitrary websites.**

Full reports (in Chinese), data and the results page are in [`docs/`](docs). Open [`docs/showcase/z-broadcast.html`](docs/showcase/z-broadcast.html) in a browser for the charts.

## Try it

You need Node ≥ 24, pnpm and Google Chrome. Set `CU_CHROME` to the Chrome binary if it is not at the macOS default path.

```sh
pnpm install
pnpm check          # typecheck + unit tests
pnpm fault-suite    # 22 fault-injection scenarios in local headless Chrome (~15 min)
```

The fault suite needs no model and is fully deterministic. Results go to `.local/fault-suite/fault-suite.json`.

To run a small model evaluation (up to 12 local Chrome surfaces), edit [`examples/local-eval.json`](examples/local-eval.json) to point at your Codex CLI and its auth file, then run:

```sh
node --import tsx lab/virtual-screen/eval-run.ts examples/local-eval.json
node --import tsx lab/virtual-screen/eval-analyze.ts .local
```

Set `"agent": "claude"` to drive Claude Code instead, through an MCP bridge. The 100-desktop server-fleet tooling used in the reports is not included in this repository.

## Layout

| Path | What |
|---|---|
| `packages/virtual-screen/src/stack.ts` | The fleet runtime: policies, canary, per-machine pipeline, semantic binding, exception grouping |
| `packages/virtual-screen/src/align.ts` | Template registration and per-target local checks |
| `packages/virtual-screen/src/cdp.ts` | Chrome DevTools surface port: frames, input, accessibility text channel |
| `packages/virtual-screen/src/workset.ts` | Durable progress ledger and per-machine worksets (the baseline) |
| `packages/virtual-screen/src/managed.ts`, `script.ts` | Per-machine and "model writes a script" baselines |
| `lab/virtual-screen/` | Workloads (synthetic business forms and MiniWoB++), preregistered runner, analysis, fault suite, results page |
| `lab/vendor/miniwob/` | Pinned MiniWoB++ subset (MIT, see its LICENSE) |
| `docs/decisions/` | Design decisions 010 (worksets) and 011 (this harness) |
| `docs/validation/` | Preregistrations, reports and raw data |

## License

Apache-2.0. The vendored MiniWoB++ files keep their MIT license.
