/**
 * Shared-canvas server: one picture, many cursors. Every client page (one per
 * cursor, each in its own browser context) sees the same grid and every other
 * cursor live. Every change and cursor move is appended with a timestamp to
 * `log.jsonl`, so a run can be replayed exactly.
 *
 *   GET  /client/<n>     the page cursor n works in
 *   GET  /view           live view (all cursors, progress)
 *   GET  /replay         replay page: ?log=<path>[&log=<path>...]&speed=<x>
 *   GET  /events         server-sent events: snapshot, then changes
 *   POST /op             a client's change or cursor move
 *   POST /meta           runner stats (tokens, decisions) for the views
 */
import { createServer, type ServerResponse } from "node:http";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { COLS, ROWS, PALETTE, target, type Grid } from "./target.js";
import { clientPage, viewPage } from "./pages.js";

export const CURSOR_COLORS = [
  "#22d3ee",
  "#f472b6",
  "#a3e635",
  "#fb923c",
  "#a78bfa",
  "#34d399",
  "#f87171",
  "#60a5fa",
  "#e879f9",
  "#4ade80",
  "#fbbf24",
  "#2dd4bf",
];

export type Cursor = {
  n: number;
  x: number;
  y: number;
  tool: "pixel" | "rect";
  color: number;
  corner: [number, number] | null;
  actor: string;
};

export async function startCanvas(o: {
  log: string;
  cursors: number;
  title: string;
  /** Fixed port (default: any free port). */
  port?: number;
  /** How long the "application" takes to apply a drawing click. */
  latency_ms?: number;
}) {
  const grid: Grid = Array(ROWS * COLS).fill(0);
  const goal = target();
  const cursors = new Map<number, Cursor>();
  for (let n = 1; n <= o.cursors; n++)
    cursors.set(n, {
      n,
      x: 0,
      y: 0,
      tool: "pixel",
      color: 1,
      corner: null,
      actor: "",
    });
  const t0 = Date.now();
  const listeners = new Set<ServerResponse>();
  writeFileSync(
    o.log,
    JSON.stringify({
      t: 0,
      type: "start",
      at: new Date(t0).toISOString(),
      title: o.title,
      cols: COLS,
      rows: ROWS,
      palette: PALETTE.map((p) => p[1]),
      goal,
      cursors: o.cursors,
    }) + "\n",
  );
  const emit = (e: Record<string, unknown>) => {
    const line = { t: Date.now() - t0, ...e };
    appendFileSync(o.log, JSON.stringify(line) + "\n");
    const data = `data: ${JSON.stringify(line)}\n\n`;
    for (const l of listeners) l.write(data);
  };
  const paint = (c: number, r: number, v: number) => {
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return false;
    grid[r * COLS + c] = v;
    return true;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://local");
    try {
      if (req.method === "GET" && url.pathname.startsWith("/client/")) {
        const n = Number(url.pathname.split("/")[2]);
        if (!cursors.has(n)) throw Error("no_cursor");
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(clientPage(n, CURSOR_COLORS[(n - 1) % CURSOR_COLORS.length]!));
        return;
      }
      if (
        req.method === "GET" &&
        (url.pathname === "/view" || url.pathname === "/replay")
      ) {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(viewPage(url.pathname === "/replay"));
        return;
      }
      if (req.method === "GET" && url.pathname === "/log") {
        // Replay data: only .jsonl logs written by a canvas run.
        const p = url.searchParams.get("path") ?? "";
        if (!p.endsWith("/log.jsonl")) throw Error("bad_log");
        res.setHeader("content-type", "application/x-ndjson");
        res.end(readFileSync(p));
        return;
      }
      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify({ t: Date.now() - t0, type: "snapshot", title: o.title, cols: COLS, rows: ROWS, palette: PALETTE.map((p) => p[1]), grid, goal, cursors: [...cursors.values()], colors: CURSOR_COLORS })}\n\n`,
        );
        listeners.add(res);
        req.on("close", () => listeners.delete(res));
        return;
      }
      if (
        req.method === "POST" &&
        (url.pathname === "/op" || url.pathname === "/meta")
      ) {
        let body = "";
        for await (const part of req) {
          body += part;
          if (body.length > 65536) throw Error("large");
        }
        const v = JSON.parse(body);
        if (url.pathname === "/meta") {
          emit({ type: "meta", ...v });
        } else {
          const c = cursors.get(Number(v.cursor));
          if (!c) throw Error("no_cursor");
          if (v.type === "move") {
            c.x = Number(v.x);
            c.y = Number(v.y);
            emit({ type: "move", cursor: c.n, x: c.x, y: c.y });
          } else if (
            v.type === "tool" &&
            (v.tool === "pixel" || v.tool === "rect")
          ) {
            c.tool = v.tool;
            c.corner = null;
            emit({ type: "tool", cursor: c.n, tool: c.tool });
          } else if (
            v.type === "color" &&
            Number.isInteger(v.color) &&
            v.color >= 0 &&
            v.color < PALETTE.length
          ) {
            c.color = v.color;
            emit({ type: "color", cursor: c.n, color: c.color });
          } else if (v.type === "cell") {
            if (o.latency_ms)
              await new Promise((r) => setTimeout(r, o.latency_ms));
            const col = Number(v.col),
              row = Number(v.row);
            if (c.tool === "pixel") {
              if (paint(col, row, c.color))
                emit({ type: "paint", cursor: c.n, col, row, color: c.color });
            } else if (!c.corner) {
              c.corner = [col, row];
              emit({ type: "corner", cursor: c.n, col, row });
            } else {
              const [c0, r0] = c.corner;
              const [a, b] = [Math.min(c0, col), Math.max(c0, col)];
              const [d, e] = [Math.min(r0, row), Math.max(r0, row)];
              for (let r = d; r <= e; r++)
                for (let q = a; q <= b; q++) paint(q, r, c.color);
              c.corner = null;
              emit({
                type: "rect",
                cursor: c.n,
                c0: a,
                r0: d,
                c1: b,
                r1: e,
                color: c.color,
              });
            }
          } else throw Error("bad_op");
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      throw Error("not_found");
    } catch (e) {
      res.writeHead(400);
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    grid,
    goal,
    cursors,
    setActor(n: number, actor: string) {
      const c = cursors.get(n);
      if (c && c.actor !== actor) {
        c.actor = actor;
        emit({ type: "actor", cursor: n, actor });
      }
    },
    meta: (v: Record<string, unknown>) => emit({ type: "meta", ...v }),
    end: (v: Record<string, unknown>) => emit({ type: "end", ...v }),
    close: () =>
      new Promise<void>((r) => {
        for (const l of listeners) l.end();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

if (process.argv[1]?.endsWith("canvas/server.ts")) {
  // Stand-alone: serve the replay page for recorded logs.
  const s = await startCanvas({
    log: "/tmp/canvas-idle-log.jsonl",
    cursors: 1,
    title: "replay",
    port: Number(process.env.CANVAS_PORT ?? 7800),
  });
  console.log(`replay: ${s.url}/replay?log=<run>/log.jsonl&speed=4`);
}
