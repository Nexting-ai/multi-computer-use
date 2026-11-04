/**
 * Blind quality judging for the studio task.
 *
 *   node --import tsx lab/workloads/judge.ts <out-dir> <hosts.json> <seed> <arm>=<studio|city>:<artifacts-dir> ...
 *
 * 1. Standard photos: every arm's building on plot n is rendered with the same
 *    camera, light and engine (module_shot.py), never the agents' own renders.
 * 2. Per plot, the arms' photos are shuffled under the letters X, Y, Z... and a
 *    different model (Claude, via the operator's launcher) scores each against
 *    the brief. The letter-to-arm map is kept out of the judge's reach.
 * 3. Scores are mapped back to arms and averaged.
 */
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  readdir,
  stat,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomInt } from "node:crypto";
import { host } from "./host.js";
import { claude, resultText } from "./claude.js";
import { PLANS, plotCentre } from "./studio.js";

const [outArg, hostsPath, seedArg, ...specs] = process.argv.slice(2) as [
  string,
  string,
  string,
  ...string[],
];
const out = resolve(outArg);
const arms = specs.map((s) => {
  const [arm, rest] = s.split("=") as [string, string];
  const [mode, dir] = rest.split(":") as ["studio" | "city", string];
  return { arm, mode, dir };
});
// JUDGE_PLAN: block (default, sixteen buildings) or street (thirty-two houses).
const plan =
  PLANS[(process.env.JUDGE_PLAN as "block" | "street" | "airport") ?? "block"];
const noun = plan.noun ?? "building";
// JUDGE_LIMIT judges only the first plots (pipeline checks).
const briefs = new Map(
  [...plan.briefs(Number(seedArg), plan.cols * plan.rows)].slice(
    0,
    Number(process.env.JUDGE_LIMIT ?? 16),
  ),
);
const h = host(JSON.parse(await readFile(hostsPath, "utf8"))[0]);
const centre = (n: number) => {
  const c = plotCentre(n, plan.cols, plan.rows);
  return [c.x, c.y];
};

// JUDGE_ONLY=W01,W07 re-judges those plots and keeps every other result.
const only = process.env.JUDGE_ONLY?.split(",");

// 1. Standard photos (only those missing, so a rerun fills gaps).
for (const a of arms) {
  const shots = join(out, "shots", a.arm);
  await mkdir(shots, { recursive: true });
  const missing = [];
  for (const id of briefs.keys())
    if (
      (!only || only.includes(id)) &&
      !((await stat(join(shots, `${id}.png`)).catch(() => null))?.size ?? 0)
    )
      missing.push(id);
  if (!missing.length) continue;
  const work = `/root/judge-${a.arm}`;
  await h.sh(`rm -rf ${work} && mkdir -p ${work}/out`);
  // The repository's module_shot.py, not the copy baked into the image.
  await h.put(
    fileURLToPath(
      new URL(
        "../../packages/desktop/apps/blender/module_shot.py",
        import.meta.url,
      ),
    ),
    `${work}/module_shot.py`,
  );
  // A piece without a saved file (never declared) gets no photo: it is
  // judged on an empty image and scores 1.
  const sources = [];
  for (const id of a.mode === "city" ? ["W01"] : missing)
    if (await stat(join(a.dir, id, "work.tar")).catch(() => null))
      sources.push(id);
  for (const id of sources) {
    await h.sh(`mkdir -p ${work}/${id}`);
    await h.put(join(a.dir, id, "work.tar"), `${work}/${id}/work.tar`);
    await h.sh(`tar -xf ${work}/${id}/work.tar -C ${work}/${id}`);
  }
  const jobs = missing.map((id) => {
    const n = Number(id.slice(1));
    const [x, y] = a.mode === "city" ? centre(n) : [0, 0];
    const [file, col] =
      a.mode === "city"
        ? [`/p/W01/${plan.scene}.blend`, `P${id.slice(1)}`]
        : [`/p/${id}/studio.blend`, "Module"];
    return `[ -f ${file} ] && blender -b ${file} --python /p/module_shot.py -- ${col} ${x} ${y} /p/out/${id}.png >/dev/null 2>&1`;
  });
  await h.sh(
    `docker run --rm -e DISPLAY=:9 -v ${work}:/p --entrypoint bash mcu-blender -c 'Xvfb :9 -screen 0 960x720x24 +extension GLX >/dev/null 2>&1 & for i in $(seq 50); do xdpyinfo -display :9 >/dev/null 2>&1 && break; sleep 0.2; done; ${jobs.join("; ")}; true'`,
  );
  for (const id of missing)
    await h
      .get(`${work}/out/${id}.png`, join(shots, `${id}.png`))
      .catch(() => {});
}

