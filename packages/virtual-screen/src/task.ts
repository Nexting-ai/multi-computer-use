import { createHash, randomUUID } from "node:crypto";
import sharp, { type OverlayOptions } from "sharp";
import { z } from "zod";
import {
  VirtualScreen,
  Gate,
  spatialSchema,
  type SurfacePort,
  type Frame,
  type Panel,
  type Rect,
  type View,
} from "./index.js";

const roles = ["facts", "controls", "receipt"] as const;
type Role = (typeof roles)[number];
const rectangle = z.strictObject({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive().max(8192),
  height: z.number().int().positive().max(8192),
});
export const taskActionSchema = spatialSchema.extend({
  targets: z
    .array(
      spatialSchema.shape.targets.element.extend({
        basis: z.string().min(1).max(240),
      }),
    )
    .min(1)
    .max(100),
  layouts: z
    .array(
      z.strictObject({
        view_id: z.string().min(1),
        z: z.number().int().positive(),
        regions: z.strictObject({
          facts: rectangle,
          controls: rectangle,
          receipt: rectangle,
        }),
      }),
    )
    .max(12)
    .optional(),
});
type Layout = {
  regions: Record<Role, Rect>;
  outside: string;
  route_id: string;
  epoch: number;
  width: number;
  height: number;
};
export type TaskView = View & { role: Role | "full" };
/** Agent-facing coordinates only; inverse transforms remain operator evidence. */
export function taskViewMetadata(v: TaskView) {
  return {
    view_id: v.view_id,
    role: v.role,
    width: v.width,
    height: v.height,
    panels: v.panels.map((p) => ({
      z: p.z,
      surface_id: p.surface_id,
      rect: p.rect,
    })),
  };
}
type Binding = {
  expires: number;
  view: TaskView;
  members: { panel: Panel; frame: Frame; base_id: string }[];
};
const digest = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
async function outside(frame: Frame, regions: Record<Role, Rect>) {
  const bytes = await sharp(frame.png)
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer();
  for (const r of Object.values(regions))
    for (let y = r.y; y < r.y + r.height; y++)
      bytes.fill(
        0,
        (y * frame.width + r.x) * 3,
        (y * frame.width + r.x + r.width) * 3,
      );
  return digest(bytes);
}
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;
/** Semantic labels come from the agent's observed pixels, never application DOM.
 * Reuses VirtualScreen's generation, queues, idempotency and exact-source guard. */
