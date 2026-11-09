import sharp from "sharp";
import type { Rect } from "./index.js";

export type Gray = { width: number; height: number; data: Uint8Array };
export type Match = {
  x: number;
  y: number;
  /** Mean absolute grey difference over unmasked template pixels (0–255). */
  mad: number;
  /** Fraction of unmasked pixels differing by more than 48 grey levels. */
  outliers: number;
  /** Local check around every click target (false = some target differs). */
  points_ok?: boolean | undefined;
  point_mad?: number | undefined;
  point_outliers?: number | undefined;
};
/** A compiled template plus the click targets that must also match locally. */
export type Template = {
  gray: Gray;
  mask: Uint8Array;
  /** Template-local click points and a mask excluding only value fields. */
  points?: { x: number; y: number }[];
  pointMask?: Uint8Array;
};
/**
 * Whole-template registration can pass on sparse pages even when a small
 * control moved: few pixels change. Every click target is therefore checked in
 * a local window at the registered offset, against the exemplar's unmasked
 * pre-action pixels (value fields excluded). Any mismatch rejects the surface.
 */
export function register(
  frame: Gray,
  t: Template,
  hint?: { x: number; y: number },
): Match | null {
  const m = locate(frame, t.gray, t.mask, hint);
  if (!m || !t.points?.length) return m;
  const half = 14;
  let worstMad = 0,
    worstOut = 0;
  for (const p of t.points) {
    let sum = 0,
      n = 0,
      out = 0;
    for (
      let y = Math.max(0, p.y - half);
      y < Math.min(t.gray.height, p.y + half);
      y++
    )
      for (
        let x = Math.max(0, p.x - half);
        x < Math.min(t.gray.width, p.x + half);
        x++
      ) {
        const i = y * t.gray.width + x;
        if (t.pointMask && !t.pointMask[i]) continue;
        const fx = m.x + x,
          fy = m.y + y;
        if (fx < 0 || fy < 0 || fx >= frame.width || fy >= frame.height) {
          out++;
          n++;
          continue;
        }
        const d = Math.abs(
          frame.data[fy * frame.width + fx]! - t.gray.data[i]!,
        );
        sum += d;
        n++;
        if (d > 48) out++;
      }
    // A target whose neighbourhood is mostly value-field pixels cannot be
    // verified; treat it as a mismatch rather than a vacuous pass.
    if (n < 0.5 * (2 * half) * (2 * half)) {
      worstOut = 1;
      continue;
    }
    worstMad = Math.max(worstMad, sum / n);
    worstOut = Math.max(worstOut, out / n);
  }
  return {
    ...m,
    point_mad: worstMad,
    point_outliers: worstOut,
    points_ok: worstMad <= 6 && worstOut <= 0.03,
  };
}

export async function gray(png: Buffer): Promise<Gray> {
  const { data, info } = await sharp(png, { limitInputPixels: 4_000_000 })
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

export function crop(g: Gray, r: Rect): Gray {
  if (
    r.x < 0 ||
    r.y < 0 ||
    r.width < 1 ||
    r.height < 1 ||
    r.x + r.width > g.width ||
    r.y + r.height > g.height
  )
    throw Error("crop_outside_image");
  const data = new Uint8Array(r.width * r.height);
  for (let y = 0; y < r.height; y++)
    data.set(
      g.data.subarray(
        (r.y + y) * g.width + r.x,
        (r.y + y) * g.width + r.x + r.width,
      ),
      y * r.width,
    );
  return { width: r.width, height: r.height, data };
}

/** 1 = compared pixel; masked rectangles are in template-local coordinates. */
export function maskFor(width: number, height: number, masked: Rect[]) {
  const m = new Uint8Array(width * height).fill(1);
  for (const r of masked)
    for (let y = Math.max(0, r.y); y < Math.min(height, r.y + r.height); y++)
      m.fill(
        0,
        y * width + Math.max(0, r.x),
        y * width + Math.min(width, r.x + r.width),
      );
  return m;
}

function down(g: Gray, m: Uint8Array | null, f: number) {
  const w = Math.floor(g.width / f),
    h = Math.floor(g.height / f),
    data = new Uint8Array(w * h),
    mask = m ? new Uint8Array(w * h) : null;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0,
        n = 0,
        all = true;
      for (let dy = 0; dy < f; dy++)
        for (let dx = 0; dx < f; dx++) {
          const i = (y * f + dy) * g.width + x * f + dx;
          s += g.data[i]!;
          n++;
          if (m && !m[i]) all = false;
        }
      data[y * w + x] = Math.round(s / n);
      if (mask) mask[y * w + x] = all ? 1 : 0;
    }
  return { g: { width: w, height: h, data }, m: mask };
}

/** Half-size of the exact search window around a hint, in pixels. */
const NEAR = 24;

