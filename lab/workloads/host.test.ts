import { expect, test } from "vitest";
import { host } from "./host.js";

test("local workload hosts execute commands without invoking SSH", async () => {
  const local = host({
    destination: "local",
    options: ["--definitely-not-an-ssh-option"],
  });

  await expect(local.sh("printf '%s' local-odoo")).resolves.toBe("local-odoo");
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

test("local workload hosts copy files without invoking SSH", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".local", "host-test-"));
  const local = host({
    destination: "local",
    options: ["--definitely-not-an-ssh-option"],
  });
  try {
    await writeFile(join(directory, "source.txt"), "odoo-evidence");
    await local.put(
      join(directory, "source.txt"),
      join(directory, "destination.txt"),
    );
    await expect(
      readFile(join(directory, "destination.txt"), "utf8"),
    ).resolves.toBe("odoo-evidence");
    await local.get(
      join(directory, "destination.txt"),
      join(directory, "copy.txt"),
    );
    await expect(readFile(join(directory, "copy.txt"), "utf8")).resolves.toBe(
      "odoo-evidence",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
