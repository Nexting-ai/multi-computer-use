import { z } from "zod";
import { open, readFile, mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Gate } from "./index.js";
export type Progress = {
  surface_id: string;
  completed: number;
  attempts: number;
  state:
    | "ready"
    | "in_flight"
    | "awaiting_verification"
    | "verified"
    | "blocked"
    | "unknown";
  operation_id?: string | undefined;
  expected?: { text: string; choice: string } | undefined;
  observation?: string | undefined;
  reason?: string | undefined;
};
/** Single-writer durable task state. No screenshots or business oracle in this ledger. */
export class ProgressLedger {
  private gate = new Gate(1);
  private failed = false;
  private constructor(
    private directory: string,
    readonly steps: number,
    private rows: Progress[],
  ) {}
  static async open(
    directory: string,
    ids: string[],
    steps: number,
    recoverDeadOwner = false,
  ) {
    if (
      !ids.length ||
      new Set(ids).size !== ids.length ||
      !Number.isSafeInteger(steps) ||
      steps < 1
    )
      throw Error("invalid_manifest");
    await mkdir(directory, { recursive: true });
    const owner = join(directory, "owner.lock");
    let lock;
    try {
      lock = await open(owner, "wx");
    } catch (e) {
      if (!recoverDeadOwner || (e as NodeJS.ErrnoException).code !== "EEXIST")
        throw e;
      const recovery = await open(join(directory, "recovery.lock"), "wx");
      try {
        const bytes = await readFile(owner, "utf8"),
          pid = JSON.parse(bytes).pid;
        if (!Number.isSafeInteger(pid) || pid <= 0)
          throw Error("invalid_owner");
        try {
          process.kill(pid, 0);
          throw Error("owner_still_running");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        if ((await readFile(owner, "utf8")) !== bytes)
          throw Error("owner_changed");
        await unlink(owner);
        lock = await open(owner, "wx");
      } finally {
        await recovery.close();
        await unlink(join(directory, "recovery.lock"));
      }
    }
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    await lock.sync();
    await lock.close();
    try {
      let rows: Progress[];
      try {
        const saved = JSON.parse(
          await readFile(join(directory, "progress.json"), "utf8"),
        );
        if (
          saved.steps !== steps ||
          JSON.stringify(saved.rows.map((r: Progress) => r.surface_id)) !==
            JSON.stringify(ids)
        )
          throw Error("manifest_mismatch");
        rows = z
          .array(
            z.strictObject({
              surface_id: z.string().min(1),
              completed: z.number().int().min(0).max(steps),
              attempts: z.number().int().nonnegative(),
              state: z.enum([
                "ready",
                "in_flight",
                "awaiting_verification",
                "verified",
                "blocked",
                "unknown",
              ]),
              operation_id: z.string().optional(),
              expected: z
                .strictObject({ text: z.string(), choice: z.string() })
                .optional(),
              observation: z.string().optional(),
              reason: z.string().optional(),
            }),
          )
          .parse(saved.rows);
        for (const r of rows) {
          if ((r.state === "verified") !== (r.completed === steps))
            throw Error("invalid_progress_state");
          if (
            ["in_flight", "awaiting_verification", "unknown"].includes(
              r.state,
            ) &&
            (!r.expected || !r.operation_id)
          )
            throw Error("missing_dispatch_evidence");
        }
        for (const r of rows) {
          if (r.state === "in_flight") {
            r.state = "unknown";
            r.reason = "process_lost_after_dispatch";
          }
          delete r.observation;
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        rows = ids.map((surface_id) => ({
          surface_id,
          completed: 0,
          attempts: 0,
          state: "ready",
        }));
      }
      const l = new ProgressLedger(directory, steps, rows);
      await l.save();
      return l;
    } catch (e) {
      await unlink(join(directory, "owner.lock"));
      throw e;
    }
  }
  private async save() {
    const path = join(this.directory, "progress.json"),
      tmp = path + "." + randomUUID();
    const f = await open(tmp, "wx", 0o600);
    try {
      await f.writeFile(JSON.stringify({ steps: this.steps, rows: this.rows }));
      await f.sync();
    } finally {
      await f.close();
    }
    await rename(tmp, path);
    const d = await open(this.directory, "r");
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  }
  get(id: string) {
    const row = this.rows.find((r) => r.surface_id === id);
    if (!row) throw Error("target_outside_manifest");
    return structuredClone(row);
  }
  private change(id: string, fn: (row: Progress) => void) {
    return this.gate.run(async () => {
      if (this.failed) throw Error("ledger_storage_failed");
      const row = this.rows.find((r) => r.surface_id === id);
      if (!row) throw Error("target_outside_manifest");
      const next = structuredClone(row);
      fn(next);
      Object.assign(row, next);
      for (const key of Object.keys(row))
        if (!(key in next)) delete (row as any)[key];
      try {
        await this.save();
      } catch (e) {
        this.failed = true;
        throw e;
      }
    });
  }
  select(limit: number, maxAttempts = 3, exclude?: ReadonlySet<string>) {
    if (this.failed) throw Error("ledger_storage_failed");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 12)
      throw Error("invalid_workset_size");
    return this.rows
      .filter(
        (r) =>
          ["ready", "awaiting_verification"].includes(r.state) &&
          r.attempts < maxAttempts &&
          !exclude?.has(r.surface_id),
      )
      .sort((a, b) => a.attempts - b.attempts)
      .slice(0, limit)
      .map((r) => r.surface_id);
  }
  async begin(ids: string[]) {
    for (const id of ids)
      await this.change(id, (r) => {
        r.attempts++;
        delete r.observation;
      });
  }
  dispatch(
    id: string,
    operation_id: string,
    expected: { text: string; choice: string },
  ) {
    return this.change(id, (r) => {
      if (r.state !== "ready") throw Error("input_not_allowed");
      r.state = "in_flight";
      r.operation_id = operation_id;
      r.expected = expected;
      delete r.observation;
      delete r.reason;
    });
  }
  deliver(
    id: string,
    status: "delivered" | "blocked" | "unknown",
    reason?: string,
  ) {
    return this.change(id, (r) => {
      if (r.state !== "in_flight") throw Error("unexpected_delivery");
      r.state =
        status === "delivered"
          ? "awaiting_verification"
          : status === "blocked"
            ? "ready"
            : "unknown";
      if (reason) r.reason = reason;
    });
  }
  /** Hold a ready target for operator attention without a business dispatch. */
  block(id: string, reason: string) {
    return this.change(id, (r) => {
      if (r.state !== "ready") throw Error("block_requires_ready");
      r.state = "blocked";
      r.reason = reason;
    });
  }
  observed(id: string, view: string) {
    return this.change(id, (r) => {
      r.observation = view;
    });
  }
  verify(id: string, view: string, text: string, choice: string) {
    return this.change(id, (r) => {
      if (
        r.state !== "awaiting_verification" ||
        !r.observation ||
        view !== r.observation
      )
        throw Error("fresh_observation_required");
      if (text !== r.expected?.text || choice !== r.expected?.choice) {
        r.state = "blocked";
        r.reason = "visual_receipt_mismatch";
        return;
      }
      r.completed++;
      r.state = r.completed === this.steps ? "verified" : "ready";
      delete r.observation;
    });
  }
  /** Free-contract tasks (e.g. MiniWoB): the model declares a ready surface's
   * item done. Not evidence of success; grading is independent. */
  declare(id: string) {
    return this.change(id, (r) => {
      if (r.state !== "ready") throw Error("declare_requires_ready");
      r.completed++;
      r.state = r.completed === this.steps ? "verified" : "ready";
      r.reason = "declared_by_model";
    });
  }
  /** Close an unknown dispatch from positive post-condition evidence observed
   * in a fresh view. Never replays; absent evidence leaves it unknown. */
  resolve(id: string, view: string, text: string, choice: string) {
    return this.change(id, (r) => {
      if (r.state !== "unknown" || !r.observation || view !== r.observation)
        throw Error("fresh_observation_required");
      if (text !== r.expected?.text || choice !== r.expected?.choice)
        throw Error("resolution_expectation_mismatch");
      r.completed++;
      r.state = r.completed === this.steps ? "verified" : "ready";
      r.reason = "resolved_from_evidence";
      delete r.observation;
    });
  }
  summary() {
    return {
      verified: this.rows.filter((r) => r.state === "verified").length,
      remaining: this.rows.filter((r) => r.state !== "verified").length,
      attention: this.rows.filter((r) =>
        ["blocked", "unknown"].includes(r.state),
      ).length,
      completed_steps: this.rows.reduce((n, r) => n + r.completed, 0),
      total_steps: this.rows.length * this.steps,
    };
  }
  async close() {
    await this.gate.run(() => unlink(join(this.directory, "owner.lock")));
  }
}

type Settled<T> = { id: string; value: T } | { id: string; code: string };
/** Independently replenished slots; collect returns ready results without an all-target barrier. */
export class ReadyQueue<T> {
  private gate: Gate;
  private active = new Set<string>();
  private settled: Settled<T>[] = [];
  private wake = new Set<() => void>();
  constructor(
    concurrency: number,
    private onError?: (id: string, error: unknown) => void,
  ) {
    this.gate = new Gate(concurrency);
  }
  get pending() {
    return this.active.size + this.settled.length;
  }
  ids() {
    return [...new Set([...this.active, ...this.settled.map((r) => r.id)])];
  }
  has(id: string) {
    return this.active.has(id) || this.settled.some((r) => r.id === id);
  }
  start(id: string, work: () => Promise<T>) {
    if (this.has(id)) throw Error("duplicate_pending_target");
    this.active.add(id);
    void this.gate
      .run(work)
      .then(
        (value) => this.settled.push({ id, value }),
        (error) => {
          this.onError?.(id, error);
          this.settled.push({ id, code: "target_operation_failed" });
        },
      )
      .finally(() => {
        this.active.delete(id);
        for (const f of this.wake) f();
      });
  }
  private wait(ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake.add(done);
    });
  }
  async collect(waitMs = 10000, coalesceMs = 100) {
    if (
      !Number.isFinite(waitMs) ||
      waitMs < 0 ||
      waitMs > 30000 ||
      !Number.isFinite(coalesceMs) ||
      coalesceMs < 0 ||
      coalesceMs > 1000
    )
      throw Error("invalid_wait");
    const end = Date.now() + waitMs;
    while (!this.settled.length && this.active.size && Date.now() < end)
      await this.wait(end - Date.now());
    if (this.settled.length && this.active.size && coalesceMs > 0)
      await new Promise((r) => setTimeout(r, coalesceMs));
    const rows = this.settled.splice(0);
    return {
      ready: rows.filter((r): r is { id: string; value: T } => "value" in r),
      errors: rows.filter(
        (r): r is { id: string; code: string } => "code" in r,
      ),
      pending: [...this.active],
    };
  }
}

