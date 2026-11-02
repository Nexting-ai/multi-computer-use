/**
 * Model-free acceptance run for a desktop workload: the oracle policies run
 * over N desktops, then the saved files are graded independently.
 *
 *   node --import tsx lab/workloads/check.ts <blender|kicad> <hosts.json> <count> <out-dir>
 *
 * hosts.json: the workload's `hosts` array ("local" or {destination, options}).
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProgressLedger } from "../../packages/virtual-screen/src/workset.js";
import { StackScreen } from "../../packages/virtual-screen/src/stack.js";
import { blender } from "./blender.js";
import { kicad } from "./kicad.js";
import { blenderOracle, kicadOracle } from "./oracles.js";

const [app, hostsPath, countArg, out = `.local/check-${app}`] =
  process.argv.slice(2);
const hosts = JSON.parse(await readFile(hostsPath!, "utf8")).map((h: any) =>
  h === "local" ? { kind: "local" } : { kind: "ssh", ...h },
);
const count = Number(countArg ?? 4);
await mkdir(out, { recursive: true });
const [workload, oracle] =
  app === "kicad"
    ? [kicad({ hosts, image: "mcu-kicad" }), kicadOracle]
    : [blender({ hosts, image: "mcu-blender" }), blenderOracle];

const t0 = performance.now();
const lab = await workload.open(out, count, 20261102);
const launched = performance.now();
const ledger = await ProgressLedger.open(
  join(out, "ledger"),
  lab.surfaces,
  workload.items,
);
const stack = new StackScreen(lab.port, ledger, lab.surfaces, {
  concurrency: count,
  inputs: lab.inputs!,
  ...(workload.settle_ms ? { settle_ms: workload.settle_ms } : {}),
});
const timings: Record<string, number> = {};
for (const { name, ...policy } of oracle) {
  const view = (await stack.observe([lab.surfaces[0]!])).views[0]!;
  const t = performance.now();
  const r = await stack.run({
    request_id: name,
    view_id: view.view_id,
    template: { x: 0, y: 0, width: 1600, height: 1000 },
    items: 1,
    ...policy,
  } as never);
  timings[name] = Math.round(performance.now() - t);
  console.log(
    JSON.stringify({ item: name, ms: timings[name], counts: r.counts }),
  );
  if (r.exceptions?.length)
    console.log(JSON.stringify(r.exceptions.slice(0, 3)));
  for (const v of r.views ?? [])
    await writeFile(join(out, `${name}-${v.surface_id}.png`), v.png);
}
const scores = await lab.grade();
await lab.collect?.(join(out, "artifacts"));
await ledger.close();
await lab.close();
const summary = {
  app,
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
