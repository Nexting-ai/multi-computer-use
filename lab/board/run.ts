/**
 * Shared-board runs: recreate a reference diagram in the real Excalidraw
 * editor, one shared board, every cursor its own browser session.
 *
 *   one      1 agent, 1 cursor, up to K actions per decision
 *   one-wide 1 agent, 1 cursor, up to N*K actions per decision (ablation)
 *   multi    1 agent, N cursors, up to K actions per cursor per decision
 *   swarm    N agents, 1 cursor each, each owning a share of the boxes
 *
 *   node --import tsx lab/board/run.ts <out> <arm> <seed> [cursors=12]
 *   BOARD_DRY=1: a scripted plan (no model) through the same tools.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { Cdp } from "../../packages/virtual-screen/src/cdp.js";
import { runAstra, type Tool, type ToolResult } from "../benchmark/astra.js";
import { startBoard } from "./server.js";
import { LAYOUT, LAYOUT48, diagram, grade, skeleton } from "./diagram.js";
import { boardText, diagramText } from "./state.js";

const [outArg, arm = "multi", seedArg = "1", cursorsArg = "12"] =
  process.argv.slice(2);
const ARMS = [
  "one",
  "one-wide",
  "multi",
  "swarm",
  "skills",
  "skills-multi",
  "skills-shift",
  "skills-handoff",
];
if (!outArg || !ARMS.includes(arm))
  throw Error(`usage: run.ts <out> <${ARMS.join("|")}> <seed> [cursors]`);
const out = resolve(outArg);
const seed = Number(seedArg);
const N = ["one", "one-wide", "skills"].includes(arm) ? 1 : Number(cursorsArg);
/** Skills arms: the agent may define parameterised action sequences. */
const SKILLS = arm.startsWith("skills");
const K = 8;
const PER_DECISION = arm === "one-wide" ? K * Number(cursorsArg) : K;
const VIEW = { width: 1280, height: 800 };
const LIMITS = {
  deadline_ms: Number(process.env.BOARD_DEADLINE_MS ?? 20 * 60_000),
  tokens: Number(process.env.BOARD_MAX_TOKENS ?? 30_000_000),
  calls: Number(process.env.BOARD_MAX_CALLS ?? 400),
  /** Pause after each action; a slower application responds later. */
  pace_ms: Number(process.env.BOARD_PACE_MS ?? 120),
};
const TITLES: Record<string, string> = {
  one: "1 个 Agent · 1 个光标",
  "one-wide": `1 个 Agent · 1 个光标（每步 ${PER_DECISION} 个动作）`,
  multi: `1 个 Agent · ${N} 个光标`,
  swarm: `${N} 个 Agent · 各 1 个光标`,
  skills: "1 个 Agent · 1 个光标 · 技能",
  "skills-multi": `1 个 Agent · ${N} 个光标 · 技能`,
  "skills-shift": `1 个 Agent · ${N} 个光标 · 技能 · 换挡收尾`,
  "skills-handoff": `1 个 Agent · ${N} 个光标 · 技能 · 文字状态收尾`,
};
await mkdir(out, { recursive: true });
/** BOARD_BOXES=48: the 8 x 6 diagram and layout. */
const BIG = process.env.BOARD_BOXES === "48";
const L = BIG ? LAYOUT48 : LAYOUT;
const D = BIG ? diagram(seed, 8, 6) : diagram(seed);
const FIT = "250,110,1270,720"; // the area the reference occupies

