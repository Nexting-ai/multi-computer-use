/**
 * Shared-canvas runs: reproduce the target picture on one shared page.
 *
 *   one    1 agent, 1 cursor                (conventional Computer Use)
 *   multi  1 agent, N cursors on the page   (the harness: one decision, N hands)
 *   swarm  N agents, 1 cursor each, each given its own region of the picture
 *
 *   node --import tsx lab/canvas/run.ts <out-dir> <one|multi|swarm> [cursors=12]
 *
 * Everything stays on this machine except model calls. The canvas log
 * (<out>/log.jsonl) records every change and cursor move for replay.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { Cdp } from "../../packages/virtual-screen/src/cdp.js";
import { runAstra, type Tool, type ToolResult } from "../benchmark/astra.js";
import { startCanvas } from "./server.js";
import { VIEWPORT, geometry } from "./pages.js";
import { COLS, ROWS, PALETTE, gridText, match, target } from "./target.js";

const [outArg, arm = "multi", cursorsArg = "12"] = process.argv.slice(2);
if (!outArg || !["one", "multi", "swarm"].includes(arm))
  throw Error("usage: run.ts <out> <one|multi|swarm> [cursors]");
const out = resolve(outArg);
const N = arm === "one" ? 1 : Number(cursorsArg);
const LIMITS = {
  deadline_ms: Number(process.env.CANVAS_DEADLINE_MS ?? 30 * 60_000),
  tokens: Number(process.env.CANVAS_MAX_TOKENS ?? 8_000_000),
  calls: Number(process.env.CANVAS_MAX_CALLS ?? 200),
  /** Most actions one cursor runs per decision (same for every arm). */
  per_cursor: 40,
  /** Pause between one cursor's actions, so the motion is visible. */
  pace_ms: 60,
};
const TITLES: Record<string, [string, string]> = {
  one: ["1 个 Agent · 1 个光标", "传统 Computer Use"],
  multi: [`1 个 Agent · ${N} 个光标`, "一次决策，多只手同时画"],
  swarm: [`${N} 个 Agent · 各 1 个光标`, "每个 Agent 负责一块"],
};

await mkdir(out, { recursive: true });
const LATENCY = Number(process.env.CANVAS_LATENCY_MS ?? 0);
const canvas = await startCanvas({
  latency_ms: LATENCY,
  log: join(out, "log.jsonl"),
  cursors: N,
  title: TITLES[arm]![0],
});
// The subtitle is part of the first log line's title for replays.
const goal = target();

// A dedicated headless Chrome; one browser context (one "user") per cursor.
const profile = join(out, "chrome-profile");
const chrome = spawn(
  process.env.CU_CHROME ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
let lines: string[] = [];
for (let k = 0; k < 100 && !lines[1]; k++) {
  lines = await readFile(join(profile, "DevToolsActivePort"), "utf8")
    .then((t) => t.trim().split("\n"))
    .catch(() => []);
  if (!lines[1]) await new Promise((r) => setTimeout(r, 100));
}
const browser = await Cdp.connect(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
const pages = new Map<number, Cdp>();
for (let n = 1; n <= N; n++) {
  const { browserContextId } = await browser.call(
    "Target.createBrowserContext",
  );
  const { targetId } = await browser.call("Target.createTarget", {
    url: `${canvas.url}/client/${n}`,
    browserContextId,
  });
  const page = await Cdp.connect(
    `ws://127.0.0.1:${lines[0]}/devtools/page/${targetId}`,
  );
  await page.call("Page.enable");
  // Every cursor's page behaves as focused and active (background pages in
  // headless Chrome otherwise stall screenshots and timers).
  await page.call("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.call("Page.setWebLifecycleState", { state: "active" });
  await page.call("Emulation.setDeviceMetricsOverride", {
    ...VIEWPORT,
    deviceScaleFactor: 1,
    mobile: false,
  });
  pages.set(n, page);
}
await new Promise((r) => setTimeout(r, 1500));

// ---- tools -------------------------------------------------------------
const action = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("click"),
    x: z.number().int().min(0).max(VIEWPORT.width),
    y: z.number().int().min(0).max(VIEWPORT.height),
  }),
]);
const actSchema = z.strictObject({
  cursors: z
    .array(
      z.strictObject({
        cursor: z.number().int().min(1).max(N),
        actions: z.array(action).min(1).max(LIMITS.per_cursor),
      }),
    )
    .min(1)
    .max(N),
});
const t = (name: string, description: string, s: z.ZodType): Tool => ({
  type: "function",
  name,
  description,
  inputSchema: z.toJSONSchema(s, { io: "input" }),
});

