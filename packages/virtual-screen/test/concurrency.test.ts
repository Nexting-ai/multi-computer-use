import { test, expect } from "vitest";
import sharp from "sharp";
import {
  Gate,
  VirtualScreen,
  type Frame,
  type SurfacePort,
} from "../src/index.js";
test("a stalled target does not block the free slot, including another tool call", async () => {
  const gate = new Gate(2);
  let release!: () => void;
  const stopped = new Promise<void>((r) => (release = r)),
    events: string[] = [];
  const a = gate.run(async () => {
    events.push("a-start");
    await stopped;
    events.push("a-end");
  });
  const b = gate.run(async () => {
    events.push("b");
  });
  const c = gate.run(async () => {
    events.push("c");
  });
  await Promise.all([b, c]);
  expect(events).toEqual(["a-start", "b", "c"]);
  release();
  await a;
});
test("a previously dispatched observation cannot execute again under a different request ID", async () => {
  let effects = 0;
  const frame: Frame = {
    surface_id: "A",
    route_id: "r",
    epoch: 0,
    revision: "unchanged",
    width: 20,
    height: 20,
    png: await sharp({
      create: { width: 20, height: 20, channels: 3, background: "red" },
    })
      .png()
      .toBuffer(),
  };
  const port: SurfacePort = {
    capture: async () => frame,
    execute: async () => {
      effects++;
      return { status: "delivered" };
    },
  };
  const layer = new VirtualScreen(port, { mode: "raw" });
  const [v] = await layer.observe([{ surface_id: "A" }]);
  const targets = [
    {
      view_id: v!.view_id,
      surface_id: "A",
      actions: [{ kind: "click" as const, x: 1, y: 1 }],
    },
  ];
  const [a, b] = await Promise.all([
    layer.act({ request_id: "a", targets }),
    layer.act({ request_id: "b", targets }),
  ]);
  expect(a[0]!.status).toBe("delivered");
  expect(b[0]!.reason).toBe("observation_consumed");
  expect(effects).toBe(1);
});