// ---- browser -------------------------------------------------------------
async function chrome(dir: string) {
  const proc = spawn(
    process.env.CU_CHROME ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless=new",
      `--user-data-dir=${dir}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let lines: string[] = [];
  for (let k = 0; k < 100 && !lines[1]; k++) {
    lines = await readFile(join(dir, "DevToolsActivePort"), "utf8")
      .then((t) => t.trim().split("\n"))
      .catch(() => []);
    if (!lines[1]) await new Promise((r) => setTimeout(r, 100));
  }
  const browser = await Cdp.connect(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
  return {
    async open(url: string) {
      const { browserContextId } = await browser.call(
        "Target.createBrowserContext",
      );
      const { targetId } = await browser.call("Target.createTarget", {
        url,
        browserContextId,
      });
      const p = await Cdp.connect(
        `ws://127.0.0.1:${lines[0]}/devtools/page/${targetId}`,
      );
      await p.call("Page.enable");
      await p.call("Emulation.setFocusEmulationEnabled", { enabled: true });
      await p.call("Page.setWebLifecycleState", { state: "active" });
      await p.call("Emulation.setDeviceMetricsOverride", {
        ...VIEW,
        deviceScaleFactor: 1,
        mobile: false,
      });
      return p;
    },
    async close() {
      browser.close();
      await new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null)
          return resolve();
        proc.once("exit", () => resolve());
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 3000).unref();
      });
    },
  };
}
const shot = async (p: Cdp) =>
  (await p.call("Page.captureScreenshot", { format: "png" })).data as string;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- the reference picture (rendered by the real editor) -----------------
const ref = await startBoard({
  log: join(out, "reference-log.jsonl"),
  cursors: 1,
  title: "reference",
  seed: skeleton(D, L),
});
const refChrome = await chrome(join(out, "chrome-reference"));
const refPage = await refChrome.open(`${ref.url}/board/1?seed=/seed.json`);
for (let k = 0; k < 100 && ref.elements.size < D.boxes.length; k++)
  await wait(200);
await wait(1500);
const reference = await shot(refPage);
await writeFile(join(out, "reference.png"), Buffer.from(reference, "base64"));
const selfCheck = grade(D, [...ref.elements.values()]);
if (!selfCheck.complete)
  throw Error(`reference_not_gradable:${JSON.stringify(selfCheck)}`);
refPage.close();
await refChrome.close();
await ref.close();

// ---- the shared board ----------------------------------------------------
const board = await startBoard({
  log: join(out, "log.jsonl"),
  cursors: N,
  title: TITLES[arm]!,
});
const browser = await chrome(join(out, "chrome"));
const pages = new Map<number, Cdp>();
for (let n = 1; n <= N; n++)
  pages.set(n, await browser.open(`${board.url}/board/${n}`));
await wait(4000);
// Each session starts focused on its board, as a user's window would be
// (keyboard shortcuts go nowhere until the page has been clicked once).
for (const p of pages.values())
  for (const type of ["mousePressed", "mouseReleased"])
    await p.call("Input.dispatchMouseEvent", {
      type,
      x: 1100,
      y: 700,
      button: "left",
      clickCount: 1,
    });

