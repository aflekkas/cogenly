import { useEffect } from "react";
import { create } from "zustand";

import type { SidebarMode } from "./modes/sidebarModes.logic";

/**
 * The narrowest the main column gets beside an inline right panel before the
 * list column steps aside: the composer at its reference width
 * (--chat-content-max-width, 53.8125rem) plus the lane's narrow padding.
 */
export const MAIN_COLUMN_COMFORTABLE_MIN_WIDTH_PX = 885;

interface ListColumnLayoutState {
  /** The user's open or closed list column, per mode. Restored on a mode switch. */
  readonly openByMode: Readonly<Record<SidebarMode, boolean>>;
  /**
   * Collapsed on its own to make room for the right panel. Separate from the
   * remembered preference, so it never overwrites it.
   */
  readonly autoCollapsed: boolean;
  /** The user reopened the column beside the panel; respected until the panel opens again. */
  readonly autoCollapseDismissed: boolean;
  /** The open inline right panel's width, or null when none is open inline. */
  readonly inlineRightPanelWidth: number | null;
  /** Applies a change from the sidebar toggle (or an automatic one, see beginAutomaticChange). */
  readonly applyOpenChange: (mode: SidebarMode, open: boolean) => void;
  /** Marks the next applyOpenChange as the automatic collapse (true) or its restore (false). */
  readonly beginAutomaticChange: (collapse: boolean) => void;
  readonly setInlineRightPanelWidth: (width: number | null) => void;
}

let pendingAutomaticCollapse: boolean | null = null;

export const useListColumnLayoutStore = create<ListColumnLayoutState>((set) => ({
  openByMode: { chats: true, tasks: true, agents: true, projects: true },
  autoCollapsed: false,
  autoCollapseDismissed: false,
  inlineRightPanelWidth: null,
  applyOpenChange: (mode, open) => {
    const automaticCollapse = pendingAutomaticCollapse;
    pendingAutomaticCollapse = null;
    set((state) => {
      if (automaticCollapse !== null) return { ...state, autoCollapsed: automaticCollapse };
      // Reopening beside the panel overrides the automatic collapse only.
      if (state.autoCollapsed && open) {
        return { ...state, autoCollapsed: false, autoCollapseDismissed: true };
      }
      return state.openByMode[mode] === open
        ? state
        : { ...state, openByMode: { ...state.openByMode, [mode]: open } };
    });
  },
  beginAutomaticChange: (collapse) => {
    pendingAutomaticCollapse = collapse;
  },
  setInlineRightPanelWidth: (width) =>
    set((state) => {
      if (state.inlineRightPanelWidth === width) return state;
      // A newly opened panel may collapse the column again.
      const opened = state.inlineRightPanelWidth === null && width !== null;
      return {
        ...state,
        inlineRightPanelWidth: width,
        autoCollapseDismissed: opened ? false : state.autoCollapseDismissed,
      };
    }),
}));

/**
 * Whether the main column would be cramped with the list column open beside
 * the inline right panel.
 */
export function mainColumnCrampedBesidePanel(input: {
  readonly viewportWidth: number;
  readonly navRailWidth: number;
  readonly listColumnWidth: number;
  readonly rightPanelWidth: number | null;
}): boolean {
  if (input.rightPanelWidth === null) return false;
  const mainWidth =
    input.viewportWidth - input.navRailWidth - input.listColumnWidth - input.rightPanelWidth;
  return mainWidth < MAIN_COLUMN_COMFORTABLE_MIN_WIDTH_PX;
}

/** Reports the thread's open inline right panel, so the list column can make room. */
export function usePublishInlineRightPanelWidth(width: number | null): void {
  useEffect(() => {
    useListColumnLayoutStore.getState().setInlineRightPanelWidth(width);
  }, [width]);
  useEffect(() => () => useListColumnLayoutStore.getState().setInlineRightPanelWidth(null), []);
}
