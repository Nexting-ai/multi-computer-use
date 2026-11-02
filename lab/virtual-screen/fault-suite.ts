/**
 * E5 (preregistered): deterministic fault injection, no model. Real headless
 * Chrome surfaces with the sequence fixture; operator-scripted policies built
 * from the fixture's known geometry (test only). Faults are injected by the
 * operator around the port. Outcomes come from input journals and business
 * records, not from the runtime's own view.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openBrowserLab } from "./browser.js";
import { sequenceScene } from "./sequence.js";
import { ProgressLedger } from "../../packages/virtual-screen/src/workset.js";
import { StackScreen } from "../../packages/virtual-screen/src/stack.js";
import type { SurfacePort } from "../../packages/virtual-screen/src/index.js";

const OUT = process.argv[2] ?? ".local/fault-suite";
const N = 12,
  SEED = 4401;
await mkdir(OUT, { recursive: true });

function policy(view_id: string, over: Record<string, any> = {}, exemplar = 1) {
  const s = sequenceScene(SEED, exemplar),
    X = s.x,
    Y = s.y;
  return {
    request_id: "p" + Math.random(),
    view_id,
    template: { x: X, y: Y, width: 540, height: 440 },
    fields: [
      { name: "code", rect: { x: X + 110, y: Y + 62, width: 300, height: 24 } },
      {
        name: "priority",
        rect: { x: X + 80, y: Y + 90, width: 200, height: 24 },
      },
      {
        name: "receipt",
        rect: { x: X + 10, y: Y + 350, width: 520, height: 30 },
      },
    ],
    ignore: [
      { x: X + 15, y: Y + 10, width: 400, height: 40 },
      { x: X + 15, y: Y + 155, width: 375, height: 52 },
      { x: X + 15, y: Y + 225, width: 260, height: 50 },
    ],
    steps: [
      { kind: "click", x: X + 100, y: Y + 180 },
      { kind: "type_field", field: "code" },
      {
        kind: "choose",
        field: "priority",
        cases: [
          { equals: "HIGH", x: X + 180, y: Y + 250, label: "Urgent" },
          { equals: "NORMAL", x: X + 60, y: Y + 250, label: "Standard" },
        ],
      },
      { kind: "click", x: X + 70, y: Y + 315 },
    ],
    verify: { field: "receipt", contains: ["{code}", "{choice}"] },
    ...over,
  };
}
type Wrap = (port: SurfacePort, lab: any) => SurfacePort;
async function scenario(
  name: string,
  opts: {
    mix?: string;
    wrap?: Wrap;
    before?: (lab: any) => Promise<void>;
    run: (stack: StackScreen, view: string) => Promise<unknown>;
    exemplar?: number;
    resolve?: boolean;
  },
) {
  const dir = join(OUT, name);
  const lab = await openBrowserLab(join(dir, "env"), N, SEED, {
    sequence: true,
    ...(opts.mix ? { mix: opts.mix } : {}),
  });
  let out: any;
  try {
    await opts.before?.(lab);
    const ledger = await ProgressLedger.open(
      join(dir, "ledger"),
      lab.surfaces,
      3,
    );
    const port = opts.wrap ? opts.wrap(lab.port, lab) : lab.port;
    const stack = new StackScreen(port, ledger, lab.surfaces, {
      concurrency: 12,
      settle_ms: 2500,
      ...(opts.resolve === false ? { resolve: false } : {}),
    });
    const ex = `W${String(opts.exemplar ?? 1).padStart(2, "0")}`;
    const view = (await stack.observe([ex])).views[0]!.view_id;
    const runtime = await opts.run(stack, view);
    out = { runtime, ledger: ledger.summary() };
    await ledger.close();
  } finally {
    await lab.close();
  }
  const journal = (await readFile(join(dir, "env/input-journal.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const scenes = Array.from({ length: N }, (_, i) =>
    sequenceScene(SEED, i + 1),
  );
  const grades = lab.grade() as any[];
  const owner = new Map(
    scenes.flatMap((s) => s.cases.map((c) => [c.code, s.id] as const)),
  );
  const business = JSON.parse(
    await readFile(join(dir, "env/business.json"), "utf8"),
  ) as any[];
  const row = {
    scenario: name,
    surfaces_with_input: new Set(
      journal.filter((j) => j.kind === "intent").map((j) => j.surface_id),
    ).size,
    input_operations: journal.filter((j) => j.kind === "intent").length,
    saves: business.length,
    wrong_saves: business.filter((b, _i) => {
      const s = scenes.find((x) => x.id === b.id)!;
      const k = business.filter((x) => x.id === b.id).indexOf(b);
      const c = s.cases[k];
      return (
        !c ||
        b.text !== c.code ||
        b.choice !== (c.urgent ? "Urgent" : "Standard")
      );
    }).length,
    misrouted: business.filter(
      (b) => owner.has(b.text) && owner.get(b.text) !== b.id,
    ).length,
    duplicates: grades.filter((g) => g.commits > 3).length,
    surfaces_correct: grades.filter((g) => g.success).length,
    ledger_verified: out.ledger.verified,
    ledger_attention: out.ledger.attention,
  };
  console.log(JSON.stringify(row));
  return row;
}
const cdp = (lab: any, id: string) => lab.port.routes.get(id).client;
const evaluate = (lab: any, id: string, expression: string) =>
  cdp(lab, id).call("Runtime.evaluate", { expression });
const lostReplies =
  (fraction: number): Wrap =>
  (port) => {
    let n = 0;
    return {
      ...port,
      readText: port.readText!.bind(port),
      probeText: port.probeText?.bind(port),
      capture: port.capture.bind(port),
      execute: async (f, a, op) => {
        const d = await port.execute(f, a, op);
        // Deterministically lose the reply of every k-th delivered execute.
        return d.status === "delivered" && ++n % Math.round(1 / fraction) === 0
          ? { status: "unknown", reason: "injected_lost_reply" }
          : d;
      },
    } as SurfacePort;
  };
const rows = [];
const wrongSave = (v: string) => ({
  steps: [
    {
      kind: "click",
      x: sequenceScene(SEED, 1).x + 300,
      y: sequenceScene(SEED, 1).y + 420,
    },
  ],
});
// 1. A policy that clicks the wrong control instead of Save (Standard: no
//    business effect, but inputs typed).
for (const canary of [true, false])
  rows.push(
    await scenario(`wrong-click-canary-${canary ? "on" : "off"}`, {
      run: (st, v) => {
        const p = policy(v, { canary });
        p.steps[3] = {
          kind: "click",
          x: p.template.x + 60,
          y: p.template.y + 250,
        } as any;
        return st.run(p);
      },
    }),
  );
// 1b. A Save click that lands on blank page: semantic binding refuses the
//     policy before any input (until v3 the canary bounded it to one surface).
rows.push(
  await scenario("wrong-click-blank-binding", {
    run: async (st, v) => {
      const p = policy(v);
      p.steps[3] = {
        kind: "click",
        x: p.template.x + 500,
        y: p.template.y + 420,
      } as any;
      return st.run(p).catch((e) => ({ refused: String(e) }));
    },
  }),
);
// 2. A policy that types the wrong field (wrong business value would be saved).
for (const canary of [true, false])
  rows.push(
    await scenario(`wrong-value-canary-${canary ? "on" : "off"}`, {
      run: (st, v) => {
        const p = policy(v, { canary });
        p.steps[1] = { kind: "type_field", field: "priority" } as any;
        return st.run(p);
      },
    }),
  );
// 3. Lost replies on a third of executes (the effect happened).
for (const resolve of [true, false])
  rows.push(
    await scenario(`lost-replies-resolve-${resolve ? "on" : "off"}`, {
      wrap: lostReplies(1 / 3),
      resolve,
      run: (st, v) => st.run(policy(v)),
    }),
  );
// 4. The page changes between observation and input on every first attempt.
rows.push(
  await scenario("frame-changes-before-input", {
    wrap: (port, lab) => {
      const seen = new Set<string>();
      return {
        ...port,
        readText: port.readText!.bind(port),
        probeText: port.probeText?.bind(port),
        capture: port.capture.bind(port),
        execute: async (f, a, op) => {
          if (!seen.has(f.surface_id)) {
            seen.add(f.surface_id);
            await evaluate(
              lab,
              f.surface_id,
              "document.querySelector('aside').append(' *')",
            );
          }
          return port.execute(f, a, op);
        },
      } as SurfacePort;
    },
    run: (st, v) => st.run(policy(v)),
  }),
);
// 5. Unmatched values on three surfaces (no otherwise branch).
rows.push(
  await scenario("unmatched-values", {
    before: async (lab) => {
      for (const id of ["W04", "W07", "W10"])
        await evaluate(
          lab,
          id,
          "document.getElementById('priority').textContent='CRITICAL'",
        );
    },
    run: (st, v) => st.run(policy(v)),
  }),
);
// 6. Two identical policies launched concurrently on all surfaces.
rows.push(
  await scenario("overlapping-concurrent-policies", {
    run: (st, v) => Promise.all([st.run(policy(v)), st.run(policy(v))]),
  }),
);
// 7. Mixed layouts: a layout-A policy must not touch other layouts or notices.
// The exemplar is the first layout-A surface of this seed.
const firstA =
  Array.from({ length: N }, (_, i) =>
    sequenceScene(SEED, i + 1, "mixed"),
  ).findIndex((x) => x.kind === "a") + 1;
rows.push(
  await scenario("mixed-layouts-a-policy", {
    mix: "mixed",
    exemplar: firstA,
    run: (st, v) => st.run(policy(v, {}, firstA)),
  }),
);
await writeFile(join(OUT, "fault-suite.json"), JSON.stringify(rows, null, 2));

// 8. Sparse page, controls move with the seed (the held-out failure mode):
//    a policy scripted from W01 of MiniWoB enter-text, local check on vs off.
{
  const { openBrowserLab: open } = await import("./browser.js");
  // on: point check + binding; binding-only: point check off; off: neither.
  for (const arm of ["on", "binding-only", "off"] as const) {
    const check = arm === "on";
    const dir = join(OUT, `sparse-moved-controls-check-${arm}`);
    const lab = await open(join(dir, "env"), N, SEED, {
      miniwob: "enter-text",
    });
    let runtime: any;
    try {
      const ledger = await ProgressLedger.open(
        join(dir, "ledger"),
        lab.surfaces,
        1,
      );
      const stack = new StackScreen(lab.port, ledger, lab.surfaces, {
        concurrency: 12,
        settle_ms: 2500,
        ...(check ? {} : { pointCheck: false }),
        ...(arm === "off" ? { binding: false } : {}),
      });
      const view = (await stack.observe(["W01"])).views[0]!.view_id;
      const f = await lab.port.capture("W01");
      const nodes = await lab.port.readText!(f);
      const box = nodes.find((n) => n.role === "textbox")!.rect,
        submit = nodes.find(
          (n) => n.role === "StaticText" && n.text === "Submit",
        )!.rect,
        word = nodes.find(
          (n) =>
            n.role === "StaticText" &&
            n.rect.y < 40 &&
            !n.text.startsWith("Enter") &&
            !n.text.startsWith('"'),
        )!.rect;
      runtime = await stack.run({
        request_id: "sparse",
        view_id: view,
        template: { x: 0, y: 0, width: 420, height: 540 },
        fields: [
          {
            name: "value",
            rect: {
              x: word.x - 2,
              y: word.y,
              width: word.width + 4,
              height: word.height,
            },
          },
          { name: "cover", rect: { x: 75, y: 180, width: 250, height: 110 } },
        ],
        // Mirrors the model's E2 policy: the region where controls move is ignored.
        ignore: [
          { x: 0, y: 0, width: 420, height: 125 },
          { x: 20, y: 130, width: 360, height: 225 },
        ],
        steps: [
          {
            kind: "click",
            x: Math.round(box.x + box.width / 2),
            y: Math.round(box.y + box.height / 2),
          },
          { kind: "type_field", field: "value" },
          { kind: "click_text", text: "Submit" },
        ],
        verify: { field: "cover", contains: ["START"] },
      });
      await ledger.close();
    } finally {
      await lab.close();
    }
    const records = JSON.parse(
      await readFile(join(dir, "env/business.json"), "utf8"),
    ) as any[];
    const row = {
      scenario: `sparse-moved-controls-check-${arm}`,
      submissions: records.length,
      correct_submissions: records.filter((r) => r.raw > 0).length,
      wrong_submissions: records.filter((r) => r.raw <= 0).length,
      surfaces_untouched: N - records.length,
      runtime_counts: runtime?.counts,
    };
    console.log(JSON.stringify(row));
    rows.push(row as any);
  }
  await writeFile(join(OUT, "fault-suite.json"), JSON.stringify(rows, null, 2));
}

// 9. Same-looking inputs whose labels are reordered per instance (F1 failure):
//    a policy scripted from W01 of MiniWoB multi-orderings, strict vs lenient
//    registration. Misapplied = submissions on surfaces whose label order differs.
{
  const { openBrowserLab: open } = await import("./browser.js");
  for (const registration of ["strict", "lenient"] as const) {
    const dir = join(OUT, `reordered-labels-${registration}`);
    const lab = await open(join(dir, "env"), N, SEED, {
      miniwob: "multi-orderings",
    });
    const order = new Map<string, string>();
    let runtime: any;
    try {
      for (const id of lab.surfaces) {
        const nodes = await lab.port.readText!(await lab.port.capture(id));
        order.set(
          id,
          nodes
            .filter((n) => ["Year", "Director", "Genre"].includes(n.text))
            .sort((a, b) => a.rect.y - b.rect.y)
            .map((n) => n.text)
            .join(","),
        );
      }
      const ledger = await ProgressLedger.open(
        join(dir, "ledger"),
        lab.surfaces,
        1,
      );
      const stack = new StackScreen(lab.port, ledger, lab.surfaces, {
        concurrency: 12,
        settle_ms: 2500,
        registration,
      });
      const view = (await stack.observe(["W01"])).views[0]!.view_id;
      const nodes = await lab.port.readText!(await lab.port.capture("W01"));
      const label = nodes.find((n) => n.text === "Genre")!.rect;
      const input = nodes
        .filter((n) => n.role === "textbox")
        .find(
          (n) =>
            Math.abs(
              n.rect.y + n.rect.height / 2 - (label.y + label.height / 2),
            ) < 20,
        )!.rect;
      const submit = nodes.find((n) => n.text === "Submit")!.rect;
      runtime = await stack.run({
        request_id: "reordered",
        view_id: view,
        // As in the model's F1 policy: the template includes blank page to the right.
        template: { x: 0, y: 0, width: 813, height: 525 },
        fields: [
          { name: "genre", rect: { x: 128, y: 6, width: 100, height: 30 } },
          { name: "cover", rect: { x: 75, y: 180, width: 250, height: 110 } },
        ],
        ignore: [{ x: 0, y: 0, width: 420, height: 100 }],
        steps: [
          {
            kind: "click",
            x: Math.round(input.x + input.width / 2),
            y: Math.round(input.y + input.height / 2),
          },
          { kind: "type_field", field: "genre" },
          {
            kind: "click",
            x: Math.round(submit.x + submit.width / 2),
            y: Math.round(submit.y + submit.height / 2),
          },
        ],
        verify: { field: "cover", contains: ["START"] },
      });
      await ledger.close();
    } finally {
      await lab.close();
    }
    const records = JSON.parse(
      await readFile(join(dir, "env/business.json"), "utf8"),
    ) as any[];
    const ref = order.get("W01");
    const row = {
      scenario: `reordered-labels-${registration}`,
      surfaces_same_order: [...order.values()].filter((o) => o === ref).length,
      submissions: records.length,
      misapplied_submissions: records.filter((r) => order.get(r.id) !== ref)
        .length,
      runtime_counts: runtime?.counts,
    };
    console.log(JSON.stringify(row));
    rows.push(row as any);
  }
  await writeFile(join(OUT, "fault-suite.json"), JSON.stringify(rows, null, 2));
}

// 10. Overlapping buttons (F1 click-test-2): click_text "ONE" on surfaces whose
//     instruction is "Click button ONE.", occlusion handling on vs off.
{
  const { openBrowserLab: open } = await import("./browser.js");
  for (const occlusion of [true, false]) {
    const dir = join(OUT, `occluded-target-${occlusion ? "on" : "off"}`);
    const lab = await open(join(dir, "env"), 24, SEED, {
      miniwob: "click-test-2",
    });
    let runtime: any;
    const ones: string[] = [];
    try {
      for (const id of lab.surfaces) {
        const nodes = await lab.port.readText!(await lab.port.capture(id));
        if (nodes.some((n) => n.text === "Click button ONE.")) ones.push(id);
      }
      const ledger = await ProgressLedger.open(
        join(dir, "ledger"),
        lab.surfaces,
        1,
      );
      const stack = new StackScreen(lab.port, ledger, lab.surfaces, {
        concurrency: 12,
        settle_ms: 2500,
        ...(occlusion ? {} : { occlusion: false }),
      });
      const view = (await stack.observe([ones[0]!])).views[0]!.view_id;
      runtime = await stack.run({
        request_id: "occl",
        view_id: view,
        // The instruction is part of the template: only "ONE" surfaces match.
        template: { x: 0, y: 0, width: 400, height: 525 },
        fields: [
          { name: "cover", rect: { x: 100, y: 230, width: 200, height: 60 } },
        ],
        ignore: [{ x: 0, y: 140, width: 400, height: 385 }],
        steps: [{ kind: "click_text", text: "ONE" }],
        verify: { field: "cover", contains: ["START"] },
        surfaces: ones,
      });
      await ledger.close();
    } finally {
      await lab.close();
    }
    const records = JSON.parse(
      await readFile(join(dir, "env/business.json"), "utf8"),
    ) as any[];
    const row = {
      scenario: `occluded-target-${occlusion ? "on" : "off"}`,
      surfaces_eligible: ones.length,
      submissions: records.length,
      correct_submissions: records.filter((r) => r.raw > 0).length,
      wrong_submissions: records.filter((r) => r.raw <= 0).length,
      runtime_counts: runtime?.counts,
    };
    console.log(JSON.stringify(row));
    rows.push(row as any);
  }
  await writeFile(join(OUT, "fault-suite.json"), JSON.stringify(rows, null, 2));
}

// 11–12. Replays of the model's own F2 policies on the same seeds, semantic
//     binding on vs off. 11: focus-text-2, "click blank page, then Tab N
//     times" under a submission-only post-condition. 12: login-user-popup, a
//     value field that cuts the instruction's text run.
{
  const { openBrowserLab: open } = await import("./browser.js");
  const replay = async (
    scenario: string,
    task: string,
    seed: number,
    count: number,
    policies: (view: string) => any[],
  ) => {
    for (const binding of [true, false]) {
      const dir = join(OUT, `${scenario}-${binding ? "on" : "off"}`);
      const lab = await open(join(dir, "env"), count, seed, { miniwob: task });
      const counts: Record<string, number> = {};
      const refused: string[] = [];
      try {
        const ledger = await ProgressLedger.open(
          join(dir, "ledger"),
          lab.surfaces,
          1,
        );
        const stack = new StackScreen(lab.port, ledger, lab.surfaces, {
          concurrency: 12,
          settle_ms: 2500,
          ...(binding ? {} : { binding: false }),
        });
        const view = (await stack.observe(["W01"])).views[0]!.view_id;
        for (const p of policies(view))
          try {
            const r = await stack.run(p);
            for (const [k, v] of Object.entries(r.counts))
              counts[k] = (counts[k] ?? 0) + (v as number);
          } catch (e) {
            refused.push(String(e).slice(0, 120));
          }
        await ledger.close();
      } finally {
        await lab.close();
      }
      const records = JSON.parse(
        await readFile(join(dir, "env/business.json"), "utf8"),
      ) as any[];
      const row = {
        scenario: `${scenario}-${binding ? "on" : "off"}`,
        surfaces_eligible: count,
        submissions: records.length,
        correct_submissions: records.filter((r) => r.raw > 0).length,
        wrong_submissions: records.filter((r) => r.raw <= 0).length,
        refused_policies: refused,
        runtime_counts: counts,
      };
      console.log(JSON.stringify(row));
      rows.push(row as any);
    }
  };
  // F2 focus-text-2 block 0 (seed 1288491019): policies third-tab-2, tab-1st, tab-2nd.
  const tab = (view: string, ordinal: string, n: number) => ({
    request_id: `tab-${ordinal}`,
    view_id: view,
    template: { x: 0, y: 0, width: 813, height: 525 },
    fields: [
      { name: "instruction", rect: { x: 0, y: 0, width: 400, height: 90 } },
      { name: "receipt", rect: { x: 110, y: 230, width: 180, height: 65 } },
    ],
    ignore: [{ x: 0, y: 125, width: 400, height: 400 }],
    steps: [
      {
        kind: "choose",
        field: "instruction",
        cases: [
          {
            // The servers' Chrome exposed the sentence twice; the local one once.
            equals: `Focus into the ${ordinal} input textbox.`,
            x: 380,
            y: 105,
            label: ordinal,
          },
        ],
      },
      ...Array.from({ length: n }, () => ({
        kind: "key_chord",
        keys: ["Tab"],
      })),
    ],
    verify: { field: "receipt", contains: ["START"] },
  });
  await replay("blind-focus", "focus-text-2", 1288491019, 24, (v) => [
    tab(v, "3rd", 3),
    tab(v, "1st", 1),
    tab(v, "2nd", 2),
  ]);
  // F2 login-user-popup block 0 (seed 936861458): policy login-main, verbatim.
  await replay("cut-field", "login-user-popup", 936861458, 12, (v) => [
    {
      request_id: "login-main",
      view_id: v,
      template: { x: 0, y: 0, width: 400, height: 525 },
      fields: [
        { name: "username", rect: { x: 289, y: 7, width: 88, height: 29 } },
        { name: "password", rect: { x: 265, y: 37, width: 33, height: 28 } },
        { name: "receipt", rect: { x: 0, y: 500, width: 400, height: 25 } },
      ],
      ignore: [
        { x: 0, y: 0, width: 400, height: 125 },
        { x: 20, y: 200, width: 315, height: 47 },
        { x: 20, y: 333, width: 265, height: 47 },
      ],
      steps: [
        { kind: "click", x: 140, y: 224 },
        { kind: "type_field", field: "username" },
        { kind: "click", x: 137, y: 356 },
        { kind: "type_field", field: "password" },
        { kind: "click", x: 96, y: 462 },
      ],
      verify: { field: "receipt", contains: ["{username}", "{password}"] },
    },
  ]);
  await writeFile(join(OUT, "fault-suite.json"), JSON.stringify(rows, null, 2));
}
