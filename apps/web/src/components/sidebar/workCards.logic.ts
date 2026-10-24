import { planPinnedReorder } from "@t3tools/client-runtime/state/thread-sort";

import type { SidebarLayout } from "~/appearancePreferences";

/**
 * The server's active order puts new, unarranged work first, and Work draws
 * it with that end nearest the search dock: top to bottom as is in the top
 * layout (`workCardsReadUp` false), reversed in the bottom layout, where the
 * list stacks up toward the dock. The list shows them under project headings
 * (`groupWorkCards`), each group keeping that order. Orders here read top to
 * bottom as drawn; `planWorkCardReorder` maps them back to the server's order,
 * so a saved order means the same in both layouts.
 */

/** Whether Work draws its cards in reverse of the server's order, newest at the bottom. */
export function workCardsReadUp(layout: SidebarLayout): boolean {
  return layout === "bottom";
}

/**
 * A Work card's first line, after T3's: the repository, led by the project it
 * is in ("Spawn Partners · platform"); the project alone for repository-less
 * Work in a project; "No project" for neither. Under a group heading (its
 * project, or "No project") the heading already names the project, so the
 * card names only where it runs: the repository, else the project folder.
 */
export function workCardLabel(input: {
  readonly projectName: string | null;
  readonly repositoryName: string | null;
  readonly projectInHeading?: boolean;
}): string {
  const { projectName, repositoryName } = input;
  if (input.projectInHeading) {
    return repositoryName ?? (projectName ? "Project folder" : "No repository");
  }
  if (projectName && repositoryName) return `${projectName} · ${repositoryName}`;
  return repositoryName ?? projectName ?? "No project";
}

/** The group key Work without a project files under. Project keys never collide with it. */
export const NO_PROJECT_WORK_GROUP = "none";

export interface WorkCardGroup<T, P> {
  /** The project's key, or NO_PROJECT_WORK_GROUP. */
  readonly key: string;
  /** The project; null for "No project". */
  readonly project: P | null;
  readonly cards: readonly T[];
}

/**
 * Work's cards under project headings: projects by name, "No project" last.
 * Inside a group the cards keep the order they came in, so the drawn order
 * (and a drag's preview of it) carries through.
 */
export function groupWorkCards<T, P extends { readonly key: string; readonly name: string }>(
  cards: readonly T[],
  projectOf: (card: T) => P | null,
): WorkCardGroup<T, P>[] {
  const groups = new Map<string, { key: string; project: P | null; cards: T[] }>();
  for (const card of cards) {
    const project = projectOf(card);
    const key = project?.key ?? NO_PROJECT_WORK_GROUP;
    const group = groups.get(key);
    if (group) group.cards.push(card);
    else groups.set(key, { key, project, cards: [card] });
  }
  return [...groups.values()].toSorted((left, right) => {
    if (left.project === null || right.project === null) {
      return Number(left.project === null) - Number(right.project === null);
    }
    return (
      left.project.name.localeCompare(right.project.name, undefined, { sensitivity: "base" }) ||
      left.key.localeCompare(right.key)
    );
  });
}

/** The collapsed-section key of a Work project group, beside Chats' date groups. */
export function workGroupSectionKey(groupKey: string): string {
  return `project:${groupKey}`;
}

/**
 * The full drawn order after a card moved inside its project group.
 * `groupOrder` is the group's cards in their new order, a reordering of a
 * subsequence of `order`. The card lands beside its new neighbour in the
 * group, so every card outside the group keeps its place. Unchanged when the
 * card is not in both.
 */
export function placeInGroupOrder(
  order: readonly string[],
  groupOrder: readonly string[],
  movedId: string,
): string[] {
  const index = groupOrder.indexOf(movedId);
  const rest = order.filter((key) => key !== movedId);
  if (index === -1 || rest.length === order.length) return [...order];
  const after = groupOrder[index + 1];
  const afterAt = after === undefined ? -1 : rest.indexOf(after);
  if (afterAt !== -1) {
    rest.splice(afterAt, 0, movedId);
    return rest;
  }
  const before = groupOrder[index - 1];
  const beforeAt = before === undefined ? -1 : rest.indexOf(before);
  if (beforeAt !== -1) {
    rest.splice(beforeAt + 1, 0, movedId);
    return rest;
  }
  return [...order];
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
 * Keys follow the server's order, which the bottom layout draws reversed, so
 * there the drawn order is reversed before planning. One write moves one card
 * between keyed neighbours; next to new, keyless cards the list is keyed once
 * in full. `keysById` should carry every active thread's key, so a new key
 * never repeats one held by a card not drawn.
 */
export function planWorkCardReorder(input: {
  readonly layout: SidebarLayout;
  readonly drawnOrder: readonly string[];
  readonly keysById: ReadonlyMap<string, string | null | undefined>;
  readonly movedId: string;
}): ReadonlyArray<{ readonly id: string; readonly orderKey: string }> {
  return planPinnedReorder({
    orderedIds: workCardsReadUp(input.layout) ? input.drawnOrder.toReversed() : input.drawnOrder,
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
