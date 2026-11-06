/**
 * Local lab for the tunable workload: a small HTTP server for the wizards and
 * submissions, and a dedicated headless Chrome with one browser context per
 * surface. Nothing leaves this machine.
 *
 * Writes `wall.json` (DevTools endpoint and targets) so the live wall can
 * watch the same pages without touching the agents' connections.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Cdp,
  CdpSurfacePort,
} from "../../../packages/virtual-screen/src/cdp.js";
import type { Lab, Score } from "../types.js";
import { companyName, html } from "./page.js";
import { scenario, type Config, type Surface } from "./scenario.js";

export const VIEW = { width: 960, height: 640 };

export function gradeSurface(
  s: Surface,
  submissions: Record<string, string>[],
): Score {
  const own = submissions;
  const one = own.length === 1 ? own[0]! : null;
  const keys = Object.keys(s.expected);
  const wrongFields = one
    ? keys.filter((k) => (one[k] ?? "").trim() !== s.expected[k])
    : keys;
  // Fields the surface must not have (cost center where none was asked).
  const extra = one ? Object.keys(one).filter((k) => !(k in s.expected)) : [];
  const correct = !!one && wrongFields.length === 0 && extra.length === 0;
  return {
    surface_id: s.id,
    success: correct,
    wrong: own.length > 1 || (own.length === 1 && !correct),
    commits: own.length,
    correct_items: correct ? 1 : 0,
    detail: {
      expected: s.expected,
      submitted: own,
      wrong_fields: wrongFields,
      extra_fields: extra,
    },
  };
}

export async function openTunableLab(
  directory: string,
  config: Config,
): Promise<Lab & { surfacesConfig: Surface[] }> {
  await mkdir(directory, { recursive: true });
  const { pages, surfaces } = scenario(config);
  const submissions = new Map<string, Record<string, string>[]>(
    surfaces.map((s) => [s.id, []]),
  );
  const save = () =>
    writeFile(
      join(directory, "submissions.json"),
      JSON.stringify(Object.fromEntries(submissions), null, 2),
    );
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://local");
      const id = url.pathname.split("/").at(-1)!;
      const s = surfaces.find((x) => x.id === id);
      if (!s) throw Error("not_found");
      if (req.method === "GET" && url.pathname.startsWith("/page/")) {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(html(s));
        return;
      }
      if (req.method === "POST" && url.pathname.startsWith("/save/")) {
        let body = "";
        for await (const part of req) {
          body += part;
          if (body.length > 16384) throw Error("large");
        }
        const v = JSON.parse(body);
        if (typeof v !== "object" || v === null) throw Error("bad");
        submissions
          .get(id)!
          .push(
            Object.fromEntries(
              Object.entries(v).map(([k, x]) => [k, String(x)]),
            ),
          );
        await save();
        res.writeHead(204);
        res.end();
        return;
      }
      throw Error("not_found");
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("server_address");

  const profile = join(directory, "profile");
  const chrome = spawn(
    process.env.CU_CHROME ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless=new",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      `--window-size=${VIEW.width},${VIEW.height}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let browser: Cdp | undefined;
  let port: CdpSurfacePort | undefined;
  const close = async () => {
    await save();
    await port?.close();
    browser?.close();
    if (chrome.exitCode === null) {
      const exited = new Promise<void>((r) => chrome.once("exit", () => r()));
      chrome.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      if (chrome.exitCode === null) chrome.kill("SIGKILL");
    }
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  };
  try {
    let lines: string[] = [];
    for (let k = 0; k < 100 && !lines[1]; k++) {
      lines = await readFile(join(profile, "DevToolsActivePort"), "utf8")
        .then((t) => t.trim().split("\n"))
        .catch(() => []);
      if (!lines[1]) {
        if (chrome.exitCode !== null) throw Error("chrome_exited");
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!lines[1]) throw Error("chrome_not_ready");
    const devtools = `ws://127.0.0.1:${lines[0]}`;
    browser = await Cdp.connect(`${devtools}${lines[1]}`);
    const routes: {
      surface_id: string;
      websocket_url: string;
      target_id: string;
    }[] = [];
    for (const s of surfaces) {
      const { browserContextId } = await browser.call(
        "Target.createBrowserContext",
      );
      const { targetId } = await browser.call("Target.createTarget", {
        url: `http://127.0.0.1:${address.port}/page/${s.id}`,
        browserContextId,
      });
      const websocket_url = `${devtools}/devtools/page/${targetId}`;
      const page = await Cdp.connect(websocket_url);
      await page.call("Page.enable");
      await page.call("Emulation.setDeviceMetricsOverride", {
        ...VIEW,
        deviceScaleFactor: 1,
        mobile: false,
      });
      // Pages are handed over once loaded (fonts and layout settled).
      for (let k = 0; k < 50; k++) {
        const r = await page.call("Runtime.evaluate", {
          expression:
            "document.readyState === 'complete' && !!document.querySelector('.card')",
          returnByValue: true,
        });
        if (r.result?.value) break;
        await new Promise((x) => setTimeout(x, 100));
      }
      page.close();
      routes.push({ surface_id: s.id, websocket_url, target_id: targetId });
    }
    await new Promise((r) => setTimeout(r, 300));
    port = await CdpSurfacePort.connect(
      routes.map(({ surface_id, websocket_url }) => ({
        surface_id,
        websocket_url,
      })),
      join(directory, "input-journal.jsonl"),
    );
    await writeFile(
      join(directory, "wall.json"),
      JSON.stringify(
        {
          devtools,
          view: VIEW,
          config,
          pages,
          journal: join(directory, "input-journal.jsonl"),
          submissions: join(directory, "submissions.json"),
          surfaces: routes.map((r) => ({
            id: r.surface_id,
            target_id: r.target_id,
            company: companyName(r.surface_id),
          })),
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(directory, "scenario.json"),
      JSON.stringify({ config, pages, surfaces }, null, 2),
    );
    await save();
    return {
      surfaces: surfaces.map((s) => s.id),
      surfacesConfig: surfaces,
      port,
      task: "",
      inputs: Object.fromEntries(surfaces.map((s) => [s.id, s.row])),
      grade: () => surfaces.map((s) => gradeSurface(s, submissions.get(s.id)!)),
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}
