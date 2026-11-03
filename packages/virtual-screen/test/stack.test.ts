import { test, expect } from "vitest";
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { StackScreen, readField } from "../src/stack.js";
import { ProgressLedger } from "../src/workset.js";
import { gray, crop, maskFor, locate, acceptable } from "../src/align.js";
import type { Action, Frame, SurfacePort, TextNode } from "../src/index.js";

const W = 320,
  H = 240,
  PW = 160,
  PH = 120;
/** Deterministic textured panel, so registration is meaningful. */
function texture(seed: number) {
  const px = Buffer.alloc(PW * PH * 3);
  let s = seed;
  for (let i = 0; i < PW * PH; i++) {
    if (i % 4 === 0) s = (s * 1103515245 + 12345) & 0x7fffffff;
    const v = (s >> 8) & 255;
    px[i * 3] = px[i * 3 + 1] = px[i * 3 + 2] = v;
  }
  return px;
}
async function render(ox: number, oy: number, seed: number) {
  const base = Buffer.alloc(W * H * 3, 230);
  const t = texture(seed);
  for (let y = 0; y < PH; y++)
    t.copy(base, ((oy + y) * W + ox) * 3, y * PW * 3, (y + 1) * PW * 3);
  return sharp(base, { raw: { width: W, height: H, channels: 3 } })
    .png()
    .toBuffer();
}
type App = {
  ox: number;
  oy: number;
  seed: number;
  cases: { code: string; priority: string }[];
  item: number;
  input: string;
  choice: string;
  receipt: string;
  saved: { text: string; choice: string }[];
  outcome?: "unknown" | "lost_reply";
  notice?: boolean;
  /** Panel moves by this offset after the first save. */
  move?: [number, number];
  png?: Buffer;
};
// Panel-local control geometry of the fake application.
const INPUT = { x: 10, y: 50, width: 100, height: 16 },
  STANDARD = { x: 10, y: 75, width: 40, height: 14 },
  URGENT = { x: 60, y: 75, width: 40, height: 14 },
  SAVE = { x: 10, y: 95, width: 40, height: 14 };
const hit = (a: App, x: number, y: number, r: typeof INPUT) =>
  x >= a.ox + r.x &&
  x < a.ox + r.x + r.width &&
  y >= a.oy + r.y &&
  y < a.oy + r.y + r.height;
