import { randomUUID, createHash } from "node:crypto";
import sharp, { type OverlayOptions } from "sharp";
import { z } from "zod";
export type Rect = { x: number; y: number; width: number; height: number };
export type Frame = {
  surface_id: string;
  route_id: string;
  epoch: number;
  revision: string;
  width: number;
  height: number;
  png: Buffer;
};
export type Action =
  | { kind: "click"; x: number; y: number }
  | { kind: "type_text"; text: string }
  | { kind: "key_chord"; keys: string[] };
export type Delivery = {
  status: "delivered" | "blocked" | "unknown";
  reason?: string | undefined;
};
/** A text node exposed by the platform accessibility layer, in frame pixels. */
/** role: StaticText | textbox | a named control (button, checkbox, radio, tab,
 * link, option, menuitem, combobox, slider). checked for checkable controls. */
export type TextNode = {
  role: string;
  text: string;
  rect: Rect;
  checked?: boolean | undefined;
};
export const TEXT_ROLES = ["StaticText", "textbox"];
/** Translation-only template registration result, in frame pixels. */
export type Registration = {
  x: number;
  y: number;
  mad: number;
  outliers: number;
  points_ok?: boolean | undefined;
  point_mad?: number | undefined;
  point_outliers?: number | undefined;
};
/** A model-declared template, cached at the edge by key. Masked rectangles are template-local. */
export type TemplateSpec = {
  key: string;
  png: Buffer;
  masked: Rect[];
  /** Template-local value fields and click targets for the local check. */
  fields?: Rect[];
  points?: { x: number; y: number }[];
};
/** Edge settle condition: field rectangle in exemplar pixels, template origin,
 * last registration and the expected post-condition (see stack.ts Expected). */
export type SettleSpec = {
  template: TemplateSpec;
  hint: { x: number; y: number };
  origin: { x: number; y: number };
  field: Rect;
  expected: { equals: string } | { contains: string[] } | { absent: string };
  timeout_ms: number;
};
export interface SurfacePort {
  /** What the text channel can see: an accessibility tree exposes controls
   * and text; OCR exposes only rendered text. Default "accessibility". */
  readonly textChannel?: "accessibility" | "ocr";
  capture(surface: string): Promise<Frame>;
  /** Optional native text channel (AX/UIA/AT-SPI or CDP accessibility). Must
   * prove the frame is still current before and after the read, and fail closed
   * otherwise. Read-only: never focuses, scrolls or inputs. */
  readText?(frame: Frame): Promise<TextNode[]>;
  /** Optional unbound text probe for post-condition polling; never a basis
   * for planning input (no frame identity is proven). `region` (frame
   * pixels) is a hint: a port may read only there (OCR is costly). */
  probeText?(surface: string, region?: Rect): Promise<TextNode[]>;
  /** Optional frame-bound text snapshot without shipping pixels (edge). */
  snapshotText?(surface: string): Promise<{ frame: Frame; nodes: TextNode[] }>;
  /** Optional edge observation: capture, register the template and read text
   * next to the surface, returning frame identity (png may be empty), the
   * registration and text nodes. Saves shipping pixels to the controller. */
  locate?(
    surface: string,
    template: TemplateSpec,
    hint?: { x: number; y: number },
  ): Promise<{
    frame: Frame;
    match: Registration | null;
    nodes: TextNode[];
    /** Host-side pixel evidence reference, when the edge keeps frames. */
    evidence?: string | undefined;
    /** Appearance fingerprint when the template did not register. */
    fingerprint?: number[] | undefined;
  }>;
  /** Optional edge crops: capture, register the template and return pixel crops
   * of exemplar-coordinate rectangles at the registered offset. */
  locateCrops?(
    surface: string,
    template: TemplateSpec,
    rects: Rect[],
    origin: { x: number; y: number },
  ): Promise<{ frame: Frame; match: Registration | null; crops: Buffer[] }>;
  /** Optional edge act-and-observe: execute exactly like `execute`, then poll
   * next to the surface until the declared field satisfies `expected` or the
   * timeout passes, returning the delivery and the last observation. The
   * controller still decides verification from the returned text nodes. */
  actAndObserve?(
    frame: Frame,
    actions: Action[],
    operation_id: string,
    settle: SettleSpec,
  ): Promise<{
    delivery: Delivery;
    observation?:
      | {
          frame: Frame;
          match: Registration | null;
          nodes: TextNode[];
          evidence?: string | undefined;
        }
      | undefined;
  }>;
  /** Must serialize shared input resources, recheck identity/epoch/pixels under
   * that ownership, and never replay an uncertain effect. */
  execute(
    frame: Frame,
    actions: Action[],
    operation_id: string,
  ): Promise<Delivery>;
}
export type Panel = {
  surface_id: string;
  rect: Rect;
  source_rect: Rect;
  z: number;
  focus_status: "none" | "active" | "invalidated" | "explicit";
};
export type View = {
  view_id: string;
  width: number;
  height: number;
  panels: Panel[];
  png: Buffer;
};
export type Batch = {
  request_id: string;
  targets: { view_id: string; surface_id: string; actions: Action[] }[];
};
const id = z.string().min(1).max(128),
  surface = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  coordinate = z.number().int().min(0).max(16384);
