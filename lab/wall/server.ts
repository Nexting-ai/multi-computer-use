/**
 * Live wall: every surface of a running experiment as a grid of tiles, with a
 * cursor per surface coloured by the agent acting on it.
 *
 *   node --import tsx lab/wall/server.ts <out> [--port 7700] [--record]
 *
 * Watches `<out>/<block>-<arm>/environment/wall.json` (written by the tunable
 * lab), streams screencast frames over a separate, passive CDP connection per
 * page (never input, never navigation), tails the input journal for cursor
 * positions and `tools.jsonl` for which agent owns which window, and serves
 * one page plus a Server-Sent-Events stream. `--record` also writes
 * `<armdir>/wall-recording/` so `/?replay=<out>&speed=4` can replay it.
 */
import { createServer, type ServerResponse } from "node:http";
import {
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Cdp } from "../../packages/virtual-screen/src/cdp.js";

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
let outDir: string | null = null;
let port = 7700;
let record = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--port") port = Number(argv[++i]);
  else if (a === "--record") record = true;
  else if (!a.startsWith("--")) outDir = resolve(a);
  else throw Error(`unknown option ${a}`);
}
if (!Number.isInteger(port) || port <= 0) throw Error("bad --port");

// ---------------------------------------------------------------- types

type Wall = {
  devtools: string;
  view: { width: number; height: number };
  journal: string;
  submissions: string;
  surfaces: { id: string; target_id: string; company: string }[];
};
type Actor = { id: string; label: string; color: string };
type Event = { type: string; panel: string; t: number } & Record<
  string,
  unknown
>;

// ---------------------------------------------------------------- actors

const DIRECTOR = "#3fd2ff";
const HELPERS = [
  "#ff5c8a",
  "#ff7a45",
  "#b67dff",
  "#4dff9a",
  "#ff6bd6",
  "#7c8dff",
  "#ff4f4f",
  "#3dffd8",
];
/** Distinct hues for per-window agents, skipping the yellow band. */
function agentColor(n: number) {
  let h = (200 + n * 137.508) % 360;
  if (h >= 38 && h < 80) h = (h + 45) % 360;
  const l = n % 2 ? 66 : 60;
  return `hsl(${h.toFixed(0)} 88% ${l}%)`;
}

function armTitle(arm: string, n: number) {
  switch (arm) {
    case "F":
      return {
        title: `一个 Agent · ${n} 个光标`,
        subtitle: "同一个 Agent 同时驱动全部窗口",
      };
    case "P-T":
      return {
        title: "每个窗口一个 Agent",
        subtitle: `${n} 个 Agent · ${n} 个光标，各自为战`,
      };
    case "S":
      return {
        title: "AI 写脚本",
        subtitle: "Agent 写一个脚本，由脚本驱动全部窗口",
      };
    case "D":
      return {
        title: "指挥 Agent + 自动分流",
        subtitle: "指挥同步驱动多数窗口，难点窗口交给助手",
      };
    default:
      return { title: arm, subtitle: `${n} 个窗口` };
  }
}
const ARM_ORDER = ["F", "D", "S", "P-T"];

// ---------------------------------------------------------------- SSE clients

type Client = { res: ServerResponse; busy: boolean };
const clients = new Set<Client>();
function send(c: Client, ev: unknown, droppable = false) {
  if (droppable && c.busy) return;
  const ok = c.res.write(`data: ${JSON.stringify(ev)}\n\n`);
  if (!ok && !c.busy) {
    c.busy = true;
    c.res.once("drain", () => (c.busy = false));
  }
}

// ---------------------------------------------------------------- file tail

/** Follows an append-only JSONL file by polling its size. */
class Tail {
  private pos = 0;
  private rest = Buffer.alloc(0);
  private busy = false;
  constructor(
    private path: string,
    private onLine: (line: string) => void,
  ) {}
  async poll() {
    if (this.busy) return;
    this.busy = true;
    let fh: FileHandle | undefined;
    try {
      const st = await stat(this.path).catch(() => null);
      if (!st || st.size <= this.pos) return;
      fh = await open(this.path, "r");
      const len = Math.min(st.size - this.pos, 32 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, this.pos);
      this.pos += bytesRead;
      const all = Buffer.concat([this.rest, buf.subarray(0, bytesRead)]);
      const cut = all.lastIndexOf(10);
      this.rest = cut < 0 ? all : all.subarray(cut + 1);
      if (cut < 0) return;
      for (const line of all.subarray(0, cut).toString("utf8").split("\n"))
        if (line.trim())
          try {
            this.onLine(line);
          } catch {}
    } finally {
      await fh?.close().catch(() => {});
      this.busy = false;
    }
  }
}