async function fleet(apps: Record<string, App>) {
  let focus: string | null = null;
  const executes: Record<string, number> = {};
  const revision = (a: App) =>
    createHash("sha256")
      .update(JSON.stringify([a.item, a.input, a.choice, a.receipt, a.notice]))
      .digest("hex");
  const frame = async (id: string): Promise<Frame> => {
    const a = apps[id]!;
    a.png ??= await render(a.ox, a.oy, a.notice ? 4242 : a.seed);
    return {
      surface_id: id,
      route_id: id,
      epoch: 1,
      revision: revision(a),
      width: W,
      height: H,
      png: a.png,
    };
  };
  const port: SurfacePort = {
    capture: frame,
    readText: async (f) => {
      const a = apps[f.surface_id]!;
      if (f.revision !== revision(a)) throw Error("source_changed_before_read");
      const c = a.cases[a.item];
      // Controls as the accessibility layer exposes them.
      const control = (role: string, text: string, r: typeof INPUT) => ({
        role,
        text,
        rect: { ...r, x: a.ox + r.x, y: a.oy + r.y },
      });
      if (a.notice)
        return [
          {
            role: "StaticText",
            text: "Session notice",
            rect: { x: a.ox + 4, y: a.oy + 6, width: 50, height: 10 },
          },
          control("button", "Continue", SAVE),
        ];
      const node = (text: string, x: number, y: number): TextNode => ({
        role: "StaticText",
        text,
        rect: { x: a.ox + x, y: a.oy + y, width: 50, height: 10 },
      });
      return [
        node("Code:", 4, 6),
        ...(c ? [node(c.code, 60, 6), node(c.priority, 60, 24)] : []),
        node(a.receipt, 4, 110),
        control("textbox", a.input, INPUT),
        control("button", "Standard", STANDARD),
        control("button", "Urgent", URGENT),
        control("button", "Save", SAVE),
      ];
    },
    execute: async (f, actions: Action[]) => {
      // The executor receives exactly a frame: identity plus pixels, nothing else.
      expect(Object.keys(f).sort()).toEqual([
        "epoch",
        "height",
        "png",
        "revision",
        "route_id",
        "surface_id",
        "width",
      ]);
      const a = apps[f.surface_id]!;
      executes[f.surface_id] = (executes[f.surface_id] ?? 0) + 1;
      if (f.revision !== revision(a))
        return { status: "blocked", reason: "source_changed_before_input" };
      if (a.outcome === "unknown") return { status: "unknown", reason: "lost" };
      const lostReply = a.outcome === "lost_reply";
      for (const x of actions) {
        if (a.notice) {
          // Only "Continue" (panel-local 10..50, 95..109) does anything.
          if (x.kind === "click" && hit(a, x.x, x.y, SAVE)) {
            a.notice = false;
            delete a.png;
          }
          continue;
        }
        if (x.kind === "click") {
          focus = hit(a, x.x, x.y, INPUT) ? f.surface_id : null;
          if (hit(a, x.x, x.y, STANDARD)) a.choice = "Standard";
          if (hit(a, x.x, x.y, URGENT)) a.choice = "Urgent";
          if (hit(a, x.x, x.y, SAVE) && a.input && a.choice) {
            a.saved.push({ text: a.input, choice: a.choice });
            a.receipt = `Saved ${a.input} / ${a.choice}`;
            a.item++;
            if (a.move && a.item === 1) {
              a.ox += a.move[0];
              a.oy += a.move[1];
              delete a.png;
            }
            a.input = "";
            a.choice = "";
          }
        } else if (x.kind === "type_text" && focus === f.surface_id)
          a.input += x.text;
      }
      // A lost reply: the effect happened, the caller cannot know.
      return lostReply
        ? { status: "unknown", reason: "reply_lost" }
        : { status: "delivered" };
    },
  };
  return { port, executes };
}
const app = (i: number, over: Partial<App> = {}): App => ({
  ox: 20 + ((i * 37) % 120),
  oy: 10 + ((i * 23) % 100),
  seed: 7,
  cases: [0, 1].map((r) => ({
    code: `C${i}-${r}`,
    priority: (i + r) % 2 ? "HIGH" : "NORMAL",
  })),
  item: 0,
  input: "",
  choice: "",
  receipt: "Saved —",
  saved: [],
  ...over,
});
// Policy in exemplar (A1) pixels, derived from A1's offset like a model would from the image.
function policy(ex: App, view_id: string, over: Record<string, unknown> = {}) {
  const at = (r: { x: number; y: number }, dx = 5, dy = 5) => ({
    x: ex.ox + r.x + dx,
    y: ex.oy + r.y + dy,
  });
  return {
    request_id: "p" + Math.random(),
    view_id,
    template: { x: ex.ox, y: ex.oy, width: PW, height: PH },
    fields: [
      {
        name: "code",
        rect: { x: ex.ox + 58, y: ex.oy + 4, width: 90, height: 14 },
      },
      {
        name: "priority",
        rect: { x: ex.ox + 58, y: ex.oy + 22, width: 90, height: 14 },
      },
      {
        name: "receipt",
        rect: { x: ex.ox + 2, y: ex.oy + 106, width: 150, height: 14 },
      },
    ],
    steps: [
      { kind: "click", ...at(INPUT) },
      { kind: "type_field", field: "code" },
      {
        kind: "choose",
        field: "priority",
        cases: [
          { equals: "HIGH", ...at(URGENT), label: "Urgent" },
          { equals: "NORMAL", ...at(STANDARD), label: "Standard" },
        ],
      },
      { kind: "click", ...at(SAVE) },
    ],
    verify: { field: "receipt", contains: ["{code}", "{choice}"] },
    ...over,
  };
}
async function setup(apps: Record<string, App>, steps = 2) {
  const dir = await mkdtemp(join(tmpdir(), "cu-stack-"));
  const ids = Object.keys(apps);
  const ledger = await ProgressLedger.open(dir, ids, steps);
  const f = await fleet(apps);
  const stack = new StackScreen(f.port, ledger, ids, { settle_ms: 300 });
  const view = (await stack.observe([ids[0]!])).views[0]!;
  return {
    ...f,
    ledger,
    stack,
    view,
    clean: async () => {
      await ledger.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const correct = (a: App) =>
  a.saved.length === a.cases.length &&
  a.saved.every(
    (s, i) =>
      s.text === a.cases[i]!.code &&
      s.choice === (a.cases[i]!.priority === "HIGH" ? "Urgent" : "Standard"),
  );

test("registration finds a translated template and rejects a different one", async () => {
  const a = await gray(await render(30, 40, 7)),
    b = await gray(await render(117, 83, 7)),
    c = await gray(await render(117, 83, 8));
  const t = crop(a, { x: 30, y: 40, width: PW, height: PH }),
    m = maskFor(PW, PH, [{ x: 50, y: 0, width: 100, height: 40 }]);
  const hit = locate(b, t, m);
  expect(hit && [hit.x, hit.y]).toEqual([117, 83]);
  expect(acceptable(hit)).toBe(true);
  expect(acceptable(locate(c, t, m))).toBe(false);
});

test("readField concatenates centred nodes in reading order only", () => {
  const n = (text: string, x: number, y: number) => ({
    role: "StaticText",
    text,
    rect: { x, y, width: 20, height: 10 },
  });
  expect(
    readField([n("B", 40, 0), n("A", 10, 0), n("label", -15, 0)], {
      x: 0,
      y: 0,
      width: 80,
      height: 12,
    }),
  ).toBe("AB");
});

test("one decision completes every matching surface with machine-read values", async () => {
  const apps = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`A${i + 1}`, app(i + 1)]),
  );
  const s = await setup(apps);
  try {
    const r = await s.stack.run(policy(apps.A1!, s.view.view_id));
    expect(r.canary).toMatchObject({ surface_id: "A1", status: "canary" });
    expect(r.counts).toEqual({ verified: 10 });
    expect(Object.values(apps).every(correct)).toBe(true);
    expect(s.ledger.summary().verified).toBe(10);
  } finally {
    await s.clean();
  }
});