// Every photo must have the same size, or the comparison is not blind to the
// arm (a smaller photo shows less detail).
const sizes = new Set<string>();
for (const a of arms)
  for (const id of briefs.keys()) {
    const f = join(out, "shots", a.arm, `${id}.png`);
    if ((await stat(f).catch(() => null))?.size)
      sizes.add(
        execFileSync("magick", ["identify", "-format", "%wx%h", f]).toString(),
      );
  }
if (sizes.size > 1) throw Error(`judge_unequal_photos:${[...sizes].join(",")}`);

// 2. Blind comparative scoring, one plot at a time.
const RUBRIC = `Score each ${noun} photo from 1 (poor) to 10 (excellent) on:
- brief: matches the brief (type, listed features, colours, target height relative to the 20 m plot);
- craft: detail and construction quality (distinct parts, openings, believable proportions);
- materials: fitting, varied materials and colours;
- soundness: nothing floating, clipping or broken; stays on its plot.
Judge only what is visible. A missing or empty photo scores 1 on everything.
Answer with JSON only: {"X": {"brief": n, "craft": n, "materials": n, "soundness": n}, ...} for every letter given.`;

const previous: any[] = only
  ? JSON.parse(await readFile(join(out, "judge-raw.json"), "utf8"))
  : [];
const results: any[] = previous.filter((r) => !only?.includes(r.id));
for (const [id, b] of briefs) {
  if (only && !only.includes(id)) continue;
  const dir = join(out, "blind", id);
  await mkdir(dir, { recursive: true });
  const order = arms.map((a) => a.arm);
  for (let i = order.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const letters = order.map((_, i) => String.fromCharCode(88 + i)); // X, Y, Z, ...
  for (const [i, arm] of order.entries())
    await copyFile(
      join(out, "shots", arm, `${id}.png`),
      join(dir, `${letters[i]}.png`),
    ).catch(async () => writeFile(join(dir, `${letters[i]}.png`), ""));
  const prompt = `Brief for this plot: a ${b.style}, about ${b.height} m tall: ${b.brief}.\nRead the photos ${letters.map((l) => `${l}.png`).join(", ")} in this directory (each shows one candidate ${noun} on the same 20 x 20 m plot).\n${RUBRIC}`;
  const text = resultText(await claude(dir, prompt));
  const scores = JSON.parse(
    text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
  );
  results.push({
    id,
    brief: b,
    scores: Object.fromEntries(letters.map((l, i) => [order[i], scores[l]])),
  });
  await writeFile(
    join(out, "judge-raw.json"),
    JSON.stringify(results, null, 2),
  );
}

// 3. Means per arm.
const summary: Record<string, Record<string, number>> = {};
for (const a of arms) {
  const rows = results.map((r) => r.scores[a.arm]).filter(Boolean);
  const keys = ["brief", "craft", "materials", "soundness"];
  summary[a.arm] = Object.fromEntries(
    keys.map((k) => [
      k,
      +(rows.reduce((s, r) => s + Number(r[k] ?? 1), 0) / rows.length).toFixed(
        2,
      ),
    ]),
  );
  summary[a.arm]!.overall = +(
    keys.reduce((s, k) => s + summary[a.arm]![k]!, 0) / keys.length
  ).toFixed(2);
}
await writeFile(
  join(out, "judge.json"),
  JSON.stringify({ summary, results }, null, 2),
);
console.log(JSON.stringify(summary));
