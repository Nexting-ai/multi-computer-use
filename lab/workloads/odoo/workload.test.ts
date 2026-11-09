import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { odoo } from "./workload.js";
import * as scenario from "./scenario.js";

test("odoo workload selects the task from the provisioned workflow", async () => {
  const directory = await mkdtemp(
    join(process.cwd(), ".local", "odoo-workload-test-"),
  );
  const cash = join(directory, "cash.json");
  const sales = join(directory, "sales.json");
  await writeFile(cash, JSON.stringify({ workflow: "order-to-cash" }));
  await writeFile(sales, JSON.stringify({}));
  try {
    expect(odoo(cash).summary).toBe(scenario.CASH_TASK);
    expect(odoo(sales).summary).toBe(scenario.TASK);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
