import { test, expect } from "vitest";
import { executeAndObserve } from "../src/step.js";
test("observation starts only after every input receipt; unknown effects are observed, not replayed", async () => {
  const order: string[] = [];
  let release: () => void = () => {};
  const wait = new Promise<void>((r) => (release = r));
  const pending = executeAndObserve(
    async () => {
      order.push("input");
      await wait;
      order.push("receipt");
      return [{ surface_id: "A", status: "unknown" as const }];
    },
    async (ids) => {
      order.push("observe");
      expect(ids).toEqual(["A"]);
      return ["fresh"];
    },
  );
  expect(order).toEqual(["input"]);
  release();
  expect(await pending).toEqual({
    deliveries: [{ surface_id: "A", status: "unknown" }],
    views: ["fresh"],
  });
  expect(order).toEqual(["input", "receipt", "observe"]);
});
test("capture failure preserves delivery receipts; an input validation failure never observes or dispatches again", async () => {
  let observations = 0;
  const capture = async () => {
    observations++;
    throw Error("target_closed");
  };
  expect(
    await executeAndObserve(
      async () => [{ surface_id: "A", status: "delivered" as const }],
      capture,
    ),
  ).toEqual({
    deliveries: [{ surface_id: "A", status: "delivered" }],
    views: [],
    observation_error: "Error: target_closed",
  });
  await expect(
    executeAndObserve(async () => {
      throw Error("bad_target");
    }, capture),
  ).rejects.toThrow("bad_target");
  expect(observations).toBe(1);
});