/**
 * The host drives coverage. Returning from a model session is not a
 * completion signal. `parallel` sessions run at once on disjoint worksets.
 */
export async function runWorksets<T>(
  ledger: ProgressLedger,
  session: (ids: string[], index: number) => Promise<T>,
  options: {
    size?: number;
    attempts?: number;
    max_sessions?: number;
    parallel?: number;
  } = {},
) {
  const results: T[] = [];
  const held = new Set<string>(),
    running = new Set<Promise<void>>();
  const max = options.max_sessions ?? 100;
  let started = 0;
  for (;;) {
    while (running.size < (options.parallel ?? 1) && started < max) {
      const ids = ledger.select(options.size ?? 8, options.attempts ?? 3, held);
      if (!ids.length) break;
      for (const id of ids) held.add(id);
      const index = started++;
      const task = (async () => {
        await ledger.begin(ids);
        results[index] = await session(ids, index);
      })().finally(() => {
        for (const id of ids) held.delete(id);
        running.delete(task);
      });
      running.add(task);
    }
    if (!running.size) break;
    try {
      await Promise.race(running);
    } catch (e) {
      await Promise.allSettled(running);
      throw e;
    }
  }
  return {
    sessions: results.filter((x) => x !== undefined),
    progress: ledger.summary(),
    complete: ledger.summary().remaining === 0,
  };
}
