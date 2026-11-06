/**
 * Target diagrams (seeded): labelled boxes on a grid and directed arrows
 * between them, and the grader that reads a board's Excalidraw elements back
 * into boxes and arrows.
 */
import { rng } from "../benchmark/metrics.js";

const NAMES = [
  "Web app",
  "Mobile app",
  "API gateway",
  "Auth",
  "Users",
  "Orders",
  "Payments",
  "Inventory",
  "Search",
  "Catalog",
  "Cart",
  "Checkout",
  "Shipping",
  "Billing",
  "Email",
  "SMS",
  "Push",
  "Analytics",
  "Events",
  "Queue",
  "Cache",
  "Database",
  "Storage",
  "CDN",
  "Logs",
  "Metrics",
  "Alerts",
  "Admin",
  "Reports",
  "Recommendations",
  "Reviews",
  "Pricing",
  "Tax",
  "Fraud",
  "Ledger",
  "Warehouse",
  "Returns",
  "Support",
  "Chat",
  "Scheduler",
];

export type Box = { id: string; label: string; col: number; row: number };
export type Diagram = { seed: number; boxes: Box[]; edges: [string, string][] };

/** cols x rows boxes; each box links to one or two neighbours to its right
 * or below, so arrows stay short and readable. */
export function diagram(seed: number, cols = 6, rows = 4): Diagram {
  const r = rng(seed);
  const names = [...NAMES].sort(() => r() - 0.5).slice(0, cols * rows);
  const boxes = names.map((label, i) => ({
    id: `b${i}`,
    label,
    col: i % cols,
    row: Math.floor(i / cols),
  }));
  const at = (c: number, w: number) =>
    boxes.find((b) => b.col === c && b.row === w);
  const edges: [string, string][] = [];
  for (const b of boxes) {
    const right = at(b.col + 1, b.row),
      down = at(b.col, b.row + 1),
      diag = at(b.col + 1, b.row + 1);
    const options = [right, down, diag].filter(Boolean) as Box[];
    const n = options.length ? (r() < 0.35 ? 2 : 1) : 0;
    for (const t of options.sort(() => r() - 0.5).slice(0, n))
      edges.push(r() < 0.8 ? [b.label, t.label] : [t.label, b.label]);
  }
  return { seed, boxes, edges };
}

/** Excalidraw element skeletons for convertToExcalidrawElements (to render
 * the target picture with the real editor). */
export const LAYOUT = {
  origin: { x: 270, y: 130 },
  cell: { w: 165, h: 150 },
  box: { w: 130, h: 56 },
};
/** A point just outside box `p`'s edge, on the line toward box `q` (both
 * top-left positions), so arrows run edge to edge and never cross a label. */
function edgePoint(
  p: { x: number; y: number },
  q: { x: number; y: number },
  box: { w: number; h: number },
  gap: number,
) {
  const cx = p.x + box.w / 2,
    cy = p.y + box.h / 2;
  const dx = q.x - p.x,
    dy = q.y - p.y;
  const k = Math.min(
    dx ? (box.w / 2 + gap) / Math.abs(dx) : Infinity,
    dy ? (box.h / 2 + gap) / Math.abs(dy) : Infinity,
  );
  return { x: cx + dx * k, y: cy + dy * k };
}

export function skeleton(d: Diagram, { origin, cell, box } = LAYOUT) {
  const pos = (b: Box) => ({
    x: origin.x + b.col * cell.w,
    y: origin.y + b.row * cell.h,
  });
  const out: unknown[] = d.boxes.map((b) => ({
    type: "rectangle",
    id: b.id,
    ...pos(b),
    width: box.w,
    height: box.h,
    roughness: 0,
    strokeWidth: 2,
    label: { text: b.label, fontSize: 16, fontFamily: 2 },
  }));
  const byLabel = new Map(d.boxes.map((b) => [b.label, b]));
  for (const [a, z] of d.edges) {
    const A = byLabel.get(a)!,
      Z = byLabel.get(z)!;
    const s = edgePoint(pos(A), pos(Z), box, 6),
      e = edgePoint(pos(Z), pos(A), box, 6);
    out.push({
      type: "arrow",
      x: s.x,
      y: s.y,
      width: e.x - s.x,
      height: e.y - s.y,
      points: [
        [0, 0],
        [e.x - s.x, e.y - s.y],
      ],
      roughness: 0,
      strokeWidth: 2,
      endArrowhead: "triangle",
      start: { id: A.id },
      end: { id: Z.id },
    });
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Boxes (rectangle-like shapes with a bound or contained text) and arrows
 * bound at both ends, read from board elements, scored against the target. */
export function grade(d: Diagram, elements: any[]) {
  const live = elements.filter((e) => !e.isDeleted);
  const byId = new Map(live.map((e) => [e.id, e]));
  const shapes = live.filter((e) =>
    ["rectangle", "ellipse", "diamond"].includes(e.type),
  );
  // A shape's label: its bound text, or a free text element whose centre lies inside it.
  const label = new Map<string, string>();
  for (const t of live.filter((e) => e.type === "text")) {
    const host = t.containerId
      ? byId.get(t.containerId)
      : shapes.find(
          (s) =>
            t.x + t.width / 2 >= s.x &&
            t.x + t.width / 2 <= s.x + s.width &&
            t.y + t.height / 2 >= s.y &&
            t.y + t.height / 2 <= s.y + s.height,
        );
    if (host)
      label.set(
        host.id,
        norm(
          (label.get(host.id) ? label.get(host.id) + " " : "") +
            (t.originalText ?? t.text ?? ""),
        ),
      );
  }
  const want = new Map(d.boxes.map((b) => [norm(b.label), b]));
  const found = new Map<string, number>();
  for (const s of shapes) {
    const l = label.get(s.id);
    if (l && want.has(l)) found.set(l, (found.get(l) ?? 0) + 1);
  }
  const boxesRight = [...want.keys()].filter((l) => found.get(l) === 1).length;
  const duplicates = [...found.values()].filter((n) => n > 1).length;
  const arrows = live.filter((e) => e.type === "arrow");
  const edgesGot = new Set<string>();
  let unbound = 0;
  for (const a of arrows) {
    const s = a.startBinding?.elementId,
      e = a.endBinding?.elementId;
    const ls = s && label.get(s),
      le = e && label.get(e);
    if (ls && le) edgesGot.add(`${ls}→${le}`);
    else unbound++;
  }
  const edgesWant = new Set(d.edges.map(([a, z]) => `${norm(a)}→${norm(z)}`));
  const edgesRight = [...edgesWant].filter((e) => edgesGot.has(e)).length;
  const edgesWrong = [...edgesGot].filter((e) => !edgesWant.has(e)).length;
  const total = want.size + edgesWant.size;
  const score = (boxesRight + edgesRight) / total;
  return {
    score,
    complete:
      boxesRight === want.size &&
      edgesRight === edgesWant.size &&
      edgesWrong === 0 &&
      duplicates === 0,
    boxes: { right: boxesRight, of: want.size, duplicates },
    edges: {
      right: edgesRight,
      of: edgesWant.size,
      wrong: edgesWrong,
      unbound,
    },
  };
}
