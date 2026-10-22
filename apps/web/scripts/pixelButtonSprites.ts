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
 * - lit-<tone>: every cell one tone brighter, one frame. Hover and the working
 *   shimmer paint it through the masks below.
 * - exit-<tone>: the tone leaving, EXIT_TICKS frames. Blocks step out bottom
 *   first, in the splash's order: one frame at the deep in-between tone, then
 *   gone (transparent), so the tone beneath shows through.
 * - exit-mask: the same order as alpha only, for the flat idle tile leaving.
 * - hover-mask: HOVER_TICKS + 1 frames revealing the lit layer in that order.
 * - shimmer-mask: SHIMMER_TICKS frames, each a different sparse set of blocks,
 *   the splash's "one tone off for a moment" while a run is live.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const COLS = 8;
const ROWS = 8;
const EXIT_TICKS = 6;
const HOVER_TICKS = 3;
const SHIMMER_TICKS = 12;
const SHIMMER_SHARE = 0.1;
// Height of the dissolving band as a share of the grid (the splash uses 0.3 of
// the window; a little wider here so six ticks don't read as plain rows).
const BAND = 0.45;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// Six-step ramps, lit (index 0) through deep (index 5), plus the in-between
// tone a block shows on its exit tick. Brand is the splash's own ember ramp.
const RAMPS = {
  brand: {
    ramp: ["#ff9a5c", "#ff8040", "#fa6c34", "#f3592a", "#eb4824", "#de3a1e"],
    deep: "#c4301a",
  },
  danger: {
    ramp: ["#ff8f84", "#ff7366", "#f9625a", "#f0514e", "#e44243", "#d4353a"],
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
  tick: number;
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
        // Bottom first, spread over a band by the Bayer matrix plus a little noise.
        order: 1 - t + BAND * (0.8 * ((BAYER[(y & 3) * 4 + (x & 3)]! + 0.5) / 16) + 0.2 * random()),
        tick: 0,
      });
    }
  }
  return blocks;
}

// Share of blocks cleared by time f (0..1): the splash's trapezoidal rate.
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

function assignTicks(blocks: Block[]) {
  const ordered = blocks.slice().sort((a, b) => a.order - b.order);
  ordered.forEach((block, rank) => {
    const at = timeForShare((rank + 0.5) / ordered.length);
    block.tick = Math.min(EXIT_TICKS - 1, Math.floor(at * EXIT_TICKS));
  });
  return ordered;
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
const ordered = assignTicks(blocks);
const rank = new Map(ordered.map((block, index) => [block, index]));

const shimmerFrames: Set<Block>[] = [];
for (let frame = 0; frame < SHIMMER_TICKS; frame++) {
  const previous = shimmerFrames[frame - 1];
  const picked = new Set<Block>();
  const count = Math.round(blocks.length * SHIMMER_SHARE);
  while (picked.size < count) {
    const block = blocks[Math.floor(random() * blocks.length)]!;
    if (!previous?.has(block)) picked.add(block);
  }
  shimmerFrames.push(picked);
}

const lines = ["/* Generated by scripts/pixelButtonSprites.ts; edit that, not this. */", ":root {"];
for (const [tone, { ramp, deep }] of Object.entries(RAMPS)) {
  lines.push(`  --pixel-face-${tone}: ${sprite(blocks, 1, (block) => ramp[block.tone + 1]!)};`);
  lines.push(`  --pixel-lit-${tone}: ${sprite(blocks, 1, (block) => ramp[block.tone]!)};`);
  lines.push(
    `  --pixel-exit-${tone}: ${sprite(blocks, EXIT_TICKS, (block, frame) =>
      block.tick < frame ? null : block.tick === frame ? deep : ramp[block.tone + 1]!,
    )};`,
  );
}
lines.push(
  `  --pixel-exit-mask: ${sprite(blocks, EXIT_TICKS, (block, frame) => (block.tick < frame ? null : "%23fff"))};`,
);
lines.push(
  `  --pixel-hover-mask: ${sprite(blocks, HOVER_TICKS + 1, (block, frame) =>
    rank.get(block)! < (frame / HOVER_TICKS) * blocks.length ? "%23fff" : null,
  )};`,
);
lines.push(
  `  --pixel-shimmer-mask: ${sprite(blocks, SHIMMER_TICKS, (block, frame) =>
    shimmerFrames[frame]!.has(block) ? "%23fff" : null,
  )};`,
);
lines.push("}", "");

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const out =
  process.argv[2] ??
  NodePath.join(here, "..", "src", "components", "ui", "pixelButton.sprites.css");
NodeFS.writeFileSync(out, lines.join("\n"));
console.log(`wrote ${out} (${NodeFS.statSync(out).size} bytes)`);