const rect = z.strictObject({
  x: coordinate,
  y: coordinate,
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
});
const KEYS =
  "Ctrl|Alt|Shift|Meta|Enter|Escape|Tab|Backspace|Delete|Space|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight";
const ALIASES: Record<string, string> = {
  control: "Ctrl",
  cmd: "Meta",
  command: "Meta",
  super: "Meta",
  win: "Meta",
  option: "Alt",
  return: "Enter",
  esc: "Escape",
  del: "Delete",
  bksp: "Backspace",
  pgup: "PageUp",
  pgdn: "PageDown",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
};
/** Canonical key name: case-insensitive, with common aliases (CTRL, Esc). */
export function normalizeKey(k: string) {
  const l = k.trim().toLowerCase();
  if (ALIASES[l]) return ALIASES[l];
  const named = KEYS.split("|").find((n) => n.toLowerCase() === l);
  if (named) return named;
  if (/^f(1[0-2]|[1-9])$/.test(l)) return l.toUpperCase();
  return k.trim();
}
const key = z
  .string()
  .describe(`${KEYS.replaceAll("|", ", ")}, F1-F12 or one letter/digit`)
  .transform(normalizeKey)
  .pipe(z.string().regex(new RegExp(`^(${KEYS}|F[1-9]|F1[0-2]|[a-zA-Z0-9])$`)));
export const actionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("click"), x: coordinate, y: coordinate }),
  z.strictObject({ kind: z.literal("type_text"), text: z.string().max(20000) }),
  z.strictObject({
    kind: z.literal("key_chord"),
    keys: z.array(key).min(1).max(4),
  }),
]);
export const observeSchema = z.strictObject({
  surfaces: z
    .array(z.strictObject({ surface_id: surface, crop: rect.optional() }))
    .min(1)
    .max(12),
});
export const batchSchema = z.strictObject({
  request_id: id,
  targets: z
    .array(
      z.strictObject({
        view_id: id,
        surface_id: surface,
        actions: z.array(actionSchema).min(1).max(20),
      }),
    )
    .min(1)
    .max(100),
});
export const focusSchema = z.strictObject({
  regions: z
    .array(z.strictObject({ view_id: id, surface_id: surface, rect }))
    .min(1)
    .max(12),
});
export const spatialSchema = z.strictObject({
  request_id: id,
  targets: z
    .array(
      z.strictObject({
        view_id: id,
        z: z.number().int().positive(),
        actions: z.array(actionSchema).min(1).max(20),
      }),
    )
    .min(1)
    .max(100),
});
type Focus = {
  crop: Rect;
  outside: string;
  route_id: string;
  epoch: number;
  width: number;
  height: number;
};
async function outsideHash(frame: Frame, crop: Rect) {
  const rgb = await sharp(frame.png, { limitInputPixels: 4_000_000 })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer();
  for (let y = crop.y; y < crop.y + crop.height; y++)
    rgb.fill(
      0,
      (y * frame.width + crop.x) * 3,
      (y * frame.width + crop.x + crop.width) * 3,
    );
  return createHash("sha256").update(rgb).digest("hex");
}
const deliverySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("delivered"),
    reason: z.string().optional(),
  }),
  z.strictObject({
    status: z.literal("blocked"),
    reason: z.string().optional(),
  }),
  z.strictObject({
    status: z.literal("unknown"),
    reason: z.string().optional(),
  }),
]);
/** Slots are released independently, including across concurrent tool calls. */
export class Gate {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw Error("invalid_concurrency");
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit)
      await new Promise<void>((r) => this.waiting.push(r));
    else this.active++;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