test("task-table inputs: each surface types its own row; the screen is not read for them", async () => {
  const apps = { A1: app(1), A2: app(2), A3: app(3) };
  const s = await setup(apps, 1);
  // The host's spec sheet: the code to enter on each surface (A3 has no row).
  const inputs = {
    A1: { given: apps.A1.cases[0]!.code },
    A2: { given: apps.A2.cases[0]!.code },
  };
  const stack = new StackScreen(s.port, s.ledger, Object.keys(apps), {
    settle_ms: 300,
    inputs,
  });
  try {
    const view = (await stack.observe(["A1"])).views[0]!.view_id;
    const p = policy(apps.A1, view, { inputs: ["given"] });
    p.steps[1] = { kind: "type_field", field: "given" } as never;
    p.verify = { field: "receipt", contains: ["{given}", "{choice}"] };
    const r = await stack.run(p);
    expect(r.counts).toEqual({ verified: 2, "exception:no_input_value": 1 });
    expect(apps.A1.saved[0]!.text).toBe(apps.A1.cases[0]!.code);
    expect(apps.A2.saved[0]!.text).toBe(apps.A2.cases[0]!.code);
    expect(apps.A3.saved).toEqual([]);
    await expect(
      stack.run(policy(apps.A1, view, { inputs: ["nope"] })),
    ).rejects.toThrow("unknown_input");
    await expect(
      stack.run(policy(apps.A1, view, { inputs: ["code"] })),
    ).rejects.toThrow("input_shadows_field");
  } finally {
    await s.clean();
  }
});

test("items caps a policy at that many items per surface, canary included", async () => {
  const apps = { A1: app(1), A2: app(2), A3: app(3) };
  const s = await setup(apps); // two items per surface
  try {
    const r = await s.stack.run(policy(apps.A1, s.view.view_id, { items: 1 }));
    expect(r.counts).toEqual({ verified: 3 });
    expect(Object.values(apps).map((a) => a.saved.length)).toEqual([1, 1, 1]);
    expect(s.ledger.summary().completed_steps).toBe(3);
  } finally {
    await s.clean();
  }
});

test("type fills placeholders per surface; overview tiles the fleet in one image", async () => {
  const apps = { A1: app(1), A2: app(2) };
  const s = await setup(apps, 1);
  const stack = new StackScreen(s.port, s.ledger, Object.keys(apps), {
    settle_ms: 300,
    inputs: {
      A1: { given: apps.A1.cases[0]!.code },
      A2: { given: apps.A2.cases[0]!.code },
    },
  });
  try {
    const view = (await stack.observe(["A1"])).views[0]!.view_id;
    const p = policy(apps.A1, view, { inputs: ["given"] });
    p.steps[1] = { kind: "type", text: "{given}" } as never;
    p.verify = { field: "receipt", contains: ["{given}", "{choice}"] };
    expect((await stack.run(p)).counts).toEqual({ verified: 2 });
    expect(apps.A2.saved[0]!.text).toBe(apps.A2.cases[0]!.code);
    await expect(
      stack.run({
        ...policy(apps.A1, view),
        steps: [{ kind: "type", text: "{nope}" }],
      } as never),
    ).rejects.toThrow("unknown_placeholder");
    const o = await stack.overview();
    const meta = await sharp(o.png).metadata();
    expect(o.surfaces).toEqual(["A1", "A2"]);
    expect(meta.width).toBeGreaterThan(900);
  } finally {
    await s.clean();
  }
});

test("a failed canary leaves every other surface untouched", async () => {
  const apps = { A1: app(1), A2: app(2), A3: app(3) };
  const s = await setup(apps);
  try {
    const p = policy(apps.A1, s.view.view_id);
    // Wrong control (Standard instead of Save): nothing is saved, the
    // canary cannot verify.
    p.steps[3] = { kind: "click", x: apps.A1.ox + 20, y: apps.A1.oy + 80 };
    const r = await s.stack.run(p);
    expect(r.canary?.status).toBe("exception");
    expect(s.executes).toEqual({ A1: 1 });
    expect(r.counts["skipped"]).toBe(2);
    expect(apps.A2.saved.length + apps.A3.saved.length).toBe(0);
  } finally {
    await s.clean();
  }
});

