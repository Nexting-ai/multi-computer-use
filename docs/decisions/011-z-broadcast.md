# Z broadcast: one decision, executed and verified per surface

Direction (2026-10-29): use the Z axis so a Computer Use model operates many screens faster and more precisely, as a vector rather than a sequence. The bounded-worksets study showed why image-layout work alone could not reach that: tokens ≈ inferences × context per inference, and per-surface operation keeps inferences proportional to the number of surfaces N (≈2 per desktop). Shrinking pixels moved the second factor by ~5%; nothing moved the first. All 19 business errors were model transcription errors that the closed loop then confirmed against the same misreading.

## Contract

Z becomes a batch dimension. The model decides once per layout class; the runtime repeats that decision per surface with independent evidence.

- **Policy.** On one real exemplar screenshot the model declares a template rectangle, named value fields, ignore rectangles, ordered steps (`click`, `type_field`, `choose` with exact-match cases, `key_chord`) and a post-condition (`equals`, `contains`, or for prepare policies `absent`). Geometry is exemplar pixels. No DOM selectors, fixture coordinates or layout metadata reach the policy.
- **Registration.** Each surface's fresh frame is searched for the template by translation-only masked pixel matching (power-of-two pyramid, exact full-resolution score). A surface whose best match exceeds the error bound is untouched and reported. Clicks and fields are translated by the measured offset and must lie inside the template.
- **Values move by machine.** Field text is read through the platform text channel (`SurfacePort.readText`: CDP accessibility here; AX/UIA/AT-SPI natively). The read is bound to an unchanged frame revision before and after. The model never transcribes a value; `choose` only maps an exactly read value to a model-chosen case, and an unmatched value receives no input.
- **Canary first.** One item on one surface must deliver and verify before any other surface receives input. A wrong policy costs at most one item.
- **Per-surface closure.** Each surface keeps the durable ledger semantics of decision 010: intent before input, `execute` rechecks the frame, unknown effects become `unknown` and are never replayed, verification compares the post-condition with values read _before_ input. A corrected policy can verify an earlier delivery from those stored values without repeating it.
- **Prepare policies** clear interruptions (notices, dialogs) once per surface. They cannot type task values, never count as items, and an unknown effect blocks the surface.
- **Exceptions return to the model** grouped by appearance, one real screenshot per group, usable as the next exemplar. Anything the fleet session leaves unfinished is handed to the existing per-surface worksets, and their cost counts.

## What this does and does not claim

Decision count scales with layout classes K plus exceptions, not with N, only when surfaces share a registrable layout and values are exposed by the text channel. Heterogeneous fleets degrade toward per-surface operation; the mixed fixture measures that. Values that exist only as pixels (no text channel) are out of scope for broadcast typing and fall back to the model. Registration is translation-only: scaled, themed or reflowed variants are different classes. The text channel is a read capability the CDP port previously did not expose; it is journaled per read and never focuses, scrolls or inputs.

## Falsifiers

The comparison fails if broadcast lowers business correctness, misroutes or duplicates any input, needs grader data, or if its fleet session cost grows with N. Both arms use the same fleet, transport, model, budgets, independent grading and randomized paired order; the baseline is the per-surface bounded-worksets runtime. The mixed-layout campaign must keep zero misroutes with K>1 and interruptions.

## Amendments from the 100-desktop campaigns (2026-10-29/30)

- `choose.otherwise` expresses a task's default branch; an empty read still receives no input.
- A post-condition that already holds before input is refused before input (`verify_not_discriminative`).
- Uncertain deliveries are closed only by evidence: a fresh bound observation whose post-condition, built from values read before input, holds. Otherwise they stay `unknown`. Nothing is replayed. This covers lost replies on the operator link.
- Edge observation (`locate`) and one-round-trip `actAndObserve` run registration, text reads and post-condition polling next to the surfaces; polling uses an unbound text probe (`probeText`) and only a satisfied probe earns a frame-bound observation. Every third miss re-registers in case the layout moved. Executors receive exactly the frame identity.
- While the canary runs, other surfaces are registered read-only; broadcast starts from those observations, and `execute` still refuses input on any frame change. Seeds are awaited outside the concurrency gate.
- Non-matching edge surfaces return a 16-bin appearance fingerprint; exceptions are grouped by fingerprint and only up to four representatives are fetched as pixels.
- Concurrent `run` calls are safe: one pipeline per surface (`surface_busy` otherwise), and each run resets only its own exception records. Models may batch independent follow-ups in one code cell.
- The per-surface runtime (`ManagedScreen`) gains `dismiss` targets, so interruptions are not an unfair handicap for the baseline.

## Amendments from the held-out evaluations (2026-10-30/31)

Third-party held-out tasks (MiniWoB++, three preregistered rounds of six unseen tasks) did not meet non-inferiority: 581, 507 and 560 of 600 against 600 per surface. Every broadcast error was traced to one of four mechanisms; each fix has an on/off fault-injection control ([report](../validation/2026-10-31-heldout-f1-f2.md)).

- **Per-target check.** Each click target's 28×28 neighbourhood must match the exemplar, and value fields may not cover click targets. Sparse pages let whole-template error stay low while controls moved.
- **Strict registration.** Pixels a policy does not declare variable must be near-identical (mad ≤ 0.25, outliers ≤ 0.05%). Blank page diluted the difference between reordered labels.
- **Occlusion.** `click_text` clicks a point no other element covers, or raises `click_text_occluded`.
- **Semantic binding.** Every click point must hit an element of the exemplar, and each surface must have the same element (role and text; role only for text boxes and data) at the translated point. Value fields whose text run extends beyond the field are refused at compile time and per surface. Under a submission-only post-condition, Tab focus moves are refused. Results report `verification: value_bound | weak_submission_only`.

The claim boundary is unchanged: order-of-magnitude gains on fleets that share a layout (development-set regressions stay 300/300 with full coverage); no claim yet for general web tasks. Semantic binding awaits a new held-out round (F3).

## Correction: speed (2026-10-31)

Earlier per-surface baselines ran one model session at a time. Against 13 parallel per-surface sessions ([E1-P](../validation/2026-10-31-e1p-parallel-baseline.md)), wall time is equal (312 s vs 312 s over three blocks). The claim is cost: about 90× fewer tokens, inference count independent of N, one model session instead of many, with correctness at least equal. The speed multiples reported before this date are withdrawn.
