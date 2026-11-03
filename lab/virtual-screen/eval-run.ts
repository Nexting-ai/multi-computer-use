/**
 * Preregistered evaluation runner (docs/validation/2026-10-30-preregistration.md).
 * Arms: P-V, P-T (per-surface, vision/text values), B-V, B-T (broadcast,
 * vision/text values), S (model-written script over text snapshots).
 * Workloads (lab/workloads): the synthetic business form (uniform | mixed |
 * k<N>), held-out MiniWoB tasks, and desktop applications (Blender, KiCad).
 * Agents: Astra (Codex app-server) or Claude (claude -p over MCP).
 * Every block draws a fresh scene seed and a random arm order; every arm gets a
 * fresh fleet and fresh model sessions. Grading is independent of the runtime.
 */
import {
  readFile,
  writeFile,
  mkdir,
  appendFile,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import sharp from "sharp";
import {
  ManagedScreen,
  managedActionSchema,
  verificationSchema,
} from "../../packages/virtual-screen/src/managed.js";
import {
  ProgressLedger,
  runWorksets,
} from "../../packages/virtual-screen/src/workset.js";
import {
  StackScreen,
  policySchema,
  cropsSchema,
  confirmSchema,
} from "../../packages/virtual-screen/src/stack.js";
import {
  ScriptScreen,
  scriptReadSchema,
  scriptActSchema,
  scriptConfirmSchema,
  scriptDoneSchema,
  compact,
} from "../../packages/virtual-screen/src/script.js";
import {
  taskViewMetadata,
  type TaskView,
} from "../../packages/virtual-screen/src/task.js";
import { runAstra, type ToolResult, type Tool } from "../benchmark/astra.js";
import { rng, type Usage } from "../benchmark/metrics.js";
import { runClaude } from "../agents/claude.js";
import { sequence, miniwob } from "../workloads/web.js";
import { blender } from "../workloads/blender.js";
import { kicad } from "../workloads/kicad.js";
import { studio } from "../workloads/studio.js";
import type { Workload } from "../workloads/types.js";

const ARMS = ["P-V", "P-T", "B-V", "B-T", "S", "F"] as const;
type Arm = (typeof ARMS)[number];
const schema = z.strictObject({
  binary: z.string(),
  auth_path: z.string(),
  output: z.string(),
  count: z.number().int().min(1).max(100),
  blocks: z.number().int().min(1).max(20),
  seed: z.number().int(),
  arms: z.array(z.enum(ARMS)).min(1),
  workload: z.union([
    z.strictObject({
      kind: z.literal("sequence"),
      variant: z.string().default("uniform"),
    }),
    z.strictObject({ kind: z.literal("miniwob"), task: z.string() }),
    z.strictObject({
      kind: z.enum(["blender", "kicad", "studio", "city"]),
      image: z.string(),
      port: z.number().int().optional(),
      /** Docker hosts; "local" or an SSH destination with its options. */
      hosts: z
        .array(
          z.union([
            z.literal("local"),
            z.strictObject({
              destination: z.string(),
              options: z.array(z.string()),
            }),
          ]),
        )
        .min(1),
    }),
  ]),
  agent: z.enum(["astra", "claude"]).default("astra"),
  claude_model: z.string().default("sonnet"),
  deadline_ms: z.number().int().min(10000).max(14400000),
  session_deadline_ms: z.number().int().min(10000).max(10800000),
  max_tokens: z.number().int().positive(),
  max_calls: z.number().int().positive(),
  session_max_tokens: z.number().int().positive().default(1000000),
  session_max_calls: z.number().int().positive().default(96),
  workset_size: z.number().int().min(1).max(8).default(8),
  /** Per-surface sessions running at once (1 = sequential, as in E1). */
  workset_parallel: z.number().int().min(1).max(16).default(1),
  stack_concurrency: z.number().int().min(1).max(100).default(64),
  slots: z
    .array(z.strictObject({ block: z.number().int(), arm: z.enum(ARMS) }))
    .optional(),
});
const o = schema.parse(JSON.parse(await readFile(process.argv[2]!, "utf8")));
o.output = resolve(o.output);
if (o.count > 12 && ["sequence", "miniwob"].includes(o.workload.kind))
  throw Error("more_than_12_local_browser_surfaces");
await mkdir(o.output, { recursive: false });

const W = o.workload;
const desktopOptions = (w: {
  image: string;
  port?: number | undefined;
  hosts: unknown[];
}) => ({
  image: w.image,
  ...(w.port ? { port: w.port } : {}),
  hosts: (w.hosts as any[]).map((h) =>
    h === "local" ? { kind: "local" as const } : { kind: "ssh" as const, ...h },
  ),
});
const workload: Workload =
  W.kind === "sequence"
    ? sequence(W.variant)
    : W.kind === "miniwob"
      ? miniwob(W.task)
      : W.kind === "blender"
        ? blender(desktopOptions(W))
        : W.kind === "kicad"
          ? kicad(desktopOptions(W))
          : studio(W.kind, desktopOptions(W));
const free = workload.declared;
const steps = workload.items;

// ---------- tool schemas ----------
const observeSchema = z.strictObject({
  surfaces: z
    .array(z.strictObject({ surface_id: z.string() }))
    .min(1)
    .max(8),
  full: z.boolean().optional(),
});
const doneSchema = z.strictObject({
  surfaces: z.array(z.string()).min(1).max(8),
});
const fleetObserve = z.strictObject({
  surfaces: z.array(z.string()).min(1).max(4),
});
const t = (name: string, description: string, s: z.ZodType): Tool => ({
  type: "function",
  name,
  description,
  inputSchema: z.toJSONSchema(s),
});
const perSurfaceTools = (text: boolean): Tool[] => [
  t(
    "desktop_observe",
    "Observe only assigned surfaces. Returns ready original-resolution views, pending targets, target-local errors and progress. For pending targets observe again; capture is read-only. Clicks use panel-local x/y (for full views equal to screen pixels). full:true restores all context." +
      (text
        ? " Each view also carries `text`: the surface's accessibility text and named controls as [text, x, y, width, height] in the same pixels; you may copy values from it instead of reading pixels."
        : ""),
    observeSchema,
  ),
  t(
    "desktop_act",
    free
      ? "Explicit per-Z input sequences on observed views; clicks are local to the selected panel. Actions are not progress by themselves: declare a surface finished with desktop_done. Returns per-target delivery and available post-action images. Never replay delivered or unknown input. Duplicate request_id only retrieves progress."
      : "Explicit per-Z input sequences on observed views; clicks are local to the selected panel. expectation is the exact CURRENT code and chosen priority read before input. One sequence performs one item, including Save once. Optionally include checks for preceding delivered items, using fresh view_id and literally observed saved text/choice. Returns per-target delivery, available post-action images and pending states. Re-observe pending/missing views, never replay delivered or unknown input. Duplicate request_id only retrieves progress. A target with dismiss:true (no expectation, no typing) clears a blocking notice; it is never an item." +
          (text ? " Post-action views also carry `text`." : ""),
    managedActionSchema(false),
  ),
  free
    ? t(
        "desktop_done",
        "Declare assigned surfaces whose instruction you have completed. Graded independently.",
        doneSchema,
      )
    : t(
        "desktop_verify",
        "Verify the final saved item of each assigned surface using a fresh view and the actual text and priority you see. Delivery is not completion. A mismatch blocks this target; report it honestly. Use checks inline in the next action for intermediate items.",
        verificationSchema,
      ),
];
const fleetRunDescription = (vision: boolean) =>
  "Broadcast ONE decision over many surfaces (Z). All rectangles/points are pixels of the exemplar view_id. template: the stable task area enclosing everything referenced; the host finds it on every surface by pixel registration (translation tolerated) and never touches a surface where it does not match. " +
  (vision
    ? "fields: named rectangles whose content varies; YOU provide their values per surface in `values` (from a fleet_crops contact sheet, crops_id), one item per surface per run; there is no text channel. "
    : "fields: named rectangles whose text varies (values only, not labels: text nodes whose centre lies inside are concatenated); the host reads their exact text via the platform text channel, so you never transcribe values. ") +
  "inputs: columns of the host task table shown in the task; steps type or choose them like fields, per surface, so you never transcribe them. items: how many items this policy performs per surface in this run (use one policy per item when items differ). " +
  "ignore: other pixels inside the template that legitimately change (counters, headings, selection highlight, input contents, receipts not declared as fields). Every click target is also checked locally against the exemplar (keep value fields off click targets); a surface whose target looks different gets no input. steps (ordered): click{x,y}; type_field{field}; choose{field,cases[{equals,x,y,label}],otherwise?{x,y,label}} clicks the case whose equals exactly matches the field value; otherwise covers any other non-empty value; no match => surface untouched and reported; " +
  (vision
    ? ""
    : "click_text{field|text} clicks the unique text/control inside the template whose text equals the field value or literal; ") +
  "key_chord. verify: post-condition of a field after the steps, {field,equals} or {field,contains:[...]} with placeholders {fieldname} and {choice} (a post-condition without placeholders only proves the steps ran and is reported as weak)" +
  (vision
    ? " (in vision mode it is not checked by the host; you confirm receipts with fleet_confirm)"
    : "") +
  ". The host first runs ONE item on ONE canary surface; only if it succeeds does it broadcast. " +
  (vision
    ? ""
    : "mode: prepare runs the steps ONCE per surface to clear an interruption, never counts as an item, cannot type field values, and may verify {field,absent:true}. A later corrected policy also verifies earlier deliveries. Uncertain deliveries are closed only from evidence. ") +
  "surfaces: limit to listed IDs (default all). Returns counts, canary outcome, exceptions" +
  (vision
    ? "."
    : " and exception_groups: visually distinct groups of exception surfaces, each with one real screenshot (view_id) usable as a new exemplar.");
const fleetTools = (vision: boolean): Tool[] => [
  t(
    "fleet_observe",
    "Full original-resolution screenshots (1–4 surfaces) to use as exemplars, plus fleet progress. Coordinates in a returned view are that image's pixels.",
    fleetObserve,
  ),
  t("fleet_run", fleetRunDescription(vision), policySchema),
  ...(vision
    ? [
        t(
          "fleet_crops",
          "Register the template (exemplar pixels) on surfaces and return labelled contact sheets of the given field rectangles, one row per surface (Z label), original resolution. Returns crops_id binding each row to that surface's current frame. Use it to read values (before fleet_run) and receipts (before fleet_confirm).",
          cropsSchema,
        ),
        t(
          "fleet_confirm",
          "Confirm delivered items from receipts you read in a contact sheet taken AFTER the delivery: checks maps surface_id to the literal saved text and choice you see.",
          confirmSchema,
        ),
      ]
    : []),
];
const overviewSchema = z.strictObject({
  surfaces: z.array(z.string()).min(1).max(100).optional(),
  region: z
    .strictObject({
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      width: z.number().int().min(8),
      height: z.number().int().min(8),
    })
    .optional(),
});
const directorTools: Tool[] = [
  ...fleetTools(false),
  t(
    "fleet_overview",
    "One image of many surfaces at once: each surface's current screen (or the same `region` of every screen, in screen pixels) as a labelled tile. Use it to review the whole fleet in one look, e.g. after rendering previews everywhere. Read-only; for exemplars and planning use fleet_observe.",
    overviewSchema,
  ),
  ...perSurfaceTools(false),
];
const directorPrompt = (task: string, ids: string[]) =>
  `${task}\nYou direct ${ids.length} desktops (${ids[0]}…${ids.at(-1)}) and decide how work is split. Work that is the same everywhere (shared helper code, materials, settings, rendering a preview, saving) is one fleet_run policy for all desktops: a \`type\` step pastes literal text with {placeholders} filled from each desktop's task-table inputs, so one script serves every desktop. Work that differs per desktop uses desktop_observe/desktop_act on that desktop alone. Review progress across the fleet with fleet_overview instead of observing desktops one by one. In this task fleet_run policies are steps: each applies once per desktop per run (canary first, then the rest), is verified by its post-condition, and never completes an item; desktops you have declared done are skipped. Declare each desktop's item with desktop_done when its result is finished and saved. ${forward} Starting progress: `;
const scriptTools: Tool[] = [
  t(
    "surface_read",
    "Frame-bound accessibility snapshots of up to 100 surfaces: per surface a token and nodes [text, x, y, width, height] in screen pixels; controls are tagged like [button]Save, [textbox]value, [checkbox:checked]Name. No screenshots. Tokens bind actions to that exact frame.",
    scriptReadSchema,
  ),
  t(
    "surface_act",
    (free
      ? "Input on up to 100 surfaces: targets {surface_id, token, actions}. Actions are not progress; declare finished surfaces with surface_done. "
      : "Input on up to 100 surfaces: targets {surface_id, token, actions, expectation:{text,choice}}; one target performs one item (exactly one type_text equal to expectation.text, then Save once). ") +
      "The host refuses input if the surface changed since the token's snapshot. Never repeat delivered or unknown input.",
    scriptActSchema,
  ),
  free
    ? t(
        "surface_done",
        "Declare surfaces whose instruction you have completed. Graded independently.",
        scriptDoneSchema,
      )
    : t(
        "surface_confirm",
        "Confirm delivered items from a snapshot taken AFTER the delivery: {surface_id, token, text, choice} with the literal saved text and choice you read.",
        scriptConfirmSchema,
      ),
];
const forward =
  'In code mode, forward every result line: for (const line of r.split("\\n")) { if (line.startsWith("data:image/")) image(line); else text(line); }.';
const fleetPrompt = (task: string, n: number, ids: string[], vision: boolean) =>
  `${task}\nYou operate a fleet of ${n} surfaces (${ids[0]}…${ids.at(-1)}, Z=1..${n}). Do not operate surfaces one by one. Observe one exemplar with fleet_observe, then express the procedure once as a fleet_run policy using that exemplar's pixels; the host canaries it on one surface before broadcasting. ` +
  (vision
    ? "There is no text channel: use fleet_crops to read each round's values from contact sheets, pass them as fleet_run values with crops_id, then after the round read receipts with fleet_crops and confirm them with fleet_confirm. "
    : "If exceptions are returned, inspect each exception group's screenshot: a different layout gets its own policy restricted to that group's surfaces; an interruption gets a prepare policy, after which the original policy is run again on those surfaces. Handle all groups in ONE code cell: independent policies for different groups run concurrently (Promise.all), and for an interruption group chain the prepare policy then the item policy with await. ") +
  `Surfaces you leave unfinished are handed to per-surface operators afterwards (more expensive). ${forward} End when the fleet is complete or nothing more can be done by policy. Starting progress: `;
const scriptPrompt = (task: string, n: number, ids: string[]) =>
  `${task}\nYou operate a fleet of ${n} surfaces (${ids[0]}…${ids.at(-1)}). You have accessibility snapshots (text and control positions), not screenshots. Write code in a single code cell where possible that loops over all surfaces: read snapshots, decide each surface's actions from its own snapshot, act, re-read, ` +
  (free
    ? "and declare done surfaces. "
    : "and confirm each item from a fresh snapshot. ") +
  `Surfaces you leave unfinished are handed to per-surface operators afterwards. ${forward} Starting progress: `;

// ---------- frozen plan ----------
const paths = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "packages",
    "lab",
    "package.json",
    "pnpm-lock.yaml",
  ],
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .sort();
const source = Object.fromEntries(
  await Promise.all(
    paths.map(async (p) => [
      p,
      createHash("sha256")
        .update(await readFile(p))
        .digest("hex"),
    ]),
  ),
);
const r = rng(o.seed);
const blocks = Array.from({ length: o.blocks }, (_, b) => {
  const order = [...o.arms];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return { block: b, seed: Math.floor(r() * 2 ** 31), order };
});
await writeFile(
  join(o.output, "plan.json"),
  JSON.stringify(
    {
      created_at: new Date().toISOString(),
      preregistration: "docs/validation/2026-10-30-preregistration.md",
      agent:
        o.agent === "astra"
          ? { kind: "astra", model: "gpt-6-astra", effort: "medium" }
          : { kind: "claude", model: o.claude_model },
      binary_sha256:
        o.agent === "astra"
          ? createHash("sha256")
              .update(await readFile(o.binary))
              .digest("hex")
          : null,
      config: { ...o, auth_path: "local authorization; never archived" },
      source_sha256: createHash("sha256")
        .update(JSON.stringify(source))
        .digest("hex"),
      source,
      blocks,
      task: workload.summary,
      tools: {
        "P-V": perSurfaceTools(false),
        "P-T": perSurfaceTools(true),
        "B-V": fleetTools(true),
        "B-T": fleetTools(false),
        S: scriptTools,
        F: directorTools,
      },
    },
    null,
    2,
  ),
);

