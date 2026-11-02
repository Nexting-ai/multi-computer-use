import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  Gate,
  actionSchema,
  type Delivery,
  type Frame,
  type SurfacePort,
  type TextNode,
} from "./index.js";
import type { ProgressLedger } from "./workset.js";

/**
 * Strong baseline S: the model writes its own automation against frame-bound
 * text snapshots (text + coordinates, no screenshots), typically looping over
 * every surface in one code cell. Same ledger, same pre-input frame check, same
 * independent grading as the other arms.
 *
 * contract "item": each act is one ledger item with a declared expectation
 * (exactly one typed value), confirmed later from a fresh snapshot.
 * contract "free": acts are not progress; the model declares a surface done.
 */
const id = z.string().min(1).max(64);
export const scriptReadSchema = z.strictObject({
  surfaces: z.array(id).min(1).max(100),
});
export const scriptActSchema = z.strictObject({
  targets: z
    .array(
      z.strictObject({
        surface_id: id,
        token: z.string().min(1).max(64),
        actions: z.array(actionSchema).min(1).max(20),
        expectation: z
          .strictObject({
            text: z.string().min(1).max(4096),
            choice: z.string().min(1).max(128),
          })
          .optional(),
      }),
    )
    .min(1)
    .max(100),
});
export const scriptConfirmSchema = z.strictObject({
  checks: z
    .array(
      z.strictObject({
        surface_id: id,
        token: z.string().min(1).max(64),
        text: z.string().max(4096),
        choice: z.string().max(128),
      }),
    )
    .min(1)
    .max(100),
});
export const scriptDoneSchema = z.strictObject({
  surfaces: z.array(id).min(1).max(100),
});

