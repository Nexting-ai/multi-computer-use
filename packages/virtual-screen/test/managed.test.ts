import { test, expect } from "vitest";
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagedScreen } from "../src/managed.js";
import { ProgressLedger, runWorksets } from "../src/workset.js";
import type { Frame, SurfacePort } from "../src/index.js";
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "cu-managed-"));
  const png = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const frame = (id: string): Frame => ({
    surface_id: id,
    route_id: id,
    epoch: 1,
    revision: "r",
    width: 100,
    height: 100,
    png,
  });
  return { dir, frame, clean: () => rm(dir, { recursive: true, force: true }) };
}
test("role actions strip orchestration fields before strict executor validation", async () => {
  const f = await fixture(),
    l = await ProgressLedger.open(f.dir, ["A"], 1);
  let effects = 0;
  const s = new ManagedScreen(
    {
      capture: async (id) => f.frame(id),
      execute: async () => {
        effects++;
        return { status: "delivered" };
      },
    },
    l,
    ["A"],
    ["A"],
    true,
  );
  try {
    const v = (await s.observe(["A"])).views[0]!;
    const r = await s.act({
      request_id: "role",
      targets: [
        {
          view_id: v.view_id,
          z: 1,
          basis: "current F1",
          expectation: { text: "F1", choice: "Standard" },
          actions: [{ kind: "type_text", text: "F1" }],
        },
      ],
      layouts: [
        {
          view_id: v.view_id,
          z: 1,
          regions: {
            facts: { x: 0, y: 0, width: 100, height: 30 },
            controls: { x: 0, y: 30, width: 100, height: 40 },
            receipt: { x: 0, y: 70, width: 100, height: 30 },
          },
        },
      ],
    });
    expect(effects).toBe(1);
    expect(r.deliveries[0]?.status).toBe("delivered");
    expect(r.views.map((v) => ("role" in v ? v.role : ""))).toEqual([
      "facts",
      "controls",
      "receipt",
    ]);
    const receipt = r.views.find((v) => "role" in v && v.role === "receipt")!;
    await s.confirm({
      checks: [
        {
          surface_id: "A",
          view_id: receipt.view_id,
          text: "F1",
          choice: "Standard",
        },
      ],
    });
    expect(l.summary().verified).toBe(1);
  } finally {
    await l.close();
    await f.clean();
  }
});
test("a slow desktop does not hold a healthy desktop or change stable Z", async () => {
  const f = await fixture();
  const l = await ProgressLedger.open(f.dir, ["A", "B"], 1);
  let finish!: (f: Frame) => void;
  const effects: string[] = [];
  const port: SurfacePort = {
    capture: (id) =>
      id === "A"
        ? new Promise((r) => (finish = r))
        : Promise.resolve(f.frame(id)),
    execute: async (f) => {
      effects.push(f.surface_id);
      return { status: "delivered" };
    },
  };
  const s = new ManagedScreen(port, l, ["A", "B"], ["A", "B"], false);
  try {
    const observed = await s.observe(["A", "B"], false, 100);
    expect(observed.views).toHaveLength(1);
    const v = observed.views[0]!;
    expect(v.panels[0]?.z).toBe(2);
    const result = await s.act(
      {
        request_id: "one",
        targets: [
          {
            view_id: v.view_id,
            z: 2,
            expectation: { text: "F1", choice: "Standard" },
            actions: [{ kind: "type_text", text: "F1" }],
          },
        ],
      },
      500,
    );
    expect(effects).toEqual(["B"]);
    expect(result.views).toHaveLength(1);
    await s.confirm({
      checks: [
        {
          surface_id: "B",
          view_id: result.views[0]!.view_id,
          text: "F1",
          choice: "Standard",
        },
      ],
    });
    expect(l.summary()).toMatchObject({ verified: 1, remaining: 1 });
    finish(f.frame("A"));
    await s.drain();
  } finally {
    await l.close();
    await f.clean();
  }
});
test("scope and expected input guards prevent effects; unknown action is never retried", async () => {
  const f = await fixture();
  const l = await ProgressLedger.open(f.dir, ["A", "B"], 1);
  let effects = 0;
  const s = new ManagedScreen(
    {
      capture: async (id) => f.frame(id),
      execute: async () => {
        effects++;
        return { status: "unknown" };
      },
    },
    l,
    ["A", "B"],
    ["A"],
    false,
  );
  try {
    await expect(s.observe(["B"])).rejects.toThrow("target_outside_workset");
    const v = (await s.observe(["A"])).views[0]!;
    await expect(
      s.act({
        request_id: "bad",
        targets: [
          {
            view_id: v.view_id,
            z: 1,
            expectation: { text: "F1", choice: "Standard" },
            actions: [{ kind: "type_text", text: "E1" }],
          },
        ],
      }),
    ).rejects.toThrow("expectation_input_mismatch");
    const request = {
      request_id: "one",
      targets: [
        {
          view_id: v.view_id,
          z: 1,
          expectation: { text: "F1", choice: "Standard" },
          actions: [{ kind: "type_text", text: "F1" }],
        },
      ],
    };
    await s.act(request);
    await s.act(request, 0);
    expect(effects).toBe(1);
    expect(l.get("A").state).toBe("unknown");
    await expect(s.act({ ...request, request_id: "two" })).rejects.toThrow(
      "input_not_allowed",
    );
  } finally {
    await l.close();
    await f.clean();
  }
});
test("host continues all groups, bounds no-progress retries and counts every session", async () => {
  const f = await fixture();
  const ids = Array.from({ length: 100 }, (_, i) => "W" + i);
  const l = await ProgressLedger.open(f.dir, ids, 1);
  try {
    const visited: string[] = [];
    const r = await runWorksets(l, async (group) => {
      visited.push(...group);
      for (const id of group) {
        await l.dispatch(id, "op" + id, { text: id, choice: "s" });
        await l.deliver(id, "delivered");
        await l.observed(id, "v" + id);
        await l.verify(id, "v" + id, id, "s");
      }
      return { tokens: 100 };
    });
    expect(r.complete).toBe(true);
    expect(r.sessions).toHaveLength(13);
    expect(new Set(visited).size).toBe(100);
  } finally {
    await l.close();
    await f.clean();
  }
  const g = await fixture();
  const stuck = await ProgressLedger.open(g.dir, ["X"], 1);
  try {
    const r = await runWorksets(stuck, async () => ({ tokens: 5 }));
    expect(r.complete).toBe(false);
    expect(r.sessions).toHaveLength(3);
  } finally {
    await stuck.close();
    await g.clean();
  }
}, 15000);

