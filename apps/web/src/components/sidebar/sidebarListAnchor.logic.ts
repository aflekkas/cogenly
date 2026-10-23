/**
 * The edge a sidebar list is anchored to. A list that stacks up against the
 * dock (Work's active lists, Agents) is "bottom": it opens on its last rows
 * and remembers how far it sits from them. Chats, search and Work's put-away
 * shelves (Settled newest first, Snoozed soonest wake first) run from the top
 * and page downward, so they are "top".
 */
export type SidebarListEdge = "top" | "bottom";

/** Which edge the open sidebar list anchors to. */
export function sidebarListEdge(input: {
  readonly searching: boolean;
  readonly mode: string;
  readonly shelf: string | null;
}): SidebarListEdge {
  if (input.searching || input.mode === "chats") return "top";
  if (input.mode === "tasks" && (input.shelf === "settled" || input.shelf === "snoozed")) {
    return "top";
  }
  return "bottom";
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