function score(
  frame: Gray,
  t: Gray,
  m: Uint8Array,
  ox: number,
  oy: number,
  limit = Infinity,
) {
  let sum = 0,
    n = 0,
    out = 0;
  for (let y = 0; y < t.height; y++) {
    const fr = (oy + y) * frame.width + ox,
      tr = y * t.width;
    for (let x = 0; x < t.width; x++) {
      if (!m[tr + x]) continue;
      const d = Math.abs(frame.data[fr + x]! - t.data[tr + x]!);
      sum += d;
      n++;
      if (d > 48) out++;
    }
    if (sum > limit) return { sum: Infinity, n, out };
  }
  return { sum, n, out };
}

/**
 * Translation-only registration of a template in a frame: exhaustive coarse
 * search on an area-averaged pyramid, then exact full-resolution refinement.
 * Pixels only; no DOM, layout metadata or fixture coordinates.
 */
export function locate(
  frame: Gray,
  template: Gray,
  mask: Uint8Array,
  hint?: { x: number; y: number },
): Match | null {
  if (template.width > frame.width || template.height > frame.height)
    return null;
  const full = (x: number, y: number): Match | null => {
    if (
      x < 0 ||
      y < 0 ||
      x + template.width > frame.width ||
      y + template.height > frame.height
    )
      return null;
    const s = score(frame, template, mask, x, y);
    return s.n ? { x, y, mad: s.sum / s.n, outliers: s.out / s.n } : null;
  };
  if (hint) {
    const h = full(hint.x, hint.y);
    if (h && h.mad < 0.5 && h.outliers === 0) return h;
    // Most templates barely move: an exact search near the hint first.
    let best: { x: number; y: number; s: number } | null = null;
    for (let dy = -NEAR; dy <= NEAR; dy++)
      for (let dx = -NEAR; dx <= NEAR; dx++) {
        const x = hint.x + dx,
          y = hint.y + dy;
        if (
          x < 0 ||
          y < 0 ||
          x + template.width > frame.width ||
          y + template.height > frame.height
        )
          continue;
        const s: number = score(
          frame,
          template,
          mask,
          x,
          y,
          best?.s ?? Infinity,
        ).sum;
        if (!best || s < best.s) best = { x, y, s };
      }
    const near = best && full(best.x, best.y);
    if (near && acceptable(near)) return near;
  }
  // Power-of-two pyramid so every level maps exactly onto the next. Thin
  // templates (a toolbar strip) still get coarse levels: an exhaustive
  // full-resolution search over a whole screen is far too slow.
  let top = 1;
  while (top < 8 && top * 2 * 6 <= Math.min(template.width, template.height))
    top *= 2;
  // Coarse-to-fine: exhaustive search at the top level, then ±2 refinement
  // of the best candidates at each finer level of the pyramid.
  const levels: number[] = [];
  for (let f = top; f >= 1; f = Math.floor(f / 2)) {
    levels.push(f);
    if (f === 1) break;
  }
  if (levels.at(-1) !== 1) levels.push(1);
  let candidates: { x: number; y: number; s: number }[] = [];
  let previous = 0;
  for (const f of levels) {
    const F = f === 1 ? frame : down(frame, null, f).g,
      T = f === 1 ? { g: template, m: mask } : down(template, mask, f);
    const keep = f === 1 ? 1 : 4;
    const next: { x: number; y: number; s: number }[] = [];
    const visit = (x: number, y: number) => {
      if (
        x < 0 ||
        y < 0 ||
        x + T.g.width > F.width ||
        y + T.g.height > F.height
      )
        return;
      if (next.some((c) => c.x === x && c.y === y)) return;
      const worst = next.length >= keep ? next[keep - 1]!.s : Infinity;
      const s = score(F, T.g, T.m!, x, y, worst).sum;
      if (s < worst) {
        next.push({ x, y, s });
        next.sort((a, b) => a.s - b.s);
        next.length = Math.min(next.length, keep);
      }
    };
    if (!previous)
      for (let y = 0; y + T.g.height <= F.height; y++)
        for (let x = 0; x + T.g.width <= F.width; x++) visit(x, y);
    else
      for (const c of candidates) {
        const r = previous / f,
          bx = c.x * r,
          by = c.y * r;
        for (let dy = -2; dy <= r + 1; dy++)
          for (let dx = -2; dx <= r + 1; dx++) visit(bx + dx, by + dy);
      }
    candidates = next;
    previous = f;
  }
  const best = candidates[0] ? full(candidates[0].x, candidates[0].y) : null;
  return best;
}

/** Coarse appearance fingerprint (16-bin luminance histogram). Grouping only. */
export function fingerprint(g: Gray) {
  const h = new Array<number>(16).fill(0);
  let n = 0;
  for (let i = 0; i < g.data.length; i += 7) {
    h[g.data[i]! >> 4]!++;
    n++;
  }
  return h.map((v) => v / n);
}
/**
 * Strict by default: every pixel the policy did not declare as varying must be
 * (near-)identical. A tolerant threshold let small label changes pass on sparse
 * pages (same-looking inputs whose labels were reordered). "lenient" is kept
 * only for ablation.
 */
export const acceptable = (
  m: Match | null,
  mode: "strict" | "lenient" = "strict",
) =>
  !!m &&
  (mode === "strict"
    ? m.mad <= 0.25 && m.outliers <= 0.0005
    : m.mad <= 3 && m.outliers <= 0.004) &&
  m.points_ok !== false;
