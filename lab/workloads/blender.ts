import { rng } from "../benchmark/metrics.js";
import { desktopWorkload, type DesktopOptions } from "./desktop.js";
import type { Score } from "./types.js";

/** One row of the building schedule (all values exactly as they are typed). */
export type Building = {
  width: string;
  depth: string;
  height: string;
  x: string;
  y: string;
  color: string;
};

const COLORS = [
  "D94F30",
  "2E86AB",
  "F2C14E",
  "5B8E7D",
  "8E5572",
  "F78154",
  "4D9078",
  "B4436C",
  "3C6E71",
  "E0A458",
  "6C5B7B",
  "C06C84",
];

/**
 * Deterministic schedule: buildings on a city grid, 15 m apart. Widths and
 * depths end in .5 and heights are whole numbers from 20, so no value is a
 * substring of another field's value.
 */
export function schedule(seed: number, count: number): Map<string, Building> {
  const r = rng(seed);
  const cols = Math.ceil(Math.sqrt(count));
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const half = [4.5, 5.5, 6.5, 7.5, 8.5, 9.5].map(String);
  return new Map(
    Array.from({ length: count }, (_, i) => [
      `W${String(i + 1).padStart(2, "0")}`,
      {
        width: pick(half),
        depth: pick(half),
        height: String(20 + Math.floor(r() * 41)),
        x: String(15 * ((i % cols) + 1)),
        y: String(15 * (Math.floor(i / cols) + 1)),
        color: pick(COLORS),
      },
    ]),
  );
}

/** Blender: build one row of a city's building schedule per desktop. */
export const blender = (o: DesktopOptions) =>
  desktopWorkload<Building>(
    {
      app: "blender",
      items: 4,
      // Blender refreshes the title bar's unsaved mark lazily (up to ~20 s).
      settle_ms: 30_000,
      summary:
        "Each surface runs Blender with one object, Building (a 1 m cube, selected, with the sidebar's Item tab and the material properties open). Make each surface's Building match its row of the task table: (1) Dimensions X = width, Y = depth, Z = height in metres; (2) Location X = x and Y = y in metres (leave Z); (3) the Facade material's Base Color = the colour hex (color); (4) save the file in place (Ctrl+S). These are four items per surface, in this order. Use only the Blender user interface: no Python console, scripts, add-ons, file dialogs or other applications. Unknown or delivered inputs must not be repeated.",
      rows: schedule,
      grader: [
        "blender",
        "-b",
        "/work/scene.blend",
        "--python",
        "/opt/app/grade.py",
      ],
      grade: gradeBuilding,
    },
    o,
  );

/** Grades the saved scene file against the schedule row. */
export function gradeBuilding(id: string, row: Building, g: any): Score {
  g ??= { found: false };
  const near = (a: number, b: string) => Math.abs(a - Number(b)) < 0.01;
  const items = g.found
    ? {
        dimensions:
          near(g.dimensions[0], row.width) &&
          near(g.dimensions[1], row.depth) &&
          near(g.dimensions[2], row.height),
        location: near(g.location[0], row.x) && near(g.location[1], row.y),
        color: String(g.color).toUpperCase() === row.color,
      }
    : { dimensions: false, location: false, color: false };
  // The starting file is a grey 1 m cube at the origin: anything else was saved.
  const saved =
    g.found &&
    (g.dimensions.some((d: number) => !near(d, "1")) ||
      !near(g.location[0], "0") ||
      !near(g.location[1], "0") ||
      g.color !== "BCBCBC");
  const correct = Object.values(items).filter(Boolean).length;
  return {
    surface_id: id,
    success: correct === 3,
    wrong: saved && correct < 3,
    commits: saved ? 1 : 0,
    correct_items: correct,
    detail: { expected: row, saved: g },
  };
}
