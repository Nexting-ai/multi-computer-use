/**
 * Odoo environment operations.
 *
 *   node --import tsx lab/workloads/odoo/cli.ts provision <env.json> <hosts.json> <level> <seed> <count> [order-to-cash]
 *   node --import tsx lab/workloads/odoo/cli.ts reset <env.json>
 *   node --import tsx lab/workloads/odoo/cli.ts grade <env.json>
 *   node --import tsx lab/workloads/odoo/cli.ts shot <env.json> <out-dir>   (a screenshot of every company)
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OdooEnv } from "./env.js";
import type { Level, Workflow } from "./scenario.js";

const [cmd, path, ...rest] = process.argv.slice(2) as [
  string,
  string,
  ...string[],
];
if (cmd === "provision") {
  const [hostsPath, level, seed, count, workflow] = rest as [
    string,
    string,
    string,
    string,
    (Workflow | undefined)?,
  ];
  if (workflow !== undefined && workflow !== "order-to-cash")
    throw Error(`unknown_workflow:${workflow}`);
  const hosts = JSON.parse(await readFile(hostsPath, "utf8"));
  await OdooEnv.provision(
    path,
    hosts,
    Number(level) as Level,
    Number(seed),
    Number(count),
    workflow,
  );
  console.log("provisioned", path);
} else {
  const env = await OdooEnv.attach(path);
  try {
    if (cmd === "reset") await env.reset();
    else if (cmd === "grade")
      console.log(JSON.stringify(await env.grade(), null, 2));
    else if (cmd === "shot") {
      const out = rest[0]!;
      await mkdir(out, { recursive: true });
      await env.reset();
      await rm(join(out, "input-journal.jsonl"), { force: true });
      await rm(join(out, "chrome-profile"), { recursive: true, force: true });
      const port = await env.surfaces(out);
      for (const c of env.file.companies) {
        const f = await port.capture(c.id);
        await writeFile(
          join(out, `${c.id}-${c.version}-${c.lang}-${c.layout}.png`),
          f.png,
        );
      }
      await port.close();
    } else throw Error("usage");
  } finally {
    env.close();
  }
}
process.exit(0);
