// @effect-diagnostics nodeBuiltinImport:off - build-time generator, no Effect runtime.
/**
 * Writes src/components/ui/pixelButton.sprites.css: the SVG sprites behind the
 * pixel button (pixelButton.css), a miniature of the boot splash mosaic in
 * apps/web/index.html. Run with `node apps/web/scripts/pixelButtonSprites.ts`
 * after changing a ramp, the grid or an order; the output is committed so the
 * app never pays for it.
 *
 * The grid is 8x8 cells, a few merged into 2x2 blocks, toned by height with
 * the splash's jittered ramp. Each sprite stacks frames vertically; the CSS
 * steps through them with `background-position` / `mask-position`:
 *
 * - face-<tone>: the resting mosaic, one frame.
 * - sweep-<tone>: light moving down through the mosaic, SWEEP_FRAMES frames.
 *   A band of brighter tones (SWEEP_PROFILE, in tones above rest) travels top
 *   to bottom; its leading edge reaches each block on the block's tick, in
 *   the splash's order (height plus a Bayer dither and a little noise), so
 *   both edges are ragged. Only the band's cells are painted; the face shows
 *   through elsewhere. The last frame is empty, the band gone. Hover plays it
 *   once; `data-working` loops it with a rest on that empty frame.
 * - exit-<tone>: the tone leaving, EXIT_TICKS frames. Blocks step out top
 *   first, in the same order: one frame at the deep in-between tone, then
 *   gone (transparent), so the tone beneath shows through.
 * - exit-mask: the same order as alpha only, for the flat idle tile leaving.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const COLS = 8;
const ROWS = 8;
const EXIT_TICKS = 6;
// Ticks for the sweep's leading edge to cross the grid, and the band behind
// it: how many tones above rest a block shows on the ticks after its own.
const SWEEP_TICKS = 10;
const SWEEP_PROFILE = [1, 2, 2, 1];
const SWEEP_FRAMES = SWEEP_TICKS + SWEEP_PROFILE.length;
// Height of the dissolving band as a share of the grid (the splash uses 0.3 of
// the window; a little wider here so six ticks don't read as plain rows).
const BAND = 0.45;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// Seven-step ramps, hot (index 0) through deep (index 6), plus the in-between
// tone a block shows on its exit tick. A block at rest sits two steps below
// the top, so the sweep's band has room to brighten it. Brand is the splash's
// own ember ramp with a hotter step above it.
const REST = 2;
const RAMPS = {
  brand: {
    ramp: ["#ffb27a", "#ff9a5c", "#ff8040", "#fa6c34", "#f3592a", "#eb4824", "#de3a1e"],
    deep: "#c4301a",
  },
  danger: {
    ramp: ["#ffa89e", "#ff8f84", "#ff7366", "#f9625a", "#f0514e", "#e44243", "#d4353a"],
    deep: "#b82a30",
  },
} as const;

// A fixed seed: the mosaic is part of the look, not a per-load surprise.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Block {
  readonly x: number;
  readonly y: number;
  readonly size: 1 | 2;
  readonly tone: number;
  readonly order: number;
  /** The exit tick this block leaves on, and the sweep tick the band reaches it. */
  tick: number;
  sweepTick: number;
}

function buildBlocks(random: () => number): Block[] {
  const taken = new Uint8Array(COLS * ROWS);
  const blocks: Block[] = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (taken[y * COLS + x]) continue;
      const merge =
        x + 1 < COLS &&
        y + 1 < ROWS &&
        !taken[y * COLS + x + 1] &&
        !taken[(y + 1) * COLS + x] &&
        !taken[(y + 1) * COLS + x + 1] &&
        random() < 0.22;
      const size = merge ? 2 : 1;
      for (let dy = 0; dy < size; dy++) {
        for (let dx = 0; dx < size; dx++) taken[(y + dy) * COLS + x + dx] = 1;
      }
      const t = (y + (merge ? 0.5 : 0)) / (ROWS - 1);
      blocks.push({
        x,
        y,
        size,
        // Bands by height with a jittered quantization, so band edges are ragged.
        tone: Math.max(0, Math.min(4, Math.round(t * 4 + (random() - 0.5) * 1.1))),
        // Top first, spread over a band by the Bayer matrix plus a little noise.
        order: t + BAND * (0.8 * ((BAYER[(y & 3) * 4 + (x & 3)]! + 0.5) / 16) + 0.2 * random()),
        tick: 0,
        sweepTick: 0,
      });
    }
  }
  return blocks;
}

