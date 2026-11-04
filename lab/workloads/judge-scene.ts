/**
 * Blind judging of whole scenes: the same frames of every arm's film (same
 * camera, light and surroundings, so only the agents' work differs) are
 * shuffled under letters per angle and scored by Claude.
 *
 *   node --import tsx lab/workloads/judge-scene.ts <out-dir> "<what the scene is>" <arm>=<film-dir> ...
 *
 * <film-dir> holds frames/f_NNNN.png from film.ts.
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomInt } from "node:crypto";
import { claude, resultText } from "./claude.js";

const [outArg, what, ...specs] = process.argv.slice(2) as [
  string,
  string,
  ...string[],
];
const out = resolve(outArg);
const arms = specs.map((s) => {
  const [arm, dir] = s.split("=") as [string, string];
  return { arm, dir };
});
// Four views around the orbit (240 frames).
const FRAMES = ["0001", "0060", "0120", "0180"];
const KEYS = ["coherence", "craft", "richness", "overall"] as const;
const RUBRIC = `Score each image from 1 (poor) to 10 (excellent) on:
- coherence: the pieces look like one place (consistent style, palette, scale and level of detail);
- craft: the pieces are well made (recognisable, detailed, nothing floating or broken);
- richness: variety and interesting detail across the scene;
- overall: how impressive the scene is as a whole.
Judge only what is visible; the surroundings (paths, jungle, runway, river) are identical in every image, so judge the sixteen pieces on the plots.
Answer with JSON only: {"X": {"coherence": n, "craft": n, "richness": n, "overall": n}, ...} for every letter given.`;

const results: any[] = [];
for (const f of FRAMES) {
  const dir = join(out, `view-${f}`);
  await mkdir(dir, { recursive: true });
  const order = arms.map((a) => a.arm);
  for (let i = order.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const letters = order.map((_, i) => String.fromCharCode(88 + i)); // X, Y, Z...
  for (const [i, arm] of order.entries())
    await copyFile(
      join(arms.find((a) => a.arm === arm)!.dir, "frames", `f_${f}.png`),
      join(dir, `${letters[i]}.png`),
    );
  const prompt = `Each image shows the same scene, ${what}, built by a different team: sixteen pieces on sixteen plots, seen from the same camera.\nRead the images ${letters.map((l) => `${l}.png`).join(", ")} in this directory.\n${RUBRIC}`;
  const text = resultText(await claude(dir, prompt));
  const scores = JSON.parse(
    text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
  );
  results.push({
    view: f,
    scores: Object.fromEntries(letters.map((l, i) => [order[i], scores[l]])),
  });
  await writeFile(
    join(out, "scene-raw.json"),
    JSON.stringify(results, null, 2),
  );
}

const summary: Record<string, Record<string, number>> = {};
for (const a of arms)
  summary[a.arm] = Object.fromEntries(
    KEYS.map((k) => [
      k,
      +(
        results.reduce((s, r) => s + Number(r.scores[a.arm]?.[k] ?? 1), 0) /
        results.length
      ).toFixed(2),
    ]),
  );
await writeFile(
  join(out, "scene.json"),
  JSON.stringify({ summary, results }, null, 2),
);
console.log(JSON.stringify(summary));
