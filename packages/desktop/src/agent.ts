/**
 * Desktop agent: runs inside one desktop container and is the only process
 * that touches its X display. It captures frames, reads text by OCR from
 * exactly those frames, and injects input only after proving the screen still
 * shows the frame the decision was made on.
 *
 *   GET  /frame    -> { epoch, revision, width, height, png }   (base64 PNG)
 *   POST /text     { revision } -> { nodes }   OCR of that captured frame
 *   GET  /probe    -> { nodes }                OCR of a fresh, unbound frame
 *   POST /execute  { revision, actions, operation_id } -> Delivery
 *
 * Executes are idempotent per operation_id: a repeated id returns the first
 * outcome and never re-injects input.
 */
import { createServer, type IncomingMessage } from "node:http";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { promisify } from "node:util";
import sharp from "sharp";
import type { Action, Delivery, Rect, TextNode } from "@cu/virtual-screen";
import { nodes, type OcrLine } from "./ocr.js";
import { xdotool } from "./keys.js";

const run = promisify(execFile);
const DISPLAY = process.env.DISPLAY ?? ":0";
const [W, H] = (process.env.SCREEN ?? "1280x800").split("x").map(Number) as [
  number,
  number,
];
const PORT = Number(process.env.AGENT_PORT ?? 7000);
const JOURNAL = process.env.JOURNAL ?? "/work/input-journal.jsonl";
/** Pixels allowed to differ between the decision frame and the screen at input
 * time (a blinking caret), as a fraction of the screen. */
/** After each input event, wait for the screen to settle (see quiet). */
const QUIET_MIN_MS = Number(process.env.QUIET_MIN_MS ?? 250);
const QUIET_POLL_MS = Number(process.env.QUIET_POLL_MS ?? 120);
const QUIET_STILL = Number(process.env.QUIET_STILL ?? 3);
const QUIET_MAX_MS = Number(process.env.QUIET_MAX_MS ?? 4000);
const SAME_SCREEN = Number(process.env.SAME_SCREEN ?? 0.0001);
const epoch = randomUUID();
const env = { ...process.env, DISPLAY };

type Shot = { revision: string; raw: Buffer; png: Buffer; text?: TextNode[] };
const shots = new Map<string, Shot>();
const outcomes = new Map<string, Delivery>();
let queue: Promise<unknown> = Promise.resolve();
/** One display, one actor: captures and inputs are serialized. */
const serial = <T>(f: () => Promise<T>) => {
  const p = queue.then(f, f);
  queue = p.catch(() => undefined);
  return p;
};

