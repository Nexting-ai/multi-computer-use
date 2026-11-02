import { test, expect } from "vitest";
import sharp from "sharp";
import { TaskScreen, taskViewMetadata } from "../src/task.js";
import type { Frame, Action } from "../src/index.js";
async function fixture() {
  const rgb = Buffer.alloc(100 * 100 * 3, 230),
    effects: { id: string; actions: Action[] }[] = [];
  const frame: Frame = {
    surface_id: "A",
    route_id: "A",
    epoch: 1,
    revision: "one",
    width: 100,
    height: 100,
    png: await sharp(rgb, { raw: { width: 100, height: 100, channels: 3 } })
      .png()
      .toBuffer(),
  };
  const screen = new TaskScreen({
    capture: async (id) => ({ ...frame, surface_id: id, route_id: id }),
    execute: async (f, actions) => {
      effects.push({ id: f.surface_id, actions });
      return { status: "delivered" };
    },
  });
  const original = await screen.observe([
    { surface_id: "A" },
    { surface_id: "B" },
  ]);
  const regions = {
    facts: { x: 10, y: 10, width: 60, height: 15 },
    controls: { x: 20, y: 30, width: 50, height: 35 },
    receipt: { x: 10, y: 70, width: 70, height: 15 },
  };
  const layouts = original.map((v) => ({
    view_id: v.view_id,
    z: v.panels[0]!.z,
    regions,
  }));
  const targets = original.map((v) => ({
    view_id: v.view_id,
    z: v.panels[0]!.z,
    basis: "Read current facts",
    actions: [{ kind: "click" as const, x: 25, y: 40 }],
  }));
  return { screen, original, regions, layouts, targets, effects, frame, rgb };
}
test("role images isolate facts from receipts; identical controls share pixels but retain distinct target maps", async () => {
  const { screen, layouts, targets, effects } = await fixture();
  await screen.act({ request_id: "first", targets, layouts });
  const v = await screen.observe([{ surface_id: "B" }, { surface_id: "A" }]);
  expect(v.map((v) => v.role)).toEqual(["facts", "controls", "receipt"]);
  const controls = v.find((v) => v.role === "controls")!;
  const compact = taskViewMetadata(controls);
  expect(compact.panels.map((p) => p.z)).toEqual([2, 1]);
  expect(compact.panels[0]!.rect).toEqual(controls.panels[0]!.rect);
  expect(compact.panels[0]).not.toHaveProperty("source_rect");
  expect(controls.panels.map((p) => p.z)).toEqual([2, 1]);
  expect(controls.panels[0]!.rect).toEqual(controls.panels[1]!.rect);
  await screen.act({
    request_id: "second",
    targets: [
      {
        view_id: controls.view_id,
        z: 1,
        basis: "Current facts imply choice",
        actions: [{ kind: "click", x: 7, y: 11 }],
      },
    ],
  });
  expect(effects.at(-1)).toEqual({
    id: "A",
    actions: [{ kind: "click", x: 27, y: 41 }],
  });
  await screen.act({
    request_id: "second",
    targets: [
      {
        view_id: controls.view_id,
        z: 1,
        basis: "Current facts imply choice",
        actions: [{ kind: "click", x: 7, y: 11 }],
      },
    ],
  });
  expect(effects).toHaveLength(3);
});
test("facts/receipt are read-only, and one bad target prevents the whole batch", async () => {
  const { screen, layouts, targets, effects } = await fixture();
  await screen.act({ request_id: "first", targets, layouts });
  const v = await screen.observe([{ surface_id: "A" }, { surface_id: "B" }]);
  const target = (role: string, z: number) => ({
    view_id: v.find((v) => v.role === role)!.view_id,
    z,
    basis: "current",
    actions: [{ kind: "click" as const, x: 4, y: 5 }],
  });
  await expect(
    screen.act({
      request_id: "bad",
      targets: [target("controls", 1), target("receipt", 2)],
    }),
  ).rejects.toThrow("read_only_region");
  expect(effects).toHaveLength(2);
  await expect(
    screen.act({ request_id: "bad2", targets: [target("facts", 1)] }),
  ).rejects.toThrow("read_only_region");
});
test("a change outside ALL selected rectangles invalidates layout; inside facts does not", async () => {
  const { screen, layouts, targets, frame, rgb } = await fixture();
  await screen.act({ request_id: "first", targets, layouts });
  const update = async (x: number, y: number) => {
    rgb[(y * 100 + x) * 3] = 10;
    frame.png = await sharp(rgb, {
      raw: { width: 100, height: 100, channels: 3 },
    })
      .png()
      .toBuffer();
  };
  await update(12, 12);
  expect(
    (await screen.observe([{ surface_id: "A" }])).every(
      (v) => v.role !== "full",
    ),
  ).toBe(true);
  await update(15, 27);
  const v = await screen.observe([{ surface_id: "A" }]);
  expect(v).toHaveLength(1);
  expect(v[0]!.role).toBe("full");
  expect(v[0]!.panels[0]!.focus_status).toBe("invalidated");
});
test("overlapping regions and stale action observations cannot produce input", async () => {
  const { screen, layouts, targets, effects } = await fixture();
  await expect(
    screen.act({
      request_id: "overlap",
      targets,
      layouts: [
        {
          ...layouts[0]!,
          regions: {
            ...layouts[0]!.regions,
            receipt: layouts[0]!.regions.facts,
          },
        },
      ],
    }),
  ).rejects.toThrow("overlapping_regions");
  expect(effects).toHaveLength(0);
  await screen.act({ request_id: "first", targets, layouts });
  const r = await screen.act({ request_id: "stale", targets });
  expect(r.every((r) => r.status === "blocked")).toBe(true);
  expect(effects).toHaveLength(2);
});
test("returned role metadata cannot grant read-only pixels input rights or rewrite a source map", async () => {
  const { screen, layouts, targets, effects } = await fixture();
  await screen.act({ request_id: "first", targets, layouts });
  const views = await screen.observe([{ surface_id: "A" }]),
    receipt = views.find((v) => v.role === "receipt")!,
    controls = views.find((v) => v.role === "controls")!;
  receipt.role = "controls";
  controls.panels[0]!.source_rect.x = 99;
  await expect(
    screen.act({
      request_id: "fake",
      targets: [
        {
          view_id: receipt.view_id,
          z: 1,
          basis: "fake",
          actions: [{ kind: "click", x: 1, y: 1 }],
        },
      ],
    }),
  ).rejects.toThrow("read_only_region");
  await screen.act({
    request_id: "real",
    targets: [
      {
        view_id: controls.view_id,
        z: 1,
        basis: "current",
        actions: [{ kind: "click", x: 1, y: 1 }],
      },
    ],
  });
  expect(effects.at(-1)).toEqual({
    id: "A",
    actions: [{ kind: "click", x: 21, y: 31 }],
  });
});
test("navigation invalidates all three regions even with identical pixels", async () => {
  const { screen, layouts, targets, frame } = await fixture();
  await screen.act({ request_id: "first", targets, layouts });
  frame.epoch++;
  const v = await screen.observe([{ surface_id: "A" }]);
  expect(v).toHaveLength(1);
  expect(v[0]!.role).toBe("full");
  expect(v[0]!.panels[0]!.focus_status).toBe("invalidated");
});
