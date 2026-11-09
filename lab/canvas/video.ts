/**
 * Renders a replay (one or more canvas logs side by side) to an mp4.
 *
 *   node --import tsx lab/canvas/video.ts <out.mp4> <speed> <log.jsonl>...
 *
 * Needs the replay server (lab/canvas/server.ts, port CANVAS_PORT or 7800).
 * The replay is stepped deterministically: for each output frame the replay
 * clock is set, then the page is captured; 30 fps.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cdp } from "../../packages/virtual-screen/src/cdp.js";

const [outArg, speedArg, ...logs] = process.argv.slice(2);
if (!outArg || !speedArg || !logs.length)
  throw Error("usage: video.ts <out.mp4> <speed> <log.jsonl>...");
const speed = Number(speedArg);
const port = Number(process.env.CANVAS_PORT ?? 7800);
const fps = 30;
const width = logs.length >= 3 ? 1680 : 1500,
  height = logs.length >= 3 ? 560 : 720;

const dir = await mkdtemp(join(tmpdir(), "canvas-video-"));
const chrome = spawn(
  process.env.CU_CHROME ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  [
    "--headless=new",
    `--user-data-dir=${join(dir, "profile")}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--hide-scrollbars",
    `--window-size=${width},${height}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
let lines: string[] = [];
for (let k = 0; k < 100 && !lines[1]; k++) {
  lines = await readFile(join(dir, "profile", "DevToolsActivePort"), "utf8")
    .then((t) => t.trim().split("\n"))
    .catch(() => []);
  if (!lines[1]) await new Promise((r) => setTimeout(r, 100));
}
const browser = await Cdp.connect(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
const { targetId } = await browser.call("Target.createTarget", {
  url: "about:blank",
});
const page = await Cdp.connect(
  `ws://127.0.0.1:${lines[0]}/devtools/page/${targetId}`,
);
await page.call("Page.enable");
await page.call("Emulation.setDeviceMetricsOverride", {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: false,
});
const url = `http://127.0.0.1:${port}/replay?${logs.map((l) => `log=${encodeURIComponent(resolve(l))}`).join("&")}&speed=0`;
await page.call("Page.navigate", { url });
const ev = async (e: string) =>
  (
    await page.call("Runtime.evaluate", {
      expression: e,
      returnByValue: true,
      awaitPromise: true,
    })
  ).result?.value;
for (let k = 0; k < 100 && !(await ev("!!window.__replay")); k++)
  await new Promise((r) => setTimeout(r, 100));
await ev("window.__replay.pause()");
const total = (await ev("window.__replay.total")) as number;
// Step the replay clock by speed/fps per frame; a short hold at the end.
const frames = Math.ceil(total / speed / (1000 / fps)) + fps * 3;
for (let f = 0; f < frames; f++) {
  const t = Math.min(total, (f * 1000 * speed) / fps);
  await ev(`(()=>{const r=window.__replay;r.setSpeed(0);r.advance(${t});})()`);
  // Let the cursor glide animate a few frames' worth.
  await new Promise((r) => setTimeout(r, 16));
  const s = await page.call("Page.captureScreenshot", {
    format: "jpeg",
    quality: 88,
  });
  await writeFile(
    join(dir, `f${String(f).padStart(6, "0")}.jpg`),
    Buffer.from(s.data, "base64"),
  );
}
page.close();
browser.close();
chrome.kill("SIGTERM");
execFileSync("ffmpeg", [
  "-y",
  "-loglevel",
  "error",
  "-framerate",
  String(fps),
  "-i",
  join(dir, "f%06d.jpg"),
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-crf",
  "20",
  resolve(outArg),
]);
await rm(dir, { recursive: true, force: true });
console.log(
  `wrote ${outArg} (${frames} frames, ${(frames / fps).toFixed(1)} s)`,
);
process.exit(0);
