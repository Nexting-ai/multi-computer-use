import { test, expect } from "vitest";
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ScriptScreen } from "../src/script.js";
import { ProgressLedger } from "../src/workset.js";
import type { Frame, SurfacePort, TextNode } from "../src/index.js";

// Minimal text-only app per surface: a code to type, a Save button, a receipt.
async function fixture(n: number) {
  const png = await sharp({
    create: { width: 200, height: 100, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const apps = Array.from({ length: n }, (_, i) => ({
    id: `S${i + 1}`,
    code: `C${i + 1}`,
    input: "",
    saved: [] as string[],
    rev: 0,
  }));
  const by = (id: string) => apps.find((a) => a.id === id)!;
  const frame = (id: string): Frame => ({
    surface_id: id,
    route_id: id,
    epoch: 1,
    revision: String(by(id).rev),
    width: 200,
    height: 100,
    png,
  });
  const nodes = (id: string): TextNode[] => [
    {
      role: "StaticText",
      text: by(id).code,
      rect: { x: 10, y: 10, width: 40, height: 10 },
    },
    {
      role: "textbox",
      text: by(id).input,
      rect: { x: 10, y: 30, width: 80, height: 16 },
    },
    {
      role: "StaticText",
      text: "Save",
      rect: { x: 100, y: 30, width: 30, height: 16 },
    },
    {
      role: "StaticText",
      text: `Saved ${by(id).saved.at(-1) ?? "-"}`,
      rect: { x: 10, y: 60, width: 80, height: 10 },
    },
  ];
  let executes = 0;
  const port: SurfacePort = {
    capture: async (id) => frame(id),
    readText: async (f) => nodes(f.surface_id),
    execute: async (f, actions) => {
      executes++;
      const a = by(f.surface_id);
      if (f.revision !== String(a.rev))
        return { status: "blocked", reason: "source_changed_before_input" };
      for (const x of actions) {
        if (x.kind === "type_text") a.input += x.text;
        if (x.kind === "click" && x.x >= 100 && x.x < 130) {
          a.saved.push(a.input);
          a.input = "";
        }
      }
      a.rev++;
      return { status: "delivered" };
    },
  };
  return { apps, port, executes: () => executes };
}

test("script baseline: one read/act/confirm loop over all surfaces, item contract", async () => {
  const f = await fixture(5);
  const dir = await mkdtemp(join(tmpdir(), "cu-script-"));
  const ids = f.apps.map((a) => a.id);
  const ledger = await ProgressLedger.open(dir, ids, 1);
  const s = new ScriptScreen(f.port, ledger, ids, { contract: "item" });
  try {
    const r = await s.read({ surfaces: ids });
    const targets = r.surfaces.map((x: any) => ({
      surface_id: x.surface_id,
      token: x.token,
      expectation: { text: x.nodes[0][0], choice: "-" },
      actions: [
        { kind: "type_text", text: x.nodes[0][0] },
        { kind: "click", x: 110, y: 35 },
      ],
    }));
    expect(
      (await s.act({ targets })).deliveries.every(
        (d) => d.status === "delivered",
      ),
    ).toBe(true);
    // A snapshot taken before the delivery cannot confirm it.
    const stale = await s.confirm({
      checks: [
        {
          surface_id: "S1",
          token: (r.surfaces[0] as any).token,
          text: "C1",
          choice: "-",
        },
      ],
    });
    expect(stale.results[0]!.result).toBe(
      "fresh_snapshot_after_delivery_required",
    );
    const after = await s.read({ surfaces: ids });
    const c = await s.confirm({
      checks: after.surfaces.map((x: any) => ({
        surface_id: x.surface_id,
        token: x.token,
        text: x.nodes[3][0].slice(6),
        choice: "-",
      })),
    });
    expect(c.fleet.verified).toBe(5);
    expect(
      f.apps.every((a) => a.saved.length === 1 && a.saved[0] === a.code),
    ).toBe(true);
    // Reusing a consumed snapshot is refused by the frame check, never replayed blindly.
    await expect(s.act({ targets: [targets[0]!] })).rejects.toThrow(
      "input_not_allowed",
    );
  } finally {
    await ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("script baseline: free contract acts are not progress; done declares; stale tokens are blocked", async () => {
  const f = await fixture(2);
  const dir = await mkdtemp(join(tmpdir(), "cu-script-free-"));
  const ids = f.apps.map((a) => a.id);
  const ledger = await ProgressLedger.open(dir, ids, 1);
  const s = new ScriptScreen(f.port, ledger, ids, { contract: "free" });
  try {
    const r = await s.read({ surfaces: ids });
    const tok = (i: number) => (r.surfaces[i] as any).token;
    await s.act({
      targets: [
        {
          surface_id: "S1",
          token: tok(0),
          actions: [{ kind: "click", x: 110, y: 35 }],
        },
      ],
    });
    expect(ledger.get("S1").state).toBe("ready");
    // Same (now stale) snapshot again: the port refuses input before any effect.
    const again = await s.act({
      targets: [
        {
          surface_id: "S1",
          token: tok(0),
          actions: [{ kind: "click", x: 110, y: 35 }],
        },
      ],
    });
    expect(again.deliveries[0]!.status).toBe("blocked");
    expect(f.apps[0]!.saved.length).toBe(1);
    await s.done({ surfaces: ["S1"] });
    expect(ledger.get("S1")).toMatchObject({
      state: "verified",
      reason: "declared_by_model",
    });
  } finally {
    await ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});
