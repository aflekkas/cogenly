import { create } from "zustand";

/**
 * The sidebar row whose context menu is open. That row shows the plain
 * selected fill (no focus ring) for as long as its menu is up, the same way
 * a highlighted menu item does.
 */
export const useSidebarContextMenuTarget = create<{ threadKey: string | null }>(() => ({
  threadKey: null,
}));

export function setSidebarContextMenuTarget(threadKey: string | null) {
  useSidebarContextMenuTarget.setState({ threadKey });
}
