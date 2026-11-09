# Preregistration E5: real business software, growing variation (2026-11-05)

Committed before any E5 run. Smoke runs on 6 companies (seeds 777 and 778, not the E5 seeds) are reported below and are not part of the results.

S1–S4 showed where the harness helps: work whose decisions are shared across machines. E5 asks the practical question behind it: for the same workflow on many real systems that differ, is the harness both as reliable as one agent per machine and much cheaper, where a conventional script breaks?

## Task

Real Odoo (open-source ERP), one company per instance. Each company enters one sales order from its row of a task table: customer, Customer Reference, two products with quantities, then Confirm (`lab/workloads/odoo/scenario.ts`, `TASK`). Every arm reads the same task text and the same table.

Variation, in four levels (each level adds to the one before):

| Level | What differs between companies |
|---|---|
| **L0** | nothing: Odoo 17, English, the default form |
| **L1** | Odoo version 16, 17 or 18; language English, French, German or Spanish |
| **L2** | each company's own form layout (where Customer Reference sits), and a maintenance notice that covers the screen 8–68 s after the page loads |
| **L3** | data that needs judgement: about 30% of customers do not exist yet (create them, as a company); about 18% of orders were already entered (do not enter them again) |

- **48 companies per level**, 8 per server on 6 servers (DigitalOcean `s-8vcpu-32gb-amd`, Singapore), with identical image digests (`odoo:16/17/18`, `postgres:16`, recorded in each environment file).
- Seeds: L0 5150, L1 5151, L2 5152, L3 5153.
- Browsers: one local headless Chrome; each company in its own browser context, logged in, settled on the Sales app before any arm starts.
- Every arm starts from the same database snapshot (reset from templates before each run).

## Arms

| Arm | What it is |
|---|---|
| **RPA** | A conventional automation script, recorded on the reference company (L0, `W01`) and replayed on every company (`lab/workloads/odoo/rpa.ts`). Selector-based as UiPath or Power Automate would be: stable field and button names, exact-text suggestions, waits and checks after each input. Developed only against L0 and frozen at commit `cff56ec` before any run at L1–L3. No model, no tokens. |
| **S** | AI writes the automation: one agent reads frame-bound text snapshots of all companies and writes its own looping script over them. |
| **P-T** | One agent per company, 48 in parallel (`workset_parallel 48`). |
| **F** | The harness: one director over all 48 companies with fleet tools (`fleet_run` canary-first broadcasts with per-company inputs, `fleet_overview`), plus per-company tools for what differs. |

Common settings for S, P-T and F:
- Model: `gpt-6-astra`, medium effort, through the Codex app-server.
- Per arm: 2 h deadline, 60M tokens. Unfinished director and per-company sessions continue in a new session at most twice, as in S4.
- Arm order within each level is randomised by the runner; RPA runs after the three agent arms.

## Measures

- **Correct:** graded from each company's database, independent of any arm: exactly one confirmed sales order with that Customer Reference, the right customer (one partner of that name, a company), the right products and quantities, and no other order.
- **Wrong records:** a duplicate, a wrong order or an extra one. A wrong record is worse than an unfinished company: someone has to find and undo it.
- **Tokens, tool calls, wall time.**

## Hypotheses

- **H1 (reliability):** F is correct on ≥ 95% of companies at every level, with no wrong records.
- **H2 (scripts break):** RPA is correct on ≥ 95% at L0 and on < 80% at L3, with at least one wrong record at L3.
- **H3 (cost):** F's tokens ≤ 33% of P-T's at L0 and L1, and ≤ 60% at L3.
- **H4 (judgement):** at L3, F is correct on at least as many companies as S.
- **Reported without a threshold:** wall time of every arm at every level (the smokes suggest F is slower than P-T at L3), S's tokens against F's, and RPA at L1 and L2.

## Runtime changes for E5, made before this preregistration

All general; none is specific to an arm.
- Pages are handed to agents only once they have settled (the wait had been in the timeout branch, so agents got half-loaded screens).
- A steady text caret and no onboarding tours, so screens stop changing on their own.
- Template registration searches near the expected place first (a toolbar-strip template had starved the event loop).
- `workset_parallel` may go up to 64.
- SSH operations (reset, grade, provisioning) keep retrying for up to 20 minutes while a server is unreachable, instead of 5.
- The grader checks that the customer exists once, as a company (the task text asks for it).

## Smoke runs before this preregistration (6 companies; not results)

| Level | Arm | Correct | Wrong | Time | Tokens |
|---|---|---|---|---|---|
| L0 | F | 6/6 | 0 | 5.0 min | 1.20M |
| L0 | P-T | 6/6 | 0 | 5.5 min | 10.12M |
| L0 | S | 6/6 | 0 | 2.8 min | 1.31M |
| L0 | RPA (development runs) | 6/6 | 0 | about 1 min | 0 |
| L3 | F | 6/6 | 0 | 9.9 min | 4.96M |
| L3 | P-T | 6/6 | 0 | 4.5 min | 9.92M |
| L3 | S | 6/6 | 0 | 6.1 min | 5.34M |
| L3 | RPA (frozen) | 1/6 | 1 | 1.1 min | 0 |

- At L3, RPA stopped at every missing customer and entered the existing order again. It was not stopped by languages, versions or layouts, because it finds fields by name.
- S and F used about the same tokens at L3. S was faster. S is a strong baseline.
- Earlier smokes on servers in San Francisco were dropped: the path from the control machine lost servers for minutes at a time (6 of 43 probes in a 30-minute test, against 0 of 43 for Singapore).
- Singapore also drops at times: two servers were unreachable from here for long stretches and were replaced, and one S smoke crashed when a reset hit a 5-minute outage (rerun above).

## Network

The control machine (agents, browser, grader) is in China; the servers are in Singapore. Every 30 s during the formal runs, a probe records which servers answer over SSH (`paths.log`). Outages are reported with the results; a run that a server outage visibly broke is reported, then rerun once.

Every result is reported as measured.