const action = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("click"), x: z.number(), y: z.number() }),
  z.strictObject({
    kind: z.literal("double_click"),
    x: z.number(),
    y: z.number(),
  }),
  z.strictObject({
    kind: z.literal("drag"),
    x: z.number(),
    y: z.number(),
    to_x: z.number(),
    to_y: z.number(),
  }),
  z.strictObject({ kind: z.literal("type"), text: z.string().min(1).max(200) }),
  z.strictObject({
    kind: z.literal("key"),
    key: z.enum([
      "Escape",
      "Enter",
      "Delete",
      "Backspace",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "0",
    ]),
  }),
]);
type Action = z.infer<typeof action>;
// Skills: a named, parameterised sequence of the same UI actions. Numbers
// may be arithmetic on parameters ("{x}+130"); text may hold "{label}".
const num = z.union([z.number(), z.string().max(80)]);
const templateAction = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("click"), x: num, y: num }),
  z.strictObject({ kind: z.literal("double_click"), x: num, y: num }),
  z.strictObject({
    kind: z.literal("drag"),
    x: num,
    y: num,
    to_x: num,
    to_y: num,
  }),
  z.strictObject({ kind: z.literal("type"), text: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal("key"), key: z.string().max(12) }),
]);
const skillSchema = z.strictObject({
  name: z.string().regex(/^[a-z_][a-z0-9_]{0,31}$/),
  params: z.array(z.string().regex(/^[a-z_][a-z0-9_]{0,15}$/)).max(12),
  actions: z.array(templateAction).min(1).max(20),
});
const skillCall = z.strictObject({
  kind: z.literal("skill"),
  name: z.string(),
  args: z.record(z.string(), z.union([z.number(), z.string().max(200)])),
});
const skills = new Map<string, z.infer<typeof skillSchema>>();
function expand(a: Action | z.infer<typeof skillCall>): Action[] {
  if (a.kind !== "skill") return [a];
  const sk = skills.get(a.name);
  if (!sk) throw Error(`unknown_skill:${a.name}`);
  const missing = sk.params.filter((p) => !(p in a.args));
  if (missing.length)
    throw Error(`skill_args_missing:${a.name}:${missing.join(",")}`);
  const sub = (t: string) =>
    t.replace(/\{([a-z_][a-z0-9_]*)\}/g, (_, k) => String(a.args[k] ?? ""));
  const n = (v: number | string) => {
    if (typeof v === "number") return v;
    const e = sub(v);
    if (!/^[-+*/().\d\s]+$/.test(e)) throw Error(`bad_expression:${v}`);
    const r = Function(`return (${e})`)() as number;
    if (!Number.isFinite(r)) throw Error(`bad_expression:${v}`);
    return r;
  };
  return sk.actions.map((t) => {
    const out =
      t.kind === "type"
        ? { kind: "type", text: sub(t.text) }
        : t.kind === "key"
          ? { kind: "key", key: sub(t.key) }
          : t.kind === "drag"
            ? {
                kind: "drag",
                x: n(t.x),
                y: n(t.y),
                to_x: n(t.to_x),
                to_y: n(t.to_y),
              }
            : { kind: t.kind, x: n(t.x), y: n(t.y) };
    return action.parse(out);
  });
}
const anyAction = SKILLS ? z.union([action, skillCall]) : action;
const actSchema = z.strictObject({
  cursors: z
    .array(
      z.strictObject({
        cursor: z.number().int().min(1).max(N),
        actions: z.array(anyAction).min(1).max(PER_DECISION),
      }),
    )
    .min(1)
    .max(N),
});
const lookSchema = z.strictObject({
  cursor: z.number().int().min(1).max(N).optional(),
});

async function perform(n: number, a: Action) {
  const p = pages.get(n)!;
  const mouse = (type: string, x: number, y: number, extra: object = {}) =>
    p.call("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: type === "mouseMoved" ? "none" : "left",
      clickCount: 1,
      ...extra,
    });
  if (a.kind === "click" || a.kind === "double_click") {
    await mouse("mouseMoved", a.x, a.y);
    await mouse("mousePressed", a.x, a.y, { buttons: 1 });
    await mouse("mouseReleased", a.x, a.y);
    if (a.kind === "double_click") {
      await mouse("mousePressed", a.x, a.y, { buttons: 1, clickCount: 2 });
      await mouse("mouseReleased", a.x, a.y, { clickCount: 2 });
      // The editor opens its text field on the next frames.
      await wait(250);
    }
  } else if (a.kind === "drag") {
    await mouse("mouseMoved", a.x, a.y);
    await mouse("mousePressed", a.x, a.y, { buttons: 1 });
    const steps = 12;
    for (let k = 1; k <= steps; k++) {
      await mouse(
        "mouseMoved",
        a.x + ((a.to_x - a.x) * k) / steps,
        a.y + ((a.to_y - a.y) * k) / steps,
        { buttons: 1, button: "left" },
      );
      await wait(15);
    }
    await mouse("mouseReleased", a.to_x, a.to_y);
  } else if (a.kind === "type")
    await p.call("Input.insertText", { text: a.text });
  else {
    const code = a.key.length === 1 ? `Digit${a.key}` : a.key;
    const vk =
      a.key.length === 1
        ? a.key.charCodeAt(0)
        : (
            { Escape: 27, Enter: 13, Delete: 46, Backspace: 8 } as Record<
              string,
              number
            >
          )[a.key]!;
    await p.call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: a.key,
      code,
      windowsVirtualKeyCode: vk,
      ...(a.key.length === 1 ? { text: a.key } : {}),
    });
    await p.call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: a.key,
      code,
      windowsVirtualKeyCode: vk,
    });
  }
  await wait(LIMITS.pace_ms);
}
let decisions = 0;
/** Shift arms: the bulk phase ends when the agent says so; then a fresh
 * single-cursor session finishes. */