test("parallel worksets are disjoint, bounded in concurrency and cover the fleet", async () => {
  const f = await fixture();
  const ids = Array.from({ length: 100 }, (_, i) => `W${i + 1}`);
  const l = await ProgressLedger.open(f.dir, ids, 1);
  try {
    const owner = new Map<string, number>();
    let live = 0,
      peak = 0;
    const r = await runWorksets(
      l,
      async (group, index) => {
        peak = Math.max(peak, ++live);
        for (const id of group) {
          expect(owner.has(id)).toBe(false);
          owner.set(id, index);
        }
        await new Promise((res) => setTimeout(res, 5));
        for (const id of group) {
          await l.dispatch(id, "op" + id, { text: id, choice: "s" });
          await l.deliver(id, "delivered");
          await l.observed(id, "v" + id);
          await l.verify(id, "v" + id, id, "s");
        }
        live--;
        return index;
      },
      { parallel: 13 },
    );
    expect(r.complete).toBe(true);
    expect(r.sessions).toHaveLength(13);
    expect(peak).toBe(13);
    expect(owner.size).toBe(100);
  } finally {
    await l.close();
    await f.clean();
  }
}, 15000);

test("a corrupt capture cannot substitute another surface, while good peers remain visible", async () => {
  const f = await fixture(),
    l = await ProgressLedger.open(f.dir, ["A", "B"], 1);
  const s = new ManagedScreen(
    {
      capture: async (id) => f.frame(id === "A" ? "B" : id),
      execute: async () => ({ status: "delivered" }),
    },
    l,
    ["A", "B"],
    ["A", "B"],
    false,
  );
  try {
    const r = await s.observe(["A", "B"]);
    expect(r.views.map((v) => v.panels[0]!.surface_id)).toEqual(["B"]);
    expect(r.errors).toEqual([
      { id: "capture:A", code: "target_operation_failed" },
    ]);
  } finally {
    await l.close();
    await f.clean();
  }
});

