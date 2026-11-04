import { createHash } from "node:crypto";
import { z } from "zod";
import sharp from "sharp";
import {
  VirtualScreen,
  Gate,
  spatialSchema,
  type SurfacePort,
  type Frame,
  type View,
  type Delivery,
} from "./index.js";
import { TaskScreen, taskActionSchema, type TaskView } from "./task.js";
import { ProgressLedger, ReadyQueue } from "./workset.js";
const expectation = z.strictObject({
  text: z.string().min(1).max(4096),
  choice: z.string().min(1).max(128),
});
export const verificationSchema = z.strictObject({
  checks: z
    .array(
      z.strictObject({
        surface_id: z.string(),
        view_id: z.string(),
        text: z.string().max(4096),
        choice: z.string().max(128),
      }),
    )
    .min(1)
    .max(12),
});
export const managedActionSchema = (roles: boolean) =>
  (roles ? taskActionSchema : spatialSchema).extend({
    targets: z
      .array(
        (roles ? taskActionSchema : spatialSchema).shape.targets.element.extend(
          {
            expectation: expectation.optional(),
            /** Clear an interruption (notice/dialog): no typed value, no
             * expectation, never counts as task progress. */
            dismiss: z.literal(true).optional(),
          },
        ),
      )
      .min(1)
      .max(12),
    checks: verificationSchema.shape.checks.optional(),
  });
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("target_deadline")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
type Receipt = Delivery & { surface_id: string; operation_id: string };
type Event =
  | { kind: "capture"; frame: Frame; full: boolean }
  | { kind: "delivery"; receipt: Receipt };
