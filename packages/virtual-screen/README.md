# Virtual screen adapter

Embed between a CUA agent's screenshot and input tools. Original PNG pixels from up to four surfaces are placed in an immutable image. An explicit target plus a point resolves to that surface's original coordinates. Raw mode supports controlled comparisons. A separate read-only evidence replay is available in the lab; it is not required by the runtime.

```ts
import { VirtualScreen } from "@cu/virtual-screen";

const screen = new VirtualScreen(trustedSurfacePort, {
  mode: "composite", // 'raw' delivers one image per surface
  concurrency: 4,
});
const views = await screen.observe([
  { surface_id: "W01" },
  { surface_id: "W02" },
]);
// Deliver each view's PNG and metadata together, without further resizing.
// The agent supplies coordinates in that WHOLE image, not panel-local pixels.
const result = await screen.act({
  request_id: "caller-generated-unique-id",
  targets: [
    {
      view_id: views[0]!.view_id,
      surface_id: "W02",
      actions: agentSelectedActions,
    },
  ],
});
```

The API deliberately requires `surface_id` as well as coordinates. This allows an agent's declared target to be checked against the image's hit map before any input is admitted. Headers, gutters and points in another panel reject the batch. Every target's sequence is ordered; different targets can progress concurrently. Dispatched observations are consumed, and subsequent input requires a fresh observation. An identical request retrieves the same receipt, including unknown outcomes. Changed arguments under an existing key fail closed. An old view never points to a newly assigned surface.

## Task focus and XYZ actions

Each surface also receives a session-stable `z`. After reading an observation, the model can choose a task rectangle in that image. The following example takes the model's selection, not a hardcoded application layout:

```ts
await screen.focus({ regions: agentSelectedRegions });
// regions: [{view_id, surface_id, rect}] — rect is in the WHOLE observed image.
const focused = await screen.observe([{ surface_id: "W02" }]);
const panel = focused[0]!.panels[0]!;
await screen.actSpatial({
  request_id: "another-unique-id",
  targets: [
    {
      view_id: focused[0]!.view_id,
      z: panel.z,
      actions: agentSelectedPanelLocalActions,
    },
  ],
});
// actSpatial click x/y is PANEL-LOCAL. Source = crop origin + local x/y.
// act (above) retains its WHOLE-IMAGE coordinate convention.
```

Focus is bound to observed pixels and reused. Outside-region pixel changes, geometry, route or navigation changes invalidate it; the next observation restores full context with `focus_status: 'invalidated'`. Use `observe(surfaces, { full: true, layout: 'raw' })` for an explicit full refresh. `first_observation_raw: true` makes the first successful observation separate full frames (unless the host explicitly supplies crops). Selection and full source capture still cost time. Busy surrounding UI can invalidate focus often. Z is stable addressing, not a prediction that 3D perspective accelerates inference.

Explicit crops remain optional trusted-host SDK input in source pixels. There is no semantic deduplication across windows or hidden business rule. Input actions currently cover click, text and a limited key chord set. No drag, scroll or automatic input-focus recovery is claimed.

## Integrating an input backend

For separated current facts, controls and prior receipts, import `TaskScreen` from `@cu/virtual-screen/task`. It uses the same trusted `SurfacePort` and input guarantees:

```ts
import { TaskScreen, taskViewMetadata } from "@cu/virtual-screen/task";
import { executeAndObserve } from "@cu/virtual-screen/step";
const task = new TaskScreen(trustedSurfacePort);
const initial = await task.observe([{ surface_id: "W01" }]);
// Deliver initial PNGs with taskViewMetadata(view).
const step = await executeAndObserve(
  () => task.act(agentSelectedRequest),
  (ids) => task.observe(ids.map((surface_id) => ({ surface_id }))),
);
// Deliver step.deliveries AND step.views together; no model turn is needed
// merely to request another screenshot. Preserve observation_error if present.
```

The agent request has `request_id`, targets `{view_id,z,basis,actions}`, and optional `layouts: [{view_id,z,regions:{facts,controls,receipt}}]`. The three disjoint rectangles are selected from a full observation; registration can accompany the initial input. The short `basis` is the model's reading of current facts, not a runtime-verified semantic assertion. Facts and receipt views refuse all input. Exact matching control pixels can share a visible panel across Z members, but every member keeps its own source binding. Partial similarity is never enough. Full views remain the fallback when any source identity/geometry/outside-region change invalidates layout.

`executeAndObserve` waits for all delivery receipts before invoking the supplied observer, including unknown outcomes. It never retries input. A capture exception returns the original delivery receipts plus `observation_error`; it must not be displayed as a failed action with no possible side effect. The observer can chunk large target sets within the screenshot budget. This helper works equally with the raw baseline executor.

Provide `SurfacePort.capture(surface_id)` and `SurfacePort.execute(frame, actions, operation_id)`. The port is a trusted host boundary, not untrusted agent code. It must authorize targets, freeze their route identity, arbitrate **all shared input resources**, check source identity/geometry/content before dispatch under ownership, and distinguish a proven pre-input refusal from an unknown effect. Same physical keyboard/mouse resources require serialization even when surface IDs differ. The adapter's per-surface queues cannot establish native-window input independence.

`src/cdp.ts` supplies a real port for a dedicated local browser with isolated page targets. It uses target-specific screenshot and input commands, without DOM, selectors, page JavaScript or `bringToFront`. It requires 1:1 pixel/CSS geometry, checks navigation/resize and screenshot content, and writes durable input intents/acknowledgements. It must not be attached to a shared human browser. Its per-target ordering does not solve shared application-account state.