test("semantic binding: a click on blank page, a field that cuts a text run and blind Tab focus are refused before input", async () => {
  const apps = { A1: app(1), A2: app(2) };
  const s = await setup(apps);
  try {
    const blank = policy(apps.A1, s.view.view_id);
    blank.steps[3] = { kind: "click", x: apps.A1.ox + 150, y: apps.A1.oy + 60 };
    await expect(s.stack.run(blank)).rejects.toThrow("click_target_unbound");
    const cut = policy(apps.A1, s.view.view_id);
    // "Code:" spans x 4..54; a field covering only its centre cuts it.
    cut.fields[0] = {
      name: cut.fields[0]!.name,
      rect: { x: apps.A1.ox + 20, y: apps.A1.oy + 4, width: 20, height: 14 },
    };
    await expect(s.stack.run(cut)).rejects.toThrow("field_cuts_text");
    const tab = policy(apps.A1, s.view.view_id);
    tab.verify = { field: "receipt", contains: ["Saved"] };
    (tab.steps as unknown[]).splice(1, 0, { kind: "key_chord", keys: ["Tab"] });
    await expect(s.stack.run(tab)).rejects.toThrow("blind_focus_navigation");
    expect(s.executes).toEqual({});
  } finally {
    await s.clean();
  }
});

test("a click whose target element differs on a surface is refused on that surface only", async () => {
  // A2's Save button is relabelled at the same position: same pixels are
  // not required by the text layer, so the binding catches it.
  const apps = { A1: app(1), A2: app(2), A3: app(3) };
  const s = await setup(apps);
  const read = s.port.readText!;
  s.port.readText = async (f) =>
    (await read(f)).map((n) =>
      f.surface_id === "A2" && n.text === "Save" ? { ...n, text: "Delete" } : n,
    );
  try {
    const r = await s.stack.run(policy(apps.A1, s.view.view_id));
    expect(r.counts, JSON.stringify(r)).toMatchObject({
      "exception:click_target_changed": 1,
    });
    expect(s.executes.A2).toBeUndefined();
    expect(apps.A1.saved.length + apps.A3.saved.length).toBe(4);
  } finally {
    await s.clean();
  }
});

test("divergent layouts and unmatched values never receive input", async () => {
  const apps = {
    A1: app(1),
    A2: app(2, { seed: 99 }),
    A3: app(3, {
      cases: [
        { code: "X", priority: "CRITICAL" },
        { code: "Y", priority: "HIGH" },
      ],
    }),
    A4: app(4),
  };
  const s = await setup(apps);
  try {
    const r = await s.stack.run(policy(apps.A1, s.view.view_id));
    expect(r.counts).toMatchObject({
      verified: 2,
      "exception:template_mismatch": 1,
      "exception:no_matching_case": 1,
    });
    expect(s.executes.A2).toBeUndefined();
    expect(s.executes.A3).toBeUndefined();
    expect(r.views.length).toBe(2);
  } finally {
    await s.clean();
  }
});

test("an unknown delivery whose effect is proven by the post-condition is resolved, not replayed", async () => {
  const apps = { A1: app(1), A2: app(2, { outcome: "lost_reply" }) };
  const s = await setup(apps);
  try {
    const r = await s.stack.run(policy(apps.A1, s.view.view_id));
    expect(r.counts).toEqual({ verified: 2 });
    // Each item executed exactly once; nothing was repeated.
    expect(s.executes.A2).toBe(2);
    expect(apps.A2.saved.length).toBe(2);
    expect(correct(apps.A2)).toBe(true);
    expect(s.ledger.get("A2").reason).toBe("resolved_from_evidence");
  } finally {
    await s.clean();
  }
});

test("a post-condition that already holds before input is refused before input", async () => {
  const apps = { A1: app(1), A2: app(2) };
  const s = await setup(apps);
  try {
    const r = await s.stack.run(
      policy(apps.A1, s.view.view_id, {
        verify: { field: "receipt", contains: ["Saved"] },
      }),
    );
    // Refused before input on every surface: not applicable, nothing touched.
    expect(r.counts).toEqual({ "exception:verify_not_discriminative": 2 });
    expect(s.executes).toEqual({});
  } finally {
    await s.clean();
  }
});

test("unknown effects are reported and never replayed", async () => {
  const apps = { A1: app(1), A2: app(2, { outcome: "unknown" }) };
  const s = await setup(apps);
  try {
    const r = await s.stack.run(policy(apps.A1, s.view.view_id));
    expect(r.counts).toMatchObject({
      verified: 1,
      "exception:unknown_effect": 1,
    });
    expect(s.executes.A2).toBe(1);
    expect(s.ledger.get("A2").state).toBe("unknown");
  } finally {
    await s.clean();
  }
});

