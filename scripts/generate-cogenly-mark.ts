#!/usr/bin/env node

// Writes the Cogenly mark masters (assets/brand/cogenly-mark.svg and
// cogenly-mark-small.svg). The tile's ember is not a smooth gradient: it is a
// coarse pixel grid, ordered-dithered (4x4 Bayer) between three quantized ember
// tones, like the boot splash's pixel mosaic. The rounded silhouette clips the
// grid and stays smooth; only the fill is pixelated. Cells sit on the 128 box
// at 8 units (16 across) for the full mark and 16 units (8 across) for the
// small cut, so renders at 16/32/48/64/128/256/1024 land on whole pixels.
//
// Run `node scripts/generate-cogenly-mark.ts`, then `vp run icons:mark` to
// re-render the tracked icons.

import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as NodeUrl from "node:url";

const EMBER_FROM = [0xff, 0x7b, 0x3a] as const;
const EMBER_TO = [0xe6, 0x3e, 0x22] as const;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;
const BOX = 128;
const CORNER = 28;

const GLYPH =
  '<path d="M79.85 41.64A28 28 0 1 0 79.85 86.36" stroke="#FFFFFF" stroke-width="16" stroke-linecap="round"/>\n' +
  '  <circle cx="91" cy="64" r="9" fill="#FFFFFF"/>';
const SMALL_GLYPH =
  '<path d="M76.71 44.08A26 26 0 1 0 76.71 83.92" stroke="#FFFFFF" stroke-width="20" stroke-linecap="round"/>\n' +
  '  <circle cx="94" cy="64" r="10" fill="#FFFFFF"/>';

function hex(channel: number): string {
  return Math.round(channel).toString(16).padStart(2, "0").toUpperCase();
}

/** The ember gradient quantized into `steps` tones, top to bottom. */
function tones(steps: number): ReadonlyArray<string> {
  return Array.from({ length: steps }, (_, index) => {
    const t = index / (steps - 1);
    return `#${EMBER_FROM.map((from, channel) => hex(from + (EMBER_TO[channel]! - from) * t)).join("")}`;
  });
}

/** Tone index for a cell: the gradient's position, ordered-dithered by Bayer 4x4. */
function toneAt(column: number, row: number, cells: number, steps: number): number {
  const value = ((row + 0.5) / cells) * (steps - 1);
  const base = Math.floor(value);
  const threshold = (BAYER[(row & 3) * 4 + (column & 3)]! + 0.5) / 16;
  return Math.min(steps - 1, value - base > threshold ? base + 1 : base);
}

/** One `<rect>` per horizontal run of equal tone, clipped to the rounded tile. */
function pixelTile(id: string, cells: number, steps: number): string {
  const palette = tones(steps);
  const size = BOX / cells;
  const rects: string[] = [];
  for (let row = 0; row < cells; row++) {
    let column = 0;
    while (column < cells) {
      const tone = toneAt(column, row, cells, steps);
      let end = column + 1;
      while (end < cells && toneAt(end, row, cells, steps) === tone) end++;
      rects.push(
        `    <rect x="${column * size}" y="${row * size}" width="${(end - column) * size}" height="${size}" fill="${palette[tone]}"/>`,
      );
      column = end;
    }
  }
  return (
    `  <defs>\n    <clipPath id="${id}"><rect width="${BOX}" height="${BOX}" rx="${CORNER}"/></clipPath>\n  </defs>\n` +
    `  <g clip-path="url(#${id})" shape-rendering="crispEdges">\n${rects.join("\n")}\n  </g>`
  );
}

function svg(body: string): string {
  return `<svg width="${BOX}" height="${BOX}" viewBox="0 0 ${BOX} ${BOX}" fill="none" xmlns="http://www.w3.org/2000/svg">\n${body}\n</svg>\n`;
}

const RIM =
  '<rect x="1.75" y="1.75" width="124.5" height="124.5" rx="26.25" stroke="#FFFFFF" stroke-opacity="0.18" stroke-width="1.5"/>';

export const COGENLY_MARK = svg(`${pixelTile("cogenly-tile", 16, 3)}\n  ${RIM}\n  ${GLYPH}`);
export const COGENLY_MARK_SMALL = svg(`${pixelTile("cogenly-tile-small", 8, 3)}\n  ${SMALL_GLYPH}`);

if (import.meta.main) {
  const repoRoot = NodePath.join(NodePath.dirname(NodeUrl.fileURLToPath(import.meta.url)), "..");
  NodeFs.writeFileSync(NodePath.join(repoRoot, "assets/brand/cogenly-mark.svg"), COGENLY_MARK);
  NodeFs.writeFileSync(
    NodePath.join(repoRoot, "assets/brand/cogenly-mark-small.svg"),
    COGENLY_MARK_SMALL,
  );
  console.log("Wrote assets/brand/cogenly-mark.svg and cogenly-mark-small.svg.");
}