Receipts mean **input delivered**, not verified task success. A model can still choose an incorrect business value or consistently name and click the wrong intended target. A later action in a sequence is model-planned; only the initial source state is pixel-checked. No automatic replay occurs after uncertain effects. All native input has a screenshot-to-action race; this prototype makes no atomic desktop-state guarantee.

## Lifetime and testing

Create one adapter per authorized agent session. Views are bounded and expire after at most ten minutes. A process restart discards view IDs; it does not resume operations. Request receipts are retained for that session with a hard 10,000-request limit. Durable multi-process job recovery remains in the existing control/receiver stack and is not claimed by this adapter.

```sh
pnpm exec vitest run packages/virtual-screen
CU_LIVE_BROWSER=1 pnpm exec vitest run tests/integration/virtual-screen.test.ts
node --import tsx lab/virtual-screen/run.ts /absolute/path/to/config.json
node --import tsx lab/virtual-screen/audit.ts /absolute/path/to/results
```

The benchmark uses an existing Chrome binary in a temporary, dedicated profile and independent browser contexts. It does not install an app, operate an existing browser profile or create cloud resources. Configuration is documented in `lab/virtual-screen/README.md`.

## Durable progress and bounded worksets

`@cu/virtual-screen/workset` exports `ProgressLedger`, `ReadyQueue` and `runWorksets`. Open a durable ledger with the complete authorized surface manifest and required steps. `runWorksets` selects up to eight unfinished surfaces, starts a fresh model session for each workset and continues after normal model termination. Failed/no-progress sessions have a finite per-target attempt budget; already completed work is retained. The default selection gives unattempted targets priority over retries. Persistence failure poisons further dispatch. Explicit dead-owner recovery checks the process lock; unresolved dispatched input becomes `unknown`, never a replay candidate.

`@cu/virtual-screen/managed` exports `ManagedScreen`, `managedActionSchema(roles)` and `verificationSchema`. Create one runtime per model workset with the port, shared ledger, full stable-Z manifest, assigned scope, and raw/role mode. `observe`, `act`, `confirm`, `status` and `drain` form the integration surface. Model requests use existing panel-local coordinates plus per-target `expectation: {text, choice}`. Subsequent `checks: [{surface_id, view_id, text, choice}]` require fresh full/receipt pixels and advance only on exact agreement. The current work unit assumes one typed value and one choice; this is an explicit task contract, not a universal business validator.

Capture/execute jobs settle independently. Invalid captures are target-local; ready images remain usable while failed reads receive at most three attempts per workset. Once images or errors are available, collection allows at most 300 ms for other ready results, bounded by the caller's wait deadline. It never waits indefinitely for every target. Native shared input resources still require port-level arbitration. A per-target action timeout is unknown; no cancellation or no-effect claim is inferred from timeout.

The ledger is host-owned state, not an oracle: model confirmation can be wrong. The benchmark independently checks actual business records after all sessions. `drain` finishes admitted work and read-only observations without inventing further model actions. This SDK does not silently reopen remote fleets after an arbitrary controller crash; the ledger safely preserves unresolved intent for explicit recovery.

Exhausted capture retries project `state: "deferred"` for the current workset without rewriting durable input truth. `workset.actionable` and `workset.can_end` tell the caller when to yield instead of polling an unavailable target. A fresh host-scheduled workset can attempt its captures again within the ledger's overall attempt limit. Model integrations should also cap each session's calls, tokens and wall time independently from the whole job budget; the provided benchmark defaults to 96 calls and 1,000,000 tokens per session.

## Z broadcast: one decision for many surfaces

`@cu/virtual-screen/stack` exports `StackScreen` and `policySchema`. Per-surface operation needs roughly two model inferences per desktop, so cost and time grow with the number of surfaces N. Broadcast makes Z a batch dimension: the model reads one real exemplar screenshot and declares, in its pixels, a template, value fields, ignore areas, ordered steps and a post-condition. The runtime then, for every surface independently:

1. registers the template in a fresh frame (translation-only masked pixel matching); a non-matching surface receives no input and is returned as an exception;
2. reads field values through the port's native text channel (`readText`: accessibility tree, bound to an unchanged frame), so the model never transcribes values;
3. runs one canary item before touching other surfaces, then executes concurrently through the same guarded `execute`;
4. verifies the post-condition against values read before input, under the durable `ProgressLedger` (intent first, unknown never replayed).

```ts
import { StackScreen } from "@cu/virtual-screen/stack";
const stack = new StackScreen(port, ledger, surfaceIds, { concurrency: 32 });
const { views } = await stack.observe(["W01"]); // deliver the PNG to the model
const result = await stack.run(modelPolicy); // policySchema; geometry from the model
// result.exception_groups: one real screenshot per visually distinct group, usable as the next exemplar
```

`mode: "prepare"` clears an interruption (notice, dialog) once per surface without counting as task progress. A port that implements `locate` performs registration and text reading next to the surfaces (edge observation); only frame identity, the match and text nodes cross the operator link. Requirements and limits: the port must expose `readText`; values that exist only as pixels are not typed by broadcast; registration does not tolerate scaling or reflow (those are separate layout classes). See [decision 011](../../docs/decisions/011-z-broadcast.md).