async function shot(n: number) {
  const r = await pages
    .get(n)!
    .call("Page.captureScreenshot", { format: "png" });
  return `data:image/png;base64,${r.data}`;
}
function status(only?: number) {
  return [...canvas.cursors.values()]
    .filter((c) => only === undefined || c.n === only)
    .map(
      (c) =>
        `C${c.n}: tool ${c.tool}, colour ${PALETTE[c.color]![0]}${c.corner ? `, rectangle corner set at col ${c.corner[0]} row ${c.corner[1]}` : ""}`,
    )
    .join("; ");
}
async function run(cursor: number, actions: z.infer<typeof action>[]) {
  const page = pages.get(cursor)!;
  for (const a of actions) {
    await page.call("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: a.x,
      y: a.y,
    });
    await page.call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: a.x,
      y: a.y,
      button: "left",
      clickCount: 1,
    });
    await page.call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: a.x,
      y: a.y,
      button: "left",
      clickCount: 1,
    });
    // Like any Computer Use step, wait for the application to respond.
    for (let k = 0; k < 200; k++) {
      const r = await page.call("Runtime.evaluate", {
        expression: "window.__busy",
        returnByValue: true,
      });
      if (!r.result?.value) break;
      await new Promise((x) => setTimeout(x, 40));
    }
    await new Promise((r) => setTimeout(r, LIMITS.pace_ms));
  }
}
let decisions = 0;
function toolsFor(own: number[] | null) {
  const many = own === null || own.length > 1;
  return {
    tools: [
      t(
        "look",
        "Screenshot of the shared page and the state of your cursor(s). The whole picture is shared: every cursor's changes appear for everyone.",
        z.strictObject({}),
      ),
      t(
        "act",
        many
          ? `Run clicks with your cursors AT THE SAME TIME: each entry gives one cursor its own ordered list of clicks (up to ${LIMITS.per_cursor}); all cursors run in parallel, then you get a fresh screenshot. Split the work so every cursor is busy on its own part.`
          : `Run up to ${LIMITS.per_cursor} clicks with your cursor in order, then get a fresh screenshot.`,
        actSchema,
      ),
    ],
    handle: async (name: string, args: unknown): Promise<ToolResult> => {
      try {
        const view = own?.[0] ?? 1;
        if (name === "look")
          return {
            success: true,
            contentItems: [
              {
                type: "inputText",
                text: status(own?.length === 1 ? own[0] : undefined),
              },
              { type: "inputImage", imageUrl: await shot(view) },
            ],
          };
        if (name === "act") {
          const q = actSchema.parse(args);
          const bad = q.cursors.find((c) => own && !own.includes(c.cursor));
          if (bad) throw Error(`not_your_cursor:${bad.cursor}`);
          decisions++;
          canvas.meta({ decisions });
          await Promise.all(q.cursors.map((c) => run(c.cursor, c.actions)));
          await new Promise((r) => setTimeout(r, 250));
          return {
            success: true,
            contentItems: [
              {
                type: "inputText",
                text: status(own?.length === 1 ? own[0] : undefined),
              },
              { type: "inputImage", imageUrl: await shot(view) },
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
    },
  };
}

const G = geometry;
const howTo =
  `A shared drawing page: a ${COLS} x ${ROWS} grid of cells. Reproduce the target picture exactly (white cells are already white). ` +
  `Page coordinates (pixels): tool Pixel at (${G.tool.pixel!.join(", ")}), tool Rectangle at (${G.tool.rect!.join(", ")}); colour swatch k at (${G.swatch(0)[0]} + 40k, 72) for k = 0..11: ` +
  PALETTE.map(([name, , l], k) => `${k} ${name} (${l})`).join(", ") +
  `. The centre of cell (col, row) is (26 + 12*col, 110 + 12*row), col 0..${COLS - 1}, row 0..${ROWS - 1}. ` +
  `Each cursor has its own tool and colour: click a tool, click a swatch, then click cells. With Rectangle, click one corner cell then the opposite corner cell to fill the rectangle (fast for large areas; paint over with details afterwards). Later paint covers earlier paint. Start painting early and work in rounds (big areas first, then details), instead of planning the whole picture before the first click. ` +
  `Target (rows 00..39, one letter per cell, letters as above, '.' white):\n${gridText(goal)}\n`;
const regionOf = (n: number) => {
  // N regions: 4 columns x ceil(N/4) rows of the picture.
  const cols = 4,
    rows = Math.ceil(N / cols),
    i = n - 1;
  const w = COLS / cols,
    h = Math.ceil(ROWS / rows);
  const c0 = (i % cols) * w,
    r0 = Math.floor(i / cols) * h;
  return { c0, c1: c0 + w - 1, r0, r1: Math.min(ROWS - 1, r0 + h - 1) };
};

// ---- agents ------------------------------------------------------------
const started = Date.now();
type Agent = {
  path: string;
  usage?: { totalTokens: number } | null;
  status?: unknown;
};
const agents: Agent[] = [];
// Live token counter for the views: sum of the latest usage per agent.
const tokensByAgent = new Map<string, number>();
const watch = setInterval(async () => {
  for (const path of tokensByAgent.keys()) {
    const ev = await readFile(join(out, path, "events.jsonl"), "utf8").catch(
      () => "",
    );
    const m = [...ev.matchAll(/"totalTokens":(\d+)/g)].at(-1);
    if (m) tokensByAgent.set(path, Number(m[1]));
  }
  canvas.meta({
    tokens: [...tokensByAgent.values()].reduce((a, b) => a + b, 0),
    decisions,
  });
}, 2000);
async function agent(
  path: string,
  own: number[] | null,
  prompt: string,
  share: number,
) {
  tokensByAgent.set(path, 0);
  const { tools, handle } = toolsFor(own);
  const a = await runAstra({
    binary:
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    authPath: `${process.env.HOME}/.codex/auth.json`,
    output: join(out, path),
    deadlineMs: LIMITS.deadline_ms,
    maxTokens: Math.floor(LIMITS.tokens * share),
    maxCalls: Math.floor(LIMITS.calls * share) + 20,
    tools,
    prompt,
    handle,
  });
  agents.push({ path, ...(a as object) } as Agent);
}
/** CANVAS_DRY=1: no model. A scripted planner paints the target through the
 * same `act` tool (row runs as rectangles, spread over the cursors), to test
 * the page, the log and the replay. */
async function dryRun() {
  const { handle } = toolsFor(null);
  type Click = { kind: "click"; x: number; y: number };
  const jobs: Click[][] = [];
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS;) {
      const v = goal[r * COLS + c]!;
      let e = c;
      while (e + 1 < COLS && goal[r * COLS + e + 1] === v) e++;
      if (v !== 0) {
        const [x0, y0] = G.cell(c, r),
          [x1, y1] = G.cell(e, r);
        jobs.push([
          { kind: "click", x: G.swatch(v)[0], y: 72 },
          { kind: "click", x: x0, y: y0 },
          { kind: "click", x: x1, y: y1 },
        ]);
      }
      c = e + 1;
    }
  const queues: Click[][] = [...pages.keys()].map(() => [
    { kind: "click", x: G.tool.rect![0], y: G.tool.rect![1] },
  ]);
  jobs.forEach((j, k) => queues[k % queues.length]!.push(...j));
  while (queues.some((q) => q.length)) {
    const cursors = queues
      .map((q, k) => ({
        cursor: k + 1,
        actions: q.splice(
          0,
          LIMITS.per_cursor - (LIMITS.per_cursor % 3) + 1 > q.length
            ? q.length
            : 39,
        ),
      }))
      .filter((c) => c.actions.length);
    await handle("act", { cursors });
  }
}
if (process.env.CANVAS_DRY) {
  for (const n of pages.keys()) canvas.setActor(n, "脚本（无模型）");
  await dryRun();
} else if (arm === "one" || arm === "multi") {
  for (const n of pages.keys()) canvas.setActor(n, "1 个 Agent");
  await agent(
    "agent",
    null,
    howTo +
      (N > 1
        ? `You control ${N} cursors (C1..C${N}) on this one page. One act call drives all of them at once, each with its own list of clicks, so plan each decision to keep every cursor busy on a different part of the picture. Work until the picture matches the target, then stop.`
        : "You control one cursor (C1). Work until the picture matches the target, then stop."),
    1,
  );
} else {
  for (const n of pages.keys()) canvas.setActor(n, `Agent ${n}`);
  await Promise.all(
    [...pages.keys()].map((n) => {
      const r = regionOf(n);
      return agent(
        `agent-${n}`,
        [n],
        howTo +
          `You are one of ${N} agents drawing this picture together, each with one cursor. You control cursor C${n} only. Your part: columns ${r.c0}..${r.c1}, rows ${r.r0}..${r.r1} of the target (the others do the rest; do not paint outside your part). Work until your part matches the target, then stop.`,
        1 / N,
      );
    }),
  );
}
clearInterval(watch);
const elapsed = Date.now() - started;
const usage = agents.reduce((s, a) => s + (a.usage?.totalTokens ?? 0), 0);
// Progress over time, from the log (time to 90% / 95% of the target).
const log = (await readFile(join(out, "log.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const g = Array(COLS * ROWS).fill(0);
const reached: Record<string, number | null> = {
  "50": null,
  "90": null,
  "95": null,
};
for (const e of log) {
  if (e.type === "paint") g[e.row * COLS + e.col] = e.color;
  else if (e.type === "rect")
    for (let r = e.r0; r <= e.r1; r++)
      for (let c = e.c0; c <= e.c1; c++) g[r * COLS + c] = e.color;
  else continue;
  const m = match(g, goal);
  for (const k of Object.keys(reached))
    if (reached[k] === null && m >= Number(k) / 100) reached[k] = e.t;
}
const result = {
  arm,
  cursors: N,
  agents: agents.length,
  elapsed_ms: elapsed,
  match: match(canvas.grid, goal),
  reached_ms: reached,
  decisions,
  tokens: usage,
  per_agent: agents.map((a) => ({
    path: a.path,
    tokens: a.usage?.totalTokens ?? null,
  })),
};
canvas.meta({ tokens: usage, decisions });
canvas.end(result);
await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
for (const p of pages.values()) p.close();
browser.close();
chrome.kill("SIGTERM");
await canvas.close();
process.exit(0);