/** Reusable workset execution. No DOM, fixture coordinates, grader or task-specific clicks. */
export class ManagedScreen {
  private jobs: ReadyQueue<Event>;
  private captureGate = new Gate(4);
  private inputGate = new Gate(4);
  private prepared = new Map<string, Frame>();
  private views = new Map<string, View>();
  private base: VirtualScreen;
  private role: TaskScreen | undefined;
  private requestHashes = new Map<string, string>();
  private serial = new Gate(1);
  private failures = new Map<string, number>();
  private enteredPort = new Set<string>();
  constructor(
    readonly port: SurfacePort,
    readonly ledger: ProgressLedger,
    readonly allSurfaces: string[],
    readonly scope: string[],
    readonly roles: boolean,
    private evidence: {
      source?: (f: Frame) => Promise<void>;
      delivery?: (request: string, r: Receipt) => Promise<void>;
      error?: (id: string, e: unknown) => void;
      /** "free": every target is a non-progress action (like dismiss); the
       * caller records completion with ledger.declare. Default "item". */
      contract?: "item" | "free";
      /** Largest scope (a per-surface operator owns at most 8; a director
       * that addresses one surface at a time may own the fleet). */
      max_scope?: number;
    } = {},
  ) {
    if (
      !scope.length ||
      scope.length > (evidence.max_scope ?? 8) ||
      new Set(scope).size !== scope.length ||
      scope.some((id) => !allSurfaces.includes(id))
    )
      throw Error("invalid_workset");
    this.jobs = new ReadyQueue(8, (id, e) => this.evidence.error?.(id, e));
    const preparedPort: SurfacePort = {
      capture: async (id) => {
        const f = this.prepared.get(id);
        if (!f) throw Error("capture_not_ready");
        await this.evidence.source?.(f);
        return f;
      },
      execute: (...args) => {
        this.enteredPort.add(args[0].surface_id);
        return bounded(port.execute(...args), 65000);
      },
    };
    this.base = new VirtualScreen(preparedPort, {
      mode: "raw",
      concurrency: 4,
      surfaces: allSurfaces,
      max_views: 128,
    });
    this.role = roles
      ? new TaskScreen(preparedPort, { concurrency: 4, surfaces: allSurfaces })
      : undefined;
  }
  private scoped(id: string) {
    if (!this.scope.includes(id)) throw Error("target_outside_workset");
  }
  private startCapture(id: string, full: boolean) {
    this.scoped(id);
    if (this.jobs.has("capture:" + id) || this.jobs.has("action:" + id)) return;
    if ((this.failures.get(id) ?? 0) >= 3) return;
    this.jobs.start("capture:" + id, () =>
      this.captureGate.run(async () => {
        try {
          const frame = await bounded(this.port.capture(id), 30000);
          if (frame.surface_id !== id) throw Error("capture_identity_mismatch");
          if (
            !frame.route_id ||
            !frame.revision ||
            !Number.isSafeInteger(frame.epoch) ||
            frame.epoch < 0 ||
            !Number.isSafeInteger(frame.width) ||
            !Number.isSafeInteger(frame.height) ||
            frame.width < 1 ||
            frame.height < 1 ||
            frame.width * frame.height > 4000000 ||
            frame.png.length > 16000000
          )
            throw Error("invalid_frame");
          const { info } = await sharp(frame.png, { limitInputPixels: 4000000 })
            .raw()
            .toBuffer({ resolveWithObject: true });
          const meta = await sharp(frame.png, {
            limitInputPixels: 4000000,
          }).metadata();
          if (
            info.width !== frame.width ||
            info.height !== frame.height ||
            meta.format !== "png"
          )
            throw Error("frame_geometry_mismatch");
          return { kind: "capture", frame, full };
        } catch (e) {
          this.failures.set(id, (this.failures.get(id) ?? 0) + 1);
          throw e;
        }
      }),
    );
  }
  private async verify(checks: z.infer<typeof verificationSchema>["checks"]) {
    if (new Set(checks.map((c) => c.surface_id)).size !== checks.length)
      throw Error("duplicate_verification");
    for (const c of checks) {
      this.scoped(c.surface_id);
      const v = this.views.get(c.view_id);
      if (!v?.panels.some((p) => p.surface_id === c.surface_id))
        throw Error("verification_view_mismatch");
      const r = this.ledger.get(c.surface_id);
      if (r.state !== "awaiting_verification" || r.observation !== c.view_id)
        throw Error("fresh_observation_required");
    }
    for (const c of checks)
      await this.ledger.verify(c.surface_id, c.view_id, c.text, c.choice);
  }
  async confirm(raw: unknown) {
    return this.serial.run(async () => {
      await this.verify(verificationSchema.parse(raw).checks);
      return this.status();
    });
  }
  status() {
    const targets = this.scope.map((id) => {
      const r = this.ledger.get(id);
      const deferred =
        (this.failures.get(id) ?? 0) >= 3 &&
        ["ready", "awaiting_verification"].includes(r.state);
      return {
        surface_id: id,
        completed: r.completed,
        state: deferred ? "deferred" : r.state,
        ...(r.state === "awaiting_verification"
          ? { expected: r.expected }
          : {}),
        ...(deferred
          ? { reason: "capture_retry_budget" }
          : r.reason
            ? { reason: r.reason }
            : {}),
      };
    });
    const pending = this.jobs.ids(),
      actionable = targets.filter((t) =>
        ["ready", "awaiting_verification"].includes(t.state),
      ).length;
    return {
      fleet: this.ledger.summary(),
      targets,
      pending,
      workset: {
        actionable,
        can_end: actionable === 0 && pending.length === 0,
      },
    };
  }
  observe(ids: string[], full = false, waitMs = 10000) {
    return this.serial.run(async () => {
      if (!ids.length || new Set(ids).size !== ids.length)
        throw Error("invalid_observation_targets");
      ids.forEach((id) => this.scoped(id));
      for (const id of ids) this.startCapture(id, full);
      return this.collect(waitMs);
    });
  }
  act(raw: unknown, waitMs = 10000) {
    return this.serial.run(async () => {
      const r = managedActionSchema(this.roles).parse(raw),
        hash = createHash("sha256").update(JSON.stringify(r)).digest("hex");
      const { checks: _checks, targets: _targets, ...actionFields } = r;
      const cleanAction = {
        ...actionFields,
        targets: r.targets.map(({ expectation: _, dismiss: _d, ...t }) => t),
      };
      const roleAction = this.roles
        ? taskActionSchema.parse(cleanAction)
        : undefined;
      const old = this.requestHashes.get(r.request_id);
      if (old) {
        if (old !== hash) throw Error("idempotency_conflict");
        return this.collect(waitMs);
      }
      if (new Set(r.targets.map((t) => t.z)).size !== r.targets.length)
        throw Error("duplicate_surface");
      // Validate all bindings and scopes before accepting any side effect.
      for (const t of r.targets) {
        const id = this.allSurfaces[t.z - 1];
        if (!id) throw Error("unknown_z");
        this.scoped(id);
        const view = this.views.get(t.view_id),
          panel = view?.panels.find((p) => p.surface_id === id && p.z === t.z);
        if (
          !panel ||
          !view ||
          ("role" in view && !["full", "controls"].includes(String(view.role)))
        )
          throw Error("action_view_mismatch");
        for (const a of t.actions)
          if (
            a.kind === "click" &&
            (a.x >= panel.rect.width || a.y >= panel.rect.height)
          )
            throw Error("point_outside_target");
        const typed = t.actions.filter((a) => a.kind === "type_text");
        if (this.evidence.contract === "free") {
          if (t.expectation) throw Error("free_contract_has_no_expectation");
          (t as { dismiss?: true }).dismiss = true;
        } else if (t.dismiss) {
          if (t.expectation || typed.length)
            throw Error("dismiss_must_not_type");
        } else if (
          !t.expectation ||
          typed.length !== 1 ||
          typed[0]?.text !== t.expectation.text
        )
          throw Error("expectation_input_mismatch");
        if (this.jobs.has("action:" + id) || this.jobs.has("capture:" + id))
          throw Error("target_busy");
      }
      if (r.checks) await this.verify(r.checks);
      for (const t of r.targets)
        if (this.ledger.get(this.allSurfaces[t.z - 1]!).state !== "ready")
          throw Error("input_not_allowed");
      this.requestHashes.set(r.request_id, hash);
      for (const t of r.targets) {
        const id = this.allSurfaces[t.z - 1]!,
          request = createHash("sha256")
            .update(`${r.request_id}/${t.z}`)
            .digest("hex");
        if (!t.dismiss) await this.ledger.dispatch(id, request, t.expectation!);
        this.jobs.start("action:" + id, () =>
          this.inputGate.run(async () => {
            let receipt: Receipt;
            this.enteredPort.delete(id);
            try {
              const { expectation: _, dismiss: _d, ...target } = t;
              const layouts = roleAction?.layouts?.filter((l) => l.z === t.z);
              const rs = await (this.role
                ? this.role.act({
                    request_id: request,
                    targets: [target as any],
                    ...(layouts ? { layouts } : {}),
                  })
                : this.base.actSpatial({
                    request_id: request,
                    targets: [target],
                  }));
              receipt = rs[0]!;
            } catch (e) {
              receipt = {
                surface_id: id,
                operation_id: request,
                status: this.enteredPort.has(id) ? "unknown" : "blocked",
                reason: this.enteredPort.has(id)
                  ? "action_outcome_unresolved"
                  : "rejected_before_input",
              };
              this.evidence.error?.(id, e);
            }
            await this.evidence.delivery?.(r.request_id, receipt);
            if (!t.dismiss)
              await this.ledger.deliver(id, receipt.status, receipt.reason);
            else if (receipt.status === "unknown")
              await this.ledger.block(id, "dismiss_unknown_effect");
            // Schedule post-observation after the action job is released by collect.
            return { kind: "delivery", receipt };
          }),
        );
      }
      return this.collect(waitMs);
    });
  }
  private async collect(waitMs: number) {
    const deliveries: Receipt[] = [],
      frames: { frame: Frame; full: boolean }[] = [],
      errors: { id: string; code: string }[] = [];
    let end = Date.now() + waitMs,
      flushing = false;
    do {
      const batch = await this.jobs.collect(Math.max(0, end - Date.now()), 0);
      errors.push(...batch.errors);
      for (const { value } of batch.ready) {
        if (value.kind === "capture") frames.push(value);
        else {
          deliveries.push(value.receipt);
          this.startCapture(value.receipt.surface_id, false);
        }
      }
      // Amortize a model round trip without waiting for the slowest desktop.
      // The grace period starts once, never extends as more results arrive.
      if (!flushing && (frames.length || errors.length)) {
        flushing = true;
        end = Math.min(end, Date.now() + 300);
      }
    } while (this.jobs.pending && Date.now() < end);
    const views: (View | TaskView)[] = [];
    for (const full of [true, false]) {
      const group = frames.filter((f) => f.full === full);
      if (!group.length) continue;
      for (const f of group) this.prepared.set(f.frame.surface_id, f.frame);
      const ids = group.map((f) => ({ surface_id: f.frame.surface_id }));
      try {
        views.push(
          ...(await (this.role
            ? this.role.observe(ids, { full })
            : this.base.observe(ids, { full: true, layout: "raw" }))),
        );
      } finally {
        for (const f of group) this.prepared.delete(f.frame.surface_id);
      }
    }
    for (const v of views) {
      this.views.set(v.view_id, v);
      if (!("role" in v) || v.role === "full" || v.role === "receipt")
        for (const p of v.panels)
          await this.ledger.observed(p.surface_id, v.view_id);
    }
    while (this.views.size > 128)
      this.views.delete(this.views.keys().next().value!);
    return {
      deliveries,
      views,
      errors,
      pending: this.jobs.ids(),
      progress: this.status(),
    };
  }
  async drain() {
    while (this.jobs.pending) {
      await this.collect(10000);
    }
    return this.status();
  }
}