const SHIFT = ["skills-shift", "skills-handoff"].includes(arm);
const HANDOFF = arm === "skills-handoff";
let bulkClosed = false;
let shiftNote = "";
let shiftAt: number | null = null;
const status = () => {
  const g = grade(D, [...board.elements.values()]);
  return `Board now: ${g.boxes.right}/${g.boxes.of} boxes labelled as in the reference, ${g.edges.right}/${g.edges.of} arrows attached as in the reference.`;
};
function toolsFor(own: number[] | null) {
  const many = own === null || own.length > 1;
  const view = (q?: number) => q ?? own?.[0] ?? 1;
  const tools: Tool[] = [
    {
      type: "function",
      name: "reference",
      description:
        "The reference diagram to recreate (same scale and position as the board).",
      inputSchema: z.toJSONSchema(z.strictObject({}), { io: "input" }),
    },
    {
      type: "function",
      name: "look",
      description:
        "Screenshot of the shared board" +
        (many
          ? " as one cursor sees it (default C1; tool and selection are per cursor)."
          : "."),
      inputSchema: z.toJSONSchema(lookSchema, { io: "input" }),
    },
    {
      type: "function",
      name: "act",
      description: many
        ? `Run actions with your cursors AT THE SAME TIME: each entry gives one cursor its own ordered actions (up to ${PER_DECISION}); all cursors run in parallel, then you get a screenshot. Give every cursor its own part of the work.`
        : `Run up to ${PER_DECISION} actions with your cursor in order, then get a screenshot.`,
      inputSchema: z.toJSONSchema(actSchema, { io: "input" }),
    },
    ...(SHIFT && own === null
      ? [
          {
            type: "function" as const,
            name: "finish_phase",
            description:
              "End the bulk phase once the bulk of the work is done (all boxes and most arrows drawn). A fresh session with one cursor and your skills then checks and fixes the rest. note: what remains or looks doubtful.",
            inputSchema: z.toJSONSchema(
              z.strictObject({ note: z.string().max(2000) }),
              { io: "input" },
            ),
          },
        ]
      : []),
    ...(SKILLS
      ? [
          {
            type: "function" as const,
            name: "skill",
            description:
              'Define (or redefine) a skill: a named sequence of the same UI actions with parameters. In actions, numbers may be arithmetic on parameters as strings ("{x}+130") and text may contain "{label}". Afterwards an act action {kind:"skill", name, args} runs the whole sequence and counts as one action. Define skills for what you repeat, check one use on the board, then reuse them.',
            inputSchema: z.toJSONSchema(skillSchema, { io: "input" }),
          },
        ]
      : []),
  ];
  const handle = async (name: string, args: unknown): Promise<ToolResult> => {
    try {
      if (name === "finish_phase") {
        bulkClosed = true;
        shiftNote = z
          .strictObject({ note: z.string().max(2000) })
          .parse(args).note;
        shiftAt = Date.now() - started;
        board.meta({ phase: "finish" });
        return {
          success: true,
          contentItems: [
            {
              type: "inputText",
              text: "Bulk phase closed. End your turn now; a fresh one-cursor session finishes the diagram.",
            },
          ],
        };
      }
      if (name === "skill") {
        const q = skillSchema.parse(args);
        skills.set(q.name, q);
        return {
          success: true,
          contentItems: [
            {
              type: "inputText",
              text: `skill ${q.name}(${q.params.join(", ")}) defined; skills: ${[...skills.keys()].join(", ")}`,
            },
          ],
        };
      }
      if (name === "reference")
        return {
          success: true,
          contentItems: [
            {
              type: "inputImage",
              imageUrl: `data:image/png;base64,${reference}`,
            },
          ],
        };
      if (name === "look") {
        const q = lookSchema.parse(args ?? {});
        if (own && q.cursor && !own.includes(q.cursor))
          throw Error(`not_your_cursor:${q.cursor}`);
        return {
          success: true,
          contentItems: [
            { type: "inputText", text: status() },
            {
              type: "inputImage",
              imageUrl: `data:image/png;base64,${await shot(pages.get(view(q.cursor))!)}`,
            },
          ],
        };
      }
      if (name === "act") {
        if (bulkClosed && own === null)
          throw Error("bulk_phase_closed:end_your_turn");
        const q = actSchema.parse(args);
        const bad = q.cursors.find((c) => own && !own.includes(c.cursor));
        if (bad) throw Error(`not_your_cursor:${bad.cursor}`);
        decisions++;
        board.meta({ decisions });
        // Expand skills first, so a bad call fails before any input.
        const plans = q.cursors.map((c) => ({
          cursor: c.cursor,
          actions: c.actions.flatMap(expand),
        }));
        await Promise.all(
          plans.map(async (c) => {
            for (const a of c.actions) await perform(c.cursor, a);
          }),
        );
        await wait(400);
        if (process.env.BOARD_SHOTS)
          for (const c of q.cursors)
            await writeFile(
              join(out, `d${decisions}-c${c.cursor}.png`),
              Buffer.from(await shot(pages.get(c.cursor)!), "base64"),
            );
        return {
          success: true,
          contentItems: [
            { type: "inputText", text: status() },
            {
              type: "inputImage",
              imageUrl: `data:image/png;base64,${await shot(pages.get(view())!)}`,
            },
          ],
        };
      }
      throw Error("unknown_tool");
    } catch (e) {
      return {
        success: false,
        contentItems: [{ type: "inputText", text: String(e).slice(0, 300) }],
      };
    }
  };
  return { tools, handle };
}