// ---------------------------------------------------------------- recorder

class Recorder {
  private queue = Promise.resolve();
  private seq = 0;
  private constructor(
    readonly dir: string,
    private events: FileHandle,
  ) {}
  static async create(armDir: string) {
    const dir = join(armDir, "wall-recording");
    await mkdir(join(dir, "frames"), { recursive: true });
    return new Recorder(dir, await open(join(dir, "events.jsonl"), "a"));
  }
  event(ev: Event) {
    this.queue = this.queue
      .then(() => this.events.write(JSON.stringify(ev) + "\n"))
      .then(
        () => {},
        () => {},
      );
  }
  frame(ev: Event, data: string) {
    const file = `frames/${ev.surface}-${ev.t}-${String(++this.seq).padStart(6, "0")}.jpg`;
    const { data: _, ...rest } = ev;
    this.queue = this.queue
      .then(() => writeFile(join(this.dir, file), Buffer.from(data, "base64")))
      .then(() => this.events.write(JSON.stringify({ ...rest, file }) + "\n"))
      .then(
        () => {},
        () => {},
      );
  }
  async close() {
    await this.queue;
    await this.events.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- panel

const READ_ONLY = /observe|overview|read|wait|list|status|inspect|probe/;
const FRAME_MS = 200; // ≤ 5 fps per surface

class Panel {
  readonly arm: string;
  readonly started: number;
  finishedAt: number | null = null;
  readonly owners = new Map<string, Actor>();
  private assigned = new Set<string>();
  private touched = new Map<string, Set<string>>();
  private helperColors = new Map<string, string>();
  readonly lastFrame = new Map<string, string>();
  readonly lastPos = new Map<string, { x: number; y: number }>();
  readonly done = new Map<string, number>();
  tokens = 0;
  private tokenByThread = new Map<string, number>();
  private tails = new Map<string, Tail>();
  private journal: Tail;
  private tools: Tail;
  private catchingUp = true;
  private timers: NodeJS.Timeout[] = [];
  private sockets: Cdp[] = [];
  private open = 0;
  private recorder: Recorder | null = null;
  private known: Set<string>;

  constructor(
    readonly id: string,
    readonly dir: string,
    readonly wall: Wall,
    started: number,
  ) {
    this.arm = id.includes("-") ? id.slice(id.indexOf("-") + 1) : id;
    this.started = started;
    this.known = new Set(wall.surfaces.map((s) => s.id));
    wall.surfaces.forEach((s, i) =>
      this.owners.set(s.id, this.defaultActor(i)),
    );
    this.journal = new Tail(wall.journal, (l) => this.onJournal(l));
    this.tools = new Tail(join(dir, "tools.jsonl"), (l) => this.onTool(l));
  }

  private defaultActor(i: number): Actor {
    if (this.arm.startsWith("P")) return this.actorOf(`sessions/${i}`);
    if (this.arm === "S") return this.actorOf("sessions/script");
    return this.actorOf("sessions/director");
  }

  actorOf(session: string): Actor {
    const name = session
      .replace(/^sessions\//, "")
      .replace(/-continued-\d+$/, "");
    if (name === "director")
      return { id: "director", label: "指挥", color: DIRECTOR };
    if (name === "script")
      return { id: "script", label: "脚本", color: DIRECTOR };
    if (/^\d+$/.test(name)) {
      const n = Number(name);
      return { id: `a${n}`, label: `A${n + 1}`, color: agentColor(n) };
    }
    let color = this.helperColors.get(name);
    if (!color) {
      color = HELPERS[this.helperColors.size % HELPERS.length]!;
      this.helperColors.set(name, color);
    }
    const m = /^delegate-(.+)$/.exec(name);
    return { id: name, label: m ? `助手·${m[1]}` : name.slice(0, 10), color };
  }

  meta(): Event {
    const { title, subtitle } = armTitle(this.arm, this.wall.surfaces.length);
    return {
      type: "panel",
      panel: this.id,
      t: this.started,
      arm: this.arm,
      title,
      subtitle,
      view: this.wall.view,
      started: this.started,
      finished: this.finishedAt,
      surfaces: this.wall.surfaces.map((s) => ({
        id: s.id,
        company: s.company,
      })),
      owners: Object.fromEntries(this.owners),
    };
  }

  /** Current state for a newly connected page. */
  snapshot(): Event[] {
    const t = Date.now();
    const out: Event[] = [this.meta()];
    for (const [surface, count] of this.done)
      out.push({ type: "done", panel: this.id, t, surface, count });
    out.push({ type: "stats", panel: this.id, t, tokens: this.tokens });
    for (const [surface, data] of this.lastFrame)
      out.push({ type: "frame", panel: this.id, t, surface, data });
    for (const [surface, p] of this.lastPos)
      out.push({
        type: "cursor",
        panel: this.id,
        t,
        surface,
        ...p,
        kind: "move",
        actor: this.owners.get(surface)!,
        quiet: true,
      });
    return out;
  }

  private emit(ev: Event) {
    const frame = ev.type === "frame";
    for (const c of clients) send(c, ev, frame);
    if (this.recorder)
      frame
        ? this.recorder.frame(ev, ev.data as string)
        : this.recorder.event(ev);
  }

  async start() {
    if (record) this.recorder = await Recorder.create(this.dir);
    this.emit(this.meta());
    // Catch up silently on what already happened before the wall attached.
    await this.journal.poll();
    await this.tools.poll();
    await this.pollSubmissions();
    await this.pollTokens();
    this.catchingUp = false;
    for (const [surface, p] of this.lastPos)
      this.emit({
        type: "cursor",
        panel: this.id,
        t: Date.now(),
        surface,
        ...p,
        kind: "move",
        actor: this.owners.get(surface)!,
        quiet: true,
      });
    this.timers.push(
      setInterval(() => void this.journal.poll(), 150),
      setInterval(() => void this.tools.poll(), 400),
      setInterval(() => void this.pollSubmissions(), 1000),
      setInterval(() => void this.pollTokens(), 3000),
    );
    await Promise.all(this.wall.surfaces.map((s) => this.watch(s)));
    if (this.open === 0) await this.finish();
  }

  /** Passive screencast of one page over its own CDP session. */
  private async watch(s: Wall["surfaces"][number]) {
    let client: Cdp;
    try {
      client = await Cdp.connect(
        `${this.wall.devtools}/devtools/page/${s.target_id}`,
      );
    } catch {
      return;
    }
    this.open++;
    this.sockets.push(client);
    let pending: string | null = null,
      last = 0,
      timer: NodeJS.Timeout | null = null;
    const flush = () => {
      timer = null;
      if (pending === null) return;
      last = Date.now();
      const data = pending;
      pending = null;
      this.lastFrame.set(s.id, data);
      this.emit({
        type: "frame",
        panel: this.id,
        t: last,
        surface: s.id,
        data,
      });
    };
    const offer = (data: string) => {
      pending = data;
      if (timer) return;
      const wait = FRAME_MS - (Date.now() - last);
      if (wait <= 0) flush();
      else timer = setTimeout(flush, wait);
    };
    client.socket.addEventListener("message", (event) => {
      let m: any;
      try {
        m = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (m.method !== "Page.screencastFrame") return;
      client
        .call("Page.screencastFrameAck", { sessionId: m.params.sessionId })
        .catch(() => {});
      offer(m.params.data);
    });
    let casting = false,
      seen = 0;
    const cast = async () => {
      try {
        await client.call("Page.startScreencast", {
          format: "jpeg",
          quality: 55,
          maxWidth: this.wall.surfaces.length > 24 ? 400 : 480,
          maxHeight: 400,
          everyNthFrame: 1,
        });
        casting = true;
      } catch {}
    };
    const still = async () => {
      try {
        const shot = await client.call("Page.captureScreenshot", {
          format: "jpeg",
          quality: 55,
        });
        if (Date.now() - seen > 1000) {
          seen = Date.now();
          offer(shot.data);
        }
      } catch {}
    };
    // A busy browser can drop the screencast start, and an idle page sends no
    // frames: retry the start and fall back to a slow still capture.
    const watchdog = setInterval(() => {
      if (client.closed) return;
      if (!casting) void cast();
      if (Date.now() - seen > 5000) void still();
    }, 2500);
    client.socket.addEventListener("message", (event) => {
      if (String(event.data).includes('"Page.screencastFrame"'))
        seen = Date.now();
    });
    client.socket.addEventListener("close", () => {
      clearInterval(watchdog);
      if (timer) clearTimeout(timer);
      flush();
      this.open--;
      if (this.open === 0) void this.finish();
    });
    await Promise.all([still(), cast()]);
  }

  private onJournal(line: string) {
    const r = JSON.parse(line);
    if (r.kind !== "intent" || !this.known.has(r.surface_id)) return;
    const surface = r.surface_id as string;
    for (const [seq, a] of (r.actions as any[]).entries()) {
      let pos = this.lastPos.get(surface) ?? {
        x: this.wall.view.width / 2,
        y: this.wall.view.height / 2,
      };
      if (a.kind === "click") pos = { x: a.x, y: a.y };
      this.lastPos.set(surface, pos);
      if (this.catchingUp) continue;
      const text =
        a.kind === "type_text"
          ? String(a.text).length > 16
            ? `${String(a.text).slice(0, 16)}…`
            : String(a.text)
          : a.kind === "click"
            ? undefined
            : (a.keys as string[] | undefined)?.join("+");
      this.emit({
        type: "cursor",
        panel: this.id,
        t: Date.now(),
        at: Date.parse(r.at),
        surface,
        ...pos,
        seq,
        kind:
          a.kind === "click"
            ? "click"
            : a.kind === "type_text"
              ? "type"
              : "key",
        ...(text === undefined ? {} : { text }),
        actor: this.owners.get(surface)!,
      });
    }
  }

  private refs(v: unknown, out: Set<string>, depth = 0) {
    if (depth > 8) return;
    if (typeof v === "string") {
      if (this.known.has(v)) out.add(v);
    } else if (Array.isArray(v))
      for (const x of v) this.refs(x, out, depth + 1);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        // Fleet-wide progress summaries list every surface; not a claim.
        if (k === "progress" || k === "fleet") continue;
        this.refs(x, out, depth + 1);
      }
  }

  private setOwner(surface: string, actor: Actor) {
    this.assigned.add(surface);
    if (this.owners.get(surface)?.id === actor.id) return;
    this.owners.set(surface, actor);
    if (!this.catchingUp)
      this.emit({
        type: "owner",
        panel: this.id,
        t: Date.now(),
        surface,
        actor,
      });
  }

  private onTool(line: string) {
    const r = JSON.parse(line);
    if (typeof r.session !== "string") return;
    const actor = this.actorOf(r.session);
    const hit = new Set<string>();
    this.refs(r.args, hit);
    this.refs(r.result, hit);
    const touched = this.touched.get(actor.id) ?? new Set<string>();
    this.touched.set(actor.id, touched);
    // A director's fleet call without named windows covers all it touched.
    if (hit.size === 0 && /^fleet_/.test(String(r.name)))
      for (const s of touched) hit.add(s);
    const readOnly = READ_ONLY.test(String(r.name));
    for (const s of hit) {
      touched.add(s);
      if (readOnly && this.assigned.has(s)) continue;
      this.setOwner(s, actor);
    }
    if (!this.catchingUp)
      this.emit({ type: "activity", panel: this.id, t: Date.now(), actor });
  }

  private async pollSubmissions() {
    const text = await readFile(this.wall.submissions, "utf8").catch(() => "");
    let v: Record<string, unknown[]>;
    try {
      v = JSON.parse(text);
    } catch {
      return;
    }
    for (const [surface, list] of Object.entries(v)) {
      const count = Array.isArray(list) ? list.length : 0;
      if (!this.known.has(surface) || (this.done.get(surface) ?? 0) === count)
        continue;
      this.done.set(surface, count);
      this.emit({
        type: "done",
        panel: this.id,
        t: Date.now(),
        surface,
        count,
      });
    }
  }

  private async pollTokens() {
    const sessions = join(this.dir, "sessions");
    const names = await readdir(sessions).catch(() => [] as string[]);
    for (const name of names) {
      // A helper session is named after its window: it owns it from birth.
      const m = /^delegate-(.+)$/.exec(name);
      if (m && this.known.has(m[1]!) && !this.tails.has(name))
        this.setOwner(m[1]!, this.actorOf(`sessions/${name}`));
      if (!this.tails.has(name))
        this.tails.set(
          name,
          new Tail(join(sessions, name, "agent", "events.jsonl"), (l) => {
            if (!l.includes("thread/tokenUsage/updated")) return;
            const p = JSON.parse(l).event?.params;
            const total = p?.tokenUsage?.total?.totalTokens;
            if (typeof total === "number")
              this.tokenByThread.set(`${name}/${p.threadId ?? ""}`, total);
          }),
        );
    }
    await Promise.all([...this.tails.values()].map((t) => t.poll()));
    let sum = 0;
    for (const v of this.tokenByThread.values()) sum += v;
    if (sum !== this.tokens) {
      this.tokens = sum;
      this.emit({ type: "stats", panel: this.id, t: Date.now(), tokens: sum });
    }
  }

  private async finish() {
    if (this.finishedAt !== null) return;
    // Wait briefly for the last journal lines and submissions to land.
    await new Promise((r) => setTimeout(r, 800));
    if (this.finishedAt !== null) return;
    await this.journal.poll();
    await this.tools.poll();
    await this.pollSubmissions();
    await this.pollTokens();
    for (const t of this.timers) clearInterval(t);
    const st = await stat(this.wall.journal).catch(() => null);
    this.finishedAt =
      this.lastFrame.size === 0 && st ? Math.floor(st.mtimeMs) : Date.now();
    this.emit({
      type: "finished",
      panel: this.id,
      t: this.finishedAt,
      finished: this.finishedAt,
    });
    await this.recorder?.close();
    this.recorder = null;
  }

  async close() {
    for (const t of this.timers) clearInterval(t);
    for (const s of this.sockets) s.close();
    await this.recorder?.close();
  }
}

// ---------------------------------------------------------------- discovery

const panels = new Map<string, Panel>();
function order(a: Panel, b: Panel) {
  const ra = ARM_ORDER.indexOf(a.arm),
    rb = ARM_ORDER.indexOf(b.arm);
  return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || a.id.localeCompare(b.id);
}

async function discover() {
  if (!outDir) return;
  const entries = await readdir(outDir, { withFileTypes: true }).catch(
    () => [],
  );
  for (const e of entries) {
    if (!(e.isDirectory() || e.isSymbolicLink()) || panels.has(e.name))
      continue;
    const dir = join(outDir, e.name);
    const path = join(dir, "environment", "wall.json");
    let wall: Wall;
    let started: number;
    try {
      wall = JSON.parse(await readFile(path, "utf8"));
      started = Math.floor((await stat(path)).mtimeMs);
    } catch {
      continue;
    }
    if (!wall.devtools || !Array.isArray(wall.surfaces)) continue;
    const panel = new Panel(e.name, dir, wall, started);
    panels.set(e.name, panel);
    console.log(
      `wall: panel ${e.name} (${wall.surfaces.length} surfaces) from ${dir}`,
    );
    void panel.start().catch((err) => console.error(`wall: ${e.name}`, err));
  }
}

// ---------------------------------------------------------------- replay

const NAME = /^[\w.-]+$/;
async function replayData(dir: string) {
  const root = resolve(dir);
  const arms: { panel: string; events: unknown[] }[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!(e.isDirectory() || e.isSymbolicLink()) || !NAME.test(e.name))
      continue;
    const text = await readFile(
      join(root, e.name, "wall-recording", "events.jsonl"),
      "utf8",
    ).catch(() => "");
    const events: unknown[] = [];
    for (const line of text.split("\n"))
      if (line.trim())
        try {
          events.push(JSON.parse(line));
        } catch {}
    if (events.length) arms.push({ panel: e.name, events });
  }
  return { dir: root, arms };
}
function replayFile(dir: string, panel: string, file: string) {
  if (!NAME.test(panel) || !/^frames\/[\w.-]+\.jpg$/.test(file)) return null;
  const base = resolve(dir, panel, "wall-recording");
  const path = resolve(base, file);
  return path.startsWith(base + sep) ? path : null;
}

// ---------------------------------------------------------------- http

const here = dirname(fileURLToPath(import.meta.url));
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://local");
    if (url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(await readFile(join(here, "page.html")));
      return;
    }
    if (url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      const c: Client = { res, busy: false };
      send(c, { type: "hello", now: Date.now(), out: outDir, record });
      for (const p of [...panels.values()].sort(order))
        for (const ev of p.snapshot()) send(c, ev);
      clients.add(c);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(c);
      });
      return;
    }
    if (url.pathname === "/replay-data") {
      const dir = url.searchParams.get("dir");
      if (!dir) throw Error("dir");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await replayData(dir)));
      return;
    }
    if (url.pathname === "/replay-file") {
      const path = replayFile(
        url.searchParams.get("dir") ?? "",
        url.searchParams.get("panel") ?? "",
        url.searchParams.get("file") ?? "",
      );
      if (!path) throw Error("path");
      const data = await readFile(path);
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "cache-control": "max-age=3600",
      });
      res.end(data);
      return;
    }
    res.writeHead(404);
    res.end();
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(
    `wall: http://127.0.0.1:${port}/${outDir ? `  watching ${outDir}` : ""}${record ? "  (recording)" : ""}`,
  );
});

await discover();
const discovery = setInterval(() => void discover(), 2000);

async function shutdown() {
  clearInterval(discovery);
  await Promise.all([...panels.values()].map((p) => p.close()));
  for (const c of clients) c.res.end();
  server.closeAllConnections();
  server.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
