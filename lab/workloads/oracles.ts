/**
 * Hand-written fleet policies, one per item, written from one exemplar
 * screenshot the way a model would. They exercise the runtime and the
 * desktops end to end without a model (see check.ts).
 */
type Rect = { x: number; y: number; width: number; height: number };
export type OraclePolicy = {
  name: string;
  fields: { name: string; rect: Rect }[];
  ignore?: Rect[];
  inputs?: string[];
  steps: unknown[];
  verify: unknown;
};

// Blender, 1600x1000, UI scale 1.25, window maximised. Value rectangles cover
// the value column only; clicks land on the left of each field.
const bViewport = { x: 0, y: 60, width: 1046, height: 840 };
const bTitle = { x: 400, y: 0, width: 800, height: 24 };
const bTransform = { x: 1046, y: 190, width: 230, height: 430 };
const bEdit = (x: number, y: number, input: string) => [
  { kind: "click", x, y },
  { kind: "key_chord", keys: ["Ctrl", "a"] },
  { kind: "type_field", field: input },
  { kind: "key_chord", keys: ["Enter"] },
];
export const blenderOracle: OraclePolicy[] = [
  {
    name: "dimensions",
    fields: [
      { name: "dims", rect: { x: 1195, y: 540, width: 79, height: 76 } },
      { name: "title", rect: bTitle },
    ],
    ignore: [bViewport],
    inputs: ["width", "depth", "height"],
    steps: [
      ...bEdit(1105, 552, "width"),
      ...bEdit(1105, 577, "depth"),
      ...bEdit(1105, 603, "height"),
    ],
    verify: { field: "dims", contains: ["{width}m", "{depth}m", "{height}m"] },
  },
  {
    name: "location",
    fields: [
      { name: "loc", rect: { x: 1160, y: 194, width: 62, height: 50 } },
      { name: "title", rect: bTitle },
    ],
    ignore: [bViewport, bTransform],
    inputs: ["x", "y"],
    steps: [...bEdit(1100, 206, "x"), ...bEdit(1100, 231, "y")],
    verify: { field: "loc", contains: ["{x}m", "{y}m"] },
  },
  {
    name: "colour",
    fields: [
      { name: "hex", rect: { x: 1320, y: 700, width: 110, height: 30 } },
      { name: "title", rect: bTitle },
    ],
    ignore: [bViewport, bTransform],
    inputs: ["color"],
    steps: [
      { kind: "click", x: 1516, y: 830 },
      { kind: "click", x: 1505, y: 676 },
      ...bEdit(1480, 715, "color"),
    ],
    verify: { field: "hex", contains: ["{color}"] },
  },
  {
    name: "save",
    fields: [{ name: "title", rect: bTitle }],
    // The colour picker may still be open over the properties.
    ignore: [
      bViewport,
      bTransform,
      { x: 1300, y: 400, width: 300, height: 450 },
    ],
    steps: [
      { kind: "click", x: 600, y: 960 },
      { kind: "key_chord", keys: ["Ctrl", "s"] },
    ],
    verify: { field: "title", contains: ["Blender[/work/scene.blend]"] },
  },
];

// KiCad PCB Editor, 1600x1000, board zoomed to fit. Texts are edited through
// their properties dialog (select, E, type, OK); the status bar shows the
// selected text and the save message.
const kCanvas = { x: 36, y: 122, width: 1286, height: 820 };
const kSelected = { x: 0, y: 955, width: 300, height: 24 };
const kMessage = { x: 0, y: 976, width: 360, height: 24 };
const kTitle = { x: 0, y: 0, width: 1600, height: 24 };
const kStatus = { x: 0, y: 944, width: 1600, height: 56 };
const kEdit = (x: number, y: number, input: string) => [
  { kind: "click", x, y },
  { kind: "key_chord", keys: ["e"] },
  { kind: "type_field", field: input },
  { kind: "click", x: 995, y: 638 },
];
export const kicadOracle: OraclePolicy[] = [
  {
    name: "name",
    fields: [{ name: "selected", rect: kSelected }],
    ignore: [kCanvas],
    inputs: ["name"],
    steps: kEdit(680, 442, "name"),
    verify: { field: "selected", contains: ["{name}"] },
  },
  {
    name: "role",
    fields: [{ name: "selected", rect: kSelected }],
    // The new name changes the canvas above ROLE, the title's unsaved mark
    // and the status bar's column layout.
    ignore: [{ x: 36, y: 122, width: 1286, height: 500 }, kTitle, kStatus],
    inputs: ["role"],
    steps: kEdit(680, 667, "role"),
    verify: { field: "selected", contains: ["{role}"] },
  },
  {
    name: "save",
    fields: [
      { name: "message", rect: kMessage },
      { name: "selected", rect: kSelected },
    ],
    ignore: [kCanvas, kTitle, kStatus],
    // Click empty canvas below the board (deselects), then save.
    steps: [
      { kind: "click", x: 200, y: 900 },
      { kind: "key_chord", keys: ["Ctrl", "s"] },
    ],
    verify: { field: "message", contains: ["saved"] },
  },
];
