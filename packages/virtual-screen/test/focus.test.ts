import { test, expect } from "vitest";
import sharp from "sharp";
import { VirtualScreen, type Frame, type Action } from "../src/index.js";
test("failed observations do not consume the first full separate observation", async () => {
  const png = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const layer = new VirtualScreen(
    {
      capture: async (surface_id) => ({
        surface_id,
        route_id: surface_id,
        epoch: 1,
        revision: "x",
        width: 20,
        height: 20,
        png,
      }),
      execute: async () => ({ status: "delivered" }),
    },
    { mode: "composite", first_observation_raw: true },
  );
  await expect(layer.observe([])).rejects.toThrow();
  expect(
    await layer.observe([{ surface_id: "A" }, { surface_id: "B" }]),
  ).toHaveLength(2);
  expect(
    await layer.observe([{ surface_id: "A" }, { surface_id: "B" }]),
  ).toHaveLength(1);
});
test("different crop sizes pack without padding every cell to the largest window", async () => {
  const { layer } = await fixture();
  const [v] = await layer.observe([
    { surface_id: "A", crop: { x: 0, y: 0, width: 20, height: 20 } },
    { surface_id: "B", crop: { x: 0, y: 0, width: 80, height: 30 } },
  ]);
  expect(v!.width).toBe(124);
  expect(v!.height).toBe(70);
  expect(v!.panels[1]!.rect).toEqual({ x: 36, y: 32, width: 80, height: 30 });
});
async function fixture() {
  const rgb = Buffer.alloc(120 * 100 * 3, 240);
  for (let y = 25; y < 75; y++)
    for (let x = 35; x < 95; x++) {
      const o = (y * 120 + x) * 3;
      rgb[o] = 30;
      rgb[o + 1] = 60;
      rgb[o + 2] = 90;
    }
  const f: Frame = {
    surface_id: "A",
    route_id: "route-A",
    epoch: 1,
    revision: "one",
    width: 120,
    height: 100,
    png: await sharp(rgb, { raw: { width: 120, height: 100, channels: 3 } })
      .png()
      .toBuffer(),
  };
  const effects: Action[][] = [];
  const layer = new VirtualScreen(
    {
      capture: async (id) => ({
        ...f,
        surface_id: id,
        route_id: `route-${id}`,
      }),
      execute: async (_f, actions) => {
        effects.push(actions);
        return { status: "delivered" };
      },
    },
    { mode: "composite" },
  );
  return { layer, f, effects, rgb };
}
test("model selects a task region from an observed view; XYZ click maps to the original window", async () => {
  const { layer, effects } = await fixture();
  const [full] = await layer.observe([{ surface_id: "A" }]);
  expect(full!.panels[0]!.z).toBe(1);
  await layer.focus({
    regions: [
      {
        view_id: full!.view_id,
        surface_id: "A",
        rect: { x: 43, y: 57, width: 60, height: 50 },
      },
    ],
  });
  const [focused] = await layer.observe([{ surface_id: "A" }]);
  expect(focused!.panels[0]!.source_rect).toEqual({
    x: 35,
    y: 25,
    width: 60,
    height: 50,
  });
  expect(focused!.panels[0]!.focus_status).toBe("active");
  await layer.actSpatial({
    request_id: "xyz",
    targets: [
      {
        view_id: focused!.view_id,
        z: 1,
        actions: [{ kind: "click", x: 5, y: 7 }],
      },
    ],
  });
  expect(effects).toEqual([[{ kind: "click", x: 40, y: 32 }]]);
});
test("focus has no fixture coordinates: unrelated crop origins map independently and Z survives reordering", async () => {
  const { layer, effects } = await fixture();
  const [full] = await layer.observe([
    { surface_id: "A" },
    { surface_id: "B" },
  ]);
  await layer.focus({
    regions: [
      {
        view_id: full!.view_id,
        surface_id: "B",
        rect: { x: 146, y: 42, width: 20, height: 35 },
      },
    ],
  });
  const [next] = await layer.observe([
    { surface_id: "B" },
    { surface_id: "A" },
  ]);
  expect(next!.panels.map((p) => p.z)).toEqual([2, 1]);
  expect(next!.panels[0]!.source_rect).toEqual({
    x: 10,
    y: 10,
    width: 20,
    height: 35,
  });
  await layer.actSpatial({
    request_id: "other",
    targets: [
      {
        view_id: next!.view_id,
        z: 2,
        actions: [{ kind: "click", x: 19, y: 34 }],
      },
    ],
  });
  expect(effects).toEqual([[{ kind: "click", x: 29, y: 44 }]]);
});
test("changed pixels inside focus preserve it; outside changes restore the full window", async () => {
  const { layer, f, rgb } = await fixture();
  const [full] = await layer.observe([{ surface_id: "A" }]);
  await layer.focus({
    regions: [
      {
        view_id: full!.view_id,
        surface_id: "A",
        rect: { x: 43, y: 57, width: 60, height: 50 },
      },
    ],
  });
  rgb[(30 * 120 + 40) * 3] = 180;
  f.png = await sharp(rgb, { raw: { width: 120, height: 100, channels: 3 } })
    .png()
    .toBuffer();
  f.revision = "two";
  expect(
    (await layer.observe([{ surface_id: "A" }]))[0]!.panels[0]!.focus_status,
  ).toBe("active");
  rgb[(5 * 120 + 5) * 3] = 20;
  f.png = await sharp(rgb, { raw: { width: 120, height: 100, channels: 3 } })
    .png()
    .toBuffer();
  f.revision = "three";
  const [changed] = await layer.observe([{ surface_id: "A" }]);
  expect(changed!.panels[0]!.focus_status).toBe("invalidated");
  expect(changed!.panels[0]!.source_rect).toEqual({
    x: 0,
    y: 0,
    width: 120,
    height: 100,
  });
});
test("epoch change invalidates focus even if all pixels look identical", async () => {
  const { layer, f } = await fixture();
  const [full] = await layer.observe([{ surface_id: "A" }]);
  await layer.focus({
    regions: [
      {
        view_id: full!.view_id,
        surface_id: "A",
        rect: { x: 43, y: 57, width: 60, height: 50 },
      },
    ],
  });
  f.epoch++;
  expect(
    (await layer.observe([{ surface_id: "A" }]))[0]!.panels[0]!.focus_status,
  ).toBe("invalidated");
});
test("stale focus, a rectangle straddling windows and wrong-Z local coordinates cannot dispatch", async () => {
  const { layer, effects } = await fixture();
  const [v] = await layer.observe([{ surface_id: "A" }, { surface_id: "B" }]);
  await expect(
    layer.focus({
      regions: [
        {
          view_id: v!.view_id,
          surface_id: "A",
          rect: { x: 100, y: 40, width: 60, height: 20 },
        },
      ],
    }),
  ).rejects.toThrow("region_outside_target");
  await expect(
    layer.actSpatial({
      request_id: "bad-z",
      targets: [
        {
          view_id: v!.view_id,
          z: 99,
          actions: [{ kind: "click", x: 5, y: 5 }],
        },
      ],
    }),
  ).rejects.toThrow("z_not_in_view");
  await expect(
    layer.actSpatial({
      request_id: "bad-x",
      targets: [
        {
          view_id: v!.view_id,
          z: 2,
          actions: [{ kind: "click", x: 120, y: 5 }],
        },
      ],
    }),
  ).rejects.toThrow("point_outside_target");
  expect(effects).toHaveLength(0);
  await layer.actSpatial({
    request_id: "valid",
    targets: [
      { view_id: v!.view_id, z: 1, actions: [{ kind: "click", x: 5, y: 5 }] },
    ],
  });
  await expect(
    layer.focus({
      regions: [
        {
          view_id: v!.view_id,
          surface_id: "A",
          rect: { x: 10, y: 40, width: 10, height: 20 },
        },
      ],
    }),
  ).rejects.toThrow("observation_consumed");
});