// ---------- run ----------
const sum = (a: Usage, b: Usage | null | undefined) => {
  if (b)
    for (const k of Object.keys(a) as (keyof Usage)[])
      a[k] = (a[k] ?? 0) + (b[k] ?? 0);
};
const rows: any[] = [];
for (const blk of blocks)
  for (const arm of blk.order) {
    if (o.slots && !o.slots.some((s) => s.block === blk.block && s.arm === arm))
      continue;
    const directory = join(o.output, `${blk.block}-${arm}`);
    await mkdir(directory);
    console.log(
      JSON.stringify({
        event: "start",
        block: blk.block,
        arm,
        at: new Date().toISOString(),
      }),
    );
    const env = join(directory, "environment");
    const lab = await workload.open(env, o.count, blk.seed);
    await writeFile(join(directory, "task.txt"), lab.task);
    const ledger = await ProgressLedger.open(
      join(directory, "ledger"),
      lab.surfaces,
      steps,
    );
    const context = new AsyncLocalStorage<number>();
    let calls = 0,
      images = 0,
      pixels = 0,
      stopReason: string | null = null;
    const sessions: any[] = [];
    const usage: Usage = {
      totalTokens: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      cacheWriteInputTokens: 0,
    };
    let trace = Promise.resolve();
    const record = (v: any) =>
      (trace = trace.then(() =>
        appendFile(join(directory, "tools.jsonl"), JSON.stringify(v) + "\n"),
      ));
    const delivery = (file: string) => (x: unknown) =>
      appendFile(join(directory, file), JSON.stringify(x) + "\n");
    const saveSource = async (
      f: { surface_id: string; png: Buffer },
      purpose: string,
    ) => {
      if (!f.png.length) return;
      await writeFile(
        join(
          directory,
          `source-${context.getStore() ?? 0}-${f.surface_id}-${purpose}-${randomUUID().slice(0, 6)}.png`,
        ),
        f.png,
      );
    };
    const toContent = async (call: number, views: any[], rest: unknown) => {
      const content: ToolResult["contentItems"] = [
          { type: "inputText", text: JSON.stringify(rest) },
        ],
        metadata: any[] = [];
      for (const [i, v] of views.entries()) {
        const file = `image-${call}-${i}.png`;
        await writeFile(join(directory, file), v.png);
        const { png, text, ...meta } = v;
        images++;
        pixels += v.width * v.height;
        metadata.push({
          ...meta,
          file,
          sha256: createHash("sha256").update(png).digest("hex"),
        });
        content.push(
          {
            type: "inputText",
            text: JSON.stringify({
              ...("panels" in v
                ? taskViewMetadata({ ...v, role: v.role ?? "full" } as TaskView)
                : meta),
              ...(text ? { text } : {}),
            }),
          },
          {
            type: "inputImage",
            imageUrl: "data:image/png;base64," + png.toString("base64"),
          },
        );
      }
      return { content, metadata };
    };
    const started = performance.now();
    const budget = () => {
      if (
        performance.now() - started >= o.deadline_ms ||
        usage.totalTokens >= o.max_tokens ||
        calls >= o.max_calls
      ) {
        stopReason = "run_budget";
        throw Error("run_budget");
      }
    };
    const session = async (
      path: string,
      tools: Tool[],
      prompt: string,
      handle: (
        name: string,
        args: unknown,
      ) => Promise<{ views: any[]; rest: unknown }>,
    ) => {
      budget();
      await mkdir(join(directory, path), { recursive: true });
      const wrapped = async (
        name: string,
        args: unknown,
      ): Promise<ToolResult> => {
        const call = ++calls,
          t0 = performance.now();
        return context.run(call, async () => {
          try {
            const { views, rest } = await handle(name, args);
            const { content, metadata } = await toContent(call, views, rest);
            await record({
              index: call,
              session: path,
              name,
              args,
              result: { rest, views: metadata },
              success: true,
              elapsed_ms: performance.now() - t0,
            });
            return { success: true, contentItems: content };
          } catch (e) {
            await record({
              index: call,
              session: path,
              name,
              args,
              error: String(e),
              success: false,
              elapsed_ms: performance.now() - t0,
            });
            return {
              success: false,
              contentItems: [
                { type: "inputText", text: String(e).slice(0, 400) },
              ],
            };
          }
        });
      };
      const remaining = {
        deadline: Math.min(
          o.session_deadline_ms,
          o.deadline_ms - (performance.now() - started),
        ),
        tokens: Math.min(
          o.session_max_tokens,
          o.max_tokens - usage.totalTokens,
        ),
        calls: Math.min(o.session_max_calls, o.max_calls - calls),
      };
      const agent =
        o.agent === "astra"
          ? await runAstra({
              binary: o.binary,
              authPath: o.auth_path,
              output: join(directory, path, "agent"),
              deadlineMs: remaining.deadline,
              maxTokens: remaining.tokens,
              maxCalls: remaining.calls,
              tools,
              prompt,
              handle: wrapped,
            })
          : await runClaude({
              output: join(directory, path, "agent"),
              prompt,
              tools,
              handle: wrapped,
              deadlineMs: remaining.deadline,
              maxCalls: remaining.calls,
              model: o.claude_model,
            });
      sessions.push({ path, agent });
      if (agent.usage) sum(usage, agent.usage);
      else stopReason = "missing_usage";
      if ("isolated_home" in agent)
        await unlink(join(agent.isolated_home as string, "auth.json")).catch(
          () => {},
        );
      console.log(
        JSON.stringify({
          event: "session_finished",
          block: blk.block,
          arm,
          path,
          progress: ledger.summary(),
          tokens: usage.totalTokens,
          status: agent.status?.status,
          stop: agent.stop_reason,
        }),
      );
      return agent;
    };
    const withText = async (value: any, text: boolean) => {
      const views = value.views ?? [];
      if (text && lab.port.probeText)
        for (const v of views) {
          const ids = [
            ...new Set((v.panels ?? []).map((p: any) => p.surface_id)),
          ] as string[];
          if (ids.length === 1)
            v.text = compact(await lab.port.probeText(ids[0]!));
        }
      return views;
    };
    /** Per-surface tools over `ids` (null when the tool is not one of them). */
    const desk = (
      runtime: ManagedScreen,
      ids: string[],
      text: boolean,
      name: string,
      args: unknown,
    ): Promise<{ views: any[]; rest: unknown }> | null => {
      if (
        ![
          "desktop_observe",
          "desktop_act",
          "desktop_verify",
          "desktop_done",
        ].includes(name)
      )
        return null;
      return (async () => {
        let value: any;
        if (name === "desktop_observe") {
          const q = observeSchema.parse(args);
          value = await runtime.observe(
            q.surfaces.map((x) => x.surface_id),
            q.full,
          );
        } else if (name === "desktop_act") value = await runtime.act(args);
        else if (!free && name === "desktop_verify")
          value = { progress: await runtime.confirm(args), views: [] };
        else if (free && name === "desktop_done") {
          for (const id of doneSchema.parse(args).surfaces) {
            if (!ids.includes(id)) throw Error("target_outside_workset");
            if (ledger.get(id).state === "ready") await ledger.declare(id);
          }
          value = { progress: runtime.status(), views: [] };
        } else throw Error("unknown_tool");
        const views = await withText(value, text);
        const { views: _v, ...rest } = value;
        return { views, rest };
      })();
    };
    const perSurface = async (text: boolean) =>
      runWorksets(
        ledger,
        async (ids, index) => {
          const runtime = new ManagedScreen(
            lab.port,
            ledger,
            lab.surfaces,
            ids,
            false,
            {
              source: (f) => saveSource(f, "workset"),
              delivery: (request, receipt) =>
                delivery("deliveries.jsonl")({
                  workset: index,
                  request,
                  receipt,
                  at: new Date().toISOString(),
                }),
              contract: free ? "free" : "item",
            },
          );
          const agent = await session(
            `sessions/${index}`,
            perSurfaceTools(text),
            lab.task +
              (free
                ? steps > 1
                  ? ` Declare each finished item with desktop_done, once per item (${steps} items per surface).`
                  : " Declare each finished surface with desktop_done."
                : " For intermediate items include checks in the next desktop_act; for the third item call desktop_verify. Use the literal observed receipt text/choice.") +
              " Coordinates are LOCAL to each selected Z panel. Use post-action images directly; only re-observe missing/pending targets.\nThis session owns ONLY " +
              ids.join(", ") +
              `. Complete actionable items in this workset. Skip deferred, blocked or unknown targets. End when workset.can_end is true. ${forward} Starting durable progress: ` +
              JSON.stringify(runtime.status()),
            (name, args) => {
              const handled = desk(runtime, ids, text, name, args);
              if (!handled) throw Error("unknown_tool");
              return handled;
            },
          );
          await context.run(-index - 1, () => runtime.drain());
          return agent;
        },
        {
          size: o.workset_size,
          attempts: 3,
          max_sessions: Math.ceil(o.count / o.workset_size) * 3 + 3,
          parallel: o.workset_parallel,
        },
      );
    const phases: Record<string, unknown> = {};
    try {
      await writeFile(join(directory, "tools.jsonl"), "");
      const t0 = performance.now();
      if (arm === "B-T" || arm === "B-V") {
        const vision = arm === "B-V";
        const stack = new StackScreen(lab.port, ledger, lab.surfaces, {
          concurrency: o.stack_concurrency,
          ...(lab.inputs ? { inputs: lab.inputs } : {}),
          ...(workload.settle_ms ? { settle_ms: workload.settle_ms } : {}),
          values: vision ? "vision" : "text",
          evidence: {
            source: saveSource,
            delivery: delivery("stack-deliveries.jsonl"),
          },
        });
        await session(
          "sessions/fleet",
          fleetTools(vision),
          fleetPrompt(lab.task, lab.surfaces.length, lab.surfaces, vision) +
            JSON.stringify(ledger.summary()),
          async (name, args) => {
            if (name === "fleet_observe") {
              const q = await stack.observe(fleetObserve.parse(args).surfaces);
              return {
                views: q.views,
                rest: { errors: q.errors, fleet: q.fleet },
              };
            }
            if (name === "fleet_run") {
              const { views, ...rest } = await stack.run(args);
              return { views, rest };
            }
            if (vision && name === "fleet_crops") {
              const { sheets, ...rest } = await stack.crops(args);
              return {
                views: sheets.map((s, i) => ({ ...s, sheet: i })),
                rest,
              };
            }
            if (vision && name === "fleet_confirm")
              return { views: [], rest: await stack.confirm(args) };
            throw Error("unknown_tool");
          },
        );
      } else if (arm === "F") {
        // The director: fleet policies for shared work, per-surface tools for
        // what differs, and one-image reviews of the whole fleet.
        const stack = new StackScreen(lab.port, ledger, lab.surfaces, {
          concurrency: o.stack_concurrency,
          contract: free ? "free" : "item",
          ...(lab.inputs ? { inputs: lab.inputs } : {}),
          ...(workload.settle_ms ? { settle_ms: workload.settle_ms } : {}),
          evidence: {
            source: saveSource,
            delivery: delivery("stack-deliveries.jsonl"),
          },
        });
        const runtime = new ManagedScreen(
          lab.port,
          ledger,
          lab.surfaces,
          lab.surfaces,
          false,
          {
            source: (f) => saveSource(f, "director"),
            delivery: (request, receipt) =>
              delivery("deliveries.jsonl")({
                director: true,
                request,
                receipt,
                at: new Date().toISOString(),
              }),
            contract: free ? "free" : "item",
          },
        );
        await session(
          "sessions/director",
          directorTools,
          directorPrompt(lab.task, lab.surfaces) +
            JSON.stringify(ledger.summary()),
          async (name, args) => {
            if (name === "fleet_observe") {
              const q = await stack.observe(fleetObserve.parse(args).surfaces);
              return {
                views: q.views,
                rest: { errors: q.errors, fleet: q.fleet },
              };
            }
            if (name === "fleet_run") {
              const { views, ...rest } = await stack.run(args);
              return { views, rest };
            }
            if (name === "fleet_overview") {
              const q = overviewSchema.parse(args);
              const ov = await stack.overview(q.surfaces, q.region);
              const meta = await sharp(ov.png).metadata();
              return {
                views: [
                  {
                    png: ov.png,
                    width: meta.width,
                    height: meta.height,
                    overview: ov.surfaces,
                  },
                ],
                rest: { fleet: ov.fleet },
              };
            }
            const handled = desk(runtime, lab.surfaces, false, name, args);
            if (!handled) throw Error("unknown_tool");
            return handled;
          },
        );
        await context.run(-1, () => runtime.drain());
      } else if (arm === "S") {
        const script = new ScriptScreen(lab.port, ledger, lab.surfaces, {
          contract: free ? "free" : "item",
          concurrency: o.stack_concurrency,
          delivery: delivery("script-deliveries.jsonl"),
        });
        await session(
          "sessions/script",
          scriptTools,
          scriptPrompt(lab.task, lab.surfaces.length, lab.surfaces) +
            JSON.stringify(ledger.summary()),
          async (name, args) => {
            if (name === "surface_read")
              return { views: [], rest: await script.read(args) };
            if (name === "surface_act")
              return { views: [], rest: await script.act(args) };
            if (!free && name === "surface_confirm")
              return { views: [], rest: await script.confirm(args) };
            if (free && name === "surface_done")
              return { views: [], rest: await script.done(args) };
            throw Error("unknown_tool");
          },
        );
      }
      phases.primary = {
        elapsed_ms: Math.round(performance.now() - t0),
        progress: ledger.summary(),
        tokens: usage.totalTokens,
      };
      // Leftovers (and the per-surface arms themselves) use per-surface worksets.
      const t1 = performance.now();
      await perSurface(arm === "P-T" || arm === "B-T" || arm === "S");
      phases.worksets = {
        elapsed_ms: Math.round(performance.now() - t1),
        progress: ledger.summary(),
      };
    } catch (e) {
      stopReason ??= String(e);
      await writeFile(
        join(directory, "run-error.json"),
        JSON.stringify({ error: String(e) }),
      );
    } finally {
      await trace;
      const elapsed_ms = Math.round(performance.now() - started);
      try {
        await writeFile(
          join(directory, "measurement.json"),
          JSON.stringify({
            elapsed_ms,
            usage,
            stop_reason: stopReason,
            at: new Date().toISOString(),
          }),
        );
        const scores = await lab.grade();
        await lab.collect?.(join(directory, "artifacts"));
        const row = {
          block: blk.block,
          arm,
          seed: blk.seed,
          elapsed_ms,
          successes: scores.filter((s: any) => s.success).length,
          wrong: scores.filter((s: any) => s.wrong).length,
          correct_items: scores.reduce(
            (n: number, s: any) => n + (s.correct_items ?? 0),
            0,
          ),
          commits: scores.reduce(
            (n: number, s: any) => n + (s.commits ?? 0),
            0,
          ),
          total: o.count,
          tokens: usage.totalTokens,
          usage,
          inferences:
            sessions.reduce((n, s) => n + (s.agent.inferences ?? 0), 0) || null,
          sessions: sessions.length,
          tool_calls: calls,
          images,
          pixels,
          progress: ledger.summary(),
          phases,
          stop_reason: stopReason,
        };
        await writeFile(
          join(directory, "result.json"),
          JSON.stringify(
            {
              ...row,
              workload: W,
              agent: o.agent,
              scores,
              sessions: sessions.map((s) => ({
                path: s.path,
                status: s.agent.status,
                stop: s.agent.stop_reason,
                usage: s.agent.usage,
                elapsed_ms: s.agent.elapsed_ms,
              })),
            },
            null,
            2,
          ),
          { flag: "wx" },
        );
        rows.push(row);
        await writeFile(
          join(o.output, "rows.json"),
          JSON.stringify(rows, null, 2),
        );
      } finally {
        await ledger.close();
        await lab.close();
        for (const s of sessions)
          if ("isolated_home" in s.agent)
            await unlink(join(s.agent.isolated_home, "auth.json")).catch(
              () => {},
            );
        await writeFile(
          join(directory, "cleanup.json"),
          JSON.stringify({ closed: true, at: new Date().toISOString() }),
        );
      }
    }
    const {
      usage: _u,
      progress: _p,
      phases: _ph,
      ...brief
    } = rows.at(-1) ?? {};
    console.log(JSON.stringify({ event: "finished", ...brief }));
  }
console.log(JSON.stringify({ event: "complete", output: o.output }));