const HOW =
  "The board is the real Excalidraw editor, shared live: everything any cursor draws appears for everyone, and you see the other cursors. Toolbar (screen pixels): select (458,38), rectangle (498,38), arrow (618,38), text (738,38); keyboard shortcuts 1 select, 2 rectangle, 5 arrow. " +
  "A box: press 2, drag from one corner to the opposite corner; then double_click inside the box, type its label, press Escape. " +
  "An arrow: press 5, then drag from a point just inside the source box's edge that faces the target (about 5 px inside) to a point just inside the target box's facing edge; it attaches only when both ends are near the edges, not from the centre. After a shape or arrow the tool returns to select. When a shape is selected a style panel covers the left of the screen (x < 220); press Escape to clear the selection. " +
  "Recreate the reference diagram (call reference to see it): every box with its exact label, at about the same place as in the reference (the reference shows the board at the same scale and position), and every arrow between the same two boxes in the same direction. Do not add other shapes.";

// ---- agents ----------------------------------------------------------------
const started = Date.now();
const agents: { path: string; usage?: { totalTokens: number } | null }[] = [];
const tokensBy = new Map<string, number>();
const watch = setInterval(async () => {
  for (const path of tokensBy.keys()) {
    const ev = await readFile(join(out, path, "events.jsonl"), "utf8").catch(
      () => "",
    );
    const m = [...ev.matchAll(/"totalTokens":(\d+)/g)].at(-1);
    if (m) tokensBy.set(path, Number(m[1]));
  }
  const g = grade(D, [...board.elements.values()]);
  board.meta({
    tokens: [...tokensBy.values()].reduce((a, b) => a + b, 0),
    decisions,
    score: g.score,
  });
}, 2000);
async function agent(
  path: string,
  own: number[] | null,
  prompt: string,
  share: number,
) {
  tokensBy.set(path, 0);
  const { tools, handle } = toolsFor(own);
  const a = await runAstra({
    binary:
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    authPath: `${process.env.HOME}/.codex/auth.json`,
    output: join(out, path),
    deadlineMs: LIMITS.deadline_ms,
    maxTokens: Math.floor(LIMITS.tokens * share),
    maxCalls: Math.floor(LIMITS.calls * share) + 30,
    tools,
    prompt,
    handle,
  });
  agents.push({ path, ...(a as object) });
}