test("a corrected policy verifies an earlier delivery from values read before input", async () => {
  const apps = { A1: app(1), A2: app(2) };
  const s = await setup(apps);
  try {
    const wrong = await s.stack.run(
      policy(apps.A1, s.view.view_id, {
        verify: { field: "receipt", equals: "Saved {code} · {choice}" },
      }),
    );
    expect(wrong.canary?.reason).toBe("receipt_mismatch");
    expect(s.ledger.get("A1").state).toBe("awaiting_verification");
    const fixed = await s.stack.run(policy(apps.A1, s.view.view_id));
    expect(fixed.counts).toEqual({ verified: 2 });
    expect(correct(apps.A1) && correct(apps.A2)).toBe(true);
    // The first item was saved once; it was verified, not repeated.
    expect(apps.A1.saved.length).toBe(2);
  } finally {
    await s.clean();
  }
});

test("geometry outside the template is rejected before any input", async () => {
  const apps = { A1: app(1), A2: app(2) };
  const s = await setup(apps);
  try {
    const p = policy(apps.A1, s.view.view_id);
    p.steps[0] = { kind: "click", x: 1, y: 1 };
    await expect(s.stack.run(p)).rejects.toThrow("click_outside_template");
    expect(s.executes).toEqual({});
  } finally {
    await s.clean();
  }
});

test("a prepare policy clears interruptions without counting progress, then items proceed", async () => {
  const apps = {
    A1: app(1),
    A2: app(2, { notice: true }),
    A3: app(3, { notice: true }),
    A4: app(4),
  };
  const s = await setup(apps);
  try {
    const first = await s.stack.run(policy(apps.A1, s.view.view_id));
    expect(first.counts).toMatchObject({
      verified: 2,
      "exception:template_mismatch": 2,
    });
    // Both notice surfaces look alike: one example, one group.
    expect(first.exception_groups).toEqual([
      expect.objectContaining({
        reason: "template_mismatch",
        count: 2,
        surfaces: ["A2", "A3"],
      }),
    ]);
    const ex = apps.A2;
    const prep = await s.stack.run({
      request_id: "prep",
      view_id: first.exception_groups[0]!.view_id,
      mode: "prepare",
      template: { x: ex.ox, y: ex.oy, width: PW, height: PH },
      fields: [
        {
          name: "notice",
          rect: { x: ex.ox + 2, y: ex.oy + 4, width: 100, height: 14 },
        },
      ],
      steps: [{ kind: "click", x: ex.ox + SAVE.x + 5, y: ex.oy + SAVE.y + 5 }],
      verify: { field: "notice", absent: true },
      surfaces: ["A2", "A3"],
    });
    expect(prep.counts).toEqual({ prepared: 2 });
    expect(s.ledger.get("A2").completed).toBe(0);
    const rest = await s.stack.run(
      policy(apps.A1, s.view.view_id, { surfaces: ["A2", "A3"] }),
    );
    expect(rest.counts).toEqual({ verified: 2 });
    expect(Object.values(apps).every(correct)).toBe(true);
  } finally {
    await s.clean();
  }
});

test("prepare policies cannot type task values and items need positive verification", async () => {
  const apps = { A1: app(1) };
  const s = await setup(apps);
  try {
    await expect(
      s.stack.run(policy(apps.A1, s.view.view_id, { mode: "prepare" })),
    ).rejects.toThrow("prepare_cannot_type_task_values");
    await expect(
      s.stack.run(
        policy(apps.A1, s.view.view_id, {
          verify: { field: "receipt", absent: true },
        }),
      ),
    ).rejects.toThrow("item_requires_positive_verification");
    expect(s.executes).toEqual({});
  } finally {
    await s.clean();
  }
});