async function grab(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn("import", ["-window", "root", "-depth", "8", "rgb:-"], {
      env,
    });
    const chunks: Buffer[] = [];
    p.stdout.on("data", (c: Buffer) => chunks.push(c));
    p.on("error", reject);
    p.on("close", (code) => {
      const raw = Buffer.concat(chunks);
      code === 0 && raw.length === W * H * 3
        ? resolve(raw)
        : reject(Error(`capture_failed:${code}:${raw.length}`));
    });
  });
}
async function capture(): Promise<Shot> {
  const raw = await grab();
  const revision = createHash("sha256").update(raw).digest("hex");
  const known = shots.get(revision);
  if (known) return known;
  const png = await sharp(raw, { raw: { width: W, height: H, channels: 3 } })
    .png()
    .toBuffer();
  const shot = { revision, raw, png };
  shots.set(revision, shot);
  while (shots.size > 8) shots.delete(shots.keys().next().value!);
  return shot;
}
/** Fraction of pixels that differ visibly between two raw frames. */
function changed(a: Buffer, b: Buffer) {
  let n = 0;
  for (let i = 0; i < a.length; i += 3)
    if (
      Math.abs(a[i]! - b[i]!) > 24 ||
      Math.abs(a[i + 1]! - b[i + 1]!) > 24 ||
      Math.abs(a[i + 2]! - b[i + 2]!) > 24
    )
      n++;
  return n / (a.length / 3);
}
/** One OCR worker per desktop, fed one PNG at a time (see ocr_server.py). */
const worker = spawn("/opt/ocr/bin/python", [
  new URL("../ocr_server.py", import.meta.url).pathname,
]);
let pending = "";
const waiting: ((line: string) => void)[] = [];
worker.stdout.on("data", (c: Buffer) => {
  pending += c;
  for (let n; (n = pending.indexOf("\n")) >= 0;) {
    const line = pending.slice(0, n);
    pending = pending.slice(n + 1);
    waiting.shift()?.(line);
  }
});
let ocrQueue: Promise<unknown> = Promise.resolve();
function recognise(png: Buffer): Promise<OcrLine[]> {
  const p = ocrQueue.then(
    () =>
      new Promise<OcrLine[]>((resolve) => {
        waiting.push((line) => resolve(JSON.parse(line)));
        const head = Buffer.alloc(4);
        head.writeUInt32BE(png.length);
        worker.stdin.write(Buffer.concat([head, png]));
      }),
  );
  ocrQueue = p.catch(() => undefined);
  return p;
}
/** OCR of one region (with a margin), in frame pixels. */
async function ocrRegion(shot: Shot, r: Rect): Promise<TextNode[]> {
  const pad = 12;
  const left = Math.max(0, Math.floor(r.x - pad)),
    top = Math.max(0, Math.floor(r.y - pad));
  const width = Math.min(W - left, Math.ceil(r.width + 2 * pad)),
    height = Math.min(H - top, Math.ceil(r.height + 2 * pad));
  if (width < 8 || height < 8) return [];
  const png = await sharp(shot.png)
    .extract({ left, top, width, height })
    .png()
    .toBuffer();
  return nodes(await recognise(png)).map((n) => ({
    ...n,
    rect: { ...n.rect, x: n.rect.x + left, y: n.rect.y + top },
  }));
}
async function ocr(shot: Shot): Promise<TextNode[]> {
  shot.text ??= nodes(await recognise(shot.png));
  return shot.text;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Waits until the application has consumed the last input, as a person waits
 * for the UI to respond: at least QUIET_MIN_MS, then until QUIET_STILL
 * consecutive captures are unchanged, at most QUIET_MAX_MS.
 */
async function quiet() {
  const end = Date.now() + QUIET_MAX_MS;
  await sleep(QUIET_MIN_MS);
  let last = await grab(),
    still = 0;
  while (Date.now() < end && still < QUIET_STILL) {
    await sleep(QUIET_POLL_MS);
    const now = await grab();
    still = changed(last, now) <= SAME_SCREEN ? still + 1 : 0;
    last = now;
  }
}
/** Long or multi-line text is pasted, as a person would paste a script:
 * typing it key by key is slow and editors re-indent typed newlines. */
const PASTE_FROM = 120;
async function paste(text: string) {
  await new Promise<void>((resolve, reject) => {
    // xclip keeps a child serving the selection: wait for the parent's exit,
    // not for its output streams.
    const p = spawn("xclip", ["-selection", "clipboard"], {
      env,
      stdio: ["pipe", "ignore", "ignore"],
    });
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(Error("clipboard_failed")),
    );
    p.stdin.end(text);
  });
  await run("xdotool", ["key", "--clearmodifiers", "ctrl+v"], { env });
}
async function inject(actions: Action[]) {
  for (const a of actions) {
    if (
      a.kind === "type_text" &&
      (a.text.includes("\n") || a.text.length >= PASTE_FROM)
    ) {
      await paste(a.text);
      await quiet();
      continue;
    }
    // A click hovers first and waits for the hover to be drawn.
    for (const [i, args] of xdotool(a).entries()) {
      if (i) await quiet();
      await run("xdotool", args, { env });
    }
    await quiet();
  }
}
async function execute(body: {
  revision: string;
  actions: Action[];
  operation_id: string;
}): Promise<Delivery> {
  const prior = outcomes.get(body.operation_id);
  if (prior) return prior;
  const decided = shots.get(body.revision);
  if (!decided) return { status: "blocked", reason: "frame_expired" };
  const now = await grab().catch(() => null);
  if (!now) return { status: "blocked", reason: "capture_failed_before_input" };
  if (changed(decided.raw, now) > SAME_SCREEN)
    return { status: "blocked", reason: "source_changed_before_input" };
  // Intent is durable before the first input event.
  await appendFile(
    JOURNAL,
    JSON.stringify({
      kind: "intent",
      operation_id: body.operation_id,
      revision: body.revision,
      actions: body.actions,
      at: new Date().toISOString(),
    }) + "\n",
  );
  let outcome: Delivery;
  try {
    await inject(body.actions);
    outcome = { status: "delivered" };
  } catch (e) {
    // Some events may have been injected: the effect is uncertain.
    outcome = { status: "unknown", reason: String(e).slice(0, 120) };
  }
  outcomes.set(body.operation_id, outcome);
  await appendFile(
    JOURNAL,
    JSON.stringify({
      kind: "outcome",
      operation_id: body.operation_id,
      ...outcome,
    }) + "\n",
  );
  return outcome;
}

/** The desktop is ready once the application has painted its window (below
 * the title bar the screen is not one flat colour) and the picture has held
 * still for a second. */
let ready = false;
async function warmUp(limitMs = 180_000) {
  const end = Date.now() + limitMs;
  let last: Buffer | null = null,
    still = 0;
  while (Date.now() < end) {
    const now = await grab().catch(() => null);
    if (
      now &&
      !flat(now.subarray(W * 3 * 32)) &&
      last &&
      changed(last, now) <= SAME_SCREEN
    ) {
      if (++still >= 4) break;
    } else still = 0;
    last = now;
    await sleep(250);
  }
  ready = true;
}
/** One colour covers almost all of the picture (nothing painted yet). */
function flat(raw: Buffer) {
  const counts = new Map<number, number>();
  let samples = 0;
  for (let i = 0; i + 2 < raw.length; i += 3 * 97, samples++) {
    const c = (raw[i]! << 16) | (raw[i + 1]! << 8) | raw[i + 2]!;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return Math.max(...counts.values()) > samples * 0.9;
}
void warmUp();

async function json(req: IncomingMessage) {
  let s = "";
  for await (const c of req) s += c;
  return JSON.parse(s || "{}");
}
createServer(async (req, res) => {
  const reply = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (!ready) return reply(503, { error: "desktop_warming_up" });
    if (req.method === "GET" && req.url === "/frame") {
      const s = await serial(capture);
      return reply(200, {
        epoch,
        revision: s.revision,
        width: W,
        height: H,
        png: s.png.toString("base64"),
      });
    }
    if (req.method === "POST" && req.url === "/text") {
      const { revision } = await json(req);
      const s = shots.get(revision);
      if (!s) return reply(410, { error: "frame_expired" });
      return reply(200, { nodes: await ocr(s) });
    }
    if (req.method === "POST" && req.url === "/probe") {
      const { region } = await json(req);
      const shot = await serial(capture);
      return reply(200, {
        nodes: region ? await ocrRegion(shot, region) : await ocr(shot),
      });
    }
    if (req.method === "POST" && req.url === "/execute") {
      const body = await json(req);
      return reply(200, await serial(() => execute(body)));
    }
    reply(404, { error: "not_found" });
  } catch (e) {
    reply(500, { error: String(e).slice(0, 200) });
  }
}).listen(PORT, "0.0.0.0");