export class TaskScreen {
  private base: VirtualScreen;
  private observationGate = new Gate(1);
  private captures = new Map<string, Frame>();
  private bindings = new Map<string, Binding>();
  private layouts = new Map<string, Layout>();
  private requests = new Map<
    string,
    { hash: string; result: ReturnType<VirtualScreen["actSpatial"]> }
  >();
  private ttl: number;
  constructor(
    port: SurfacePort,
    options: {
      concurrency?: number;
      ttl_ms?: number;
      surfaces?: string[];
    } = {},
  ) {
    this.ttl = options.ttl_ms ?? 600000;
    this.base = new VirtualScreen(
      {
        capture: async (id) => {
          const f = await port.capture(id);
          this.captures.set(id, { ...f, png: Buffer.from(f.png) });
          return f;
        },
        execute: (...args) => port.execute(...args),
      },
      { mode: "raw", max_views: 128, ...options },
    );
  }
  private save(view: TaskView, members: Binding["members"]) {
    this.bindings.set(view.view_id, {
      view: { ...view, panels: structuredClone(view.panels) },
      expires: Date.now() + this.ttl,
      members: members.map((m) => ({ ...m, panel: structuredClone(m.panel) })),
    });
    while (this.bindings.size > 128)
      this.bindings.delete(this.bindings.keys().next().value!);
  }
  private member(view_id: string, z: number) {
    const v = this.bindings.get(view_id);
    if (!v || v.expires <= Date.now()) throw Error("view_expired");
    const member = v.members.find((m) => m.panel.z === z);
    if (!member) throw Error("z_not_in_view");
    return { v, ...member };
  }
  observe(
    surfaces: { surface_id: string }[],
    options: { full?: boolean } = {},
  ): Promise<TaskView[]> {
    return this.observationGate.run(async () => {
      this.captures.clear();
      const raw = await this.base.observe(surfaces, {
          full: true,
          layout: "raw",
        }),
        result: TaskView[] = [];
      const organized: {
        frame: Frame;
        base_id: string;
        z: number;
        layout: Layout;
      }[] = [];
      for (const v of raw) {
        const p = v.panels[0]!,
          f = this.captures.get(p.surface_id)!;
        let layout = this.layouts.get(p.surface_id),
          invalid = false;
        if (
          layout &&
          (f.route_id !== layout.route_id ||
            f.epoch !== layout.epoch ||
            f.width !== layout.width ||
            f.height !== layout.height ||
            (await outside(f, layout.regions)) !== layout.outside)
        ) {
          this.layouts.delete(p.surface_id);
          layout = undefined;
          invalid = true;
        }
        if (layout && !options.full)
          organized.push({ frame: f, base_id: v.view_id, z: p.z, layout });
        else {
          const view: TaskView = {
            ...v,
            role: "full",
            panels: [{ ...p, focus_status: invalid ? "invalidated" : "none" }],
          };
          this.save(view, [
            { panel: view.panels[0]!, frame: f, base_id: v.view_id },
          ]);
          result.push(view);
        }
      }
      for (const role of roles) {
        const groups: {
          png: Buffer;
          width: number;
          height: number;
          members: typeof organized;
        }[] = [];
        const identical = new Map<string, number>();
        for (const s of organized) {
          const r = s.layout.regions[role],
            png = await sharp(s.frame.png)
              .extract({
                left: r.x,
                top: r.y,
                width: r.width,
                height: r.height,
              })
              .png()
              .toBuffer();
          const key = `${r.width}/${r.height}/${digest(await sharp(png).toColourspace("srgb").removeAlpha().raw().toBuffer())}`;
          const old = role === "controls" ? identical.get(key) : undefined;
          if (old !== undefined) groups[old]!.members.push(s);
          else {
            identical.set(key, groups.length);
            groups.push({
              png,
              width: r.width,
              height: r.height,
              members: [s],
            });
          }
        }
        // Up to eight original-resolution crops in one role image. Controls may
        // share exact pixels, never source identity or execution state.
        for (let start = 0; start < groups.length; start += 8) {
          const chunk = groups.slice(start, start + 8),
            rows = Array.from({ length: Math.ceil(chunk.length / 2) }, (_, i) =>
              chunk.slice(i * 2, i * 2 + 2),
            );
          const heights = rows.map(
              (r) => Math.max(...r.map((g) => g.height)) + 32,
            ),
            width = Math.max(
              ...rows.map((r) => r.reduce((n, g) => n + g.width + 8, 8)),
            ),
            height = heights.reduce((a, b) => a + b, 8);
          if (width * height > 16000000) throw Error("composite_budget");
          const panels: Panel[] = [],
            members: Binding["members"] = [],
            overlays: OverlayOptions[] = [];
          for (const [i, g] of chunk.entries()) {
            const x = i % 2 === 0 ? 8 : chunk[i - 1]!.width + 16,
              y =
                32 +
                heights.slice(0, Math.floor(i / 2)).reduce((a, b) => a + b, 0),
              rect = { x, y, width: g.width, height: g.height };
            overlays.push({ input: g.png, left: x, top: y });
            const label = `${role === "facts" ? "CURRENT" : role === "receipt" ? "PREVIOUS" : "CONTROLS"} ${g.members.map((m) => `Z${m.z}`).join(",")}`;
            overlays.push({
              input: Buffer.from(
                `<svg width="${g.width}" height="24"><text x="2" y="18" font-family="Arial" font-size="15" fill="white">${label}</text></svg>`,
              ),
              left: x,
              top: y - 24,
            });
            for (const s of g.members) {
              const panel: Panel = {
                surface_id: s.frame.surface_id,
                z: s.z,
                rect,
                source_rect: { ...s.layout.regions[role] },
                focus_status: "active",
              };
              panels.push(panel);
              members.push({ panel, frame: s.frame, base_id: s.base_id });
            }
          }
          const view: TaskView = {
            view_id: randomUUID(),
            role,
            width,
            height,
            panels,
            png: await sharp({
              create: { width, height, channels: 3, background: "#1d2633" },
            })
              .composite(overlays)
              .png()
              .toBuffer(),
          };
          this.save(view, members);
          result.push(view);
        }
      }
      return result;
    });
  }
  async act(request: z.input<typeof taskActionSchema>) {
    const r = taskActionSchema.parse(request),
      hash = digest(JSON.stringify(r)),
      old = this.requests.get(r.request_id);
    if (old) {
      if (old.hash !== hash) throw Error("idempotency_conflict");
      return structuredClone(await old.result);
    }
    if (this.requests.size >= 10000) throw Error("session_request_limit");
    // Resolve the entire batch before storing layout or sending any input.
    const targets = r.targets.map((t) => {
      const m = this.member(t.view_id, t.z);
      if (!["full", "controls"].includes(m.v.view.role))
        throw Error("read_only_region");
      const actions = t.actions.map((a) => {
        if (a.kind !== "click") return a;
        if (a.x >= m.panel.rect.width || a.y >= m.panel.rect.height)
          throw Error("point_outside_target");
        return {
          ...a,
          x: m.panel.source_rect.x + a.x,
          y: m.panel.source_rect.y + a.y,
        };
      });
      return { view_id: m.base_id, z: t.z, actions };
    });
    if (new Set(r.targets.map((t) => t.z)).size !== r.targets.length)
      throw Error("duplicate_surface");
    const pending = (r.layouts ?? []).map((l) => {
      const m = this.member(l.view_id, l.z);
      if (m.v.view.role !== "full") throw Error("layout_requires_full_view");
      if (!r.targets.some((t) => t.z === l.z && t.view_id === l.view_id))
        throw Error("layout_not_in_action");
      const rects = Object.values(l.regions);
      for (const [i, b] of rects.entries()) {
        if (b.x + b.width > m.frame.width || b.y + b.height > m.frame.height)
          throw Error("region_outside_target");
        if (rects.slice(0, i).some((a) => overlaps(a, b)))
          throw Error("overlapping_regions");
      }
      return { l, m };
    });
    if (new Set(pending.map((p) => p.l.z)).size !== pending.length)
      throw Error("duplicate_layout");
    // Cache before asynchronous hashing, including concurrent identical calls.
    const result = (async () => {
      const prepared = await Promise.all(
        pending.map(async ({ l, m }) => ({
          id: m.frame.surface_id,
          layout: {
            regions: l.regions,
            outside: await outside(m.frame, l.regions),
            route_id: m.frame.route_id,
            epoch: m.frame.epoch,
            width: m.frame.width,
            height: m.frame.height,
          },
        })),
      );
      const receipts = await this.base.actSpatial({
        request_id: r.request_id,
        targets,
      });
      for (const p of prepared)
        if (
          receipts.some(
            (a) => a.surface_id === p.id && a.status === "delivered",
          )
        )
          this.layouts.set(p.id, p.layout);
      return receipts;
    })();
    this.requests.set(r.request_id, { hash, result });
    return structuredClone(await result);
  }
}
