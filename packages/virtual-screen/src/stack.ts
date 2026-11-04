import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  Gate,
  actionSchema,
  type Action,
  type Frame,
  type Rect,
  type SurfacePort,
  type TextNode,
  type TemplateSpec,
  type SettleSpec,
  type Delivery,
} from "./index.js";
import sharp from "sharp";
import { tileSheet } from "./sheet.js";
import {
  acceptable,
  register,
  type Template,
  fingerprint,
  crop,
  gray,
  locate,
  maskFor,
  type Gray,
  type Match,
} from "./align.js";
import type { ProgressLedger } from "./workset.js";

const coordinate = z.number().int().min(0).max(16384);
const rect = z.strictObject({
  x: coordinate,
  y: coordinate,
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
});
const field = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const step = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("click"), x: coordinate, y: coordinate }),
  z.strictObject({ kind: z.literal("type_field"), field }),
  /** Literal text with {placeholders} filled per surface from fields and
   * inputs (e.g. one parametric script, each surface with its own row). */
  z.strictObject({
    kind: z.literal("type"),
    text: z.string().min(1).max(20000),
  }),
  z.strictObject({
    kind: z.literal("choose"),
    field,
    cases: z
      .array(
        z.strictObject({
          equals: z.string().min(1).max(256),
          x: coordinate,
          y: coordinate,
          label: z.string().min(1).max(128),
        }),
      )
      .min(1)
      .max(8),
    /** Default branch for any other NON-EMPTY value, when the task defines one. */
    otherwise: z
      .strictObject({
        x: coordinate,
        y: coordinate,
        label: z.string().min(1).max(128),
      })
      .optional(),
  }),
  /** Click the centre of the unique text node inside the template whose text
   * equals a field's value or a literal (needs the text channel). */
  z
    .strictObject({
      kind: z.literal("click_text"),
      field: field.optional(),
      text: z.string().min(1).max(256).optional(),
    })
    .refine((v) => !!v.field !== !!v.text, "field_xor_text"),
  actionSchema.options[2],
]);
/**
 * One decision broadcast over many Z surfaces. All geometry is in the exemplar
 * view's pixels. The runtime registers the template on every surface, reads the
 * declared fields through the native text channel, and executes per surface.
 */
export const policySchema = z.strictObject({
  request_id: z.string().min(1).max(128),
  view_id: z.string().min(1).max(128),
  template: rect,
  fields: z
    .array(z.strictObject({ name: field, rect }))
    .min(1)
    .max(8),
  ignore: z.array(rect).max(8).optional(),
  /** Columns of the host's task table used by this policy (e.g. a spec sheet
   * row per surface). Steps use them like fields; they are never read from
   * the screen and never transcribed by the model. */
  inputs: z.array(field).max(8).optional(),
  /** The model's own per-surface values for inputs, e.g. a different edit
   * script for each surface in one decision. Without `surfaces`, the policy
   * runs on exactly the assigned surfaces. */
  assign: z
    .record(z.string(), z.record(field, z.string().min(1).max(20000)))
    .optional(),
  steps: z.array(step).min(1).max(12),
  /** Required, except in a free task: without it each surface's result is
   * "delivered" (template matched, input sent) and the model checks the
   * effect by looking, e.g. with an overview. */
  verify: z
    .union([
      z.strictObject({ field, equals: z.string().min(1).max(512) }),
      z.strictObject({
        field,
        contains: z.array(z.string().min(1).max(256)).min(1).max(8),
      }),
      z.strictObject({ field, absent: z.literal(true) }),
    ])
    .optional(),
  /** item: one durable task item per execution (default). prepare: clear an
   * interruption once per surface; never counts as task progress. */
  mode: z.enum(["item", "prepare"]).optional(),
  /** Items this policy performs per surface in this run (default: until the
   * surface is complete). Tasks whose items differ use one policy each. */
  items: z.number().int().min(1).max(100).optional(),
  surfaces: z.array(z.string()).min(1).max(100).optional(),
  dry_run: z.boolean().optional(),
  /** Vision mode only: model-transcribed field values per surface, bound to the
   * frames of a fleet_crops snapshot (crops_id). One item per surface per run. */
  values: z
    .record(z.string(), z.record(z.string(), z.string().max(256)))
    .optional(),
  crops_id: z.string().max(64).optional(),
  canary: z.boolean().optional(),
});
export type Policy = z.infer<typeof policySchema>;
export const cropsSchema = z.strictObject({
  view_id: z.string().min(1).max(128),
  template: rect,
  fields: z
    .array(z.strictObject({ name: field, rect }))
    .min(1)
    .max(8),
  ignore: z.array(rect).max(8).optional(),
  surfaces: z.array(z.string()).min(1).max(100).optional(),
});
export const confirmSchema = z.strictObject({
  crops_id: z.string().max(64),
  checks: z.record(
    z.string(),
    z.strictObject({ text: z.string().max(4096), choice: z.string().max(128) }),
  ),
});
export type StackView = {
  view_id: string;
  surface_id: string;
  z: number;
  width: number;
  height: number;
  png: Buffer;
};
export type SurfaceResult = {
  surface_id: string;
  z: number;
  status:
    | "verified"
    | "delivered"
    | "prepared"
    | "canary"
    | "dry_run"
    | "exception"
    | "skipped";
  completed: number;
  reason?: string | undefined;
  detail?: string | undefined;
  items?: number;
  ms?: number;
};
type Compiled = {
  id: string;
  policy: Policy;
  template: Gray;
  mask: Uint8Array;
  tpl: Template;
  spec: TemplateSpec;
  /** Per click point (absolute, exemplar coordinates): the element it acts on. */
  bindings: Map<string, Binding | null>;
  /** Items each surface had completed when this run first reached it. */
  baseline: Map<string, number>;
};
/** The post-condition's field; only free-task steps may run without one. */
const verifyField = (c: Compiled) => {
  if (!c.policy.verify) throw Error("verify_required");
  return c.policy.verify.field;
};
type Binding = { role: string; text: string };
type Observation = {
  frame: Frame;
  match: Match | null;
  nodes: TextNode[];
  evidence?: string | undefined;
  fingerprint?: number[] | undefined;
};
const inside = (r: Rect, outer: Rect) =>
  r.x >= outer.x &&
  r.y >= outer.y &&
  r.x + r.width <= outer.x + outer.width &&
  r.y + r.height <= outer.y + outer.height;
const point = (x: number, y: number, outer: Rect) =>
  inside({ x, y, width: 1, height: 1 }, outer);
/** Placeholder names in a literal text step. */
const placeholders = (t: string) =>
  [...t.matchAll(/\{([a-z][a-z0-9_]{0,31})\}/g)].map((m) => m[1]!);
/** Fields whose reading becomes input or a choice. */
const valueFields = (p: Policy) =>
  new Set(
    p.steps.flatMap((s) =>
      s.kind === "type_field" || s.kind === "choose"
        ? [s.field]
        : s.kind === "click_text" && s.field
          ? [s.field]
          : s.kind === "type"
            ? placeholders(s.text)
            : [],
    ),
  );
/** The smallest element containing a point. */
export function hitNode(nodes: TextNode[], x: number, y: number) {
  let best: TextNode | undefined;
  for (const n of nodes)
    if (
      x >= n.rect.x &&
      x < n.rect.x + n.rect.width &&
      y >= n.rect.y &&
      y < n.rect.y + n.rect.height &&
      (!best ||
        n.rect.width * n.rect.height < best.rect.width * best.rect.height)
    )
      best = n;
  return best;
}
/** A text run the field reads (centre inside) that extends beyond it. */
export function cutNode(nodes: TextNode[], r: Rect, tolerance = 4) {
  return nodes
    .filter((n) => n.role === "StaticText" || n.role === "textbox")
    .find((n) => {
      const cx = n.rect.x + n.rect.width / 2,
        cy = n.rect.y + n.rect.height / 2;
      const read =
        cx >= r.x && cx < r.x + r.width && cy >= r.y && cy < r.y + r.height;
      return (
        read &&
        (n.rect.x < r.x - tolerance ||
          n.rect.y < r.y - tolerance ||
          n.rect.x + n.rect.width > r.x + r.width + tolerance ||
          n.rect.y + n.rect.height > r.y + r.height + tolerance)
      );
    });
}
export function readField(nodes: TextNode[], r: Rect) {
  return (
    nodes
      // Fields read text only; controls duplicate their inner text.
      .filter((n) => n.role === "StaticText" || n.role === "textbox")
      .filter((n) => {
        const cx = n.rect.x + n.rect.width / 2,
          cy = n.rect.y + n.rect.height / 2;
        return (
          cx >= r.x && cx < r.x + r.width && cy >= r.y && cy < r.y + r.height
        );
      })
      .sort((a, b) =>
        Math.abs(a.rect.y - b.rect.y) > a.rect.height / 2
          ? a.rect.y - b.rect.y
          : a.rect.x - b.rect.x,
      )
      .map((n) => n.text)
      .join("")
      .trim()
  );
}
/** Expected post-condition of the verify field, from values read before input. */
export function expect(
  p: Policy,
  values: Record<string, string>,
): Expected | null {
  if (!p.verify) return null;
  return "equals" in p.verify
    ? { equals: fill(p.verify.equals, values) }
    : "contains" in p.verify
      ? { contains: p.verify.contains.map((t: string) => fill(t, values)) }
      : { absent: values[p.verify.field] ?? "" };
}
export type Expected =
  { equals: string } | { contains: string[] } | { absent: string };
