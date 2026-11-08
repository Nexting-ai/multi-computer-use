import { LAYOUT, type Diagram } from "./diagram.js";

const point = (x: number, y: number) => `${Math.round(x)},${Math.round(y)}`;
const quoted = (value: string) => JSON.stringify(value);

export function diagramText(d: Diagram, layout: typeof LAYOUT) {
  const boxes = d.boxes.map(
    (b) =>
      `${quoted(b.label)} @ ${point(
        layout.origin.x + b.col * layout.cell.w,
        layout.origin.y + b.row * layout.cell.h,
      )}`,
  );
  const arrows = d.edges.map(
    ([from, to]) => `${quoted(from)} -> ${quoted(to)}`,
  );
  return [
    "Boxes (label @ top-left x,y):",
    ...boxes,
    "Arrows (source -> target):",
    ...arrows,
  ].join("\n");
}

export function boardText(elements: any[]) {
  const live = elements.filter((e) => !e.isDeleted);
  const byId = new Map(live.map((e) => [e.id, e]));
  const shapes = live.filter((e) =>
    ["rectangle", "ellipse", "diamond"].includes(e.type),
  );
  const labels = new Map<string, string>();
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
    if (host) {
      const value = String(t.originalText ?? t.text ?? "");
      labels.set(
        host.id,
        labels.has(host.id) ? `${labels.get(host.id)} ${value}` : value,
      );
    }
  }
  const boxes = shapes.map((s) => {
    const label = labels.get(s.id);
    return `${label === undefined ? `(unlabelled ${s.type})` : quoted(label)} @ ${point(s.x, s.y)}`;
  });
  const arrows = live
    .filter((e) => e.type === "arrow")
    .map((a) => {
      const from = labels.get(a.startBinding?.elementId);
      const to = labels.get(a.endBinding?.elementId);
      const ends =
        from === undefined || to === undefined
          ? ` @ ${point(a.x, a.y)} -> ${point(
              a.x + (a.points?.at(-1)?.[0] ?? a.width ?? 0),
              a.y + (a.points?.at(-1)?.[1] ?? a.height ?? 0),
            )}`
          : "";
      return `${from === undefined ? "(unbound)" : quoted(from)} -> ${to === undefined ? "(unbound)" : quoted(to)}${ends}`;
    });
  return [
    "Boxes (label @ top-left x,y):",
    ...boxes,
    "Arrows (source -> target):",
    ...arrows,
  ].join("\n");
}
