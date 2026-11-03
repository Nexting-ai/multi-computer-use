import { test, expect } from "vitest";
import { nodes } from "../src/ocr.js";
import { xdotool } from "../src/keys.js";

test("OCR lines become text nodes in reading order; low confidence is dropped", () => {
  expect(
    nodes([
      [938.4, 667, 980.6, 690, "12 m", 0.91],
      [734, 574, 830, 596, "Dimensions:", 1],
      [760, 609, 772, 630, "?", 0.3],
    ]),
  ).toEqual([
    {
      role: "StaticText",
      text: "Dimensions:",
      rect: { x: 734, y: 574, width: 96, height: 22 },
    },
    {
      role: "StaticText",
      text: "12 m",
      rect: { x: 938, y: 667, width: 42, height: 23 },
    },
  ]);
});

test("key chords map to xdotool keysyms", () => {
  expect(xdotool({ kind: "key_chord", keys: ["Ctrl", "s"] })).toEqual([
    ["key", "--clearmodifiers", "ctrl+s"],
  ]);
  expect(xdotool({ kind: "key_chord", keys: ["F12"] })).toEqual([
    ["key", "--clearmodifiers", "F12"],
  ]);
  expect(xdotool({ kind: "click", x: 3, y: 4 })).toEqual([
    ["mousemove", "--sync", "3", "4"],
    ["click", "1"],
  ]);
});
