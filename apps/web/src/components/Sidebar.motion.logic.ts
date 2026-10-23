/**
 * How a row that leaves or joins the sidebar list gives up or takes its space.
 * The row stays where it is and fades; a clip closes (or opens) the gap from
 * the side the neighbours move into, at the pace they move. So the rows beside
 * it slide once, and nothing crosses the rows that stay.
 */

/** Where a row sat (leaving) or sits (joining), in the list's coordinates. */
export interface WipeGeometry {
  readonly top: number;
  readonly height: number;
}

export interface RowWipe {
  /** The edge the clip moves from: the side facing the neighbour that moves. */
  readonly edge: "top" | "bottom";
  /** Space between this row and that neighbour, taken up by rows leaving or joining with it. */
  readonly before: number;
  /** How far that neighbour travels. */
  readonly distance: number;
}

// Below this the neighbour has not moved on screen.
const MOVED_PX = 1;

/**
 * The wipe for the row at `index` of `order`: against the nearest unchanged
 * neighbour that moves, looking up the list first, then down. A bottom-anchored
 * list closes a gap by moving the rows above it, a top-anchored one the rows
 * below. Null when no neighbour moves (the row fades where it stands).
 * `isNeighbour` names the rows that stay; the others leave or join with this one.
 */
export function findRowWipe<T>(input: {
  readonly order: readonly T[];
  readonly index: number;
  readonly geometry: (node: T) => WipeGeometry | undefined;
  readonly isNeighbour: (node: T) => boolean;
  /** How far a neighbour moves, signed; only its size matters here. */
  readonly displacement: (node: T) => number;
}): RowWipe | null {
  const { order, index } = input;
  const self = input.geometry(order[index]!);
  if (self === undefined) return null;
  for (const step of [-1, 1] as const) {
    for (let cursor = index + step; cursor >= 0 && cursor < order.length; cursor += step) {
      const node = order[cursor]!;
      if (!input.isNeighbour(node)) continue;
      const distance = Math.abs(input.displacement(node));
      const neighbour = input.geometry(node);
      // The nearest neighbour decides: one past it is moved by it, not by the gap.
      if (distance < MOVED_PX || neighbour === undefined) break;
      const before =
        step < 0
          ? self.top - (neighbour.top + neighbour.height)
          : neighbour.top - (self.top + self.height);
      return { edge: step < 0 ? "top" : "bottom", before: Math.max(0, before), distance };
    }
  }
  return null;
}

const inset = (edge: RowWipe["edge"], amount: number) =>
  edge === "top" ? `inset(${amount}px 0px 0px 0px)` : `inset(0px 0px ${amount}px 0px)`;

/**
 * The clip-path keyframes of a row `height` tall leaving (`out`: whole, then
 * clipped away) or joining (`in`: the same played back). The clip eats the row
 * at the speed the neighbour travels, starting once the rows between them
 * (`before`) are gone. Null when the neighbour never reaches the row.
 */
export function rowWipeKeyframes(
  wipe: RowWipe,
  height: number,
  direction: "out" | "in",
): Array<{ offset: number; clipPath: string }> | null {
  if (height <= 0 || wipe.before >= wipe.distance) return null;
  const start = wipe.before / wipe.distance;
  const end = Math.min(1, (wipe.before + height) / wipe.distance);
  const reached = Math.min(height, wipe.distance - wipe.before);
  const out = [
    { offset: 0, clipPath: inset(wipe.edge, 0) },
    ...(start > 0 ? [{ offset: start, clipPath: inset(wipe.edge, 0) }] : []),
    { offset: end, clipPath: inset(wipe.edge, reached) },
    ...(end < 1 ? [{ offset: 1, clipPath: inset(wipe.edge, reached) }] : []),
  ];
  return direction === "out"
    ? out
    : out.toReversed().map((frame) => ({ ...frame, offset: 1 - frame.offset }));
}
