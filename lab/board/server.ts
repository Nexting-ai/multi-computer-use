/**
 * Shared Excalidraw board: the real editor (lab/board/app) in one browser
 * session per cursor, kept in sync here. Elements merge by Excalidraw's own
 * rule (higher version wins; ties by lower versionNonce). Every change and
 * pointer move is logged with a timestamp (log.jsonl) for exact replay.
 *
 *   GET  /board/<n>        the editor cursor n works in
 *   GET  /view             read-only live view with every cursor
 *   GET  /replay?log=...   replay of one or more logs side by side
 *   GET  /events           server-sent events: snapshot, elements, pointers
 *   POST /elements         changed elements from a session
 *   POST /pointer          a session's pointer
 *   GET  /state            current elements (for grading)
 */
import { createServer, type ServerResponse } from "node:http";
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, "app", "dist");
const ASSETS = join(
  here,
  "app",
  "node_modules",
  "@excalidraw",
  "excalidraw",
  "dist",
  "prod",
);
const TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

export type Element = {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  [k: string]: unknown;
};
type Pointer = {
  n: number;
  x: number;
  y: number;
  button: string;
  label: string;
};

const page = (
  title: string,
  extra = "",
) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="/app.css"><style>html,body{margin:0;height:100%}</style>
<script>window.EXCALIDRAW_ASSET_PATH="/assets/";</script>${extra}</head>
<body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;

export async function startBoard(o: {
  /** Element skeletons served at /seed.json (to render a target picture). */
  seed?: unknown[];
  log: string;
  cursors: number;
  title: string;
  port?: number;
}) {
  const elements = new Map<string, Element>();
  const pointers = new Map<number, Pointer>();
  for (let n = 1; n <= o.cursors; n++)
    pointers.set(n, { n, x: 0, y: 0, button: "up", label: `C${n}` });
  const t0 = Date.now();
  const listeners = new Set<ServerResponse>();
  writeFileSync(
    o.log,
    JSON.stringify({
      t: 0,
      type: "start",
      at: new Date(t0).toISOString(),
      title: o.title,
      cursors: o.cursors,
    }) + "\n",
  );
  const log = (e: Record<string, unknown>) =>
    appendFileSync(o.log, JSON.stringify({ t: Date.now() - t0, ...e }) + "\n");
  const send = (e: Record<string, unknown>) => {
    const data = `data: ${JSON.stringify(e)}\n\n`;
    for (const l of listeners) l.write(data);
  };
  // Pointers go out in batches, at most every 80 ms.
  let dirty = false;
  const flush = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    send({ type: "pointers", pointers: [...pointers.values()] });
  }, 80);
  const merge = (incoming: Element[]) => {
    const accepted: Element[] = [];
    for (const el of incoming) {
      if (typeof el?.id !== "string" || typeof el.version !== "number")
        continue;
      const cur = elements.get(el.id);
      if (
        !cur ||
        el.version > cur.version ||
        (el.version === cur.version && el.versionNonce < cur.versionNonce)
      ) {
        elements.set(el.id, el);
        accepted.push(el);
      }
    }
    return accepted;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://local");
    try {
      if (req.method === "GET" && url.pathname.startsWith("/board/")) {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(page(`Board · cursor ${url.pathname.split("/")[2]}`));
        return;
      }
      if (req.method === "GET" && url.pathname === "/view") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(page("Board · view"));
        return;
      }
      if (req.method === "GET" && url.pathname === "/replay") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(readFileSync(join(here, "replay.html"), "utf8"));
        return;
      }
      if (req.method === "GET" && url.pathname === "/log") {
        const p = url.searchParams.get("path") ?? "";
        if (!p.endsWith("/log.jsonl")) throw Error("bad_log");
        res.setHeader("content-type", "application/x-ndjson");
        res.end(readFileSync(p));
        return;
      }
      if (req.method === "GET" && url.pathname === "/seed.json") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(o.seed ?? []));
        return;
      }
      if (req.method === "GET" && url.pathname === "/state") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify([...elements.values()]));
        return;
      }
      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify({ type: "snapshot", elements: [...elements.values()], pointers: [...pointers.values()] })}\n\n`,
        );
        listeners.add(res);
        req.on("close", () => listeners.delete(res));
        return;
      }
      if (
        req.method === "POST" &&
        (url.pathname === "/elements" || url.pathname === "/pointer")
      ) {
        let body = "";
        for await (const part of req) {
          body += part;
          if (body.length > 4_000_000) throw Error("large");
        }
        const v = JSON.parse(body);
        if (url.pathname === "/elements") {
          const accepted = merge(Array.isArray(v.elements) ? v.elements : []);
          if (accepted.length) {
            log({ type: "elements", cursor: v.cursor, elements: accepted });
            send({ type: "elements", elements: accepted });
          }
        } else {
          const p = pointers.get(Number(v.n));
          if (p) {
            p.x = Number(v.x);
            p.y = Number(v.y);
            p.button = v.button === "down" ? "down" : "up";
            log({ type: "pointer", n: p.n, x: p.x, y: p.y, button: p.button });
            dirty = true;
          }
        }
        res.setHeader("content-type", "application/json");
        res.end('{"ok":true}');
        return;
      }
      if (req.method === "GET") {
        // Static: the bundle (dist) and Excalidraw's assets (fonts, locales).
        const rel = normalize(decodeURIComponent(url.pathname)).replace(
          /^\/+/,
          "",
        );
        const file = rel.startsWith("assets/")
          ? join(ASSETS, rel.slice(7))
          : join(DIST, rel);
        if (!file.startsWith(DIST) && !file.startsWith(ASSETS))
          throw Error("bad_path");
        if (!existsSync(file)) throw Error("not_found");
        res.setHeader(
          "content-type",
          TYPES[extname(file)] ?? "application/octet-stream",
        );
        res.end(readFileSync(file));
        return;
      }
      throw Error("not_found");
    } catch (e) {
      res.writeHead(404);
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    elements,
    pointers,
    label(n: number, label: string) {
      const p = pointers.get(n);
      if (p && p.label !== label) {
        p.label = label;
        log({ type: "label", n, label });
        dirty = true;
      }
    },
    meta: (v: Record<string, unknown>) => log({ type: "meta", ...v }),
    end: (v: Record<string, unknown>) => log({ type: "end", ...v }),
    close: () =>
      new Promise<void>((r) => {
        clearInterval(flush);
        for (const l of listeners) l.end();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

if (process.argv[1]?.endsWith("board/server.ts")) {
  const s = await startBoard({
    log: "/tmp/board-idle-log.jsonl",
    cursors: 2,
    title: "idle",
    port: Number(process.env.BOARD_PORT ?? 7900),
  });
  console.log(
    `board: ${s.url}/board/1  view: ${s.url}/view  replay: ${s.url}/replay?log=<run>/log.jsonl`,
  );
}
