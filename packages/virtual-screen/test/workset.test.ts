import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProgressLedger, ReadyQueue } from "../src/workset.js";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("model ending after eight targets never finishes a hundred-target manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cu-progress-"));
  try {
    const ids = Array.from({ length: 100 }, (_, i) => `W${i + 1}`);
    const l = await ProgressLedger.open(dir, ids, 3);
    expect(l.select(8)).toHaveLength(8);
    for (const id of ids.slice(0, 8))
      for (let step = 1; step <= 3; step++) {
        await l.dispatch(id, `op-${id}-${step}`, {
          text: `${id}-${step}`,
          choice: "Standard",
        });
        await l.deliver(id, "delivered");
        await l.observed(id, `v-${id}-${step}`);
        await l.verify(id, `v-${id}-${step}`, `${id}-${step}`, "Standard");
      }
    expect(l.summary()).toMatchObject({ verified: 8, remaining: 92 });
    expect(l.select(8)).toEqual(ids.slice(8, 16));
    await l.close();
    const recovered = await ProgressLedger.open(dir, ids, 3);
    expect(recovered.summary().remaining).toBe(92);
    await recovered.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dispatch recovery, stale proof and mismatched fields cannot become successful", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cu-progress-"));
  try {
    let l = await ProgressLedger.open(dir, ["A", "B"], 1);
    await l.dispatch("A", "a", { text: "F1", choice: "Standard" });
    await l.dispatch("B", "b", { text: "F2", choice: "Urgent" });
    await l.deliver("B", "delivered");
    await expect(l.verify("B", "old", "F2", "Urgent")).rejects.toThrow(
      "fresh_observation_required",
    );
    await l.observed("B", "new");
    await l.verify("B", "new", "E2", "Urgent");
    expect(l.get("B").state).toBe("blocked");
    await l.close();
    l = await ProgressLedger.open(dir, ["A", "B"], 1);
    expect(l.get("A").state).toBe("unknown");
    await expect(
      l.dispatch("A", "again", { text: "F1", choice: "Standard" }),
    ).rejects.toThrow("input_not_allowed");
    expect(l.summary().verified).toBe(0);
    await l.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ready results escape a stalled member; failed reads remain target-local", async () => {
  const q = new ReadyQueue<number>(2);
  let finish!: (v: number) => void;
  q.start("slow", () => new Promise((r) => (finish = r)));
  q.start("fast", async () => 7);
  const a = await q.collect(100, 5);
  expect(a.ready).toEqual([{ id: "fast", value: 7 }]);
  expect(a.pending).toEqual(["slow"]);
  q.start("bad", async () => {
    throw Error("private transport detail");
  });
  const b = await q.collect(100, 5);
  expect(b.errors).toEqual([{ id: "bad", code: "target_operation_failed" }]);
  expect(b.pending).toEqual(["slow"]);
  finish(9);
  expect((await q.collect(100, 5)).ready[0]?.value).toBe(9);
  expect(q.pending).toBe(0);
});

test("a live owner cannot be stolen, even with recovery requested", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cu-progress-owner-"));
  try {
    const l = await ProgressLedger.open(dir, ["A"], 1);
    await expect(ProgressLedger.open(dir, ["A"], 1, true)).rejects.toThrow(
      "owner_still_running",
    );
    await l.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("actual owner death after dispatch recovers uncertainty without allowing replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cu-dead-owner-"));
  const module = new URL("../src/workset.ts", import.meta.url).href;
  const code = `import {ProgressLedger} from ${JSON.stringify(module)};const l=await ProgressLedger.open(${JSON.stringify(dir)},['A','B'],1);await l.dispatch('A','immutable',{text:'F1',choice:'Standard'});process.stdout.write('ready');setInterval(()=>{},1000);`;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await once(child.stdout, "data");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const l = await ProgressLedger.open(dir, ["A", "B"], 1, true);
    try {
      expect(l.get("A").state).toBe("unknown");
      expect(l.select(8)).toEqual(["B"]);
      await expect(
        l.dispatch("A", "retry", { text: "F1", choice: "Standard" }),
      ).rejects.toThrow("input_not_allowed");
    } finally {
      await l.close();
    }
  } finally {
    child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
