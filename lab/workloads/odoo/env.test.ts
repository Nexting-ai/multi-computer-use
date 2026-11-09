import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { OdooEnv, type EnvFile } from "./env.js";

const prototype = OdooEnv.prototype as any;
const originalReady = prototype.ready;
afterEach(() => {
  prototype.ready = originalReady;
});

test("local environments use direct container ports without SSH tunnels", async () => {
  prototype.ready = async () => {};
  const directory = await mkdtemp(
    join(process.cwd(), ".local", "odoo-env-test-"),
  );
  const file: EnvFile = {
    level: 0,
    seed: 1,
    hosts: [{ destination: "local", options: ["--not-an-ssh-option"] }],
    companies: [
      {
        id: "W01",
        db: "c01",
        version: "17",
        lang: "en_US",
        layout: "default",
        notice: null,
        order: {
          customer: "Northwind Traders",
          po: "PO-1000",
          lines: [{ product: "Office Chair", qty: 1 }],
        },
        missingCustomer: false,
        duplicate: false,
        host: 0,
        port: 18100,
      },
    ],
    images: {},
    local_port: 21000,
  };
  const path = join(directory, "env.json");
  await writeFile(path, JSON.stringify(file));
  let env: OdooEnv | undefined;
  try {
    env = await OdooEnv.attach(path);
    expect((env as any).tunnels).toHaveLength(0);
    expect((env as any).url(0)).toBe("http://127.0.0.1:18100");
  } finally {
    env?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
