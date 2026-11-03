import { rng } from "../benchmark/metrics.js";
import { desktopWorkload, type DesktopOptions } from "./desktop.js";
import type { Score, Workload } from "./types.js";

/** One building of the block: what to build on one plot. */
export type Brief = { style: string; height: string; brief: string };

/** Sixteen buildings, deliberately different, each buildable on 20 x 20 m. */
export const CATALOG: Brief[] = [
  {
    style: "glass office tower",
    height: "52",
    brief:
      "blue-green curtain-wall glass with thin steel mullions and a stepped crown",
  },
  {
    style: "brick townhouse row",
    height: "14",
    brief:
      "three attached red-brick houses with gabled roofs, chimneys and white window frames",
  },
  {
    style: "timber pavilion",
    height: "8",
    brief:
      "open timber post-and-beam frame with a slatted roof over a wooden deck",
  },
  {
    style: "pagoda",
    height: "30",
    brief:
      "five tiers with upturned red eaves and dark tiled roofs on a stone base",
  },
  {
    style: "domed museum",
    height: "20",
    brief: "white stone base, a front colonnade and a copper-green dome",
  },
  {
    style: "brutalist block",
    height: "24",
    brief: "raw concrete, deep recessed windows and a cantilevered top floor",
  },
  {
    style: "lighthouse",
    height: "34",
    brief: "tapered white tower with red bands and a glazed lantern room",
  },
  {
    style: "greenhouse",
    height: "10",
    brief: "glass barrel vault on a white frame with planting beds inside",
  },
  {
    style: "art deco hotel",
    height: "40",
    brief: "cream facade with vertical gold fins and a stepped tower top",
  },
  {
    style: "mediterranean villa",
    height: "9",
    brief:
      "white stucco walls, terracotta roof, arched loggia and a small pool",
  },
  {
    style: "clock tower",
    height: "28",
    brief: "sandstone shaft with a clock face on each side and a pyramid roof",
  },
  {
    style: "modern library",
    height: "16",
    brief: "stacked offset boxes clad in timber with large glass openings",
  },
  {
    style: "water tower",
    height: "22",
    brief: "steel lattice legs carrying a cylindrical tank with a conical roof",
  },
  {
    style: "mini stadium",
    height: "12",
    brief: "oval stands around a green pitch with four floodlight masts",
  },
  {
    style: "shrine garden",
    height: "7",
    brief: "red torii gates, stone lanterns and a small pond on gravel",
  },
  {
    style: "twin towers",
    height: "60",
    brief: "two slim dark-glass towers joined by a high skybridge",
  },
];

/** The block's briefs in plot order (a seeded arrangement of the catalogue). */
export function block(seed: number, count: number): Map<string, Brief> {
  const r = rng(seed);
  const order = [...CATALOG];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return new Map(
    Array.from({ length: count }, (_, i) => [
      `W${String(i + 1).padStart(2, "0")}`,
      order[i % order.length]!,
    ]),
  );
}

const QUALITY =
  "Aim for a convincing, detailed building, not a placeholder: real proportions, distinct parts (base, body, top), windows or openings, materials with fitting colours. A long script can keep Blender busy for minutes with a frozen screen: wait (desktop_wait) and observe again before concluding it is unresponsive. Check your work with preview renders (F12) and fix what looks wrong (floating or intersecting parts, wrong scale, flat colours). Stay inside the plot and near the target height. Save (Ctrl+S) when the building is finished. Use the Blender interface and its Python (text editor + Alt+P, or the Python console); no other applications, add-ons or downloads. Unknown or delivered inputs must not be repeated.";

/**
 * The studio task: a city block of sixteen different buildings. `studio`
 * gives each building its own desktop (one plot, collection Module); `city`
 * gives one desktop all sixteen plots (collections P01..P16).
 */
export function studio(
  variant: "studio" | "city",
  o: DesktopOptions,
): Workload {
  const city = variant === "city";
  const surfaces = (count: number) => (city ? 1 : count);
  const base = desktopWorkload<Brief>(
    {
      app: "blender",
      items: city ? 16 : 1,
      settle_ms: 60_000,
      summary: city
        ? `Blender is open on a city block with sixteen empty 20 x 20 m plots (collections P01..P16; their coordinates are in module.py). Build every plot's building from the task table below (row Wnn is plot Pnn). ${QUALITY} Each plot is one item: declare it done when its building is finished and saved.`
        : `Each surface runs Blender on one empty 20 x 20 m plot. Build that surface's building from its row of the task table, inside the collection Module. ${QUALITY} One item per surface: declare it done when the building is finished and saved.`,
      rows: (seed, count) => block(seed, count),
      grader: [
        "blender",
        "-b",
        city ? "/work/city.blend" : "/work/studio.blend",
        "--python",
        "/opt/app/grade_module.py",
      ],
      // city: one desktop holds all plots; the wrapper below grades each.
      grade: (id, row, g) =>
        city
          ? {
              surface_id: id,
              success: false,
              wrong: false,
              commits: 0,
              detail: { raw: g },
            }
          : gradeBuilding(id, row, g?.Module),
    },
    { ...o, env: { ...(o.env ?? {}), SCENE: variant } },
  );
  if (!city) return base;
  // One desktop carries every brief; its grade covers all sixteen plots.
  return {
    ...base,
    async open(directory, count, seed) {
      const lab = await base.open(directory, surfaces(count), seed);
      const briefs = block(seed, 16);
      const table = [...briefs]
        .map(
          ([id, b]) =>
            `${id.replace("W", "P")}: ${b.style}, height ${b.height} m, ${b.brief}`,
        )
        .join("\n");
      return {
        ...lab,
        task: `${base.summary}\nTask table:\n${table}`,
        inputs: {},
        grade: async () => {
          const [one] = (await lab.grade()) as Score[];
          const g = (one?.detail as any)?.raw ?? {};
          return [...briefs].map(([id, b]) =>
            gradeBuilding(
              id,
              b,
              g[id.replace("W", "P")],
              plotCentre(Number(id.slice(1))),
            ),
          );
        },
      };
    },
  };
}

/** Plot centre on the 4 x 4 grid (city.blend). */
function plotCentre(n: number) {
  return {
    x: (((n - 1) % 4) - 1.5) * 30,
    y: (1.5 - Math.floor((n - 1) / 4)) * 30,
  };
}

/**
 * Objective checks only (aesthetics are judged separately, blind to the arm):
 * something was built, it stays on its plot, and its height is within 25% of
 * the brief.
 */
export function gradeBuilding(
  id: string,
  row: Brief,
  g: any,
  centre = { x: 0, y: 0 },
): Score {
  const built = !!g && g.objects > 0 && g.min && g.max;
  const onPlot =
    built &&
    g.min[0] >= centre.x - 10.5 &&
    g.max[0] <= centre.x + 10.5 &&
    g.min[1] >= centre.y - 10.5 &&
    g.max[1] <= centre.y + 10.5 &&
    g.min[2] >= -0.5;
  const target = Number(row.height);
  const height = built ? g.max[2] : 0;
  const heightOk = built && Math.abs(height - target) <= target * 0.25;
  const correct = [built, onPlot, heightOk].filter(Boolean).length;
  return {
    surface_id: id,
    success: correct === 3,
    wrong: built && correct < 3,
    commits: built ? 1 : 0,
    correct_items: correct,
    detail: { expected: row, measured: g ?? null },
  };
}
