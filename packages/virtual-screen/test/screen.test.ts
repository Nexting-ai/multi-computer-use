import { test, expect } from "vitest";
import sharp from "sharp";
import {
  VirtualScreen,
  type Frame,
  type SurfacePort,
  type Action,
  type Delivery,
} from "../src/index.js";

async function fixture(mode: "raw" | "composite" = "composite", extra = {}) {
  const frames = new Map<string, Frame>();
  for (const [id, color] of [
    ["A", "red"],
    ["B", "blue"],
  ])
    frames.set(id!, {
      surface_id: id!,
      route_id: "route/" + id,
      epoch: 1,
      revision: "original",
      width: 100,
      height: 80,
      png: await sharp({
        create: { width: 100, height: 80, channels: 3, background: color! },
      })
        .png()
        .toBuffer(),
    });
  const delivered: { surface: string; actions: Action[] }[] = [];
  const port: SurfacePort = {
    async capture(id) {
      const f = frames.get(id);
      if (!f) throw Error("missing");
      return { ...f };
    },
    async execute(frame, actions): Promise<Delivery> {
      const current = frames.get(frame.surface_id)!;
      if (
        current.route_id !== frame.route_id ||
        current.epoch !== frame.epoch ||
        current.revision !== frame.revision
      )
        return { status: "blocked", reason: "stale_source" };
      delivered.push({ surface: frame.surface_id, actions });
      return { status: "delivered" };
    },
  };
  return {
    layer: new VirtualScreen(port, { mode, ...extra }),
    frames,
    delivered,
    port,
  };
}
test("real PNG composition keeps pixels, crop origin and second-window input identity", async () => {
  const { layer, delivered } = await fixture();
  const [v] = await layer.observe([
    { surface_id: "A", crop: { x: 10, y: 20, width: 40, height: 30 } },
    { surface_id: "B", crop: { x: 30, y: 10, width: 40, height: 30 } },
  ]);
  expect(v!.panels).toEqual([
    {
      surface_id: "A",
      z: 1,
      focus_status: "explicit",
      rect: { x: 8, y: 32, width: 40, height: 30 },
      source_rect: { x: 10, y: 20, width: 40, height: 30 },
    },
    {
      surface_id: "B",
      z: 2,
      focus_status: "explicit",
      rect: { x: 56, y: 32, width: 40, height: 30 },
      source_rect: { x: 30, y: 10, width: 40, height: 30 },
    },
  ]);
  const { data, info } = await sharp(v!.png)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect([
    ...data.subarray(
      (33 * info.width + 57) * 3,
      (33 * info.width + 57) * 3 + 3,
    ),
  ]).toEqual([0, 0, 255]);
  await layer.act({
    request_id: "one",
    targets: [
      {
        view_id: v!.view_id,
        surface_id: "B",
        actions: [
          { kind: "click", x: 59, y: 36 },
          { kind: "type_text", text: "B你好" },
        ],
      },
    ],
  });
  expect(delivered).toEqual([
    {
      surface: "B",
      actions: [
        { kind: "click", x: 33, y: 14 },
        { kind: "type_text", text: "B你好" },
      ],
    },
  ]);
});
test("one coordinate in the wrong panel rejects the entire batch before any input", async () => {
  const { layer, delivered } = await fixture();
  const [v] = await layer.observe([{ surface_id: "A" }, { surface_id: "B" }]);
  await expect(
    layer.act({
      request_id: "bad",
      targets: [
        {
          view_id: v!.view_id,
          surface_id: "A",
          actions: [{ kind: "click", x: 9, y: 33 }],
        },
        {
          view_id: v!.view_id,
          surface_id: "B",
          actions: [{ kind: "click", x: 9, y: 33 }],
        },
      ],
    }),
  ).rejects.toThrow("point_outside_target");
  expect(delivered).toEqual([]);
});
test.each([
  [0, 0],
  [8, 31],
  [108, 32],
  [8, 112],
  [-1, 32],
  [8.5, 33],
])("gutter/header/edge/invalid click %s,%s never dispatches", async (x, y) => {
  const { layer, delivered } = await fixture();
  const [v] = await layer.observe([{ surface_id: "A" }]);
  await expect(
    layer.act({
      request_id: "bad",
      targets: [
        {
          view_id: v!.view_id,
          surface_id: "A",
          actions: [{ kind: "click", x, y }],
        },
      ],
    }),
  ).rejects.toThrow();
  expect(delivered).toEqual([]);
});
test("view membership is immutable across later reordering and caller metadata mutation", async () => {
  const { layer, delivered } = await fixture();
  const [old] = await layer.observe([{ surface_id: "A" }, { surface_id: "B" }]);
  old!.panels[0]!.surface_id = "B";
  await layer.observe([{ surface_id: "B" }, { surface_id: "A" }]);
  await layer.act({
    request_id: "old",
    targets: [
      {
        view_id: old!.view_id,
        surface_id: "A",
        actions: [{ kind: "click", x: 9, y: 33 }],
      },
    ],
  });
  expect(delivered[0]).toEqual({
    surface: "A",
    actions: [{ kind: "click", x: 1, y: 1 }],
  });
});
test("raw mode has identical batch capability and original coordinate system", async () => {
  const { layer, delivered } = await fixture("raw");
  const vs = await layer.observe([{ surface_id: "A" }, { surface_id: "B" }]);
  expect(vs).toHaveLength(2);
  await layer.act({
    request_id: "raw",
    targets: vs.map((v) => ({
      view_id: v.view_id,
      surface_id: v.panels[0]!.surface_id,
      actions: [{ kind: "click" as const, x: 99, y: 79 }],
    })),
  });
  expect(delivered).toEqual([
    { surface: "A", actions: [{ kind: "click", x: 99, y: 79 }] },
    { surface: "B", actions: [{ kind: "click", x: 99, y: 79 }] },
  ]);
});
test("closed/replaced/resized/changed source blocks only that target", async () => {
  const { layer, frames, delivered } = await fixture();
  const [v] = await layer.observe([{ surface_id: "A" }, { surface_id: "B" }]);
  frames.get("A")!.epoch++;
  const r = await layer.act({
    request_id: "stale",
    targets: [
      {
        view_id: v!.view_id,
        surface_id: "A",
        actions: [{ kind: "click", x: 9, y: 33 }],
      },
      {
        view_id: v!.view_id,
        surface_id: "B",
        actions: [{ kind: "click", x: 117, y: 33 }],
      },
    ],
  });
  expect(r.map((x) => x.status)).toEqual(["blocked", "delivered"]);
  expect(delivered.map((x) => x.surface)).toEqual(["B"]);
});
test("identical concurrent request executes once, conflict is rejected, unknown never replays", async () => {
  const f = await fixture();
  let effects = 0;
  f.port.execute = async () => {
    effects++;
    throw Error("lost_after_input");
  };
  const [v] = await f.layer.observe([{ surface_id: "A" }]);
  const request = {
    request_id: "repeat",
    targets: [
      {
        view_id: v!.view_id,
        surface_id: "A",
        actions: [{ kind: "click" as const, x: 9, y: 33 }],
      },
    ],
  };
  const [a, b] = await Promise.all([
    f.layer.act(request),
    f.layer.act(request),
  ]);
  expect(a).toEqual(b);
  expect(a[0]!.status).toBe("unknown");
  expect(effects).toBe(1);
  await f.layer.act(request);
  expect(effects).toBe(1);
  await expect(
    f.layer.act({
      ...request,
      targets: [
        { ...request.targets[0]!, actions: [{ kind: "click", x: 10, y: 33 }] },
      ],
    }),
  ).rejects.toThrow("idempotency_conflict");
});
test("expired or foreign-session view cannot be used to type into a current focus", async () => {
  const f = await fixture("composite", { ttl_ms: 1 });
  const [v] = await f.layer.observe([{ surface_id: "A" }]);
  await new Promise((r) => setTimeout(r, 5));
  const req = {
    request_id: "expired",
    targets: [
      {
        view_id: v!.view_id,
        surface_id: "A",
        actions: [{ kind: "type_text" as const, text: "x" }],
      },
    ],
  };
  await expect(f.layer.act(req)).rejects.toThrow("view_expired");
  const other = await fixture();
  await expect(other.layer.act(req)).rejects.toThrow("view_expired");
  expect(f.delivered).toEqual([]);
});
test("duplicate targets and excessive image dimensions are rejected", async () => {
  const f = await fixture();
  await expect(
    f.layer.observe([{ surface_id: "A" }, { surface_id: "A" }]),
  ).rejects.toThrow("duplicate_surface");
  f.frames.get("A")!.width = 1_000_000;
  await expect(f.layer.observe([{ surface_id: "A" }])).rejects.toThrow();
});
