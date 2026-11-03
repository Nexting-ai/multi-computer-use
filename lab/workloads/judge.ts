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
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { randomInt } from "node:crypto";
import { host } from "./host.js";
import { block } from "./studio.js";

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
// JUDGE_LIMIT judges only the first plots (pipeline checks).
const briefs = new Map(
  [...block(Number(seedArg), 16)].slice(
    0,
    Number(process.env.JUDGE_LIMIT ?? 16),
  ),
);
const h = host(JSON.parse(await readFile(hostsPath, "utf8"))[0]);
const centre = (n: number) => [
  (((n - 1) % 4) - 1.5) * 30,
  (1.5 - Math.floor((n - 1) / 4)) * 30,
];

// 1. Standard photos.
for (const a of arms) {
  const shots = join(out, "shots", a.arm);
  await mkdir(shots, { recursive: true });
  const work = `/root/judge-${a.arm}`;
  await h.sh(`rm -rf ${work} && mkdir -p ${work}/out`);
  for (const id of (await readdir(a.dir)).filter((d) => /^W\d+$/.test(d))) {
    await h.sh(`mkdir -p ${work}/${id}`);
    await h.put(join(a.dir, id, "work.tar"), `${work}/${id}/work.tar`);
    await h.sh(`tar -xf ${work}/${id}/work.tar -C ${work}/${id}`);
  }
  const jobs = [...briefs.keys()].map((id) => {
    const n = Number(id.slice(1));
    const [x, y] = a.mode === "city" ? centre(n) : [0, 0];
    const [file, col] =
      a.mode === "city"
        ? ["/p/W01/city.blend", `P${id.slice(1)}`]
        : [`/p/${id}/studio.blend`, "Module"];
    return `[ -f ${file} ] && blender -b ${file} --python /opt/app/module_shot.py -- ${col} ${x} ${y} /p/out/${id}.png >/dev/null 2>&1`;
  });
  await h.sh(
    `docker run --rm -e DISPLAY=:9 -v ${work}:/p --entrypoint bash mcu-blender -c 'Xvfb :9 -screen 0 960x720x24 +extension GLX >/dev/null 2>&1 & sleep 1; ${jobs.join("; ")}; true'`,
  );
  for (const id of briefs.keys())
    await h
      .get(`${work}/out/${id}.png`, join(shots, `${id}.png`))
      .catch(() => {});
}

// 2. Blind comparative scoring, one plot at a time.
const RUBRIC = `Score each building photo from 1 (poor) to 10 (excellent) on:
- brief: matches the brief (type, listed features, colours, target height relative to the 20 m plot);
- craft: detail and construction quality (distinct parts, openings, believable proportions);
- materials: fitting, varied materials and colours;
- soundness: nothing floating, clipping or broken; stays on its plot.
Judge only what is visible. A missing or empty photo scores 1 on everything.
Answer with JSON only: {"X": {"brief": n, "craft": n, "materials": n, "soundness": n}, ...} for every letter given.`;

function claude(cwd: string, prompt: string): Promise<string> {
  return new Promise((resolveOut, reject) => {
    const args = [
      "-p",
      prompt,
      "--tools",
      "Read",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--setting-sources",
      "project",
      "--disable-slash-commands",
      "--model",
      "sonnet",
    ];
    // The operator's launcher applies the required Anthropic egress.
    const p = spawn("zsh", ["-ic", 'claude "$@"', "zsh", ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) => !/proxy/i.test(k) && k !== "NODE_USE_ENV_PROXY",
        ),
      ),
    });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolveOut(stdout) : reject(Error(`claude ${code}`)),
    );
  });
}

const results: any[] = [];
for (const [id, b] of briefs) {
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
  const prompt = `Brief for this plot: a ${b.style}, about ${b.height} m tall: ${b.brief}.\nRead the photos ${letters.map((l) => `${l}.png`).join(", ")} in this directory (each shows one candidate building on the same 20 x 20 m plot).\n${RUBRIC}`;
  const raw = await claude(dir, prompt);
  // The launcher may print status lines before claude's JSON result.
  const line = raw
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("{") && l.includes('"result"'));
  if (!line) throw Error("judge_no_result:" + raw.slice(0, 200));
  const text = JSON.parse(line).result as string;
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