/** BOARD_DRY: the known-good plan, through the same act tool. */
async function dry() {
  const { handle } = toolsFor(null);
  const { cell, box, origin: o } = L;
  const at = (label: string) => {
    const b = D.boxes.find((x) => x.label === label)!;
    return { x: o.x + b.col * cell.w, y: o.y + b.row * cell.h };
  };
  const jobs: Action[][] = D.boxes.map((b) => {
    const p = at(b.label);
    return [
      { kind: "key", key: "2" },
      { kind: "drag", x: p.x, y: p.y, to_x: p.x + box.w, to_y: p.y + box.h },
      { kind: "double_click", x: p.x + box.w / 2, y: p.y + box.h / 2 },
      { kind: "type", text: b.label },
      { kind: "key", key: "Escape" },
    ];
  });
  // Arrow ends 5 px inside the facing edges (centre-to-centre does not attach).
  const edge = (p: { x: number; y: number }, to: { x: number; y: number }) => {
    const cx = p.x + box.w / 2,
      cy = p.y + box.h / 2;
    const dx = to.x - p.x,
      dy = to.y - p.y;
    const k = Math.min(
      dx ? (box.w / 2 - 5) / Math.abs(dx) : Infinity,
      dy ? (box.h / 2 - 5) / Math.abs(dy) : Infinity,
    );
    return { x: cx + dx * k, y: cy + dy * k };
  };
  const arrows: Action[][] = D.edges.map(([a, z]) => {
    const pa = at(a),
      pz = at(z);
    const s0 = edge(pa, pz),
      e0 = edge(pz, pa);
    return [
      { kind: "key", key: "Escape" },
      { kind: "key", key: "5" },
      { kind: "drag", x: s0.x, y: s0.y, to_x: e0.x, to_y: e0.y },
    ];
  });
  if (SKILLS) {
    // The same plan as two skills, called once per box and arrow.
    await handle("skill", {
      name: "box",
      params: ["x", "y", "label"],
      actions: [
        { kind: "key", key: "2" },
        {
          kind: "drag",
          x: "{x}",
          y: "{y}",
          to_x: `{x}+${box.w}`,
          to_y: `{y}+${box.h}`,
        },
        { kind: "double_click", x: `{x}+${box.w / 2}`, y: `{y}+${box.h / 2}` },
        { kind: "type", text: "{label}" },
        { kind: "key", key: "Escape" },
      ],
    });
    await handle("skill", {
      name: "arrow",
      params: ["x", "y", "tx", "ty"],
      actions: [
        { kind: "key", key: "Escape" },
        { kind: "key", key: "5" },
        { kind: "drag", x: "{x}", y: "{y}", to_x: "{tx}", to_y: "{ty}" },
      ],
    });
    jobs.splice(
      0,
      jobs.length,
      ...D.boxes.map((b) => {
        const p = at(b.label);
        return [
          {
            kind: "skill",
            name: "box",
            args: { x: p.x, y: p.y, label: b.label },
          } as any,
        ];
      }),
    );
    arrows.splice(
      0,
      arrows.length,
      ...arrows.map((a) => {
        const d = a[2] as any;
        return [
          {
            kind: "skill",
            name: "arrow",
            args: { x: d.x, y: d.y, tx: d.to_x, ty: d.to_y },
          } as any,
        ];
      }),
    );
  }
  for (const phase of [jobs, arrows]) {
    const queues: Action[][] = [...pages.keys()].map(() => []);
    phase.forEach((j, k) => queues[k % queues.length]!.push(...j));
    while (queues.some((q) => q.length)) {
      const cursors = queues
        .map((q, k) => ({ cursor: k + 1, actions: q.splice(0, PER_DECISION) }))
        .filter((c) => c.actions.length);
      await handle("act", { cursors });
    }
  }
}