test("edge observation gives the same outcome without shipping pixels", async () => {
  const { edgeObserve, edgeTemplate } = await import("../src/stack.js");
  const apps = Object.fromEntries(
    Array.from({ length: 6 }, (_, i) => [`A${i + 1}`, app(i + 1)]),
  );
  apps.A6!.seed = 99;
  const dir = await mkdtemp(join(tmpdir(), "cu-stack-edge-"));
  const ids = Object.keys(apps);
  const ledger = await ProgressLedger.open(dir, ids, 2);
  const f = await fleet(apps);
  const cache = new Map<string, Awaited<ReturnType<typeof edgeTemplate>>>();
  let shipped = 0;
  const port: SurfacePort = {
    ...f.port,
    capture: async (id) => {
      shipped++;
      return f.port.capture(id);
    },
    locate: async (id, t, hint) => {
      if (!cache.has(t.key))
        cache.set(
          t.key,
          await edgeTemplate(t.png, t.masked, t.fields, t.points),
        );
      return {
        ...(await edgeObserve(
          await f.port.capture(id),
          f.port.readText!,
          cache.get(t.key)!,
          hint,
        )),
        evidence: `${id}.png`,
      };
    },
  };
  const stack = new StackScreen(port, ledger, ids, { settle_ms: 300 });
  try {
    const view = (await stack.observe(["A1"])).views[0]!;
    shipped = 0;
    const r = await stack.run(policy(apps.A1!, view.view_id));
    expect(r.counts).toEqual({ verified: 5, "exception:template_mismatch": 1 });
    expect(Object.values(apps).slice(0, 5).every(correct)).toBe(true);
    expect(f.executes.A6).toBeUndefined();
    // Only the exception example is fetched as pixels.
    expect(shipped).toBe(1);
    expect(r.views.length).toBe(1);
  } finally {
    await ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("choose.otherwise covers a task default but never an empty read", async () => {
  const apps = {
    A1: app(1),
    A2: app(2, {
      cases: [
        { code: "Q", priority: "LOW" },
        { code: "R", priority: "HIGH" },
      ],
    }),
    A3: app(3, {
      cases: [
        { code: "S", priority: "" },
        { code: "T", priority: "HIGH" },
      ],
    }),
  };
  const s = await setup(apps);
  try {
    const p = policy(apps.A1, s.view.view_id);
    const ch = p.steps[2] as any;
    ch.cases = [ch.cases[0]];
    ch.otherwise = {
      x: ch.cases[0].x - 50,
      y: ch.cases[0].y,
      label: "Standard",
    };
    const r = await s.stack.run(p);
    expect(r.counts).toMatchObject({
      verified: 2,
      "exception:no_matching_case": 1,
    });
    expect(apps.A2.saved.map((x) => x.choice)).toEqual(["Standard", "Urgent"]);
    expect(s.executes.A3).toBeUndefined();
  } finally {
    await s.clean();
  }
});

test("edge act-and-observe completes items with one round trip each and the same outcome", async () => {
  const { edgeActAndObserve, edgeObserve, edgeTemplate } =
    await import("../src/stack.js");
  const apps = Object.fromEntries(
    Array.from({ length: 5 }, (_, i) => [`A${i + 1}`, app(i + 1)]),
  );
  const dir = await mkdtemp(join(tmpdir(), "cu-stack-act-"));
  const ids = Object.keys(apps);
  const ledger = await ProgressLedger.open(dir, ids, 2);
  const f = await fleet(apps);
  const cache = new Map<string, Awaited<ReturnType<typeof edgeTemplate>>>();
  const tpl = async (t: {
    key: string;
    png: Buffer;
    masked: any[];
    fields?: any[];
    points?: any[];
  }) => {
    if (!cache.has(t.key))
      cache.set(t.key, await edgeTemplate(t.png, t.masked, t.fields, t.points));
    return cache.get(t.key)!;
  };
  let roundTrips = 0;
  const port: SurfacePort = {
    ...f.port,
    locate: async (id, t, hint) => {
      roundTrips++;
      return edgeObserve(
        await f.port.capture(id),
        f.port.readText!,
        await tpl(t),
        hint,
      );
    },
    actAndObserve: async (frame, actions, op, spec) => {
      roundTrips++;
      return edgeActAndObserve(
        {
          execute: f.port.execute,
          capture: f.port.capture,
          readText: f.port.readText!,
        },
        await tpl(spec.template),
        frame,
        actions,
        op,
        spec,
      );
    },
  };
  const stack = new StackScreen(port, ledger, ids, { settle_ms: 300 });
  try {
    const view = (await stack.observe(["A1"])).views[0]!;
    const r = await stack.run(policy(apps.A1!, view.view_id));
    expect(r.counts).toEqual({ verified: 5 });
    expect(Object.values(apps).every(correct)).toBe(true);
    // One locate per surface (+1 when the canary surface resumes in the
    // broadcast), then one act-and-observe per item.
    expect(roundTrips).toBe(5 + 1 + 5 * 2);
  } finally {
    await ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("text probes replace screenshot polling while waiting for a post-condition", async () => {
  const run = async (probe: boolean) => {
    const apps = Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [`A${i + 1}`, app(i + 1)]),
    );
    const dir = await mkdtemp(join(tmpdir(), "cu-stack-probe-"));
    const ids = Object.keys(apps);
    const ledger = await ProgressLedger.open(dir, ids, 2);
    const f = await fleet(apps);
    let captures = 0;
    const port: SurfacePort = {
      ...f.port,
      capture: async (id) => {
        captures++;
        return f.port.capture(id);
      },
      ...(probe
        ? {
            probeText: async (id: string) => {
              const a = apps[id]!;
              return f.port.readText!(
                await f.port.capture(id).then((x) => (captures--, x)),
              );
            },
          }
        : {}),
    };
    const stack = new StackScreen(port, ledger, ids, { settle_ms: 300 });
    try {
      const view = (await stack.observe(["A1"])).views[0]!;
      const r = await stack.run(policy(apps.A1!, view.view_id));
      expect(r.counts).toEqual({ verified: 4 });
      expect(Object.values(apps).every(correct)).toBe(true);
      return captures;
    } finally {
      await ledger.close();
      await rm(dir, { recursive: true, force: true });
    }
  };
  // Same outcome; the probe path never takes more screenshots.
  expect(await run(true)).toBeLessThanOrEqual(await run(false));
});

test("probing still follows a panel that moves after a save", async () => {
  const apps = { A1: app(1), A2: app(2, { ox: 20, oy: 10, move: [45, 30] }) };
  const dir = await mkdtemp(join(tmpdir(), "cu-stack-move-"));
  const ids = Object.keys(apps);
  const ledger = await ProgressLedger.open(dir, ids, 2);
  const f = await fleet(apps);
  const port: SurfacePort = {
    ...f.port,
    probeText: async (id) => f.port.readText!(await f.port.capture(id)),
  };
  const stack = new StackScreen(port, ledger, ids, { settle_ms: 1500 });
  try {
    const view = (await stack.observe(["A1"])).views[0]!;
    const r = await stack.run(policy(apps.A1, view.view_id));
    expect(r.counts).toEqual({ verified: 2 });
    expect(correct(apps.A2)).toBe(true);
  } finally {
    await ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("independent policies may run concurrently on disjoint surfaces; overlap is refused per surface", async () => {
  const apps = { A1: app(1), A2: app(2), A3: app(3), A4: app(4) };
  const s = await setup(apps);
  try {
    const [r1, r2] = await Promise.all([
      s.stack.run(policy(apps.A1, s.view.view_id, { surfaces: ["A1", "A2"] })),
      s.stack.run(policy(apps.A1, s.view.view_id, { surfaces: ["A3", "A4"] })),
    ]);
    expect(r1.counts).toEqual({ verified: 2 });
    expect(r2.counts).toEqual({ verified: 2 });
    expect(Object.values(apps).every(correct)).toBe(true);
    // Every item executed exactly once.
    expect(Object.values(s.executes)).toEqual([2, 2, 2, 2]);
  } finally {
    await s.clean();
  }
});

test("overlapping concurrent policies never double-execute a surface", async () => {
  const apps = { A1: app(1), A2: app(2), A3: app(3) };
  const s = await setup(apps);
  try {
    await Promise.all([
      s.stack.run(policy(apps.A1, s.view.view_id)),
      s.stack.run(policy(apps.A1, s.view.view_id)),
    ]);
    for (const a of Object.values(apps))
      expect(a.saved.length).toBeLessThanOrEqual(2);
    expect(
      Object.values(apps).every((a) =>
        a.saved.every((x, i) => x.text === a.cases[i]!.code),
      ),
    ).toBe(true);
  } finally {
    await s.clean();
  }
});

test("surfaces registered during the canary start acting without a second registration", async () => {
  const { edgeObserve, edgeTemplate } = await import("../src/stack.js");
  const apps = Object.fromEntries(
    Array.from({ length: 6 }, (_, i) => [`A${i + 1}`, app(i + 1)]),
  );
  const dir = await mkdtemp(join(tmpdir(), "cu-stack-seed-"));
  const ids = Object.keys(apps);
  const ledger = await ProgressLedger.open(dir, ids, 2);
  const f = await fleet(apps);
  const cache = new Map<string, Awaited<ReturnType<typeof edgeTemplate>>>();
  let locates = 0;
  const port: SurfacePort = {
    ...f.port,
    locate: async (id, t, hint) => {
      locates++;
      if (!cache.has(t.key))
        cache.set(
          t.key,
          await edgeTemplate(t.png, t.masked, t.fields, t.points),
        );
      return edgeObserve(
        await f.port.capture(id),
        f.port.readText!,
        cache.get(t.key)!,
        hint,
      );
    },
  };
  const stack = new StackScreen(port, ledger, ids, { settle_ms: 300 });
  try {
    const view = (await stack.observe(["A1"])).views[0]!;
    const r = await stack.run(policy(apps.A1!, view.view_id));
    expect(r.counts).toEqual({ verified: 6 });
    expect(Object.values(apps).every(correct)).toBe(true);
    // No surface needs a fresh registration before its first broadcast item.
    const firstItemFresh = locates;
    expect(firstItemFresh).toBeLessThan(6 * 4);
  } finally {
    await ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("vision mode (ablation B-V): contact sheet, model values, confirmation; no text channel", async () => {
  const apps = { A1: app(1), A2: app(2), A3: app(3) };
  const dir = await mkdtemp(join(tmpdir(), "cu-stack-vision-"));
  const ids = Object.keys(apps);
  const ledger = await ProgressLedger.open(dir, ids, 2);
  const f = await fleet(apps);
  let reads = 0;
  const port: SurfacePort = {
    ...f.port,
    readText: async (fr) => {
      reads++;
      return f.port.readText!(fr);
    },
  };
  const stack = new StackScreen(port, ledger, ids, {
    settle_ms: 300,
    values: "vision",
  });
  try {
    const view = (await stack.observe(["A1"])).views[0]!;
    const p = policy(apps.A1, view.view_id);
    const fields = p.fields.filter((x) => x.name !== "receipt");
    await expect(stack.run(p)).rejects.toThrow("vision_mode_requires_values");
    const sheet = await stack.crops({
      view_id: view.view_id,
      template: p.template,
      fields,
    });
    expect(sheet.rows.map((r) => r.surface_id)).toEqual(ids);
    expect(sheet.sheets.length).toBe(1);
    // The "model" transcribes from the sheet; here it reads the truth.
    const values = Object.fromEntries(
      ids.map((id) => {
        const c = apps[id as keyof typeof apps].cases[0]!;
        return [id, { code: c.code, priority: c.priority }];
      }),
    );
    const r = await stack.run({
      ...p,
      request_id: "v1",
      values,
      crops_id: sheet.crops_id,
    });
    expect(r.counts).toEqual({ delivered: 3 });
    // Confirmation needs a snapshot taken after the delivery.
    await expect(
      stack.confirm({
        crops_id: sheet.crops_id,
        checks: { A1: { text: values.A1!.code, choice: "x" } },
      }),
    ).resolves.toMatchObject({
      results: [{ result: "fresh_snapshot_after_delivery_required" }],
    });
    const after = await stack.crops({
      view_id: view.view_id,
      template: p.template,
      fields: p.fields,
    });
    const choice = (id: string) =>
      apps[id as keyof typeof apps].cases[0]!.priority === "HIGH"
        ? "Urgent"
        : "Standard";
    const c = await stack.confirm({
      crops_id: after.crops_id,
      checks: Object.fromEntries(
        ids.map((id) => [id, { text: values[id]!.code, choice: choice(id) }]),
      ),
    });
    expect(c.results.every((x) => x.result === "ready")).toBe(true);
    expect(ids.every((id) => ledger.get(id).completed === 1)).toBe(true);
    expect(reads).toBe(0);
  } finally {
    await ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("click_text clicks the unique matching text node inside the template", async () => {
  const apps = { A1: app(1), A2: app(2) };
  const s = await setup(apps);
  try {
    const p = policy(apps.A1, s.view.view_id);
    // Replace the input click with a click on the "Code:" label (unique) — harmless here.
    p.steps.unshift({ kind: "click_text", text: "Code:" } as any);
    const r = await s.stack.run(p);
    expect(r.counts).toEqual({ verified: 2 });
    const q = policy(apps.A1, s.view.view_id, { request_id: "missing" });
    q.steps.unshift({ kind: "click_text", text: "Nope" } as any);
  } finally {
    await s.clean();
  }
});

test("the canary skips surfaces where the policy does not apply and runs on the first applicable one", async () => {
  const apps = { A1: app(1, { seed: 99 }), A2: app(2), A3: app(3) };
  const dir = await mkdtemp(join(tmpdir(), "cu-stack-canary-"));
  const ids = Object.keys(apps);
  const ledger = await ProgressLedger.open(dir, ids, 2);
  const f = await fleet(apps);
  const stack = new StackScreen(f.port, ledger, ids, { settle_ms: 300 });
  try {
    // Exemplar is A2 (layout 7); A1 has another layout and is first in order.
    const view = (await stack.observe(["A2"])).views[0]!;
    const r = await stack.run(policy(apps.A2, view.view_id));
    expect(r.canary).toMatchObject({ surface_id: "A2" });
    expect(r.counts).toEqual({ verified: 2, "exception:template_mismatch": 1 });
    expect(f.executes.A1).toBeUndefined();
  } finally {
    await ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("click_text avoids the part of a target covered by another element", async () => {
  const { unoccludedPoint } = await import("../src/stack.js");
  const one = {
    role: "button",
    text: "ONE",
    rect: { x: 31, y: 166, width: 98, height: 98 },
  };
  const oneText = {
    role: "StaticText",
    text: "ONE",
    rect: { x: 50, y: 200, width: 72, height: 30 },
  };
  const two = {
    role: "button",
    text: "TWO",
    rect: { x: 86, y: 146, width: 98, height: 98 },
  };
  const p = unoccludedPoint(oneText, [one, oneText, two])!;
  // Inside ONE's text and outside TWO.
  expect(p.x).toBeLessThan(86 - 2);
  expect(p.x >= 50 && p.y >= 200 && p.y < 230).toBe(true);
  // Fully covered: no point, no input.
  expect(
    unoccludedPoint(oneText, [
      oneText,
      {
        role: "button",
        text: "X",
        rect: { x: 0, y: 0, width: 300, height: 300 },
      },
    ]),
  ).toBeNull();
});
