import type { Workload } from "../types.js";
import { openTunableLab } from "./lab.js";
import { task, type Config } from "./scenario.js";

/** The tunable wizard (see scenario.ts): `share` of the 12 pages are the same
 * on every surface; the others differ in the given ways. */
export function tunable(o: Omit<Config, "seed" | "count">): Workload {
  const summary = task({ ...o, seed: 0, count: 0 });
  return {
    items: 1,
    declared: true,
    settle_ms: 4_000,
    summary,
    async open(directory, count, seed) {
      const lab = await openTunableLab(directory, { ...o, seed, count });
      const rows = Object.entries(lab.inputs!);
      const columns = Object.keys(rows[0]![1]);
      const table = rows
        .map(
          ([id, r]) =>
            `${id}: ${columns.map((k) => `${k} ${r[k]}`).join(", ")}`,
        )
        .join("\n");
      return {
        ...lab,
        task: `${summary}\nTask table (also available to fleet policies as inputs ${columns.join(", ")}):\n${table}`,
      };
    },
  };
}