if (process.env.BOARD_DRY) {
  for (const n of pages.keys()) board.label(n, "脚本");
  await dry();
} else if (arm !== "swarm") {
  for (const n of pages.keys()) board.label(n, N > 1 ? `Agent·C${n}` : "Agent");
  const shiftHint = SHIFT
    ? " When the bulk is done (all boxes and most arrows), call finish_phase: a fresh one-cursor session with your skills will check and fix the rest, which is faster than steering all cursors for the last details."
    : "";
  await agent(
    "agent",
    null,
    HOW +
      (N > 1
        ? ` You control ${N} cursors (C1..C${N}) on this one board. One act call drives all of them at once, each with its own actions, so plan every decision to keep all cursors busy on different boxes and arrows (e.g. each cursor takes its own boxes, then its own arrows). Work until the diagram is complete, then stop.`
        : " You control one cursor (C1). Work until the diagram is complete, then stop.") +
      (SKILLS
        ? " You can define skills (the skill tool): a repeated sequence then costs one action in act."
        : "") +
      shiftHint,
    1,
  );
  if (SHIFT && bulkClosed) {
    board.label(1, "收尾·C1");
    const finishCheck = HANDOFF
      ? `Use the textual reference and current board below to add what is missing and fix what is wrong (a wrong arrow: click it, press Delete, draw it again). You do not need to re-read pictures first; call reference or look only if the text is insufficient.\nReference diagram as text:\n${diagramText(D, L)}\nCurrent board as text:\n${boardText([...board.elements.values()])}`
      : "Compare the board with the reference, then add what is missing and fix what is wrong (a wrong arrow: click it, press Delete, draw it again).";
    await agent(
      "agent-finish",
      [1],
      HOW +
        ` Finishing phase: one agent with ${N} cursors has drawn the bulk of the diagram on this board. Its note: ${shiftNote || "(none)"}. You now control cursor C1 alone. ${finishCheck} These skills are defined and callable in act: ${[...skills.values()].map((k) => `${k.name}(${k.params.join(", ")})`).join("; ") || "none"}. Work until the diagram is complete, then stop.`,
      1,
    );
  }
} else {
  for (const n of pages.keys()) board.label(n, `A${n}`);
  await Promise.all(
    [...pages.keys()].map((n) => {
      const mine = D.boxes
        .filter((_, i) => i % N === n - 1)
        .map((b) => b.label);
      return agent(
        `agent-${n}`,
        [n],
        HOW +
          ` You are one of ${N} agents building this diagram together, each with one cursor; you control C${n} only. Your part: the boxes ${mine.map((x) => `"${x}"`).join(", ")}, and every arrow that starts at one of your boxes (draw an arrow once its target box exists; others draw the other boxes). Do not draw anything else. Work until your part is done, then stop.`,
        1 / N,
      );
    }),
  );
}
clearInterval(watch);
const elapsed = Date.now() - started;
const final = grade(D, [...board.elements.values()]);
// Score over time, from the log.
const log = (await readFile(join(out, "log.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const els = new Map<string, any>();
const reached: Record<string, number | null> = {
  "50": null,
  "90": null,
  "100": null,
};
const curve: [number, number][] = [];
for (const e of log) {
  if (e.type !== "elements") continue;
  for (const el of e.elements) els.set(el.id, el);
  const s = grade(D, [...els.values()]).score;
  curve.push([e.t, s]);
  for (const k of Object.keys(reached))
    if (reached[k] === null && s >= Number(k) / 100) reached[k] = e.t;
}
const tokens = agents.reduce((s, a) => s + (a.usage?.totalTokens ?? 0), 0);
const result = {
  shift_ms: shiftAt,
  arm,
  seed,
  cursors: N,
  per_decision: PER_DECISION,
  agents: agents.length,
  elapsed_ms: elapsed,
  final,
  reached_ms: reached,
  decisions,
  tokens,
  per_agent: agents.map((a) => ({
    path: a.path,
    tokens: a.usage?.totalTokens ?? null,
  })),
  curve,
};
board.meta({ tokens, decisions, score: final.score });
board.end({ arm, final, elapsed_ms: elapsed, tokens, decisions });
await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, curve: undefined }));
for (const p of pages.values()) p.close();
await browser.close();
await board.close();
// Browser profiles are caches, not evidence: remove them (disk).
await rm(join(out, "chrome"), { recursive: true, force: true });
await rm(join(out, "chrome-reference"), { recursive: true, force: true });
process.exit(0);