test("invalid PNG is isolated before composition and retries are bounded per target", async () => {
  const f = await fixture(),
    l = await ProgressLedger.open(f.dir, ["A", "B"], 1);
  let failures = 0;
  const s = new ManagedScreen(
    {
      capture: async (id) => {
        if (id === "A") {
          failures++;
          return { ...f.frame(id), png: Buffer.from("not a PNG") };
        }
        return f.frame(id);
      },
      execute: async () => ({ status: "delivered" }),
    },
    l,
    ["A", "B"],
    ["A", "B"],
    true,
  );
  try {
    const r = await s.observe(["A", "B"]);
    expect(r.views.flatMap((v) => v.panels.map((p) => p.surface_id))).toEqual([
      "B",
    ]);
    expect(r.errors).toHaveLength(1);
    for (let i = 0; i < 5; i++) await s.observe(["A"], false, 0);
    await s.drain();
    // Further completed retry attempts cannot exceed the per-workset read budget.
    for (let i = 0; i < 5; i++) await s.observe(["A"]);
    expect(failures).toBe(3);
    expect(s.status().targets.find((t) => t.surface_id === "A")).toMatchObject({
      state: "deferred",
      reason: "capture_retry_budget",
    });
    expect(s.status().workset.actionable).toBe(1);
    expect(l.get("A").state).toBe("ready");
    const recovered = new ManagedScreen(
      {
        capture: async (id) => f.frame(id),
        execute: async () => ({ status: "delivered" }),
      },
      l,
      ["A", "B"],
      ["A"],
      true,
    );
    expect(recovered.status().targets[0]?.state).toBe("ready");
    expect((await recovered.observe(["A"])).views).toHaveLength(1);
  } finally {
    await l.close();
    await f.clean();
  }
});
test("a rejected role layout is known not sent and does not block a healthy peer", async () => {
  const f = await fixture(),
    l = await ProgressLedger.open(f.dir, ["A", "B"], 1);
  const effects: string[] = [];
  const s = new ManagedScreen(
    {
      capture: async (id) => f.frame(id),
      execute: async (f) => {
        effects.push(f.surface_id);
        return { status: "delivered" };
      },
    },
    l,
    ["A", "B"],
    ["A", "B"],
    true,
  );
  try {
    const views = (await s.observe(["A", "B"])).views;
    const targets = views.map((v) => ({
      view_id: v.view_id,
      z: v.panels[0]!.z,
      basis: "current F1",
      expectation: { text: "F1", choice: "Standard" },
      actions: [{ kind: "type_text", text: "F1" }],
    }));
    const v = views.find((v) => v.panels[0]!.z === 1)!;
    const r = await s.act({
      request_id: "bad-layout",
      targets,
      layouts: [
        {
          view_id: v.view_id,
          z: 1,
          regions: {
            facts: { x: 0, y: 0, width: 200, height: 30 },
            controls: { x: 0, y: 30, width: 100, height: 40 },
            receipt: { x: 0, y: 70, width: 100, height: 30 },
          },
        },
      ],
    });
    expect(effects).toEqual(["B"]);
    expect(r.deliveries.find((d) => d.surface_id === "A")?.status).toBe(
      "blocked",
    );
    expect(l.get("A").state).toBe("ready");
    expect(l.get("B").state).toBe("awaiting_verification");
  } finally {
    await l.close();
    await f.clean();
  }
});

