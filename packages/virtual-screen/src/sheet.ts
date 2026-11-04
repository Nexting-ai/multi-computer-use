import sharp from "sharp";

/**
 * One labelled grid image of many surfaces, so a model reviews a whole fleet
 * in a single look instead of one screenshot per surface.
 */
export async function tileSheet(
  tiles: { label: string; png: Buffer }[],
  tile: { width: number; height: number },
  columns = Math.ceil(Math.sqrt(tiles.length)),
): Promise<Buffer> {
  const gap = 6,
    band = 22;
  const rows = Math.ceil(tiles.length / columns);
  const cellW = tile.width,
    cellH = tile.height + band;
  const parts = await Promise.all(
    tiles.map(async (t, i) => {
      const x = (i % columns) * (cellW + gap),
        y = Math.floor(i / columns) * (cellH + gap);
      const image = await sharp(t.png)
        .resize(tile.width, tile.height, {
          fit: "contain",
          background: "#1b1b1b",
        })
        .toBuffer();
      const label = Buffer.from(
        `<svg width="${cellW}" height="${band}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#1b1b1b"/><text x="6" y="16" font-family="Arial" font-size="14" font-weight="bold" fill="#fff">${t.label.replace(/[<&>]/g, "")}</text></svg>`,
      );
      return [
        { input: label, left: x, top: y },
        { input: image, left: x, top: y + band },
      ];
    }),
  );
  return sharp({
    create: {
      width: columns * (cellW + gap) - gap,
      height: rows * (cellH + gap) - gap,
      channels: 3,
      background: "#000",
    },
  })
    .composite(parts.flat())
    .png()
    .toBuffer();
}
