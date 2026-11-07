/**
 * E7 summary: per diagram and arm, the final score, time to 50/90/100%, score
 * at fixed times, tokens and decisions, and where the time went: the model's
 * thinking (between a tool result and the next call) against the cursors'
 * execution (inside act calls).
 *
 *   node --import tsx lab/board/analyze.ts <runs-dir>
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2]!;
const rows: Record<string, unknown>[] = [];
for (const d of (await readdir(root)).sort()) {
  const r = await readFile(join(root, d, "result.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  if (!r) continue;
  const at = (s: number) => {
    const c = (r.curve as [number, number][]).filter(([t]) => t <= s * 1000);
    return c.length ? c[c.length - 1]![1] : 0;
  };
  // Tool timing from every agent's event log.
  let execute = 0,
    think = 0,
    calls = 0;
  const agentDirs = (await readdir(join(root, d))).filter((x) =>
    x.startsWith("agent"),
  );
  for (const a of agentDirs) {
    const ev = (
      await readFile(join(root, d, a, "events.jsonl"), "utf8").catch(() => "")
    ).split("\n");
    const started = new Map<string, number>();
    let lastDone: number | null = null;
    for (const l of ev) {
      if (!l.includes('"item/')) continue;
      let e: any;
      try {
        e = JSON.parse(l);
      } catch {
        continue;
      }
      const m = e.event?.method,
        it = e.event?.params?.item;
      if (
        !it ||
        !["dynamicToolCall", "mcpToolCall", "functionCall"].includes(it.type)
      )
        continue;
      const t = Date.parse(e.at);
      if (m === "item/started") {
        if (lastDone !== null && agentDirs.length === 1) think += t - lastDone;
        started.set(it.id, t);
      } else if (m === "item/completed" && started.has(it.id)) {
        if ((it.tool ?? it.name) === "act") execute += t - started.get(it.id)!;
        calls++;
        lastDone = t;
      }
    }
  }
  const [seed, ...armParts] = d.split("-");
  rows.push({
    seed,
    arm: armParts.join("-"),
    score: +r.final.score.toFixed(3),
    complete: r.final.complete,
    boxes: `${r.final.boxes.right}/${r.final.boxes.of}`,
    arrows: `${r.final.edges.right}/${r.final.edges.of}`,
    wrong: r.final.edges.wrong,
    t50: r.reached_ms["50"] && Math.round(r.reached_ms["50"] / 1000),
    t90: r.reached_ms["90"] && Math.round(r.reached_ms["90"] / 1000),
    t100: r.reached_ms["100"] && Math.round(r.reached_ms["100"] / 1000),
    at60: +at(60).toFixed(2),
    at120: +at(120).toFixed(2),
    at300: +at(300).toFixed(2),
    total_s: Math.round(r.elapsed_ms / 1000),
    decisions: r.decisions,
    tokens: r.tokens,
    execute_s: Math.round(execute / 1000),
    think_s: agentDirs.length === 1 ? Math.round(think / 1000) : null,
    tool_calls: calls,
  });
}
const cols = Object.keys(rows[0] ?? {});
console.log(
  "| " + cols.join(" | ") + " |\n|" + cols.map(() => "---").join("|") + "|",
);
for (const r of rows)
  console.log("| " + cols.map((c) => String(r[c] ?? "–")).join(" | ") + " |");