/** Text channels disagree on whitespace (OCR reads "12m" or "12 m"), so
 * post-conditions compare text with all whitespace removed. */
const squash = (t: string) => t.replace(/\s+/g, "");
export const satisfied = (e: Expected, seen: string | undefined) => {
  if (seen === undefined) return false;
  const s = squash(seen);
  return "equals" in e
    ? s === squash(e.equals)
    : "contains" in e
      ? e.contains.every((t) => s.includes(squash(t)))
      : e.absent !== "" && !s.includes(squash(e.absent));
};
/** A post-condition from an earlier delivery's values, or null when that
 * delivery lacks this policy's placeholders (it belongs to another item). */
function rebuild(
  p: Policy,
  prior: { values: Record<string, string>; choice: string },
): Expected | null {
  try {
    return expect(p, { ...prior.values, choice: prior.choice });
  } catch (e) {
    if (String(e).includes("unknown_placeholder")) return null;
    throw e;
  }
}
export function fill(template: string, values: Record<string, string>) {
  return template.replace(/\{([a-z][a-z0-9_]{0,31})\}/g, (_, k: string) => {
    if (!(k in values)) throw Error("unknown_placeholder:" + k);
    return values[k]!;
  });
}
async function bounded<T>(work: Promise<T>, ms: number, code: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(code)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class Exception extends Error {
  constructor(
    readonly reason: string,
    readonly detail?: string,
    readonly frame?: Frame,
  ) {
    super(reason);
  }
}

/**
 * Z broadcast ("cerebellum"): the model decides once per layout class; the
 * runtime registers, reads, executes and verifies each surface independently.
 * Divergent surfaces leave the policy without input and return to the model.
 */
export class StackScreen {
  private views = new Map<
    string,
    { frame: Frame; z: number; nodes: Promise<TextNode[] | null> }
  >();
  private policies = new Map<string, string>();
  /** Machine-read values used for each surface's last dispatched item. */
  private dispatched = new Map<
    string,
    { values: Record<string, string>; choice: string; operation: string }
  >();
  private gate: Gate;
  constructor(
    readonly port: SurfacePort,
    readonly ledger: ProgressLedger,
    readonly surfaces: string[],
    private options: {
      concurrency?: number;
      /** text: values via the text channel (full Infra). vision: no text
       * channel anywhere; values and receipts are transcribed by the model
       * from fleet_crops contact sheets (ablation B-V). */
      values?: "text" | "vision";
      /** item (default): a policy run delivers and verifies task items.
       * free: the model declares items done itself (open-ended work such as
       * building a model); every policy is a step that applies once per
       * surface per run, verified, never counted as an item, and finished
       * (declared) surfaces are left alone. */
      contract?: "item" | "free";
      /** Task table supplied by the host: surface id -> column -> value. */
      inputs?: Record<string, Record<string, string>>;
      /** Ablation only: false clicks text centres without avoiding occlusion. */
      occlusion?: boolean;
      /** Ablation only: false disables semantic binding of clicks and fields. */
      binding?: boolean;
      /** Ablation only: "lenient" restores the old tolerant registration. */
      registration?: "strict" | "lenient";
      /** Ablation only: false disables the per-click-target local check. */
      pointCheck?: boolean;
      /** Ablation only: false disables evidence-based closure of unknowns. */
      resolve?: boolean;
      /** Use the port's edge observation when available (default true). */
      edge?: boolean;
      settle_ms?: number;
      deadline_ms?: number;
      evidence?: {
        source?: (f: Frame, purpose: string) => Promise<void>;
        delivery?: (record: unknown) => Promise<void>;
      };
    } = {},
  ) {
    if (!port.readText) throw Error("text_channel_required");
    this.gate = new Gate(options.concurrency ?? 16);
  }
  private z(id: string) {
    const z = this.surfaces.indexOf(id) + 1;
    if (!z) throw Error("unknown_surface");
    return z;
  }
  private register(frame: Frame): StackView {
    const view_id = "x" + randomUUID().slice(0, 8);
    this.views.set(view_id, {
      frame,
      z: this.z(frame.surface_id),
      // The exemplar's elements, read while the frame is current.
      nodes:
        this.options.values === "vision" || this.options.binding === false
          ? Promise.resolve(null)
          : this.port.readText!(frame).catch(() => null),
    });
    while (this.views.size > 64)
      this.views.delete(this.views.keys().next().value!);
    return {
      view_id,
      surface_id: frame.surface_id,
      z: this.z(frame.surface_id),
      width: frame.width,
      height: frame.height,
      png: frame.png,
    };
  }
  /**
   * Review a fleet in one image: every listed surface (default all), cropped
   * to `region` when given, tiled with its id. Read-only; not an exemplar
   * (planning uses observe).
   */
  async overview(
    ids: string[] = this.surfaces,
    region?: Rect,
    tile = { width: 480, height: 300 },
  ) {
    if (!ids.length || ids.length > 100)
      throw Error("invalid_overview_targets");
    for (const id of ids) this.z(id);
    const shots = await Promise.all(
      ids.map(async (id) => {
        try {
          const f = await bounded(
            this.port.capture(id),
            30000,
            "capture_timeout",
          );
          const png = region
            ? await sharp(f.png)
                .extract({
                  left: region.x,
                  top: region.y,
                  width: Math.min(region.width, f.width - region.x),
                  height: Math.min(region.height, f.height - region.y),
                })
                .png()
                .toBuffer()
            : f.png;
          return { label: `${id} (Z${this.z(id)})`, png };
        } catch (e) {
          const png = await sharp({
            create: { width: 16, height: 10, channels: 3, background: "#400" },
          })
            .png()
            .toBuffer();
          return { label: `${id}: ${String(e).slice(0, 40)}`, png };
        }
      }),
    );
    return {
      png: await tileSheet(shots, tile),
      surfaces: ids,
      fleet: this.ledger.summary(),
    };
  }
  async observe(ids: string[]) {
    if (!ids.length || ids.length > 4 || new Set(ids).size !== ids.length)
      throw Error("invalid_observation_targets");
    const views: StackView[] = [],
      errors: { surface_id: string; error: string }[] = [];
    await Promise.all(
      ids.map(async (id) => {
        this.z(id);
        try {
          const f = await bounded(
            this.port.capture(id),
            30000,
            "capture_timeout",
          );
          await this.options.evidence?.source?.(f, "observe");
          views.push(this.register(f));
        } catch (e) {
          errors.push({ surface_id: id, error: String(e).slice(0, 160) });
        }
      }),
    );
    return { views, errors, fleet: this.ledger.summary() };
  }
  private async compile(p: Policy): Promise<Compiled> {
    const v = this.views.get(p.view_id);
    if (!v) throw Error("unknown_or_expired_view");
    const t = p.template;
    if (
      !inside(t, { x: 0, y: 0, width: v.frame.width, height: v.frame.height })
    )
      throw Error("template_outside_view");
    if (t.width * t.height < 2500) throw Error("template_too_small");
    const names = new Set<string>();
    for (const f of p.fields) {
      if (names.has(f.name)) throw Error("duplicate_field");
      names.add(f.name);
      if (!inside(f.rect, t)) throw Error("field_outside_template:" + f.name);
    }
    for (const r of p.ignore ?? [])
      if (!inside(r, t)) throw Error("ignore_outside_template");
    const columns = new Set(
      Object.values(this.options.inputs ?? {}).flatMap((row) =>
        Object.keys(row),
      ),
    );
    const usable = new Set(names);
    const assigned = p.surfaces ?? Object.keys(p.assign ?? {});
    for (const id of Object.keys(p.assign ?? {}))
      if (!this.surfaces.includes(id)) throw Error("unknown_surface:" + id);
    for (const i of p.inputs ?? []) {
      if (names.has(i)) throw Error("input_shadows_field:" + i);
      const own =
        !!p.assign &&
        assigned.length > 0 &&
        assigned.every((id) => p.assign?.[id]?.[i]);
      if (!columns.has(i) && !own) throw Error("unknown_input:" + i);
      usable.add(i);
    }
    let choose = 0;
    for (const s of p.steps) {
      if (s.kind === "click" && !point(s.x, s.y, t))
        throw Error("click_outside_template");
      if (
        (s.kind === "type_field" || s.kind === "choose") &&
        !usable.has(s.field)
      )
        throw Error("unknown_field:" + s.field);
      if (s.kind === "click_text" && s.field && !usable.has(s.field))
        throw Error("unknown_field:" + s.field);
      if (s.kind === "type")
        for (const name of placeholders(s.text))
          if (!usable.has(name)) throw Error("unknown_placeholder:" + name);
      if (s.kind === "choose") {
        choose++;
        if (new Set(s.cases.map((c) => c.equals)).size !== s.cases.length)
          throw Error("duplicate_case");
        for (const c of [...s.cases, ...(s.otherwise ? [s.otherwise] : [])])
          if (!point(c.x, c.y, t)) throw Error("case_outside_template");
      }
    }
    if (choose > 1) throw Error("at_most_one_choose");
    if (!p.steps.some((s) => s.kind !== "key_chord"))
      throw Error(
        "no_effective_step (keys alone have no checked target: add a click on the element that should receive them)",
      );
    if (!p.verify) {
      if (this.options.contract !== "free")
        throw Error("verify_required (only a free task may omit it)");
    } else if (!names.has(p.verify.field)) throw Error("unknown_verify_field");
    else if ((p.mode ?? "item") === "item" && "absent" in p.verify)
      throw Error("item_requires_positive_verification");
    const local = (r: Rect) => ({ ...r, x: r.x - t.x, y: r.y - t.y });
    const masked = [...p.fields.map((f) => f.rect), ...(p.ignore ?? [])].map(
      local,
    );
    const g = await gray(v.frame.png),
      template = crop(g, t),
      mask = maskFor(t.width, t.height, masked);
    if (mask.reduce((n, x) => n + x, 0) < t.width * t.height * 0.25)
      throw Error("template_mostly_masked");
    const {
      request_id: _r,
      surfaces: _s,
      dry_run: _d,
      canary: _c,
      values: _v,
      crops_id: _ci,
      ...shape
    } = p;
    if (
      p.mode === "prepare" &&
      this.options.contract !== "free" &&
      (p.inputs?.length ||
        p.steps.some(
          (s) =>
            s.kind === "type_field" ||
            (s.kind === "type" && placeholders(s.text).length),
        ))
    )
      throw Error("prepare_cannot_type_task_values");
    const id = createHash("sha256")
      .update(JSON.stringify({ shape, template: v.frame.revision }))
      .digest("hex")
      .slice(0, 16);
    const png = await sharp(v.frame.png)
      .extract({ left: t.x, top: t.y, width: t.width, height: t.height })
      .png()
      .toBuffer();
    // Click targets (template-local) for the per-target local check.
    const points =
      this.options.pointCheck === false
        ? []
        : p.steps.flatMap((st) =>
            st.kind === "click"
              ? [{ x: st.x - t.x, y: st.y - t.y }]
              : st.kind === "choose"
                ? [...st.cases, ...(st.otherwise ? [st.otherwise] : [])].map(
                    (k) => ({
                      x: k.x - t.x,
                      y: k.y - t.y,
                    }),
                  )
                : [],
          );
    const fields = p.fields.map((f) => local(f.rect));
    // Every click target must be verifiable: at most half of its 28x28
    // neighbourhood may lie inside value fields.
    for (const pt of points) {
      let covered = 0,
        total = 0;
      for (let y = pt.y - 14; y < pt.y + 14; y++)
        for (let x = pt.x - 14; x < pt.x + 14; x++) {
          if (x < 0 || y < 0 || x >= t.width || y >= t.height) continue;
          total++;
          if (
            fields.some(
              (f) =>
                x >= f.x && x < f.x + f.width && y >= f.y && y < f.y + f.height,
            )
          )
            covered++;
        }
      if (total && covered > total / 2)
        throw Error(
          `click_target_inside_field:${pt.x + t.x},${pt.y + t.y} (keep value fields off click targets)`,
        );
    }
    const bindings = await this.bind(p, await v.nodes);
    const tpl: Template = {
      gray: template,
      mask,
      points,
      pointMask: maskFor(t.width, t.height, fields),
    };
    return {
      id,
      policy: p,
      template,
      mask,
      tpl,
      spec: { key: id, png, masked, fields, points },
      bindings,
      baseline: new Map(),
    };
  }
  /**
   * Semantic binding: every click acts on an element of the exemplar, value
   * fields hold whole text runs, and focus is not moved blind. Pixels alone
   * cannot tell that a click lands on blank page or that a field cuts a
   * sentence in half.
   */
  private async bind(p: Policy, nodes: TextNode[] | null) {
    const bindings = new Map<string, Binding | null>();
    // Binding reads the text layer; the vision ablation has none.
    if (this.options.binding === false || this.options.values === "vision")
      return bindings;
    if (!nodes)
      throw Error("exemplar_text_unavailable (observe the surface again)");
    const weak = !/\{[a-z]/.test(JSON.stringify(p.verify));
    if (
      weak &&
      p.steps.some((s) => s.kind === "key_chord" && s.keys.includes("Tab"))
    )
      throw Error(
        "blind_focus_navigation (with a submission-only post-condition, click the control instead of moving focus with Tab)",
      );
    const used = valueFields(p);
    for (const f of p.fields) {
      if (!used.has(f.name)) continue;
      const cut = cutNode(nodes, f.rect);
      if (cut)
        throw Error(
          `field_cuts_text:${f.name}:${JSON.stringify(cut.text)} (a value field must cover whole text runs; read this value per surface instead)`,
        );
    }
    // OCR sees text, not controls (icons have no text): clicks are held by
    // the pixel registration and the per-target local check instead.
    if (this.port.textChannel === "ocr") return bindings;
    const points = p.steps.flatMap((s) =>
      s.kind === "click"
        ? [{ x: s.x, y: s.y }]
        : s.kind === "choose"
          ? [...s.cases, ...(s.otherwise ? [s.otherwise] : [])]
          : [],
    );
    for (const pt of points) {
      const n = hitNode(nodes, pt.x, pt.y);
      if (!n && p.mode !== "prepare")
        throw Error(
          `click_target_unbound:${pt.x},${pt.y} (no control or text there; click a visible element)`,
        );
      bindings.set(
        `${pt.x},${pt.y}`,
        n
          ? {
              role: n.role,
              // Element text that is task data (inside a field) or editable varies.
              text:
                n.role === "textbox" ||
                p.fields.some((f) =>
                  inside(
                    {
                      x: Math.floor(n.rect.x + n.rect.width / 2),
                      y: Math.floor(n.rect.y + n.rect.height / 2),
                      width: 1,
                      height: 1,
                    },
                    f.rect,
                  ),
                )
                  ? ""
                  : n.text.trim(),
            }
          : null,
      );
    }
    return bindings;
  }
  /** Capture, register and read one surface; at the edge when the port can. */
  private async observeAt(
    c: Compiled,
    id: string,
    hint?: Match,
  ): Promise<Observation> {
    if (this.port.locate && this.options.edge !== false)
      return bounded(
        this.port.locate(id, c.spec, hint),
        30000,
        "locate_timeout",
      );
    const frame = await bounded(
      this.port.capture(id),
      30000,
      "capture_timeout",
    );
    const match = register(await gray(frame.png), c.tpl, hint);
    const nodes = await bounded(
      this.port.readText!(frame),
      15000,
      "read_timeout",
    );
    return { frame, match, nodes };
  }
  private registered(o: Observation) {
    if (!this.ok(o.match) && o.fingerprint)
      this.fingerprints.set(o.frame.surface_id, o.fingerprint);
    if (!this.ok(o.match))
      throw new Exception(
        "template_mismatch",
        o.match
          ? `mad=${o.match.mad.toFixed(2)} outliers=${o.match.outliers.toFixed(4)}`
          : "none",
        o.frame,
      );
    return o.match!;
  }
  private values(c: Compiled, nodes: TextNode[], m: Match) {
    const dx = m.x - c.policy.template.x,
      dy = m.y - c.policy.template.y;
    const values: Record<string, string> = {};
    for (const f of c.policy.fields)
      values[f.name] = readField(nodes, {
        ...f.rect,
        x: f.rect.x + dx,
        y: f.rect.y + dy,
      });
    return { values, dx, dy };
  }
  /** This surface's row of the host task table, for the policy's inputs. */
  private given(c: Compiled, id: string, frame: Frame) {
    const out: Record<string, string> = {};
    for (const i of c.policy.inputs ?? []) {
      const v = c.policy.assign?.[id]?.[i] ?? this.options.inputs?.[id]?.[i];
      if (!v) throw new Exception("no_input_value", i, frame);
      out[i] = v;
    }
    return out;
  }
  private async evidence(f: Frame, purpose: string) {
    if (f.png.length) await this.options.evidence?.source?.(f, purpose);
  }
  private plan(
    c: Compiled,
    values: Record<string, string>,
    dx: number,
    dy: number,
    frame: Frame,
    nodes: TextNode[] | null,
  ) {
    const actions: Action[] = [],
      typed: string[] = [];
    let choice = "";
    // The exemplar's fields held whole text runs; so must this surface's.
    if (nodes && this.options.binding !== false)
      for (const f of c.policy.fields) {
        if (!valueFields(c.policy).has(f.name)) continue;
        const cut = cutNode(nodes, {
          ...f.rect,
          x: f.rect.x + dx,
          y: f.rect.y + dy,
        });
        if (cut)
          throw new Exception(
            "field_cuts_text",
            `${f.name}:${JSON.stringify(cut.text)}`,
            frame,
          );
      }
    for (const s of c.policy.steps) {
      if (s.kind === "click") {
        this.check(c, s, dx, dy, nodes, frame);
        actions.push({ kind: "click", x: s.x + dx, y: s.y + dy });
      } else if (s.kind === "type_field") {
        const v = values[s.field]!;
        if (!v) throw new Exception("field_empty", s.field, frame);
        actions.push({ kind: "type_text", text: v });
        typed.push(v);
      } else if (s.kind === "type") {
        for (const name of placeholders(s.text))
          if (!values[name]) throw new Exception("field_empty", name, frame);
        const text = fill(s.text, values);
        actions.push({ kind: "type_text", text });
        typed.push(text);
      } else if (s.kind === "choose") {
        const v = values[s.field]!,
          k =
            s.cases.find((x) => x.equals === v) ??
            (v ? s.otherwise : undefined);
        if (!k)
          throw new Exception(
            "no_matching_case",
            `${s.field}=${JSON.stringify(v)}`,
            frame,
          );
        this.check(c, k, dx, dy, nodes, frame);
        actions.push({ kind: "click", x: k.x + dx, y: k.y + dy });
        choice = k.label;
      } else if (s.kind === "click_text") {
        if (!nodes)
          throw new Exception("text_channel_unavailable", undefined, frame);
        const want = s.field ? values[s.field]! : s.text!;
        if (!want) throw new Exception("field_empty", s.field, frame);
        const t = c.policy.template,
          box = { ...t, x: t.x + dx, y: t.y + dy };
        const hits = nodes.filter((n) => {
          const cx = n.rect.x + n.rect.width / 2,
            cy = n.rect.y + n.rect.height / 2;
          return (
            n.text.trim() === want &&
            cx >= box.x &&
            cx < box.x + box.width &&
            cy >= box.y &&
            cy < box.y + box.height
          );
        });
        // A control and the text inside it describe one target: drop any hit
        // that contains another hit's centre and is not smaller than it.
        const centreIn = (a: TextNode, b: TextNode) => {
          const cx = a.rect.x + a.rect.width / 2,
            cy = a.rect.y + a.rect.height / 2;
          return (
            cx >= b.rect.x &&
            cx < b.rect.x + b.rect.width &&
            cy >= b.rect.y &&
            cy < b.rect.y + b.rect.height
          );
        };
        const area = (a: TextNode) => a.rect.width * a.rect.height;
        const distinct = hits.filter(
          (h, i) =>
            !hits.some(
              (o, j) =>
                j !== i &&
                centreIn(o, h) &&
                (area(o) < area(h) || (area(o) === area(h) && j < i)),
            ),
        );
        hits.splice(0, hits.length, ...distinct);
        if (hits.length !== 1)
          throw new Exception(
            hits.length ? "click_text_ambiguous" : "click_text_missing",
            JSON.stringify(want),
            frame,
          );
        const n = hits[0]!;
        const pt =
          this.options.occlusion === false
            ? {
                x: Math.round(n.rect.x + n.rect.width / 2),
                y: Math.round(n.rect.y + n.rect.height / 2),
              }
            : unoccludedPoint(n, nodes);
        if (!pt)
          throw new Exception(
            "click_text_occluded",
            JSON.stringify(want),
            frame,
          );
        actions.push({ kind: "click", x: pt.x, y: pt.y });
      } else actions.push(s);
    }
    for (const a of actions)
      if (
        a.kind === "click" &&
        (a.x >= frame.width || a.y >= frame.height || a.x < 0 || a.y < 0)
      )
        throw new Exception("click_outside_frame", undefined, frame);
    const expected = { text: typed.join("\n"), choice };
    const receipt = expect(c.policy, { ...values, choice });
    // A post-condition that already holds before input proves nothing.
    // (Without a reading of the verify field, as in vision mode, it is unknown.)
    if (
      receipt &&
      c.policy.verify &&
      values[verifyField(c)] !== undefined &&
      satisfied(receipt, values[verifyField(c)])
    )
      throw new Exception("verify_not_discriminative", verifyField(c), frame);
    return { actions, expected, receipt };
  }
  /** The element under a click point must be the exemplar's element. */
  private check(
    c: Compiled,
    pt: { x: number; y: number },
    dx: number,
    dy: number,
    nodes: TextNode[] | null,
    frame: Frame,
  ) {
    const want = c.bindings.get(`${pt.x},${pt.y}`);
    if (!want || !nodes) return;
    const n = hitNode(nodes, pt.x + dx, pt.y + dy);
    if (
      !n ||
      n.role !== want.role ||
      (want.text && n.text.trim() !== want.text)
    )
      throw new Exception(
        "click_target_changed",
        JSON.stringify({ want, got: n && { role: n.role, text: n.text } }),
        frame,
      );
  }
  private async settle(
    c: Compiled,
    id: string,
    receipt: Expected,
    hint: Match,
    commit: boolean | "resolve" = true,
  ): Promise<{
    ok: boolean;
    hint: Match;
    seen?: string | undefined;
    obs?: Observation | undefined;
  }> {
    const end = Date.now() + (this.options.settle_ms ?? 5000);
    let seen: string | undefined,
      last: Observation | undefined,
      misses = 0;
    for (;;) {
      try {
        if (this.port.probeText) {
          // Screenshot-free wait; only a satisfied probe earns a bound observation.
          const f = c.policy.fields.find((f) => f.name === verifyField(c))!;
          const region = {
            ...f.rect,
            x: f.rect.x + hint.x - c.policy.template.x,
            y: f.rect.y + hint.y - c.policy.template.y,
          };
          const probe = this.values(
            c,
            await this.port.probeText(id, region),
            hint,
          ).values[verifyField(c)];
          // Probes read at the last proven offset; every third miss falls
          // through to a full registration in case the layout moved.
          if (!satisfied(receipt, probe) && ++misses % 3 !== 0) {
            seen = probe;
            if (Date.now() >= end) return { ok: false, hint, seen, obs: last };
            await new Promise((r) => setTimeout(r, 100));
            continue;
          }
        }
        const o = await this.observeAt(c, id, hint);
        last = o;
        // An application may legitimately change template pixels after the
        // final item (e.g. a completion heading). Registration is preferred;
        // otherwise the receipt is read, never acted on, at the last proven offset.
        const registered = this.ok(o.match);
        const m = registered ? o.match! : hint;
        if (registered) hint = m;
        seen = this.values(c, o.nodes, m).values[verifyField(c)];
        if (satisfied(receipt, seen)) {
          await this.evidence(o.frame, "verify");
          const reusable = registered ? o : undefined;
          if (!commit) return { ok: true, hint, obs: reusable };
          const view = "stack:" + o.frame.revision.slice(0, 16);
          await this.ledger.observed(id, view);
          const row = this.ledger.get(id);
          if (commit === "resolve") {
            await this.ledger.resolve(
              id,
              view,
              row.expected!.text,
              row.expected!.choice,
            );
            return { ok: true, hint, obs: reusable };
          }
          await this.ledger.verify(
            id,
            view,
            row.expected!.text,
            row.expected!.choice,
          );
          return { ok: true, hint, obs: reusable };
        }
      } catch {
        // A transitional frame can fail to register or change during a read.
      }
      if (Date.now() >= end) return { ok: false, hint, seen, obs: last };
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  /** At most one policy pipeline per surface; concurrent runs on disjoint
   * surfaces are independent, overlapping ones yield surface_busy. */
  private ok(m: Match | null) {
    return acceptable(m, this.options.registration ?? "strict");
  }
  private busy = new Set<string>();
  /** Surfaces whose input port was entered (for canary applicability). */
  private inputAttempted = new Set<string>();
  private async surface(
    c: Compiled,
    id: string,
    deadline: number,
    dry: boolean,
    limit = Infinity,
    seed?: Observation,
  ): Promise<SurfaceResult> {
    if (this.busy.has(id))
      return {
        surface_id: id,
        z: this.z(id),
        status: "exception",
        completed: this.ledger.get(id).completed,
        reason: "surface_busy",
      };
    this.busy.add(id);
    try {
      return await this.pipeline(c, id, deadline, dry, limit, seed);
    } finally {
      this.busy.delete(id);
    }
  }
  private async pipeline(
    c: Compiled,
    id: string,
    deadline: number,
    dry: boolean,
    limit: number,
    seed?: Observation,
  ): Promise<SurfaceResult> {
    const z = this.z(id),
      t0 = performance.now();
    let hint: Match | undefined,
      // A read-only observation taken while the canary ran; execute still
      // refuses input if the frame changed since.
      reuse: Observation | undefined =
        seed && this.ok(seed.match) ? seed : undefined,
      items = 0,
      blocked = 0;
    const result = (r: Partial<SurfaceResult>): SurfaceResult => ({
      surface_id: id,
      z,
      status: "exception",
      completed: this.ledger.get(id).completed,
      items,
      ms: Math.round(performance.now() - t0),
      ...r,
    });
    try {
      for (;;) {
        const row = this.ledger.get(id);
        if (row.state === "verified") return result({ status: "verified" });
        if (row.state === "awaiting_verification") {
          // A corrected policy may verify an earlier delivery: the expected
          // receipt is rebuilt from the values read BEFORE that input.
          const prior = this.dispatched.get(id);
          // Only a policy whose post-condition can be built from that
          // delivery's values may verify it (not a later item's policy).
          const expected = prior && rebuild(c.policy, prior);
          if (!expected)
            return result({ reason: "verification_requires_model" });
          if (!hint) hint = this.registered(await this.observeAt(c, id));
          if (dry) {
            const o = await this.observeAt(c, id, hint);
            const { values } = this.values(c, o.nodes, hint);
            return result({
              status: "dry_run",
              detail: JSON.stringify({
                pending_verification: {
                  expected,
                  seen: values[verifyField(c)],
                  match: satisfied(expected, values[verifyField(c)]),
                },
              }),
            });
          }
          const s = await this.settle(c, id, expected, hint);
          hint = s.hint;
          if (!s.ok)
            throw new Exception(
              "receipt_mismatch",
              JSON.stringify({ expected, seen: s.seen }),
              s.obs?.frame,
            );
          continue;
        }
        if (row.state === "unknown") {
          // Evidence-based closure of an uncertain delivery, never a replay.
          const prior = this.dispatched.get(id);
          if (
            this.options.resolve === false ||
            !prior ||
            prior.operation !== row.operation_id
          )
            return result({ reason: "unknown", detail: row.reason });
          const expected = rebuild(c.policy, prior);
          if (!expected)
            return result({ reason: "unknown", detail: row.reason });
          if (!hint) hint = this.registered(await this.observeAt(c, id));
          const s = await this.settle(c, id, expected, hint, "resolve");
          hint = s.hint;
          if (!s.ok)
            return result({ reason: "unknown_effect", detail: row.reason });
          reuse = s.obs;
          continue;
        }
        if (row.state !== "ready")
          return result({ reason: row.state, detail: row.reason });
        if (
          (c.policy.mode ?? "item") === "prepare" ||
          this.options.contract === "free"
        )
          return await this.prepare(c, id, deadline, dry, result);
        if (items >= limit) return result({ status: "canary" });
        if (!c.baseline.has(id)) c.baseline.set(id, row.completed);
        if (row.completed - c.baseline.get(id)! >= (c.policy.items ?? Infinity))
          return result({ status: "verified" });
        if (Date.now() > deadline)
          return result({ status: "skipped", reason: "run_deadline" });
        // The frame that verified the previous item is current evidence; the
        // port still rejects input if pixels changed since it was captured.
        const tObs = performance.now();
        const reused = !!reuse;
        const o = reuse ?? (await this.observeAt(c, id, hint));
        const observeMs = Math.round(performance.now() - tObs);
        reuse = undefined;
        const frame = o.frame;
        const m = this.registered(o);
        hint = m;
        const read = this.values(c, o.nodes, m);
        const { dx, dy } = read;
        const values = { ...read.values, ...this.given(c, id, frame) };
        const p = this.plan(c, values, dx, dy, frame, o.nodes);
        if (!p.receipt) throw Error("verify_required");
        if (dry) {
          await this.evidence(frame, "dry_run");
          return result({
            status: "dry_run",
            detail: JSON.stringify({
              values,
              actions: p.actions.length,
              receipt: p.receipt,
            }),
          });
        }
        await this.evidence(frame, "act");
        const op = createHash("sha256")
          .update(
            `${c.id}/${id}/${row.completed}/${row.attempts}/${blocked}/${randomUUID()}`,
          )
          .digest("hex");
        await this.ledger.dispatch(id, op, p.expected);
        this.dispatched.set(id, {
          values,
          choice: p.expected.choice,
          operation: op,
        });
        const tAct = performance.now();
        const r = await this.actAndSettle(
          c,
          frame,
          p.actions,
          op,
          m,
          p.receipt,
        );
        const d = r.delivery;
        const actMs = Math.round(performance.now() - tAct);
        await this.options.evidence?.delivery?.({
          policy: c.id,
          surface_id: id,
          z,
          operation_id: op,
          offset: { dx, dy, mad: m.mad },
          ...(o.evidence ? { edge_frame: o.evidence } : {}),
          timing: {
            observe_ms: observeMs,
            reused,
            act_ms: actMs,
            settled_at_edge: !!r.observation,
          },
          values,
          actions: p.actions,
          expected: p.expected,
          receipt: p.receipt,
          delivery: d,
          at: new Date().toISOString(),
        });
        await this.ledger.deliver(id, d.status, d.reason);
        if (d.status === "blocked") {
          if (++blocked > 3)
            return result({ reason: "blocked_repeatedly", detail: d.reason });
          continue;
        }
        if (d.status === "unknown") continue; // resolved from evidence or reported
        hint = m;
        if (r.observation) {
          // The controller re-decides verification from the edge's text nodes.
          const ob = r.observation;
          const registered = this.ok(ob.match);
          const at = registered ? ob.match! : m;
          const seen = this.values(c, ob.nodes, at).values[verifyField(c)];
          if (satisfied(p.receipt, seen)) {
            const view = "stack:" + ob.frame.revision.slice(0, 16);
            await this.ledger.observed(id, view);
            await this.ledger.verify(
              id,
              view,
              p.expected.text,
              p.expected.choice,
            );
            hint = at;
            reuse = registered ? ob : undefined;
            items++;
            continue;
          }
        }
        const s = await this.settle(c, id, p.receipt, m);
        hint = s.hint;
        if (!s.ok)
          throw new Exception(
            "receipt_mismatch",
            JSON.stringify({ expected: p.receipt, seen: s.seen }),
            s.obs?.frame,
          );
        reuse = s.obs;
        items++;
      }
    } catch (e) {
      if (e instanceof Exception) {
        if (e.frame) this.failed.set(id, e.frame);
        return result({
          reason: e.reason,
          ...(e.detail ? { detail: e.detail } : {}),
        });
      }
      return result({
        reason: "runtime_error",
        detail: String(e).slice(0, 200),
      });
    }
  }
  /** One interruption-clearing execution; the durable item ledger is untouched. */
  private async prepare(
    c: Compiled,
    id: string,
    deadline: number,
    dry: boolean,
    result: (r: Partial<SurfaceResult>) => SurfaceResult,
  ): Promise<SurfaceResult> {
    for (let blocked = 0; ; blocked++) {
      if (Date.now() > deadline)
        return result({ status: "skipped", reason: "run_deadline" });
      const o = await this.observeAt(c, id);
      const frame = o.frame;
      const m = this.registered(o);
      const read = this.values(c, o.nodes, m);
      const { dx, dy } = read;
      const values = { ...read.values, ...this.given(c, id, frame) };
      const p = this.plan(c, values, dx, dy, frame, o.nodes);
      if (dry)
        return result({
          status: "dry_run",
          detail: JSON.stringify({ values, actions: p.actions.length }),
        });
      await this.evidence(frame, "prepare");
      const op = createHash("sha256")
        .update(`prepare/${c.id}/${id}/${randomUUID()}`)
        .digest("hex");
      const r = await this.actAndSettle(c, frame, p.actions, op, m, p.receipt);
      const d = r.delivery;
      await this.options.evidence?.delivery?.({
        policy: c.id,
        mode: "prepare",
        surface_id: id,
        z: this.z(id),
        operation_id: op,
        offset: { dx, dy, mad: m.mad },
        values,
        actions: p.actions,
        receipt: p.receipt,
        delivery: d,
        at: new Date().toISOString(),
      });
      if (d.status === "blocked") {
        if (blocked >= 3)
          return result({ reason: "blocked_repeatedly", detail: d.reason });
        continue;
      }
      if (d.status === "unknown") {
        // An item task cannot continue on an uncertain state; in a free task
        // the model inspects the surface and decides (nothing is replayed).
        if (this.options.contract !== "free")
          await this.ledger.block(id, "prepare_unknown_effect");
        return result({ reason: "unknown_effect", detail: d.reason });
      }
      // No post-condition (free task): sent, to be checked by looking.
      if (!c.policy.verify || !p.receipt)
        return result({ status: "delivered" });
      if (r.observation) {
        const at = this.ok(r.observation.match) ? r.observation.match! : m;
        const seen = this.values(c, r.observation.nodes, at).values[
          verifyField(c)
        ];
        if (satisfied(p.receipt, seen)) return result({ status: "prepared" });
      }
      const s = await this.settle(c, id, p.receipt, m, false);
      if (!s.ok)
        throw new Exception(
          "prepare_unverified",
          JSON.stringify({ seen: s.seen }),
          s.obs?.frame,
        );
      return result({ status: "prepared" });
    }
  }
  /** Execute, and when the port can, wait for the post-condition at the edge
   * in the same round trip. Delivery semantics are exactly execute's. */
  private async actAndSettle(
    c: Compiled,
    frame: Frame,
    actions: Action[],
    op: string,
    m: Match,
    receipt: Expected | null,
  ): Promise<Awaited<ReturnType<NonNullable<SurfacePort["actAndObserve"]>>>> {
    this.inputAttempted.add(frame.surface_id);
    const settleMs = this.options.settle_ms ?? 5000;
    const verify = c.policy.verify;
    if (
      receipt &&
      verify &&
      this.port.actAndObserve &&
      this.options.edge !== false
    )
      return bounded(
        this.port.actAndObserve(frame, actions, op, {
          template: c.spec,
          hint: { x: m.x, y: m.y },
          origin: { x: c.policy.template.x, y: c.policy.template.y },
          field: c.policy.fields.find((f) => f.name === verify.field)!.rect,
          expected: receipt,
          timeout_ms: settleMs,
        }),
        65000 + settleMs,
        "execute_timeout",
      ).catch((e) => ({
        delivery: { status: "unknown" as const, reason: String(e) },
      }));
    return {
      delivery: await bounded(
        this.port.execute(frame, actions, op),
        65000,
        "execute_timeout",
      ).catch((e): Delivery => ({ status: "unknown", reason: String(e) })),
    };
  }
  private failed = new Map<string, Frame>();
  private fingerprints = new Map<string, number[]>();
  /** Group exception frames by a coarse luminance histogram so the model sees
   * one real example per visually distinct layout. Presentation only. */
  private async clusters(results: SurfaceResult[]) {
    const groups: { hist: number[]; members: SurfaceResult[] }[] = [];
    for (const r of results) {
      const f = this.failed.get(r.surface_id);
      if (!f) continue;
      // Edge fingerprints avoid shipping every failed frame; local frames
      // carry pixels. A frame with neither still forms its own group.
      const hist =
        this.fingerprints.get(r.surface_id) ??
        (f.png.length ? fingerprint(await gray(f.png)) : null);
      const g = hist
        ? groups.find(
            (g) =>
              g.members[0]!.reason === r.reason &&
              g.hist.length === 16 &&
              g.hist.reduce((s, h, i) => s + Math.abs(h - hist[i]!), 0) < 0.25,
          )
        : undefined;
      if (g) g.members.push(r);
      else groups.push({ hist: hist ?? [], members: [r] });
    }
    groups.sort((a, b) => b.members.length - a.members.length);
    const top = groups.slice(0, 4);
    // Fetch pixels only for the representatives, concurrently.
    await Promise.all(
      top.map(async (g) => {
        const id = g.members[0]!.surface_id;
        if (this.failed.get(id)!.png.length) return;
        try {
          this.failed.set(
            id,
            await bounded(this.port.capture(id), 30000, "capture_timeout"),
          );
        } catch {
          /* keep the group; it simply has no example picture */
        }
      }),
    );
    return top
      .filter((g) => this.failed.get(g.members[0]!.surface_id)!.png.length)
      .map((g) => ({
        view: this.register(this.failed.get(g.members[0]!.surface_id)!),
        reason: g.members[0]!.reason!,
        surfaces: g.members.map((m) => m.surface_id),
      }));
  }
  private cropSets = new Map<
    string,
    { at: number; snaps: Map<string, { frame: Frame; match: Match }> }
  >();
  private deliveredAt = new Map<string, number>();
  private async templateFor(view_id: string, t: Rect, masked: Rect[]) {
    const v = this.views.get(view_id);
    if (!v) throw Error("unknown_or_expired_view");
    if (
      !inside(t, { x: 0, y: 0, width: v.frame.width, height: v.frame.height })
    )
      throw Error("template_outside_view");
    const local = masked.map((r) => ({ ...r, x: r.x - t.x, y: r.y - t.y }));
    const g = await gray(v.frame.png);
    const png = await sharp(v.frame.png)
      .extract({ left: t.x, top: t.y, width: t.width, height: t.height })
      .png()
      .toBuffer();
    const key = createHash("sha256")
      .update(JSON.stringify({ t, local, r: v.frame.revision }))
      .digest("hex")
      .slice(0, 16);
    return {
      gray: crop(g, t),
      mask: maskFor(t.width, t.height, local),
      spec: { key, png, masked: local },
    };
  }
  /** Ablation B-V: register every surface by pixels and return a labelled
   * contact sheet of its field crops. No text channel is used. */
  async crops(raw: unknown) {
    const p = cropsSchema.parse(raw);
    for (const f of p.fields)
      if (!inside(f.rect, p.template))
        throw Error("field_outside_template:" + f.name);
    const tc = await this.templateFor(p.view_id, p.template, [
      ...p.fields.map((f) => f.rect),
      ...(p.ignore ?? []),
    ]);
    const ids = (p.surfaces ?? this.surfaces).filter((id) =>
      ["ready", "awaiting_verification"].includes(this.ledger.get(id).state),
    );
    const rects = p.fields.map((f) => f.rect),
      origin = { x: p.template.x, y: p.template.y };
    type Row =
      | { id: string; error: string }
      | { id: string; frame: Frame; match: Match; crops: Buffer[] };
    const rows: Row[] = await Promise.all(
      ids.map((id) =>
        this.gate.run(async (): Promise<Row> => {
          try {
            const o =
              this.port.locateCrops && this.options.edge !== false
                ? await bounded(
                    this.port.locateCrops(id, tc.spec, rects, origin),
                    30000,
                    "crops_timeout",
                  )
                : await edgeCrops(
                    await bounded(
                      this.port.capture(id),
                      30000,
                      "capture_timeout",
                    ),
                    tc,
                    rects,
                    origin,
                  );
            if (!this.ok(o.match)) return { id, error: "template_mismatch" };
            return { id, frame: o.frame, match: o.match!, crops: o.crops };
          } catch (e) {
            return { id, error: String(e).slice(0, 120) };
          }
        }),
      ),
    );
    const ok = rows.filter(
      (r): r is Extract<Row, { crops: Buffer[] }> => "crops" in r,
    );
    const crops_id = "c" + randomUUID().slice(0, 8);
    this.cropSets.set(crops_id, {
      at: Date.now(),
      snaps: new Map(ok.map((r) => [r.id, { frame: r.frame, match: r.match }])),
    });
    while (this.cropSets.size > 16)
      this.cropSets.delete(this.cropSets.keys().next().value!);
    const sheets = await contactSheets(
      ok.map((r) => ({ label: `Z${this.z(r.id)} ${r.id}`, crops: r.crops })),
      p.fields.map((f) => f.name),
    );
    return {
      crops_id,
      fields: p.fields.map((f) => f.name),
      rows: ok.map((r, i) => {
        const row = this.ledger.get(r.id);
        return {
          sheet: Math.floor(i / SHEET_ROWS),
          surface_id: r.id,
          z: this.z(r.id),
          state: row.state,
          completed: row.completed,
        };
      }),
      errors: rows.filter((r) => "error" in r),
      fleet: this.ledger.summary(),
      sheets,
    };
  }
  /** Ablation B-V: confirm earlier deliveries from receipts the model read in a
   * contact sheet taken after the delivery. */
  async confirm(raw: unknown) {
    const p = confirmSchema.parse(raw);
    const set = this.cropSets.get(p.crops_id);
    if (!set) throw Error("unknown_or_expired_crops");
    const out: { surface_id: string; result: string }[] = [];
    for (const [id, c] of Object.entries(p.checks)) {
      this.z(id);
      const snap = set.snaps.get(id),
        row = this.ledger.get(id);
      if (
        !snap ||
        row.state !== "awaiting_verification" ||
        (this.deliveredAt.get(id) ?? Infinity) > set.at
      ) {
        out.push({
          surface_id: id,
          result: "fresh_snapshot_after_delivery_required",
        });
        continue;
      }
      const view = "crops:" + snap.frame.revision.slice(0, 16);
      await this.ledger.observed(id, view);
      await this.ledger.verify(id, view, c.text, c.choice);
      out.push({ surface_id: id, result: this.ledger.get(id).state });
    }
    return { results: out, fleet: this.ledger.summary() };
  }
  /** Ablation B-V: one item on one surface with model-provided values, bound to
   * the snapshot frame; execute refuses input if the frame changed. */
  private async deliverWithValues(
    c: Compiled,
    id: string,
    snap: { frame: Frame; match: Match },
    vals: Record<string, string>,
  ): Promise<SurfaceResult> {
    const z = this.z(id);
    const base = {
      surface_id: id,
      z,
      completed: this.ledger.get(id).completed,
    };
    try {
      if (this.ledger.get(id).state !== "ready")
        return {
          ...base,
          status: "exception",
          reason: this.ledger.get(id).state,
        };
      const dx = snap.match.x - c.policy.template.x,
        dy = snap.match.y - c.policy.template.y;
      const p = this.plan(c, vals, dx, dy, snap.frame, null);
      const op = createHash("sha256")
        .update(`${c.id}/${id}/${randomUUID()}`)
        .digest("hex");
      await this.ledger.dispatch(id, op, p.expected);
      this.inputAttempted.add(id);
      const d = await bounded(
        this.port.execute(snap.frame, p.actions, op),
        65000,
        "execute_timeout",
      ).catch((e): Delivery => ({ status: "unknown", reason: String(e) }));
      await this.options.evidence?.delivery?.({
        policy: c.id,
        mode: "vision",
        surface_id: id,
        z,
        operation_id: op,
        offset: { dx, dy, mad: snap.match.mad },
        values: vals,
        actions: p.actions,
        expected: p.expected,
        delivery: d,
        at: new Date().toISOString(),
      });
      await this.ledger.deliver(id, d.status, d.reason);
      if (d.status === "delivered") {
        this.deliveredAt.set(id, Date.now());
        return { ...base, status: "delivered", items: 1 };
      }
      return {
        ...base,
        status: "exception",
        reason:
          d.status === "blocked" ? "frame_changed_recrop" : "unknown_effect",
        detail: d.reason,
      };
    } catch (e) {
      if (e instanceof Exception)
        return {
          ...base,
          status: "exception",
          reason: e.reason,
          detail: e.detail,
        };
      return {
        ...base,
        status: "exception",
        reason: "runtime_error",
        detail: String(e).slice(0, 200),
      };
    }
  }
  /** Validate, then broadcast. Duplicate request IDs with different content fail closed. */
  async run(raw: unknown) {
    const p = policySchema.parse(raw);
    const hash = createHash("sha256").update(JSON.stringify(p)).digest("hex");
    const old = this.policies.get(p.request_id);
    if (old && old !== hash) throw Error("idempotency_conflict");
    if (old) throw Error("duplicate_request_already_ran");
    const vision = this.options.values === "vision";
    if (vision !== !!p.values)
      throw Error(
        vision ? "vision_mode_requires_values" : "values_only_in_vision_mode",
      );
    if (vision && ((p.mode ?? "item") !== "item" || p.dry_run))
      throw Error("vision_mode_item_policies_only");
    const c = await this.compile(p);
    this.policies.set(p.request_id, hash);
    if (vision) {
      const set = this.cropSets.get(p.crops_id ?? "");
      if (!set) throw Error("unknown_or_expired_crops");
      const vids = Object.keys(p.values!);
      for (const id of vids)
        if (!set.snaps.has(id)) throw Error("surface_not_in_crops:" + id);
      const t0 = performance.now();
      const run1 = (id: string) =>
        this.deliverWithValues(c, id, set.snaps.get(id)!, p.values![id]!);
      let results: SurfaceResult[];
      const canary =
        p.canary !== false && vids.length ? await run1(vids[0]!) : undefined;
      if (canary && canary.status === "exception")
        results = vids.map((id) =>
          id === vids[0]
            ? canary
            : {
                surface_id: id,
                z: this.z(id),
                status: "skipped" as const,
                completed: this.ledger.get(id).completed,
                reason: "canary_failed",
              },
        );
      else
        results = [
          ...(canary ? [canary] : []),
          ...(await Promise.all(
            vids
              .slice(canary ? 1 : 0)
              .map((id) => this.gate.run(() => run1(id))),
          )),
        ];
      const counts: Record<string, number> = {};
      for (const r of results) {
        const k = r.status === "exception" ? `exception:${r.reason}` : r.status;
        counts[k] = (counts[k] ?? 0) + 1;
      }
      return {
        policy_id: c.id,
        elapsed_ms: Math.round(performance.now() - t0),
        counts,
        exceptions: results
          .filter((r) => r.status === "exception")
          .map(({ surface_id, z, reason, detail }) => ({
            surface_id,
            z,
            reason,
            ...(detail ? { detail: detail.slice(0, 160) } : {}),
          })),
        fleet: this.ledger.summary(),
        views: [] as StackView[],
        canary: canary
          ? {
              surface_id: canary.surface_id,
              status: canary.status,
              ...(canary.reason ? { reason: canary.reason } : {}),
            }
          : undefined,
        exception_groups: [] as {
          view_id: string;
          reason: string;
          count: number;
          surfaces: string[];
        }[],
      };
    }

    const ids =
      p.surfaces ?? (p.assign ? Object.keys(p.assign) : this.surfaces);
    for (const id of ids) this.z(id);
    const deadline = Date.now() + (this.options.deadline_ms ?? 600000);
    // Only this run's surfaces are reset; other concurrent runs keep theirs.
    for (const id of ids) {
      this.failed.delete(id);
      this.fingerprints.delete(id);
    }
    const t0 = performance.now();
    // Canary: one item on one surface must verify before the policy touches
    // any other surface. A wrong policy therefore costs at most one item.
    let results: SurfaceResult[] = [];
    // Canary: the first APPLICABLE surface runs one item before any other
    // surface is touched. A candidate that exits before any input (template
    // mismatch, unmatched value, empty field...) is "not applicable", not a
    // canary failure; the next candidate is tried. A wrong policy therefore
    // costs at most one item.
    let canary: SurfaceResult | undefined;
    const settled = new Map<string, SurfaceResult>();
    const seeds = new Map<string, Promise<Observation | undefined>>();
    if (!p.dry_run && (p.mode ?? "item") === "item")
      for (const id of ids)
        if (this.ledger.get(id).state === "ready" && !this.busy.has(id))
          seeds.set(
            id,
            this.gate.run(() => this.observeAt(c, id)).catch(() => undefined),
          );
    if (!p.dry_run && p.canary !== false) {
      for (const id of ids) {
        if (this.ledger.get(id).state !== "ready" || this.busy.has(id))
          continue;
        this.inputAttempted.delete(id);
        const r = await this.surface(
          c,
          id,
          deadline,
          false,
          1,
          await seeds.get(id),
        );
        seeds.delete(id);
        if (!this.inputAttempted.has(id) && r.status === "exception") {
          settled.set(id, r);
          continue;
        }
        canary = r;
        break;
      }
      if (canary?.status === "exception")
        results = ids.map(
          (id) =>
            (id === canary!.surface_id ? canary : settled.get(id)) ?? {
              surface_id: id,
              z: this.z(id),
              status: "skipped",
              completed: this.ledger.get(id).completed,
              reason: "canary_failed",
            },
        );
    }
    if (!results.length)
      results = await Promise.all(
        ids.map((id) =>
          settled.get(id)
            ? Promise.resolve(settled.get(id)!)
            : // A prepared canary is finished; an item canary continues its items.
              (canary?.status === "prepared" ||
                  canary?.status === "delivered") &&
                id === canary.surface_id
              ? Promise.resolve(canary)
              : // Await the read-only seed OUTSIDE the gate: no slot waits on another.
                (seeds.get(id) ?? Promise.resolve(undefined)).then((seed) =>
                  this.gate.run(() =>
                    this.surface(c, id, deadline, !!p.dry_run, Infinity, seed),
                  ),
                ),
        ),
      );
    const counts: Record<string, number> = {};
    for (const r of results) {
      const k = r.status === "exception" ? `exception:${r.reason}` : r.status;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    // One real frame per visually distinct exception group (at most 4).
    const groups = await this.clusters(results);
    const views = groups.map((g) => g.view);
    return {
      policy_id: c.id,
      elapsed_ms: Math.round(performance.now() - t0),
      ...(canary
        ? {
            canary: {
              surface_id: canary.surface_id,
              status: canary.status,
              ...(canary.reason ? { reason: canary.reason } : {}),
            },
          }
        : {}),
      counts,
      exceptions: results
        .filter((r) => r.status === "exception")
        .map(({ surface_id, z, reason, detail, completed }) => ({
          surface_id,
          z,
          reason,
          completed,
          ...(detail ? { detail: detail.slice(0, 200) } : {}),
        })),
      ...(p.dry_run
        ? {
            preview: results
              .filter((r) => r.status === "dry_run")
              .slice(0, 3)
              .map((r) => ({
                surface_id: r.surface_id,
                z: r.z,
                ...JSON.parse(r.detail!),
              })),
          }
        : {}),
      // A post-condition without value placeholders proves only that the
      // steps ran (e.g. "a cover appeared"), not that the result is correct.
      verification: /\{[a-z]/.test(JSON.stringify(p.verify))
        ? "value_bound"
        : "weak_submission_only",
      exception_groups: groups.map((g) => ({
        view_id: g.view.view_id,
        reason: g.reason,
        count: g.surfaces.length,
        surfaces: g.surfaces,
      })),
      fleet: this.ledger.summary(),
      views,
    };
  }
}

/**
 * Edge half of observeAt, for a trusted host next to the surfaces: register a
 * cached template on a local frame and read its text. Returns frame identity
 * without pixels so only kilobytes cross the operator link.
 */
export async function edgeObserve(
  frame: Frame,
  readText: (f: Frame) => Promise<TextNode[]>,
  template: Template,
  hint?: { x: number; y: number },
) {
  const g = await gray(frame.png);
  const match = register(g, template, hint);
  const nodes = await readText(frame);
  const { png: _png, ...identity } = frame;
  return {
    frame: { ...identity, png: Buffer.alloc(0) },
    match,
    nodes,
    // Lets the controller group non-matching surfaces without fetching pixels.
    ...(acceptable(match) ? {} : { fingerprint: fingerprint(g) }),
  };
}
export async function edgeTemplate(
  png: Buffer,
  masked: Rect[],
  fields: Rect[] = [],
  points: { x: number; y: number }[] = [],
): Promise<Template> {
  const g = await gray(png);
  return {
    gray: g,
    mask: maskFor(g.width, g.height, masked),
    points,
    pointMask: maskFor(g.width, g.height, fields),
  };
}

/** Edge half of actAndObserve, shared by trusted hosts next to the surfaces. */
export async function edgeActAndObserve(
  deps: {
    execute: (f: Frame, a: Action[], op: string) => Promise<Delivery>;
    capture: (id: string) => Promise<Frame>;
    readText: (f: Frame) => Promise<TextNode[]>;
    /** Screenshot-free polling; the final observation is still frame-bound. */
    probeText?: (id: string) => Promise<TextNode[]>;
  },
  template: Template,
  frame: Frame,
  actions: Action[],
  operation_id: string,
  spec: Omit<SettleSpec, "template">,
) {
  const delivery = await deps.execute(frame, actions, operation_id);
  if (delivery.status !== "delivered") return { delivery };
  const end = Date.now() + spec.timeout_ms;
  let hint: { x: number; y: number } = spec.hint,
    last,
    misses = 0;
  const at = (p: { x: number; y: number }) => ({
    ...spec.field,
    x: spec.field.x + p.x - spec.origin.x,
    y: spec.field.y + p.y - spec.origin.y,
  });
  for (;;) {
    try {
      if (deps.probeText) {
        const probe = readField(
          await deps.probeText(frame.surface_id),
          at(hint),
        );
        // Every third miss re-registers in case the layout moved.
        if (!satisfied(spec.expected, probe) && ++misses % 3 !== 0) {
          if (Date.now() >= end) return { delivery, observation: last };
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
      }
      const o = await edgeObserve(
        await deps.capture(frame.surface_id),
        deps.readText,
        template,
        hint,
      );
      last = o;
      const pos = acceptable(o.match) ? o.match! : hint;
      if (acceptable(o.match)) hint = pos;
      const seen = readField(o.nodes, at(pos));
      if (satisfied(spec.expected, seen)) return { delivery, observation: o };
    } catch {
      // Transitional frames retry until the deadline.
    }
    if (Date.now() >= end) return { delivery, observation: last };
    await new Promise((r) => setTimeout(r, 120));
  }
}

/** Edge/local crop helper: register a template, crop rectangles at its offset. */
export async function edgeCrops(
  frame: Frame,
  template: Template,
  rects: Rect[],
  origin: { x: number; y: number },
  hint?: { x: number; y: number },
) {
  const match = register(await gray(frame.png), template, hint);
  const crops: Buffer[] = [];
  if (acceptable(match))
    for (const r of rects) {
      const left = r.x + match!.x - origin.x,
        top = r.y + match!.y - origin.y;
      if (
        left < 0 ||
        top < 0 ||
        left + r.width > frame.width ||
        top + r.height > frame.height
      )
        throw Error("crop_outside_frame");
      crops.push(
        await sharp(frame.png)
          .extract({ left, top, width: r.width, height: r.height })
          .png()
          .toBuffer(),
      );
    }
  const { png: _png, ...identity } = frame;
  return { frame: { ...identity, png: Buffer.alloc(0) }, match, crops };
}
export const SHEET_ROWS = 34;
const esc = (t: string) =>
  t.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
/** Original-resolution crops in labelled rows; at most SHEET_ROWS per image. */
export async function contactSheets(
  rows: { label: string; crops: Buffer[] }[],
  fields: string[],
) {
  if (!rows.length) return [];
  const metas = await Promise.all(
    rows.map((r) => Promise.all(r.crops.map((c) => sharp(c).metadata()))),
  );
  const colW = fields.map((_, j) =>
    Math.max(...metas.map((m) => m[j]!.width!)),
  );
  const rowH = Math.max(...metas.flat().map((m) => m.height!)) + 8;
  const labelW = 120,
    headerH = 26,
    gap = 12;
  const width = labelW + colW.reduce((a, b) => a + b + gap, 0);
  const out = [];
  for (let s = 0; s * SHEET_ROWS < rows.length; s++) {
    const part = rows.slice(s * SHEET_ROWS, (s + 1) * SHEET_ROWS);
    const height = headerH + part.length * rowH;
    let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#fff"/>`;
    let x = labelW;
    fields.forEach((f, j) => {
      svg += `<text x="${x}" y="18" font-family="Arial" font-size="14" font-weight="bold">${esc(f)}</text>`;
      x += colW[j]! + gap;
    });
    part.forEach((r, i) => {
      const y = headerH + i * rowH;
      svg += `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#ccc"/><text x="6" y="${y + rowH / 2 + 5}" font-family="Arial" font-size="14">${esc(r.label)}</text>`;
    });
    svg += "</svg>";
    const composites: { input: Buffer; left: number; top: number }[] = [];
    part.forEach((r, i) => {
      let left = labelW;
      r.crops.forEach((c, j) => {
        composites.push({ input: c, left, top: headerH + i * rowH + 4 });
        left += colW[j]! + gap;
      });
    });
    const png = await sharp(Buffer.from(svg))
      .composite(composites)
      .png()
      .toBuffer();
    out.push({ png, width, height });
  }
  return out;
}

/**
 * A point inside the target that no other node covers. Paint order is unknown
 * from the text channel, so any overlap is avoided whichever element is on top
 * (e.g. a button partly covered by another). Nodes nested in the target (its
 * own text) or containing it (its own control) are not obstacles. Returns the
 * free grid point nearest the target's centre, or null when fully covered.
 */
export function unoccludedPoint(target: TextNode, nodes: TextNode[]) {
  const r = target.rect;
  const inside = (a: Rect, b: Rect) =>
    a.x >= b.x &&
    a.y >= b.y &&
    a.x + a.width <= b.x + b.width &&
    a.y + a.height <= b.y + b.height;
  const obstacles = nodes
    .filter(
      (o) =>
        o !== target &&
        !inside(o.rect, r) &&
        // The control that owns this text (same text, enclosing) is not an obstacle.
        !(inside(r, o.rect) && o.text.trim() === target.text.trim()),
    )
    .map((o) => o.rect);
  const cx = r.x + r.width / 2,
    cy = r.y + r.height / 2;
  let best: { x: number; y: number; d: number } | null = null;
  const steps = 9;
  for (let i = 0; i < steps; i++)
    for (let j = 0; j < steps; j++) {
      const x = Math.round(r.x + ((i + 0.5) * r.width) / steps),
        y = Math.round(r.y + ((j + 0.5) * r.height) / steps);
      // Keep a 2px margin from any obstacle.
      if (
        obstacles.some(
          (o) =>
            x >= o.x - 2 &&
            x < o.x + o.width + 2 &&
            y >= o.y - 2 &&
            y < o.y + o.height + 2,
        )
      )
        continue;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (!best || d < best.d) best = { x, y, d };
    }
  return best ? { x: best.x, y: best.y } : null;
}