// Share of blocks reached by time f (0..1): the splash's trapezoidal rate.
function clearedBy(f: number) {
  const rate = 1 / (1 - 0.1 - 0.075);
  if (f < 0.2) return (rate * f * f) / 0.4;
  if (f > 0.85) return 1 - (rate * (1 - f) * (1 - f)) / 0.3;
  return rate * (f - 0.1);
}

function timeForShare(u: number) {
  let low = 0;
  let high = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    if (clearedBy(mid) < u) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

// Spreads the blocks over `ticks` ticks in their order, along that rate.
function assignTicks(blocks: Block[], ticks: number, set: (block: Block, tick: number) => void) {
  const ordered = blocks.slice().sort((a, b) => a.order - b.order);
  ordered.forEach((block, rank) => {
    const at = timeForShare((rank + 0.5) / ordered.length);
    set(block, Math.min(ticks - 1, Math.floor(at * ticks)));
  });
}

type Paint = (block: Block, frame: number) => string | null;

// One SVG of `frames` stacked grids: one path per fill, cells merged along rows.
function sprite(blocks: readonly Block[], frames: number, paint: Paint) {
  const runs = new Map<string, string[]>();
  for (let frame = 0; frame < frames; frame++) {
    const grid = Array.from<string | null>({ length: COLS * ROWS }, () => null);
    for (const block of blocks) {
      const fill = paint(block, frame);
      for (let dy = 0; dy < block.size; dy++) {
        for (let dx = 0; dx < block.size; dx++) {
          grid[(block.y + dy) * COLS + block.x + dx] = fill;
        }
      }
    }
    for (let y = 0; y < ROWS; y++) {
      let x = 0;
      while (x < COLS) {
        const fill = grid[y * COLS + x];
        let run = 1;
        while (x + run < COLS && grid[y * COLS + x + run] === fill) run++;
        if (fill) {
          const path = runs.get(fill) ?? [];
          path.push(`M${x} ${frame * ROWS + y}h${run}v1H${x}z`);
          runs.set(fill, path);
        }
        x += run;
      }
    }
  }
  const paths = [...runs].map(([fill, path]) => `<path fill='${fill}' d='${path.join("")}'/>`);
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${COLS} ${ROWS * frames}' shape-rendering='crispEdges'>${paths.join("")}</svg>`;
  return `url("data:image/svg+xml,${svg.replaceAll("#", "%23")}")`;
}

const random = mulberry32(12);
const blocks = buildBlocks(random);
assignTicks(blocks, EXIT_TICKS, (block, tick) => {
  block.tick = tick;
});
assignTicks(blocks, SWEEP_TICKS, (block, tick) => {
  block.sweepTick = tick;
});

const lines = ["/* Generated by scripts/pixelButtonSprites.ts; edit that, not this. */", ":root {"];
for (const [tone, { ramp, deep }] of Object.entries(RAMPS)) {
  lines.push(`  --pixel-face-${tone}: ${sprite(blocks, 1, (block) => ramp[block.tone + REST]!)};`);
  lines.push(
    `  --pixel-sweep-${tone}: ${sprite(blocks, SWEEP_FRAMES, (block, frame) => {
      const lift = SWEEP_PROFILE[frame - block.sweepTick];
      return lift === undefined ? null : ramp[block.tone + REST - lift]!;
    })};`,
  );
  lines.push(
    `  --pixel-exit-${tone}: ${sprite(blocks, EXIT_TICKS, (block, frame) =>
      block.tick < frame ? null : block.tick === frame ? deep : ramp[block.tone + REST]!,
    )};`,
  );
}
lines.push(
  `  --pixel-exit-mask: ${sprite(blocks, EXIT_TICKS, (block, frame) => (block.tick < frame ? null : "%23fff"))};`,
);
lines.push("}", "");

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const out =
  process.argv[2] ??
  NodePath.join(here, "..", "src", "components", "ui", "pixelButton.sprites.css");
NodeFS.writeFileSync(out, lines.join("\n"));
console.log(`wrote ${out} (${NodeFS.statSync(out).size} bytes)`);
