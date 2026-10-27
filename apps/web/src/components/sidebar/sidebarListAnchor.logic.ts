import type { SidebarLayout } from "~/appearancePreferences";

/**
 * The edge a sidebar list is anchored to: the edge the dock sits on, which is
 * the sidebar layout's. Every list (each mode, filter, shelf and search)
 * anchors to it, so none sits apart from the rest. A "top" list reads down
 * from its first rows; a "bottom" list stacks up against the dock: it opens on
 * its last rows and remembers how far it sits from them.
 */
export type SidebarListEdge = SidebarLayout;

/**
 * Items ranked from the dock outward (the most relevant first: newest, soonest
 * to wake, best match), in the order they draw top to bottom, so the first
 * always sits next to the dock.
 */
export function drawFromDock<T>(ranked: readonly T[], edge: SidebarListEdge): readonly T[] {
  return edge === "bottom" ? ranked.toReversed() : ranked;
}

/**
 * Grouped items ranked from the dock outward (Chats' Pinned, Today, Yesterday,
 * each newest first), drawn top to bottom. Groups and their rows run away from
 * the dock as `drawFromDock` does, while each heading stays above its rows.
 */
export function drawGroupsFromDock<T>(
  groups: readonly { readonly header: T | null; readonly rows: readonly T[] }[],
  edge: SidebarListEdge,
): T[] {
  return drawFromDock(groups, edge).flatMap((group) => [
    ...(group.header === null ? [] : [group.header]),
    ...drawFromDock(group.rows, edge),
  ]);
}

/**
 * The search result an arrow key moves to. Results are ranked from the dock
 * outward (index 0, the best match, sits next to the input), so in a "bottom"
 * list ArrowUp walks away from the input to lower matches. Both ends wrap.
 */
export function stepSearchResultIndex(
  key: "ArrowUp" | "ArrowDown",
  index: number,
  count: number,
  edge: SidebarListEdge,
): number {
  const awayFromDock = edge === "top" ? key === "ArrowDown" : key === "ArrowUp";
  return awayFromDock ? (index + 1) % count : (index - 1 + count) % count;
}

export type ScrollMetrics = {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
};

const maxScrollTop = (metrics: Omit<ScrollMetrics, "scrollTop">) =>
  Math.max(0, metrics.scrollHeight - metrics.clientHeight);

/** How far the viewport sits from `edge`, in pixels (0 = against it). */
export function offsetFromEdge(edge: SidebarListEdge, metrics: ScrollMetrics): number {
  const top = Math.min(Math.max(0, metrics.scrollTop), maxScrollTop(metrics));
  return edge === "top" ? top : maxScrollTop(metrics) - top;
}

/** The scrollTop that puts the viewport `offset` pixels from `edge`, clamped to the content. */
export function scrollTopForOffset(
  edge: SidebarListEdge,
  offset: number,
  metrics: Omit<ScrollMetrics, "scrollTop">,
): number {
  const max = maxScrollTop(metrics);
  const top = edge === "top" ? offset : max - offset;
  return Math.min(Math.max(0, top), max);
}
