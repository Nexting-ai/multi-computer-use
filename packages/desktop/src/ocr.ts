import type { TextNode } from "@cu/virtual-screen";

/** One recognised text line: [x0, y0, x1, y1, text, confidence], in pixels. */
export type OcrLine = [number, number, number, number, string, number];

/**
 * Text lines as text nodes, the shape an accessibility layer would expose.
 * Lines below `minConf` are dropped: an unread value must stay unread rather
 * than become a guess.
 */
export function nodes(lines: OcrLine[], minConf = 0.6): TextNode[] {
  return lines
    .filter(([, , , , text, conf]) => text.trim() && conf >= minConf)
    .map(([x0, y0, x1, y1, text]) => ({
      role: "StaticText",
      text: text.trim(),
      rect: {
        x: Math.round(x0),
        y: Math.round(y0),
        width: Math.round(x1 - x0),
        height: Math.round(y1 - y0),
      },
    }))
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}
