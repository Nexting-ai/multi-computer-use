import {
  DesktopFleet,
  type DockerHost,
} from "../../packages/desktop/src/fleet.js";
import type { Score, Workload } from "./types.js";

/** What distinguishes one desktop-application task from another. */
export type DesktopTask<Row extends Record<string, string>> = {
  /** Image name prefix; the image is built from packages/desktop/image. */
  app: string;
  items: number;
  settle_ms?: number;
  /** Task text shared by every arm (the per-block table is appended). */
  summary: string;
  /** Deterministic per-surface rows (surface id -> row). */
  rows(seed: number, count: number): Map<string, Row>;
  /** Command run inside a desktop after the run; prints `GRADE {json}`. */
  grader: string[];
  /** Grades one desktop's saved work against its row. */
  grade(id: string, row: Row, grade: any): Score;
};

export type DesktopOptions = {
  hosts: DockerHost[];
  image: string;
  port?: number;
  /** Resources of one desktop. */
  cpus?: number;
  memory?: string;
};

/**
 * A fleet of identical application desktops, each with its own row of a
 * task table. The table is shown to every arm and given to fleet policies as
 * inputs; grading reads the files the application saved.
 */
export function desktopWorkload<Row extends Record<string, string>>(
  task: DesktopTask<Row>,
  o: DesktopOptions,
): Workload {
  return {
    items: task.items,
    declared: true,
    ...(task.settle_ms ? { settle_ms: task.settle_ms } : {}),
    summary: task.summary,
    async open(_directory, count, seed) {
      const rows = task.rows(seed, count);
      const fleet = await DesktopFleet.launch({
        hosts: o.hosts,
        image: o.image,
        count,
        name: `mcu-${task.app}-${seed}`,
        port: o.port ?? 17000,
        cpus: o.cpus ?? 2,
        memory: o.memory ?? "4g",
      });
      const columns = Object.keys(rows.values().next().value ?? {});
      const table = [...rows]
        .map(
          ([id, r]) =>
            `${id}: ${columns.map((c) => `${c} ${r[c]}`).join(", ")}`,
        )
        .join("\n");
      return {
        surfaces: fleet.surfaces,
        port: fleet.port,
        task: `${task.summary}\nTask table (also available to fleet policies as inputs ${columns.join(", ")}):\n${table}`,
        inputs: Object.fromEntries(rows),
        grade: () =>
          Promise.all(
            fleet.surfaces.map(async (id) => {
              const out = await fleet.exec(id, task.grader);
              const line = out.split("\n").find((l) => l.startsWith("GRADE "));
              return task.grade(
                id,
                rows.get(id)!,
                line ? JSON.parse(line.slice(6)) : null,
              );
            }),
          ),
        collect: async (dir) => {
          for (const id of fleet.surfaces)
            await fleet.collect(id, `${dir}/${id}`);
        },
        close: () => fleet.close(),
      };
    },
  };
}
