import { readFileSync } from "node:fs";
import type { Workload } from "../types.js";
import { OdooEnv, type EnvFile } from "./env.js";
import { CASH_TASK, row, TASK as BASE_TASK } from "./scenario.js";

/**
 * Odoo on a provisioned environment (see cli.ts provision): every run resets
 * the companies' databases and opens fresh, logged-in browser contexts. The
 * environment selects the original sales-order or order-to-cash task.
 */
export function odoo(envPath: string): Workload {
  const TASK =
    (JSON.parse(readFileSync(envPath, "utf8")) as EnvFile).workflow ===
    "order-to-cash"
      ? CASH_TASK
      : BASE_TASK;
  return {
    items: 1,
    declared: true,
    settle_ms: 20_000,
    summary: TASK,
    async open(directory, count) {
      const env = await OdooEnv.attach(envPath);
      try {
        if (env.file.companies.length !== count)
          throw Error(`count_mismatch:${env.file.companies.length}`);
        await env.reset();
        const port = await env.surfaces(directory);
        const rows = env.file.companies.map((c) => [c.id, row(c)] as const);
        const columns = Object.keys(rows[0]![1]);
        const table = rows
          .map(
            ([id, r]) =>
              `${id}: ${columns.map((k) => `${k} ${r[k]}`).join(", ")}`,
          )
          .join("\n");
        return {
          surfaces: env.file.companies.map((c) => c.id),
          port,
          task: `${TASK}\nTask table (also available to fleet policies as inputs ${columns.join(", ")}):\n${table}`,
          inputs: Object.fromEntries(rows),
          grade: () => env.grade(),
          close: async () => {
            await port.close();
            env.close();
          },
        };
      } catch (e) {
        env.close();
        throw e;
      }
    },
  };
}