test("one permanently unreadable target is deferred while the other 99 finish", async () => {
  const f = await fixture(),
    ids = Array.from({ length: 100 }, (_, i) => `W${i + 1}`),
    l = await ProgressLedger.open(f.dir, ids, 1);
  const effects: string[] = [];
  try {
    const r = await runWorksets(l, async (group) => {
      const s = new ManagedScreen(
        {
          capture: async (id) => {
            if (id === "W1") throw Error("unreadable");
            return f.frame(id);
          },
          execute: async (frame) => {
            effects.push(frame.surface_id);
            return { status: "delivered" };
          },
        },
        l,
        ids,
        group,
        false,
      );
      const observed = await s.observe(group);
      const targets = observed.views.map((v) => ({
        view_id: v.view_id,
        z: v.panels[0]!.z,
        expectation: { text: v.panels[0]!.surface_id, choice: "Standard" },
        actions: [{ kind: "type_text", text: v.panels[0]!.surface_id }],
      }));
      if (targets.length) {
        const done = await s.act({ request_id: "current-workset", targets });
        await s.confirm({
          checks: done.views.map((v) => ({
            surface_id: v.panels[0]!.surface_id,
            view_id: v.view_id,
            text: v.panels[0]!.surface_id,
            choice: "Standard",
          })),
        });
      }
      if (group.includes("W1")) {
        await s.observe(["W1"]);
        await s.observe(["W1"]);
      }
      expect(s.status().workset.can_end).toBe(true);
      return { effects: targets.length };
    });
    expect(r.complete).toBe(false);
    expect(l.summary()).toMatchObject({ verified: 99, remaining: 1 });
    expect(new Set(effects).size).toBe(99);
    expect(effects).toHaveLength(99);
    expect(effects).not.toContain("W1");
    expect(l.get("W1").attempts).toBe(3);
  } finally {
    await l.close();
    await f.clean();
  }
}, 30000);

test("dismiss clears an interruption without progress; typing or unknown effects are refused or held", async () => {
  const f = await fixture(),
    l = await ProgressLedger.open(f.dir, ["A", "B"], 1);
  let outcome: "delivered" | "unknown" = "delivered";
  const s = new ManagedScreen(
    {
      capture: async (id) => f.frame(id),
      execute: async () => ({ status: outcome }),
    },
    l,
    ["A", "B"],
    ["A", "B"],
    false,
  );
  try {
    const v = (await s.observe(["A", "B"])).views;
    const view = (id: string) => v.find((x) => x.panels[0]!.surface_id === id)!;
    await expect(
      s.act({
        request_id: "typed",
        targets: [
          {
            view_id: view("A").view_id,
            z: 1,
            dismiss: true,
            actions: [{ kind: "type_text", text: "x" }],
          },
        ],
      }),
    ).rejects.toThrow("dismiss_must_not_type");
    const r = await s.act({
      request_id: "ok",
      targets: [
        {
          view_id: view("A").view_id,
          z: 1,
          dismiss: true,
          actions: [{ kind: "click", x: 5, y: 5 }],
        },
      ],
    });
    expect(r.deliveries[0]?.status).toBe("delivered");
    expect(l.get("A")).toMatchObject({ state: "ready", completed: 0 });
    outcome = "unknown";
    await s.act({
      request_id: "lost",
      targets: [
        {
          view_id: view("B").view_id,
          z: 2,
          dismiss: true,
          actions: [{ kind: "click", x: 5, y: 5 }],
        },
      ],
    });
    await s.drain();
    expect(l.get("B")).toMatchObject({
      state: "blocked",
      reason: "dismiss_unknown_effect",
    });
  } finally {
    await l.close();
    await f.clean();
  }
});
