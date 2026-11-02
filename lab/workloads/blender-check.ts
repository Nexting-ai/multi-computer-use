/**
 * Model-free acceptance check for the Blender workload: four hand-written
 * fleet policies (the kind a model writes from one exemplar screenshot) run
 * over N desktops, then the saved files are graded independently.
 *
 *   node --import tsx lab/workloads/blender-check.ts <hosts.json> <count> <out-dir>
 *
 * hosts.json: the workload's `hosts` array ("local" or {destination, options}).
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProgressLedger } from "../../packages/virtual-screen/src/workset.js";
import { StackScreen } from "../../packages/virtual-screen/src/stack.js";
import { blender } from "./blender.js";

const [hostsPath, countArg, out = ".local/blender-check"] =
  process.argv.slice(2);
const hosts = JSON.parse(await readFile(hostsPath!, "utf8")).map((h: any) =>
  h === "local" ? { kind: "local" } : { kind: "ssh", ...h },
);
const count = Number(countArg ?? 4);
await mkdir(out, { recursive: true });

const workload = blender({ hosts, image: "mcu-blender" });
const t0 = performance.now();
const lab = await workload.open(out, count, 20261102);
const launched = performance.now();
const ledger = await ProgressLedger.open(join(out, "ledger"), lab.surfaces, 4);
const stack = new StackScreen(lab.port, ledger, lab.surfaces, {
  concurrency: count,
  inputs: lab.inputs!,
  settle_ms: workload.settle_ms!,
});

// Exemplar geometry (1600x1000, UI scale 1.25, window maximised).
const screen = { x: 0, y: 0, width: 1600, height: 1000 };
const viewport = { x: 0, y: 60, width: 1046, height: 840 };
const title = { x: 400, y: 0, width: 800, height: 24 };
// Value columns only: clicks land on the left of each field, off the
// read rectangles (the runtime refuses clicks inside value fields).
const dims = { x: 1195, y: 540, width: 79, height: 76 };
const location = { x: 1160, y: 194, width: 62, height: 50 };
const hex = { x: 1320, y: 700, width: 110, height: 30 };
// Location, scale and dimensions all change once an item is done.
const transform = { x: 1046, y: 190, width: 230, height: 430 };
const edit = (x: number, y: number, input: string) => [
  { kind: "click", x, y },
  { kind: "key_chord", keys: ["Ctrl", "a"] },
  { kind: "type_field", field: input },
  { kind: "key_chord", keys: ["Enter"] },
];
const items = [
  {
    name: "dimensions",
    fields: [
      { name: "dims", rect: dims },
      { name: "title", rect: title },
    ],
    ignore: [viewport],
    inputs: ["width", "depth", "height"],
    steps: [
      ...edit(1105, 552, "width"),
      ...edit(1105, 577, "depth"),
      ...edit(1105, 603, "height"),
    ],
    verify: { field: "dims", contains: ["{width}m", "{depth}m", "{height}m"] },
  },
  {
    name: "location",
    fields: [
      { name: "loc", rect: location },
      { name: "title", rect: title },
    ],
    ignore: [viewport, transform],
    inputs: ["x", "y"],
    steps: [...edit(1100, 206, "x"), ...edit(1100, 231, "y")],
    verify: { field: "loc", contains: ["{x}m", "{y}m"] },
  },
  {
    name: "colour",
    fields: [
      { name: "hex", rect: hex },
      { name: "title", rect: title },
    ],
    ignore: [viewport, transform],
    inputs: ["color"],
    steps: [
      { kind: "click", x: 1516, y: 830 },
      { kind: "click", x: 1505, y: 676 },
      ...edit(1480, 715, "color"),
    ],
    verify: { field: "hex", contains: ["{color}"] },
  },
  {
    name: "save",
    fields: [{ name: "title", rect: title }],
    // The colour picker may still be open over the properties.
    ignore: [viewport, transform, { x: 1300, y: 400, width: 300, height: 450 }],
    steps: [
      { kind: "click", x: 600, y: 960 },
      { kind: "key_chord", keys: ["Ctrl", "s"] },
    ],
    verify: { field: "title", contains: ["Blender[/work/scene.blend]"] },
  },
];

const timings: Record<string, number> = {};
for (const item of items) {
  const view = (await stack.observe([lab.surfaces[0]!])).views[0]!;
  const t = performance.now();
  const { name, ...policy } = item;
  const r = await stack.run({
    request_id: name,
    view_id: view.view_id,
    template: screen,
    items: 1,
    ...policy,
  } as never);
  timings[name] = Math.round(performance.now() - t);
  console.log(
    JSON.stringify({
      item: name,
      ms: timings[name],
      counts: r.counts,
      canary: r.canary,
    }),
  );
  if (r.exceptions?.length)
    console.log(JSON.stringify(r.exceptions.slice(0, 3)));
}
const scores = await lab.grade();
await lab.collect?.(join(out, "artifacts"));
await ledger.close();
await lab.close();
const summary = {
  count,
  launch_ms: Math.round(launched - t0),
  work_ms: Math.round(performance.now() - launched),
  timings,
  success: scores.filter((s) => s.success).length,
  correct_items: scores.reduce((n, s) => n + (s.correct_items ?? 0), 0),
  scores,
};
await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, scores: undefined }));
