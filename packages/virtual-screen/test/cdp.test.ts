import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CdpSurfacePort } from "../src/cdp.js";
test("two logical surfaces cannot alias the same CDP input target, even with loopback host aliases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cu-cdp-config-"));
  try {
    await expect(
      CdpSurfacePort.connect(
        [
          {
            surface_id: "A",
            websocket_url: "ws://127.0.0.1:1/devtools/page/same",
          },
          {
            surface_id: "B",
            websocket_url: "ws://localhost:1/devtools/page/same",
          },
        ],
        join(dir, "journal"),
      ),
    ).rejects.toThrow("duplicate_input_route");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
