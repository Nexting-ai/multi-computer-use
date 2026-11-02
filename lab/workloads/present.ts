/**
 * Presentation assets from a check or benchmark run (not part of grading):
 * a wall of every desktop's final screen, and the application's own render
 * of the saved work (Blender: the assembled city; KiCad: each badge).
 *
 *   node --import tsx lab/workloads/present.ts <blender|kicad> <run-dir> <hosts.json>
 *
 * <run-dir> holds final/Wxx.png and artifacts/Wxx/work.tar (see check.ts).
 */
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import sharp from "sharp";

const run = promisify(execFile);
const [app, dir, hostsPath] = process.argv.slice(2) as [string, string, string];

/** A grid of equally sized tiles, labelled by surface. */
async function grid(
  files: string[],
  tileW: number,
  tileH: number,
  out: string,
) {
  const cols = Math.ceil(Math.sqrt(files.length)),
    rows = Math.ceil(files.length / cols),
    gap = 6;
  const tiles = await Promise.all(
    files.map(async (f, i) => ({
      input: await sharp(f)
        .resize(tileW, tileH, { fit: "contain", background: "#111" })
        .toBuffer(),
      left: (i % cols) * (tileW + gap),
      top: Math.floor(i / cols) * (tileH + gap),
    })),
  );
  await sharp({
    create: {
      width: cols * (tileW + gap) - gap,
      height: rows * (tileH + gap) - gap,
      channels: 3,
      background: "#111",
    },
  })
    .composite(tiles)
    .png()
    .toFile(out);
}

const ids = (await readdir(join(dir, "final")))
  .filter((f) => f.endsWith(".png"))
  .sort();
await grid(
  ids.map((f) => join(dir, "final", f)),
  400,
  250,
  join(dir, "wall.png"),
);

// Render on the first host: upload the saved work, run the app headless.
const host = JSON.parse(await readFile(hostsPath!, "utf8"))[0];
/** SSH through a flaky proxy: retry only when the connection never opened. */
async function retry<T>(f: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++)
    try {
      return await f();
    } catch (e: any) {
      if (
        attempt >= 5 ||
        !/Connection (closed|reset)|kex_exchange/.test(String(e.stderr))
      )
        throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
}
const ssh = (cmd: string) =>
  retry(() =>
    run("ssh", [...host.options, host.destination, cmd], {
      maxBuffer: 1 << 28,
    }),
  );
const scp = (from: string, to: string) =>
  retry(() =>
    run("scp", ["-q", ...host.options, from, to], { maxBuffer: 1 << 28 }),
  );
const remote = `/root/present-${app}`;
await ssh(`rm -rf ${remote} && mkdir -p ${remote}/in ${remote}/out`);
for (const f of ids) {
  const id = f.replace(".png", "");
  await ssh(`mkdir -p ${remote}/in/${id}`);
  await scp(
    join(dir, "artifacts", id, "work.tar"),
    `${host.destination}:${remote}/in/${id}/work.tar`,
  );
  await ssh(`tar -xf ${remote}/in/${id}/work.tar -C ${remote}/in/${id}`);
}
await mkdir(join(dir, "render"), { recursive: true });
if (app === "blender") {
  await ssh(
    `docker run --rm -v ${remote}:/p --entrypoint blender mcu-blender -b --factory-startup --python /opt/app/city.py -- /p/in /p/out/city.png >/dev/null 2>&1; ls ${remote}/out`,
  );
  await scp(
    `${host.destination}:${remote}/out/city.png`,
    join(dir, "city.png"),
  );
} else {
  await ssh(
    `docker run --rm -v ${remote}:/p --entrypoint bash mcu-kicad -c 'Xvfb :9 >/dev/null 2>&1 & sleep 1; for d in /p/in/*/; do id=$(basename $d); DISPLAY=:9 kicad-cli pcb render --side top --quality high --background opaque -w 900 -h 500 -o /p/out/$id.png $d/badge.kicad_pcb >/dev/null 2>&1; done'`,
  );
  for (const f of ids)
    await scp(`${host.destination}:${remote}/out/${f}`, join(dir, "render", f));
  await grid(
    ids.map((f) => join(dir, "render", f)),
    450,
    250,
    join(dir, "badges.png"),
  );
}
console.log("done", dir);
