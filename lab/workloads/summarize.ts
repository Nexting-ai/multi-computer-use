/**
 * Summarises preregistered runs of a declared (free) task.
 *
 *   node --import tsx lab/workloads/summarize.ts <arm>=<run-block-dir> ... > summary.json
 *
 * Per arm: wall time, time from the first session start to the last item
 * declared, tokens, tool calls, images sent to the model, items declared and
 * the objective grade from the saved files.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const out: Record<string, unknown> = {};
for (const spec of process.argv.slice(2)) {
  const [arm, dir] = spec.split("=") as [string, string];
  const r = JSON.parse(await readFile(join(dir, "result.json"), "utf8"));
  const ledger = JSON.parse(
    await readFile(join(dir, "ledger", "progress.json"), "utf8"),
  );
  // Session starts and declarations, from the agents' event logs.
  const starts: number[] = [],
    declared: number[] = [];
  for (const s of await readdir(join(dir, "sessions"))) {
    const text = await readFile(
      join(dir, "sessions", s, "agent", "events.jsonl"),
      "utf8",
    ).catch(() => "");
    for (const line of text.split("\n")) {
      if (!line.startsWith("{")) continue;
      const at = Date.parse(JSON.parse(line).at);
      if (!starts.length || at < starts.at(-1)!) starts.push(at);
      if (
        line.includes('"desktop_done"') &&
        line.includes('"direction":"receive"')
      )
        declared.push(at);
    }
  }
  const t0 = Math.min(...starts);
  out[arm] = {
    wall_s: Math.round(r.elapsed_ms / 1000),
    to_last_declared_s: declared.length
      ? Math.round((Math.max(...declared) - t0) / 1000)
      : null,
    tokens: r.tokens,
    tool_calls: r.tool_calls,
    images: r.images,
    sessions: r.sessions.length,
    declared: ledger.rows.reduce((n: number, x: any) => n + x.completed, 0),
    objective: {
      buildings_fully_correct: r.successes,
      checks_passed: r.correct_items,
      checks_total: r.total * 3,
    },
    stop_reason: r.stop_reason,
  };
}
console.log(JSON.stringify(out, null, 2));
