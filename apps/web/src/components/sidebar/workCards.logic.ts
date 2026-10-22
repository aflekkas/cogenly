import { planPinnedReorder } from "@t3tools/client-runtime/state/thread-sort";

/**
 * Work is one flat list of cards, drawn top to bottom in reverse of the
 * server's active order: that order puts new, unarranged work first, and the
 * list stacks up from the search dock, so new work lands at the bottom by the
 * dock. Orders here read top to bottom as drawn.
 */

/**
 * A Work card's first line, after T3's: the repository, led by the project it
 * is in ("Spawn Partners · platform"); the project alone for repository-less
 * Work in a project; "No project" for neither.
 */
export function workCardLabel(input: {
  readonly projectName: string | null;
  readonly repositoryName: string | null;
}): string {
  const { projectName, repositoryName } = input;
  if (projectName && repositoryName) return `${projectName} · ${repositoryName}`;
  return repositoryName ?? projectName ?? "No project";
}

/**
 * The drawn order with `key` moved one card up (-1) or down (+1), for
 * keyboard reordering; null when it is already at that end or not listed.
 */
export function moveInOrder(order: readonly string[], key: string, delta: -1 | 1): string[] | null {
  const from = order.indexOf(key);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= order.length) return null;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, key);
  return next;
}

/**
 * The drawn order while a drag previews: `preview` for the cards it knew
 * about, then any card that arrived mid-drag where the list put it, so a new
 * card never hides until the drop.
 */
export function applyDrawnOrder(drawn: readonly string[], preview: readonly string[]): string[] {
  const present = new Set(drawn);
  const known = new Set(preview);
  return [...preview.filter((key) => present.has(key)), ...drawn.filter((key) => !known.has(key))];
}

/**
 * The order-key writes that put the cards in `drawnOrder` (top to bottom).
 * Keys run up from the dock, so the drawn order is reversed before planning.
 * One write moves one card between keyed neighbours; next to new, keyless
 * cards the list is keyed once in full. `keysById` should carry every active
 * thread's key, so a new key never repeats one held by a card not drawn.
 */
export function planWorkCardReorder(input: {
  readonly drawnOrder: readonly string[];
  readonly keysById: ReadonlyMap<string, string | null | undefined>;
  readonly movedId: string;
}): ReadonlyArray<{ readonly id: string; readonly orderKey: string }> {
  return planPinnedReorder({
    orderedIds: input.drawnOrder.toReversed(),
    keysById: input.keysById,
    movedId: input.movedId,
  });
}

/**
 * Collapsed section keys after a toggle. Each space keeps its own list, so
 * folding "Today" in Chats never folds anything elsewhere.
 */
export function toggleCollapsedSection(
  collapsed: Readonly<Record<string, readonly string[]>>,
  space: string,
  key: string,
): Record<string, string[]> {
  const current = collapsed[space] ?? [];
  const next = current.includes(key)
    ? current.filter((candidate) => candidate !== key)
    : [...current, key];
  const result: Record<string, string[]> = {};
  for (const [name, keys] of Object.entries(collapsed)) result[name] = [...keys];
  if (next.length === 0) delete result[space];
  else result[space] = next;
  return result;
}

/**
 * Whether a row shows under its section heading: always while open; folded,
 * only the open thread, so the page you are on never vanishes behind it.
 */
export function rowShowsInSection(input: {
  readonly collapsed: boolean;
  readonly isOpen: boolean;
}): boolean {
  return !input.collapsed || input.isOpen;
}
