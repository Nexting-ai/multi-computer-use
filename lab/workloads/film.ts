/**
 * The city block's film (presentation; identical for every arm): assemble
 * the saved work with the fixed surroundings, render the 10 s orbit with
 * Eevee split across hosts, and encode it.
 *
 *   node --import tsx lab/workloads/film.ts <city|modules> <run-artifacts-dir> <hosts.json> <out-dir>
 *
 * <run-artifacts-dir> holds Wnn/work.tar (from a run's artifacts).
 */
import { readFile, readdir, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { host } from "./host.js";

const run = promisify(execFile);
const [mode, src, hostsPath, out] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
const hosts = JSON.parse(await readFile(hostsPath, "utf8")).map(host);
await mkdir(join(out, "frames"), { recursive: true });
const work = "/root/film";
const blender = (args: string) =>
  `docker run --rm -e DISPLAY=:9 -v ${work}:/p -v ${work}/out:/out --entrypoint bash mcu-blender -c 'Xvfb :9 -screen 0 1280x720x24 +extension GLX >/dev/null 2>&1 & sleep 1; ${args}'`;

// 1. Assemble on the first host.
const first = hosts[0]!;
await first.sh(`rm -rf ${work} && mkdir -p ${work}/in ${work}/out/frames`);
for (const id of (await readdir(src)).filter((d) => /^W\d+$/.test(d)).sort()) {
  await first.sh(`mkdir -p ${work}/in/${id}`);
  await first.put(join(src, id, "work.tar"), `${work}/in/${id}/work.tar`);
  await first.sh(`tar -xf ${work}/in/${id}/work.tar -C ${work}/in/${id}`);
}
const input = mode === "city" ? "/p/in/W01/city.blend" : "/p/in";
await first.sh(
  blender(
    `blender -b --factory-startup --python /opt/app/assemble.py -- ${mode} ${input} /p/final.blend >/dev/null 2>&1; ls /p/final.blend`,
  ),
);
await first.get(`${work}/final.blend`, join(out, "final.blend"));

// 2. Render frame ranges on every host at once.
const frames = 240,
  per = Math.ceil(frames / hosts.length);
await Promise.all(
  hosts.map(async (h: ReturnType<typeof host>, i: number) => {
    const [s, e] = [i * per + 1, Math.min(frames, (i + 1) * per)];
    if (h !== first) {
      await h.sh(`rm -rf ${work} && mkdir -p ${work}/out/frames`);
      await h.put(join(out, "final.blend"), `${work}/final.blend`);
    }
    await h.sh(
      blender(
        `blender -b /p/final.blend -s ${s} -e ${e} -a >/dev/null 2>&1; true`,
      ),
    );
    await h.sh(`cd ${work}/out/frames && tar -cf ${work}/frames-${i}.tar .`);
    await h.get(`${work}/frames-${i}.tar`, join(out, `frames-${i}.tar`));
    await run("tar", [
      "-xf",
      join(out, `frames-${i}.tar`),
      "-C",
      join(out, "frames"),
    ]);
  }),
);

// 3. Encode.
await run("ffmpeg", [
  "-y",
  "-loglevel",
  "error",
  "-framerate",
  "24",
  "-i",
  join(out, "frames", "f_%04d.png"),
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-crf",
  "18",
  join(out, "city.mp4"),
]);
console.log("film", join(out, "city.mp4"));
