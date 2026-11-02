import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Cdp, CdpSurfacePort } from "../../packages/virtual-screen/src/cdp.js";
import { scene, html, gradeScene, type Saved } from "./scene.js";
import {
  miniwobScene,
  miniwobPage,
  miniwobStatic,
  gradeMiniwob,
  type MiniwobRecord,
} from "./miniwob.js";
import {
  sequenceScene,
  sequenceHtml,
  gradeSequence,
  nextSequence,
} from "./sequence.js";
// Dedicated test browser only; never attaches to a user's browser profile.
export async function openBrowserLab(
  directory: string,
  count: number,
  seed: number,
  options: {
    sequence?: boolean;
    mix?: boolean | string;
    miniwob?: string;
  } = {},
) {
  if (!Number.isInteger(count) || count < 1 || count > 100)
    throw Error("invalid_count");
  await mkdir(directory, { recursive: true });
  const scenes = Array.from({ length: count }, (_, i) => scene(seed, i + 1)),
    records: Saved[] = [],
    events: unknown[] = [];
  const sequences = options.sequence
    ? Array.from({ length: count }, (_, i) =>
        sequenceScene(seed, i + 1, options.mix),
      )
    : [];
  const width = options.sequence || options.miniwob ? 1100 : 640,
    height = options.sequence || options.miniwob ? 760 : 480;
  const miniwobs = options.miniwob
    ? Array.from({ length: count }, (_, i) =>
        miniwobScene(seed, i + 1, options.miniwob!),
      )
    : [];
  const miniwobRecords: MiniwobRecord[] = [];
  const server = createServer(async (req, res) => {
    if (options.miniwob) {
      try {
        const url = new URL(req.url!, "http://local");
        const m = miniwobs.find((x) => x.id === url.pathname.split("/").at(-1));
        if (req.method === "GET" && url.pathname.startsWith("/page/") && m) {
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(await miniwobPage(m, `/result/${m.id}`));
          return;
        }
        if (req.method === "GET") {
          const f = await miniwobStatic(url.pathname).catch(() => null);
          if (!f) throw Error("not_found");
          res.setHeader("content-type", f.type);
          res.end(f.body);
          return;
        }
        if (req.method === "POST" && url.pathname.startsWith("/result/") && m) {
          let body = "";
          for await (const part of req) body += part;
          if (!miniwobRecords.some((r) => r.id === m.id)) {
            const v = JSON.parse(body);
            miniwobRecords.push({
              id: m.id,
              task: m.task,
              seed: m.seed,
              reward: Number(v.reward),
              raw: Number(v.raw),
              done: !!v.done,
              reason: v.reason ?? null,
            });
            await writeFile(
              join(directory, "business.json"),
              JSON.stringify(miniwobRecords, null, 2),
            );
          }
          res.writeHead(204);
          res.end();
          return;
        }
        throw Error("not_found");
      } catch {
        res.writeHead(404);
        res.end();
        return;
      }
    }
    const url = new URL(req.url!, "http://local"),
      id = url.pathname.split("/").at(-1),
      s = scenes.find((s) => s.id === id);
    if (!s) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.method === "GET") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        options.sequence
          ? sequenceHtml(sequences.find((x) => x.id === s.id)!)
          : html(s),
      );
      return;
    }
    try {
      let body = "";
      for await (const part of req) {
        body += part;
        if (body.length > 8192) throw Error("large");
      }
      const parsed = JSON.parse(body);
      if (url.pathname.startsWith("/save/")) {
        if (
          typeof parsed.text !== "string" ||
          !["Urgent", "Standard"].includes(parsed.choice)
        )
          throw Error("bad");
        const round = records.filter((r) => r.id === s.id).length + 1;
        records.push({
          id: s.id,
          text: parsed.text,
          choice: parsed.choice,
          ...(options.sequence ? { round } : {}),
        });
        await writeFile(
          join(directory, "business.json"),
          JSON.stringify(records, null, 2),
        );
        if (options.sequence) {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify(
              nextSequence(
                sequences.find((x) => x.id === s.id)!,
                round,
              ),
            ),
          );
          return;
        }
      } else if (url.pathname.startsWith("/event/"))
        events.push({ id: s.id, ...parsed });
      else throw Error("unknown");
      res.end("ok");
    } catch {
      res.writeHead(400);
      res.end("invalid");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("server_address");
  const chrome = spawn(
    process.env.CU_CHROME ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless=new",
      `--user-data-dir=${join(directory, "profile")}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let browser: Cdp | undefined, port: CdpSurfacePort | undefined;
  const clients = new Map<string, Cdp>(),
    targets = new Map<string, string>(),
    contexts: string[] = [];
  const close = async () => {
    await writeFile(
      join(directory, "business.json"),
      JSON.stringify(options.miniwob ? miniwobRecords : records, null, 2),
    );
    await writeFile(
      join(directory, "browser-events.json"),
      JSON.stringify(events, null, 2),
    );
    await port?.close();
    for (const c of clients.values()) c.close();
    browser?.close();
    if (chrome.exitCode === null)
      await new Promise<void>((r) => {
        const timer = setTimeout(() => {
          chrome.kill("SIGKILL");
          r();
        }, 3000);
        chrome.once("exit", () => {
          clearTimeout(timer);
          r();
        });
        chrome.kill("SIGTERM");
      });
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  };
  try {
    let lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      try {
        lines = (
          await readFile(join(directory, "profile/DevToolsActivePort"), "utf8")
        )
          .trim()
          .split("\n");
        break;
      } catch {
        if (chrome.exitCode !== null) throw Error("chrome_exited");
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!lines[0] || !lines[1]) throw Error("chrome_not_ready");
    browser = await Cdp.connect(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
    const routes = [];
    for (const s of scenes) {
      const { browserContextId } = await browser.call(
        "Target.createBrowserContext",
      );
      contexts.push(browserContextId);
      const { targetId } = await browser.call("Target.createTarget", {
        url: `http://127.0.0.1:${address.port}/page/${s.id}`,
        browserContextId,
      });
      targets.set(s.id, targetId);
      const websocket_url = `ws://127.0.0.1:${lines[0]}/devtools/page/${targetId}`,
        client = await Cdp.connect(websocket_url);
      clients.set(s.id, client);
      await client.call("Page.enable");
      await client.call("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      routes.push({ surface_id: s.id, websocket_url });
    }
    await new Promise((r) => setTimeout(r, 300));
    port = await CdpSurfacePort.connect(
      routes,
      join(directory, "input-journal.jsonl"),
    );
    await writeFile(
      join(directory, "environment.json"),
      JSON.stringify(
        {
          seed,
          count,
          scenes: options.miniwob
            ? miniwobs
            : options.sequence
              ? sequences
              : scenes,
          workload: options.miniwob
            ? `miniwob:${options.miniwob}`
            : options.sequence
              ? "sequence"
              : "single",
          targets: Object.fromEntries(targets),
          contexts,
          version: await browser.call("Browser.getVersion"),
          profile: join(directory, "profile"),
          isolation: "separate browser contexts; shared browser process",
          viewport: { width, height, deviceScaleFactor: 1 },
        },
        null,
        2,
      ),
    );
    return {
      port,
      surfaces: scenes.map((s) => s.id),
      records,
      events,
      grade: () =>
        options.miniwob
          ? miniwobs.map((s) => gradeMiniwob(s, miniwobRecords))
          : options.sequence
            ? sequences.map((s) => gradeSequence(s, records))
            : scenes.map((s) => gradeScene(s, records)),
      resize: async (id: string, width: number, height: number) => {
        await clients.get(id)!.call("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
      },
      closeSurface: async (id: string) => {
        await browser!.call("Target.closeTarget", {
          targetId: targets.get(id),
        });
        await new Promise((r) => setTimeout(r, 50));
      },
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}
