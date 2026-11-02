/**
 * Held-out workload: pinned, unmodified MiniWoB++ task pages (MIT, see
 * lab/vendor/miniwob). Only episode setup is injected: a per-surface seed,
 * a display zoom, a long episode limit, and a reward beacon recorded once per
 * surface for independent grading. Task logic and rewards are MiniWoB's own.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export const MINIWOB_TASKS = [
  "click-button",
  "enter-text",
  "login-user",
  "click-checkboxes",
  "form-sequence",
  "click-tab-2",
  // F1 held-out set (2026-10-31-preregistration-f1.md)
  "multi-orderings",
  "click-test-2",
  "click-dialog",
  "read-table-2",
  "focus-text",
  "enter-text-2",
  // F2 held-out set (2026-10-31-preregistration-f2.md)
  "click-option",
  "enter-text-dynamic",
  "focus-text-2",
  "login-user-popup",
  "click-tab",
  "odd-or-even",
] as const;
export type MiniwobTask = (typeof MINIWOB_TASKS)[number];
export const MINIWOB_ROOT = resolve(import.meta.dirname, "../vendor/miniwob");
export type MiniwobScene = { id: string; task: MiniwobTask; seed: string };
export type MiniwobRecord = {
  id: string;
  task: string;
  seed: string;
  reward: number;
  raw: number;
  done: boolean;
  reason: string | null;
};
export function miniwobScene(
  seed: number,
  index: number,
  task: string,
): MiniwobScene {
  if (!(MINIWOB_TASKS as readonly string[]).includes(task))
    throw Error("unknown_miniwob_task");
  return {
    id: `W${String(index).padStart(2, "0")}`,
    task: task as MiniwobTask,
    seed: createHash("sha256")
      .update(`miniwob/${seed}/${index}`)
      .digest("hex")
      .slice(0, 12),
  };
}
export function gradeMiniwob(s: MiniwobScene, records: MiniwobRecord[]) {
  const own = records.filter((r) => r.id === s.id);
  const success = own.length === 1 && own[0]!.done && own[0]!.raw > 0;
  return {
    surface_id: s.id,
    success,
    wrong: own.length === 1 && !success,
    commits: own.length,
    correct_items: success ? 1 : 0,
  };
}
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".gif": "image/gif",
};
/** The task page with the injected episode setup. */
export async function miniwobPage(s: MiniwobScene, beacon: string) {
  const html = await readFile(
    join(MINIWOB_ROOT, "miniwob", s.task + ".html"),
    "utf8",
  );
  const setup = `<style>body{zoom:2.5}#reward-display{display:none!important}</style><script>window.addEventListener('load',function(){
Math.seedrandom(${JSON.stringify(s.seed)});
var original=core.endEpisode,sent=false;
core.endEpisode=function(){var pending=core.EP_TIMER!==null;original.apply(this,arguments);
if(pending&&!sent){sent=true;fetch('${beacon}',{method:'POST',body:JSON.stringify({done:WOB_DONE_GLOBAL,raw:WOB_RAW_REWARD_GLOBAL,reward:WOB_REWARD_GLOBAL,reason:WOB_REWARD_REASON})});}};
core.EPISODE_MAX_TIME=3600000;core.startEpisodeReal();});</script>`;
  return html.replace("</body>", setup + "</body>");
}
/** Static vendor files referenced by task pages (../core, ../common). */
export async function miniwobStatic(pathname: string) {
  const file = resolve(MINIWOB_ROOT, "." + decodeURIComponent(pathname));
  if (
    !file.startsWith(MINIWOB_ROOT + sep) ||
    !/^\/(core|common)\//.test(pathname)
  )
    return null;
  return {
    body: await readFile(file),
    type: MIME[extname(file)] ?? "application/octet-stream",
  };
}
/** Container-side store: one episode per surface, first reward only. */
export class MiniwobStore {
  readonly scene: MiniwobScene;
  private record: MiniwobRecord | null = null;
  private queue = Promise.resolve();
  constructor(
    readonly directory: string,
    seed: number,
    index: number,
    task: string,
  ) {
    this.scene = miniwobScene(seed, index, task);
  }
  private persist(value: unknown) {
    this.queue = this.queue.then(async () => {
      const p = join(this.directory, "visual-business.json");
      await writeFile(p + ".tmp", JSON.stringify(value));
      await rename(p + ".tmp", p);
    });
    return this.queue;
  }
  async initialize() {
    try {
      await readFile(join(this.directory, "visual-business.json"));
      throw Error("fixture_state_already_exists");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    await this.persist([]);
    await writeFile(join(this.directory, "visual-events.json"), "[]");
  }
  async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, "http://local");
    if (req.method === "GET" && url.pathname === "/") {
      res.setHeader("content-type", MIME[".html"]!);
      res.end(await miniwobPage(this.scene, "/result"));
      return true;
    }
    if (req.method === "GET") {
      const f = await miniwobStatic(url.pathname).catch(() => null);
      if (!f) return false;
      res.setHeader("content-type", f.type);
      res.end(f.body);
      return true;
    }
    if (req.method === "POST" && url.pathname === "/result") {
      let body = "";
      for await (const part of req) {
        body += part;
        if (body.length > 4096) break;
      }
      if (!this.record) {
        const v = JSON.parse(body);
        this.record = {
          id: this.scene.id,
          task: this.scene.task,
          seed: this.scene.seed,
          reward: Number(v.reward),
          raw: Number(v.raw),
          done: !!v.done,
          reason: v.reason ?? null,
        };
        await this.persist([this.record]);
      }
      res.statusCode = 204;
      res.end();
      return true;
    }
    return false;
  }
}
