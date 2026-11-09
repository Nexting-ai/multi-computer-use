/**
 * The shared canvas: a grid of colour cells, a fixed palette, and the target
 * picture agents reproduce (a skyline at sunset with the word NEXTING).
 */
export const COLS = 64;
export const ROWS = 40;

/** Palette: index -> [name, hex, letter used in the text grid]. */
export const PALETTE: [string, string, string][] = [
  ["white", "#ffffff", "."],
  ["black", "#111318", "K"],
  ["navy", "#1d2b53", "N"],
  ["blue", "#2f6fdf", "B"],
  ["sky", "#7cc4ff", "S"],
  ["purple", "#6b3fa0", "P"],
  ["pink", "#ff77a8", "I"],
  ["orange", "#ff9a3c", "O"],
  ["yellow", "#ffe14d", "Y"],
  ["green", "#2fb67a", "G"],
  ["gray", "#8a90a0", "R"],
  ["red", "#e5484d", "D"],
];
export const LETTER = Object.fromEntries(PALETTE.map(([, , l], i) => [l, i]));

export type Grid = number[]; // ROWS * COLS colour indices, row-major

const FONT: Record<string, string[]> = {
  N: ["X...X", "XX..X", "X.X.X", "X..XX", "X...X"],
  E: ["XXXXX", "X....", "XXXX.", "X....", "XXXXX"],
  X: ["X...X", ".X.X.", "..X..", ".X.X.", "X...X"],
  T: ["XXXXX", "..X..", "..X..", "..X..", "..X.."],
  I: ["XXX", ".X.", ".X.", ".X.", "XXX"],
  G: [".XXXX", "X....", "X..XX", "X...X", ".XXX."],
};

export function target(): Grid {
  const g: Grid = Array(ROWS * COLS).fill(0);
  const set = (c: number, r: number, v: number) => {
    if (c >= 0 && c < COLS && r >= 0 && r < ROWS) g[r * COLS + c] = v;
  };
  const rect = (c0: number, r0: number, c1: number, r1: number, v: number) => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) set(c, r, v);
  };
  // Sky bands.
  rect(0, 0, 63, 9, 5);
  rect(0, 10, 63, 15, 6);
  rect(0, 16, 63, 21, 7);
  // Sun.
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      if ((c - 46) ** 2 + (r - 18) ** 2 <= 36 && r <= 22) set(c, r, 8);
  // Word NEXTING, white, on the purple band.
  let x = 13;
  for (const ch of "NEXTING") {
    const f = FONT[ch]!;
    f.forEach((row, ry) =>
      [...row].forEach((p, rx) => p === "X" && set(x + rx, 2 + ry, 0)),
    );
    x += f[0]!.length + 1;
  }
  // Skyline: buildings with windows.
  const towers: [number, number, number, number][] = [
    [0, 5, 20, 2],
    [6, 9, 14, 1],
    [10, 15, 18, 2],
    [16, 19, 24, 1],
    [20, 27, 12, 2],
    [28, 31, 19, 1],
    [32, 37, 16, 2],
    [38, 41, 22, 1],
    [42, 49, 17, 2],
    [50, 53, 13, 1],
    [54, 59, 21, 2],
    [60, 63, 15, 1],
  ];
  for (const [c0, c1, top, tone] of towers) {
    rect(c0, top, c1, 31, tone);
    for (let r = top + 2; r <= 29; r += 3)
      for (let c = c0 + 1; c < c1; c += 2) set(c, r, 8);
  }
  // Water with a reflection of the sun.
  rect(0, 32, 63, 39, 3);
  for (let r = 33; r <= 39; r += 2)
    rect(42 - (r - 33) / 2, r, 50 + (r - 33) / 2, r, 7);
  rect(0, 32, 63, 32, 4);
  return g;
}

/** The target as text: one line per row, one palette letter per cell. */
export function gridText(g: Grid) {
  const lines: string[] = [];
  for (let r = 0; r < ROWS; r++)
    lines.push(
      `${String(r).padStart(2, "0")} ` +
        g
          .slice(r * COLS, (r + 1) * COLS)
          .map((v) => PALETTE[v]![2])
          .join(""),
    );
  return lines.join("\n");
}

export function match(a: Grid, b: Grid) {
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}
