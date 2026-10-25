import type { HybridClock, SharedDocumentChange } from "@cogenly/contracts";

/** Total order: physical milliseconds, logical counter, then stable environment id. */
export const compareClock = (a: HybridClock, b: HybridClock): number =>
  a.wall - b.wall || a.logical - b.logical || (a.node < b.node ? -1 : a.node > b.node ? 1 : 0);

/** Receive and tick in one step. Observing a future clock never moves local time backwards. */
export function tickClock(
  node: string,
  now: number,
  local?: HybridClock,
  received?: HybridClock,
): HybridClock {
  const wall = Math.max(now, local?.wall ?? 0, received?.wall ?? 0);
  const logical =
    wall === local?.wall && wall === received?.wall
      ? Math.max(local.logical, received.logical) + 1
      : wall === local?.wall
        ? local.logical + 1
        : wall === received?.wall
          ? received.logical + 1
          : 0;
  if (!Number.isSafeInteger(wall) || !Number.isSafeInteger(logical))
    throw new RangeError("HLC overflow");
  return { wall, logical, node };
}

/** Tombstones are permanent: stale or concurrent edits cannot resurrect an identity. */
export function mergeDocument(
  current: SharedDocumentChange | undefined,
  incoming: SharedDocumentChange,
): SharedDocumentChange {
  if (current && (current.kind !== incoming.kind || current.id !== incoming.id))
    throw new Error("Document identity mismatch");
  const fields = { ...current?.fields };
  const clocks = { ...current?.clocks };
  for (const [key, clock] of Object.entries(incoming.clocks)) {
    const previous = clocks[key];
    if (!previous || compareClock(clock, previous) > 0) {
      fields[key] = incoming.fields[key]!;
      clocks[key] = clock;
    }
  }
  const tombstone =
    current?.tombstone &&
    (!incoming.tombstone || compareClock(current.tombstone, incoming.tombstone) >= 0)
      ? current.tombstone
      : incoming.tombstone;
  const latest = [...Object.values(clocks), ...(tombstone ? [tombstone] : [])]
    .sort(compareClock)
    .at(-1);
  return {
    kind: incoming.kind,
    id: incoming.id,
    fields,
    clocks,
    tombstone,
    updatedBy: (latest?.node ?? incoming.updatedBy) as SharedDocumentChange["updatedBy"],
  };
}