type Saved = {
  expires: number;
  panels: Panel[];
  frames: Frame[];
  generations: number[];
};
type Receipt = Delivery & { surface_id: string; operation_id: string };
export class VirtualScreen {
  private focusRegions = new Map<string, Focus>();
  private zBySurface = new Map<string, number>();
  private spatialRequests = new Map<
    string,
    { digest: string; result: Promise<Receipt[]> }
  >();
  async focus(request: z.input<typeof focusSchema>) {
    const r = focusSchema.parse(request);
    if (new Set(r.regions.map((s) => s.surface_id)).size !== r.regions.length)
      throw Error("duplicate_surface");
    const plans = r.regions.map((s) => {
      const view = this.views.get(s.view_id);
      if (!view || view.expires <= Date.now()) throw Error("view_expired");
      const i = view.panels.findIndex((p) => p.surface_id === s.surface_id);
      if (i < 0) throw Error("surface_not_in_view");
      if (view.generations[i] !== (this.generations.get(s.surface_id) ?? 0))
        throw Error("observation_consumed");
      const p = view.panels[i]!,
        b = s.rect;
      if (
        b.x < p.rect.x ||
        b.y < p.rect.y ||
        b.x + b.width > p.rect.x + p.rect.width ||
        b.y + b.height > p.rect.y + p.rect.height
      )
        throw Error("region_outside_target");
      return {
        surface_id: s.surface_id,
        frame: view.frames[i]!,
        generation: view.generations[i]!,
        expires: view.expires,
        crop: {
          x: p.source_rect.x + b.x - p.rect.x,
          y: p.source_rect.y + b.y - p.rect.y,
          width: b.width,
          height: b.height,
        },
      };
    });
    const prepared = await Promise.all(
      plans.map(async (p) => ({
        ...p,
        outside: await outsideHash(p.frame, p.crop),
      })),
    );
    for (const p of prepared) {
      if (p.expires <= Date.now()) throw Error("view_expired");
      if (p.generation !== (this.generations.get(p.surface_id) ?? 0))
        throw Error("observation_consumed");
    }
    for (const p of prepared)
      this.focusRegions.set(p.surface_id, {
        crop: p.crop,
        outside: p.outside,
        route_id: p.frame.route_id,
        epoch: p.frame.epoch,
        width: p.frame.width,
        height: p.frame.height,
      });
    return prepared.map((p) => ({
      surface_id: p.surface_id,
      z: this.zBySurface.get(p.surface_id)!,
      source_rect: p.crop,
    }));
  }
  async actSpatial(request: z.input<typeof spatialSchema>): Promise<Receipt[]> {
    const r = spatialSchema.parse(request),
      digest = createHash("sha256").update(JSON.stringify(r)).digest("hex"),
      old = this.spatialRequests.get(r.request_id);
    if (old) {
      if (old.digest !== digest) throw Error("idempotency_conflict");
      return structuredClone(await old.result);
    }
    if (this.spatialRequests.size >= 10_000)
      throw Error("session_request_limit");
    const targets = r.targets.map((t) => {
      const view = this.views.get(t.view_id);
      if (!view || view.expires <= Date.now()) throw Error("view_expired");
      const p = view.panels.find((p) => p.z === t.z);
      if (!p) throw Error("z_not_in_view");
      const actions = t.actions.map((a) => {
        if (a.kind !== "click") return a;
        if (a.x >= p.rect.width || a.y >= p.rect.height)
          throw Error("point_outside_target");
        return { ...a, x: a.x + p.rect.x, y: a.y + p.rect.y };
      });
      return { view_id: t.view_id, surface_id: p.surface_id, actions };
    });
    const result = this.act({ request_id: r.request_id, targets });
    this.spatialRequests.set(r.request_id, { digest, result });
    return structuredClone(await result);
  }
  private views = new Map<string, Saved>();
  private observed = false;
  private requests = new Map<
    string,
    { digest: string; result: Promise<Receipt[]> }
  >();
  private locks = new Map<string, Gate>();
  private generations = new Map<string, number>();
  private captures: Gate;
  private inputs: Gate;
  private ttl: number;
  private capacity: number;
  constructor(
    readonly port: SurfacePort,
    readonly options: {
      mode: "raw" | "composite";
      ttl_ms?: number;
      max_views?: number;
      concurrency?: number;
      first_observation_raw?: boolean;
      surfaces?: string[];
    },
  ) {
    if (options.surfaces) {
      if (new Set(options.surfaces).size !== options.surfaces.length)
        throw Error("duplicate_surface");
      options.surfaces.forEach((id, i) => this.zBySurface.set(id, i + 1));
    }
    this.captures = new Gate(options.concurrency ?? 4);
    this.inputs = new Gate(options.concurrency ?? 4);
    this.ttl = options.ttl_ms ?? 600_000;
    this.capacity = options.max_views ?? 32;
    if (
      !Number.isSafeInteger(this.ttl) ||
      this.ttl < 1 ||
      this.ttl > 600_000 ||
      !Number.isSafeInteger(this.capacity) ||
      this.capacity < 12 ||
      this.capacity > 128
    )
      throw Error("invalid_limits");
  }
  private lock(id: string) {
    let lock = this.locks.get(id);
    if (!lock) {
      lock = new Gate(1);
      this.locks.set(id, lock);
    }
    return lock;
  }
  async observe(
    surfaces: { surface_id: string; crop?: Rect }[],
    options: { full?: boolean; layout?: "raw" | "composite" } = {},
  ): Promise<View[]> {
    const specs = observeSchema.parse({ surfaces }).surfaces;
    if (new Set(specs.map((s) => s.surface_id)).size !== specs.length)
      throw Error("duplicate_surface");
    for (const s of specs)
      if (!this.zBySurface.has(s.surface_id))
        this.zBySurface.set(s.surface_id, this.zBySurface.size + 1);
    const sources = await Promise.all(
      specs.map((s) =>
        this.lock(s.surface_id).run(() =>
          this.captures.run(async () => {
            const f = await this.port.capture(s.surface_id);
            if (
              f.surface_id !== s.surface_id ||
              !f.route_id ||
              !f.revision ||
              !Number.isSafeInteger(f.epoch) ||
              f.epoch < 0 ||
              !Number.isSafeInteger(f.width) ||
              !Number.isSafeInteger(f.height) ||
              f.width < 1 ||
              f.height < 1 ||
              f.width * f.height > 4_000_000 ||
              f.png.length > 16_000_000
            )
              throw Error("invalid_frame");
            const metadata = await sharp(f.png, {
              limitInputPixels: 4_000_000,
            }).metadata();
            if (
              metadata.width !== f.width ||
              metadata.height !== f.height ||
              metadata.format !== "png"
            )
              throw Error("frame_geometry_mismatch");
            let focus = this.focusRegions.get(s.surface_id),
              focus_status: Panel["focus_status"] = "none";
            if (focus) {
              if (
                focus.route_id !== f.route_id ||
                focus.epoch !== f.epoch ||
                focus.width !== f.width ||
                focus.height !== f.height ||
                (await outsideHash(f, focus.crop)) !== focus.outside
              ) {
                this.focusRegions.delete(s.surface_id);
                focus = undefined;
                focus_status = "invalidated";
              } else if (!options.full) focus_status = "active";
            }
            if (s.crop) focus_status = "explicit";
            const crop = s.crop ??
              (!options.full && focus ? focus.crop : undefined) ?? {
                x: 0,
                y: 0,
                width: f.width,
                height: f.height,
              };
            if (
              crop.x + crop.width > f.width ||
              crop.y + crop.height > f.height
            )
              throw Error("crop_outside_source");
            return {
              frame: { ...f, png: Buffer.from(f.png) },
              crop,
              focus_status,
              generation: this.generations.get(s.surface_id) ?? 0,
            };
          }),
        ),
      ),
    );
    if (
      sources.reduce((n, s) => n + s.crop.width * s.crop.height, 0) > 12_000_000
    )
      throw Error("pixel_budget");
    const result: View[] = [],
      layout =
        this.options.first_observation_raw && !this.observed
          ? "raw"
          : (options.layout ?? this.options.mode);
    for (let i = 0; i < sources.length; i += layout === "raw" ? 1 : 4) {
      const chunk = sources.slice(i, i + (layout === "raw" ? 1 : 4));
      const raw = layout === "raw";
      const rows = [chunk.slice(0, 2), chunk.slice(2)].filter(
        (row) => row.length,
      );
      const rowWidths = rows.map((row) =>
        row.reduce((n, s) => n + s.crop.width + 8, 8),
      );
      const rowHeights = rows.map(
        (row) => Math.max(...row.map((s) => s.crop.height)) + 32,
      );
      const width = raw ? chunk[0]!.crop.width : Math.max(...rowWidths),
        height = raw
          ? chunk[0]!.crop.height
          : rowHeights.reduce((a, b) => a + b, 8);
      if (width * height > 16_000_000) throw Error("composite_budget");
      const panels: Panel[] = [],
        overlays: OverlayOptions[] = [];
      for (const [j, s] of chunk.entries()) {
        const row = Math.floor(j / 2),
          x = raw ? 0 : 8 + (j % 2 === 1 ? chunk[j - 1]!.crop.width + 8 : 0),
          y = raw
            ? 0
            : 32 + rowHeights.slice(0, row).reduce((a, b) => a + b, 0);
        const png = await sharp(s.frame.png)
          .extract({
            left: s.crop.x,
            top: s.crop.y,
            width: s.crop.width,
            height: s.crop.height,
          })
          .png()
          .toBuffer();
        panels.push({
          surface_id: s.frame.surface_id,
          z: this.zBySurface.get(s.frame.surface_id)!,
          focus_status: s.focus_status,
          rect: { x, y, width: s.crop.width, height: s.crop.height },
          source_rect: { ...s.crop },
        });
        overlays.push({ input: png, left: x, top: y });
        if (!raw)
          overlays.push({
            input: Buffer.from(
              `<svg width="${s.crop.width}" height="24"><text x="2" y="18" font-family="Arial" font-size="16" fill="white">Z${this.zBySurface.get(s.frame.surface_id)} · ${s.frame.surface_id}</text></svg>`,
            ),
            left: x,
            top: y - 24,
          });
      }
      const png = raw
        ? (overlays[0]!.input as Buffer)
        : await sharp({
            create: { width, height, channels: 3, background: "#1d2633" },
          })
            .composite(overlays)
            .png()
            .toBuffer();
      const view_id = randomUUID();
      this.views.set(view_id, {
        expires: Date.now() + this.ttl,
        panels: structuredClone(panels),
        frames: chunk.map((s) => s.frame),
        generations: chunk.map((s) => s.generation),
      });
      result.push({ view_id, width, height, panels, png });
    }
    while (this.views.size > this.capacity)
      this.views.delete(this.views.keys().next().value!);
    this.observed = true;
    return result;
  }
  async act(request: Batch): Promise<Receipt[]> {
    const r = batchSchema.parse(request),
      digest = createHash("sha256").update(JSON.stringify(r)).digest("hex");
    const old = this.requests.get(r.request_id);
    if (old) {
      if (old.digest !== digest) throw Error("idempotency_conflict");
      return structuredClone(await old.result);
    }
    if (this.requests.size >= 10_000) throw Error("session_request_limit");
    if (new Set(r.targets.map((t) => t.surface_id)).size !== r.targets.length)
      throw Error("duplicate_surface");
    // Resolve and validate EVERY coordinate before starting any target. Clients
    // cannot supply maps, source coordinates or input routes.
    const planned = r.targets.map((t) => {
      const view = this.views.get(t.view_id);
      if (!view || view.expires <= Date.now()) throw Error("view_expired");
      const index = view.panels.findIndex((p) => p.surface_id === t.surface_id);
      if (index < 0) throw Error("surface_not_in_view");
      const panel = view.panels[index]!,
        frame = view.frames[index]!;
      const actions = t.actions.map((a) => {
        if (a.kind !== "click") return a;
        if (
          a.x < panel.rect.x ||
          a.y < panel.rect.y ||
          a.x >= panel.rect.x + panel.rect.width ||
          a.y >= panel.rect.y + panel.rect.height
        )
          throw Error("point_outside_target");
        return {
          ...a,
          x: panel.source_rect.x + a.x - panel.rect.x,
          y: panel.source_rect.y + a.y - panel.rect.y,
        };
      });
      return {
        frame,
        actions,
        generation: view.generations[index]!,
        expires: view.expires,
      };
    });
    const result = Promise.all(
      planned.map((p) =>
        this.lock(p.frame.surface_id).run(() =>
          this.inputs.run(async (): Promise<Receipt> => {
            const operation_id = randomUUID(),
              identity = { surface_id: p.frame.surface_id, operation_id };
            if (Date.now() >= p.expires)
              return { ...identity, status: "blocked", reason: "view_expired" };
            if (
              p.generation !== (this.generations.get(p.frame.surface_id) ?? 0)
            )
              return {
                ...identity,
                status: "blocked",
                reason: "observation_consumed",
              };
            let receipt: Delivery;
            try {
              receipt = deliverySchema.parse(
                await this.port.execute(p.frame, p.actions, operation_id),
              );
            } catch {
              receipt = {
                status: "unknown",
                reason: "adapter_outcome_unknown",
              };
            }
            if (receipt.status !== "blocked")
              this.generations.set(p.frame.surface_id, p.generation + 1);
            return { ...identity, ...receipt };
          }),
        ),
      ),
    );
    this.requests.set(r.request_id, { digest, result });
    return structuredClone(await result);
  }
}
