import { rng } from "../benchmark/metrics.js";
import { desktopWorkload, type DesktopOptions } from "./desktop.js";
import type { Score, Workload } from "./types.js";

/** One building of the block: what to build on one plot. */
export type Brief = { style: string; height: string; brief: string } & Record<
  string,
  string
>;

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

/** The street's shared architecture: every house is this style. */
export const NORDIC =
  "a Scandinavian timber house: steep gable roof with deep eaves, vertical board cladding, white window frames with mullions, a front door under a small canopy, a brick chimney and a low stone plinth";
const CLADDING: [string, string][] = [
  ["falu red", "8E2B22"],
  ["ochre", "C8912E"],
  ["forest green", "2F5233"],
  ["slate blue", "4A6378"],
  ["off-white", "E9E4D6"],
  ["charcoal", "35363A"],
  ["sage", "8FA58A"],
  ["mustard", "D6A93A"],
];
const DOORS: [string, string][] = [
  ["white", "F2F2EE"],
  ["black", "1E1E1E"],
  ["teal", "2E7D7A"],
  ["oxblood", "5E1F1E"],
];

/** Thirty-two variations of one design (seeded). */
export function street(seed: number, count: number): Map<string, Brief> {
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  return new Map(
    Array.from({ length: count }, (_, i) => {
      const floors = r() < 0.6 ? 2 : 3;
      const width = pick(["6.5", "7", "7.5", "8", "8.5", "9"]);
      const [cname, chex] = pick(CLADDING);
      const [dname, dhex] = pick(DOORS);
      const roof = pick(["dark grey standing-seam metal", "red clay tiles"]);
      const balcony = r() < 0.4 ? "yes" : "no";
      const height = String(floors * 3 + 5);
      return [
        `W${String(i + 1).padStart(2, "0")}`,
        {
          style: "nordic house",
          height,
          brief: `${NORDIC}; ${width} m wide, ${floors} floors, ${cname} cladding (#${chex}), ${dname} door (#${dhex}), ${roof} roof, ${balcony === "yes" ? "a timber balcony on the upper floor" : "no balcony"}`,
          width,
          floors: String(floors),
          cladding: chex,
          door: dhex,
          roof,
          balcony,
        },
      ];
    }),
  );
}

/** A set of plots: which briefs, how many, and where (many-plot scene). */
type Plan = {
  scene: "city" | "street";
  cols: number;
  rows: number;
  briefs: (seed: number, count: number) => Map<string, Brief>;
  what: string;
};
export const PLANS: Record<"block" | "street", Plan> = {
  block: {
    scene: "city",
    cols: 4,
    rows: 4,
    briefs: block,
    what: "a city block of sixteen different buildings",
  },
  street: {
    scene: "street",
    cols: 8,
    rows: 4,
    briefs: street,
    what: `a street of thirty-two houses of one design, ${NORDIC}, each with its own variations`,
  },
};

/** Plot centre of Pn on a plan's grid (30 m spacing). */
export function plotCentre(n: number, cols = 4, rows = 4) {
  return {
    x: (((n - 1) % cols) - (cols - 1) / 2) * 30,
    y: ((rows - 1) / 2 - Math.floor((n - 1) / cols)) * 30,
  };
}

/**
 * The studio task. `studio` gives each building its own desktop (one plot,
 * collection Module); `many` gives one desktop every plot (collections
 * P01..Pnn of the plan's scene).
 */
export function studio(
  variant: "studio" | "many",
  o: DesktopOptions,
  plan: Plan = PLANS.block,
): Workload {
  const many = variant === "many";
  const total = plan.cols * plan.rows;
  const base = desktopWorkload<Brief>(
    {
      app: "blender",
      items: many ? total : 1,
      settle_ms: 60_000,
      summary: many
        ? `Blender is open on ${plan.what}: ${total} empty 20 x 20 m plots (collections P01..P${total}; their coordinates are in module.py). Build every plot's building from the task table below (row Wnn is plot Pnn). ${QUALITY} Each plot is one item: declare it done when its building is finished and saved.`
        : `This is ${plan.what}. Each surface runs Blender on one empty 20 x 20 m plot. Build that surface's building from its row of the task table, inside the collection Module. ${QUALITY} One item per surface: declare it done when the building is finished and saved.`,
      rows: (seed, count) => plan.briefs(seed, count),
      grader: [
        "blender",
        "-b",
        many ? `/work/${plan.scene}.blend` : "/work/studio.blend",
        "--python",
        "/opt/app/grade_module.py",
      ],
      // many: one desktop holds all plots; the wrapper below grades each.
      grade: (id, row, g) =>
        many
          ? {
              surface_id: id,
              success: false,
              wrong: false,
              commits: 0,
              detail: { raw: g },
            }
          : gradeBuilding(id, row, g?.Module),
    },
    { ...o, env: { ...(o.env ?? {}), SCENE: many ? plan.scene : "studio" } },
  );
  if (!many) return base;
  // One desktop carries every brief; its grade covers every plot.
  return {
    ...base,
    async open(directory, _count, seed) {
      const lab = await base.open(directory, 1, seed);
      const briefs = plan.briefs(seed, total);
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
              plotCentre(Number(id.slice(1)), plan.cols, plan.rows),
            ),
          );
        },
      };
    },
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