export class ScriptScreen {
  private tokens = new Map<string, { frame: Frame; at: number }>();
  private deliveredAt = new Map<string, number>();
  private gate: Gate;
  constructor(
    readonly port: SurfacePort,
    readonly ledger: ProgressLedger,
    readonly surfaces: string[],
    private options: {
      contract: "item" | "free";
      concurrency?: number;
      delivery?: (r: unknown) => Promise<void>;
    },
  ) {
    if (!port.readText && !port.snapshotText)
      throw Error("text_channel_required");
    this.gate = new Gate(options.concurrency ?? 32);
  }
  private z(sid: string) {
    const z = this.surfaces.indexOf(sid) + 1;
    if (!z) throw Error("unknown_surface");
    return z;
  }
  private async snapshot(sid: string) {
    if (this.port.snapshotText) return this.port.snapshotText(sid);
    const frame = await this.port.capture(sid);
    return { frame, nodes: await this.port.readText!(frame) };
  }
  /** Frame-bound text snapshots: [text, x, y, width, height] per node. */
  async read(raw: unknown) {
    const p = scriptReadSchema.parse(raw);
    p.surfaces.forEach((s) => this.z(s));
    const out = await Promise.all(
      p.surfaces.map((sid) =>
        this.gate.run(async () => {
          const row = this.ledger.get(sid);
          try {
            const { frame, nodes } = await this.snapshot(sid);
            const token = "t" + randomUUID().slice(0, 12);
            this.tokens.set(token, { frame, at: Date.now() });
            return {
              surface_id: sid,
              z: this.z(sid),
              token,
              state: row.state,
              completed: row.completed,
              nodes: compact(nodes),
            };
          } catch (e) {
            return {
              surface_id: sid,
              z: this.z(sid),
              error: String(e).slice(0, 120),
              state: row.state,
              completed: row.completed,
            };
          }
        }),
      ),
    );
    while (this.tokens.size > 2000)
      this.tokens.delete(this.tokens.keys().next().value!);
    return { surfaces: out, fleet: this.ledger.summary() };
  }
  async act(raw: unknown) {
    const p = scriptActSchema.parse(raw);
    if (new Set(p.targets.map((t) => t.surface_id)).size !== p.targets.length)
      throw Error("duplicate_surface");
    // Validate the whole batch before any input.
    for (const t of p.targets) {
      this.z(t.surface_id);
      const tok = this.tokens.get(t.token);
      if (!tok || tok.frame.surface_id !== t.surface_id)
        throw Error("token_surface_mismatch:" + t.surface_id);
      for (const a of t.actions)
        if (
          a.kind === "click" &&
          (a.x >= tok.frame.width || a.y >= tok.frame.height)
        )
          throw Error("point_outside_frame:" + t.surface_id);
      const typed = t.actions.filter((a) => a.kind === "type_text");
      if (this.options.contract === "item") {
        if (
          !t.expectation ||
          typed.length !== 1 ||
          typed[0]?.text !== t.expectation.text
        )
          throw Error("expectation_input_mismatch:" + t.surface_id);
      } else if (t.expectation) throw Error("free_contract_has_no_expectation");
      if (this.ledger.get(t.surface_id).state !== "ready")
        throw Error("input_not_allowed:" + t.surface_id);
    }
    const results = await Promise.all(
      p.targets.map((t) =>
        this.gate.run(async () => {
          const frame = this.tokens.get(t.token)!.frame;
          const op = createHash("sha256")
            .update(`script/${t.surface_id}/${randomUUID()}`)
            .digest("hex");
          if (this.options.contract === "item")
            await this.ledger.dispatch(t.surface_id, op, t.expectation!);
          const d = await this.port
            .execute(frame, t.actions, op)
            .catch((e): Delivery => ({ status: "unknown", reason: String(e) }));
          await this.options.delivery?.({
            mode: "script",
            surface_id: t.surface_id,
            operation_id: op,
            actions: t.actions,
            expectation: t.expectation,
            delivery: d,
            at: new Date().toISOString(),
          });
          if (this.options.contract === "item")
            await this.ledger.deliver(t.surface_id, d.status, d.reason);
          else if (d.status === "unknown")
            await this.ledger.block(t.surface_id, "free_unknown_effect");
          if (d.status === "delivered")
            this.deliveredAt.set(t.surface_id, Date.now());
          return {
            surface_id: t.surface_id,
            status: d.status,
            ...(d.reason ? { reason: d.reason } : {}),
          };
        }),
      ),
    );
    return { deliveries: results, fleet: this.ledger.summary() };
  }
  /** Item contract: confirm a delivered item from a snapshot taken after it. */
  async confirm(raw: unknown) {
    const p = scriptConfirmSchema.parse(raw);
    const out = [];
    for (const c of p.checks) {
      this.z(c.surface_id);
      const tok = this.tokens.get(c.token),
        row = this.ledger.get(c.surface_id);
      if (
        !tok ||
        tok.frame.surface_id !== c.surface_id ||
        row.state !== "awaiting_verification" ||
        tok.at < (this.deliveredAt.get(c.surface_id) ?? Infinity)
      ) {
        out.push({
          surface_id: c.surface_id,
          result: "fresh_snapshot_after_delivery_required",
        });
        continue;
      }
      const view = "script:" + c.token;
      await this.ledger.observed(c.surface_id, view);
      await this.ledger.verify(c.surface_id, view, c.text, c.choice);
      out.push({
        surface_id: c.surface_id,
        result: this.ledger.get(c.surface_id).state,
      });
    }
    return { results: out, fleet: this.ledger.summary() };
  }
  /** Free contract: the model declares surfaces finished (graded independently). */
  async done(raw: unknown) {
    if (this.options.contract !== "free")
      throw Error("done_requires_free_contract");
    const p = scriptDoneSchema.parse(raw);
    for (const sid of p.surfaces) {
      this.z(sid);
      if (this.ledger.get(sid).state === "ready")
        await this.ledger.declare(sid);
    }
    return { fleet: this.ledger.summary() };
  }
}
export function compact(nodes: TextNode[]) {
  return nodes
    .filter((n) => n.text.trim() || n.role === "textbox")
    .map(
      (n) =>
        [
          n.role === "StaticText"
            ? n.text
            : `[${n.role}${n.checked === undefined ? "" : n.checked ? ":checked" : ":unchecked"}]${n.text}`,
          n.rect.x,
          n.rect.y,
          n.rect.width,
          n.rect.height,
        ] as const,
    );
}
