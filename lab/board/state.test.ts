import { describe, expect, test } from "vitest";
import type { Diagram } from "./diagram.js";
import { boardText, diagramText } from "./state.js";

const layout = {
  origin: { x: 10, y: 20 },
  cell: { w: 100, h: 80 },
  box: { w: 60, h: 30 },
  font: 16,
};
const target: Diagram = {
  seed: 1,
  boxes: [
    { id: "b0", label: "Web app", col: 0, row: 0 },
    { id: "b1", label: "Auth", col: 1, row: 1 },
  ],
  edges: [["Web app", "Auth"]],
};

describe("diagramText", () => {
  test("describes the reference labels, positions and arrow direction", () => {
    expect(diagramText(target, layout)).toBe(
      [
        "Boxes (label @ top-left x,y):",
        '"Web app" @ 10,20',
        '"Auth" @ 110,100',
        "Arrows (source -> target):",
        '"Web app" -> "Auth"',
      ].join("\n"),
    );
  });
});

describe("boardText", () => {
  test("describes live boxes and bindings without hiding unbound or unlabelled elements", () => {
    const elements = [
      { id: "r1", type: "rectangle", x: 10, y: 20, width: 60, height: 30 },
      {
        id: "t1",
        type: "text",
        x: 15,
        y: 25,
        width: 40,
        height: 20,
        containerId: "r1",
        originalText: "Web app",
      },
      { id: "r2", type: "rectangle", x: 110, y: 100, width: 60, height: 30 },
      {
        id: "t2",
        type: "text",
        x: 125,
        y: 105,
        width: 30,
        height: 20,
        originalText: "Auth",
      },
      {
        id: "a1",
        type: "arrow",
        x: 70,
        y: 35,
        points: [
          [0, 0],
          [40, 65],
        ],
        startBinding: { elementId: "r1" },
        endBinding: { elementId: "r2" },
      },
      {
        id: "a2",
        type: "arrow",
        x: 20,
        y: 140,
        points: [
          [0, 0],
          [40, 40],
        ],
        startBinding: null,
        endBinding: null,
      },
      { id: "d1", type: "diamond", x: 200, y: 20, width: 60, height: 30 },
      {
        id: "deleted",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 20,
        height: 20,
        isDeleted: true,
      },
      {
        id: "deleted-text",
        type: "text",
        x: 0,
        y: 0,
        width: 20,
        height: 20,
        containerId: "deleted",
        originalText: "Deleted",
        isDeleted: true,
      },
    ];

    expect(boardText(elements)).toBe(
      [
        "Boxes (label @ top-left x,y):",
        '"Web app" @ 10,20',
        '"Auth" @ 110,100',
        "(unlabelled diamond) @ 200,20",
        "Arrows (source -> target):",
        '"Web app" -> "Auth"',
        "(unbound) -> (unbound) @ 20,140 -> 60,180",
      ].join("\n"),
    );
  });
});
