import { rng } from "../benchmark/metrics.js";
import { desktopWorkload, type DesktopOptions } from "./desktop.js";
import type { Score } from "./types.js";

/** One badge of the order: the two silkscreen lines. */
export type Badge = { name: string; role: string };

const NAMES = [
  "ADA LOVELACE",
  "GRACE HOPPER",
  "ALAN TURING",
  "KATHERINE JOHNSON",
  "CLAUDE SHANNON",
  "MARGARET HAMILTON",
  "JOHN VON NEUMANN",
  "BARBARA LISKOV",
  "DONALD KNUTH",
  "FRANCES ALLEN",
  "KEN THOMPSON",
  "RADIA PERLMAN",
  "DENNIS RITCHIE",
  "SOPHIE WILSON",
  "EDSGER DIJKSTRA",
  "LYNN CONWAY",
  "TIM BERNERS-LEE",
  "HEDY LAMARR",
  "LINUS TORVALDS",
  "ANITA BORG",
];
const ROLES = [
  "ENGINEER",
  "DESIGNER",
  "RESEARCHER",
  "ARCHITECT",
  "SPEAKER",
  "MENTOR",
];

/** Deterministic badge order: distinct names, roles drawn per badge. */
export function order(seed: number, count: number): Map<string, Badge> {
  const r = rng(seed);
  const names = [...NAMES];
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [names[i], names[j]] = [names[j]!, names[i]!];
  }
  return new Map(
    Array.from({ length: count }, (_, i) => [
      `W${String(i + 1).padStart(2, "0")}`,
      {
        name: names[i % names.length]!,
        role: ROLES[Math.floor(r() * ROLES.length)]!,
      },
    ]),
  );
}

/** KiCad: personalise one conference badge PCB per desktop. */
export const kicad = (o: DesktopOptions) =>
  desktopWorkload<Badge>(
    {
      app: "kicad",
      items: 3,
      settle_ms: 20_000,
      summary:
        "Each surface runs the KiCad PCB Editor with a conference badge board that carries two silkscreen texts, NAME and ROLE. Personalise each surface's badge from its row of the task table: (1) change the text NAME to the name; (2) change the text ROLE to the role; (3) save the board in place (Ctrl+S). These are three items per surface, in this order. Use only the KiCad user interface: no scripting console, plugins, file dialogs or other applications. Unknown or delivered inputs must not be repeated.",
      rows: order,
      grader: ["python3", "/opt/app/grade.py", "/work/badge.kicad_pcb"],
      grade: gradeBadge,
    },
    o,
  );

/** Grades the saved board: both texts as ordered and a clean design rule check. */
export function gradeBadge(id: string, row: Badge, g: any): Score {
  const texts: string[] = g?.texts ?? [];
  const items = {
    name: texts.includes(row.name),
    role: texts.includes(row.role),
  };
  const saved =
    texts.length > 0 && !(texts.includes("NAME") && texts.includes("ROLE"));
  const clean = g?.drc_violations === 0;
  const correct = Object.values(items).filter(Boolean).length;
  return {
    surface_id: id,
    success: correct === 2 && clean,
    wrong: saved && (correct < 2 || !clean),
    commits: saved ? 1 : 0,
    correct_items: correct,
    detail: { expected: row, saved: g },
  };
}
