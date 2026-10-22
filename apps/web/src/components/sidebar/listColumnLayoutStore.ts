import { useEffect, useState } from "react";
import { create } from "zustand";

import { PREVIEW_PANEL_MIN_WIDTH } from "../../hooks/usePreviewPanelInlineSize";
import { THREAD_MAIN_CONTENT_MIN_WIDTH } from "../threadSidebarWidth";
import type { SidebarMode } from "./modes/sidebarModes.logic";

/**
 * Space negotiation between the list column, the main chat column and the
 * inline right panel. Opening one never closes another while they fit at their
 * minimums. The right panel shrinks toward RIGHT_PANEL_MIN_WIDTH_PX first
 * (usePreviewPanelInlineSize clamps it against the main column's minimum);
 * only when even that leaves the main column under MAIN_COLUMN_MIN_WIDTH_PX
 * does one of them give way: the list column when the panel opens, the panel
 * when the column is docked by hand. A panel closed that way comes back once
 * there is room again.
 */
export const MAIN_COLUMN_MIN_WIDTH_PX = THREAD_MAIN_CONTENT_MIN_WIDTH;
export const RIGHT_PANEL_MIN_WIDTH_PX = PREVIEW_PANEL_MIN_WIDTH;

export interface AutoClosedPanel {
  /** What was closed: a thread key, or "project" for the Projects panel. */
  readonly scope: string;
  readonly reopen: () => void;
}

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
  /**
   * The right panel closed on its own for lack of room (never by the user).
   * Reopened by `reopen` once the panels fit again, while `scope` is still shown.
   */
  readonly autoClosedPanel: AutoClosedPanel | null;
  readonly setAutoClosedPanel: (panel: AutoClosedPanel | null) => void;
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
  autoClosedPanel: null,
  setAutoClosedPanel: (panel) => set((state) => ({ ...state, autoClosedPanel: panel })),
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
        // A panel open again, by the user or by the restore, settles the memory.
        autoClosedPanel: width !== null ? null : state.autoClosedPanel,
      };
    }),
}));

/**
 * Whether the main column would fall under its minimum with the list column
 * open beside the inline right panel at its own minimum width.
 */
export function mainColumnCrampedBesidePanel(input: {
  readonly viewportWidth: number;
  readonly navRailWidth: number;
  readonly listColumnWidth: number;
  readonly rightPanelOpen: boolean;
}): boolean {
  if (!input.rightPanelOpen) return false;
  return (
    input.viewportWidth - input.navRailWidth - input.listColumnWidth - RIGHT_PANEL_MIN_WIDTH_PX <
    MAIN_COLUMN_MIN_WIDTH_PX
  );
}

/**
 * Below this window width the list column rests collapsed and floats out from
 * the sidebar toggle, where a phone would show the sheet. A click still docks
 * it, and that holds until a right panel opens.
 */
export const LIST_COLUMN_DOCK_MIN_VIEWPORT_WIDTH_PX = 768;

/** Whether the window alone is too narrow to keep the list column docked by default. */
export function windowTooNarrowToDock(viewportWidth: number): boolean {
  return viewportWidth < LIST_COLUMN_DOCK_MIN_VIEWPORT_WIDTH_PX;
}

/** Whether a closed right panel fits again, at its minimum, beside the column as it is now. */
export function rightPanelFitsAgain(input: {
  readonly viewportWidth: number;
  readonly navRailWidth: number;
  readonly listColumnWidth: number;
  readonly listColumnOpen: boolean;
}): boolean {
  return !mainColumnCrampedBesidePanel({
    ...input,
    listColumnWidth: input.listColumnOpen ? input.listColumnWidth : 0,
    rightPanelOpen: true,
  });
}

/**
 * Whether a panel closed for room should come back: only a panel the layout
 * itself closed (a user's close leaves no record), on the page it left, with
 * room for it again.
 */
export function shouldReopenAutoClosedPanel(
  autoClosed: AutoClosedPanel | null,
  scopeShown: string | null,
  roomAgain: boolean,
): boolean {
  return autoClosed !== null && roomAgain && autoClosed.scope === scopeShown;
}

// The publisher whose width is current. Several surfaces publish (a chat's
// browser panel, the project panel beside a chat's hero); one that has no
// open panel publishes null, which must not clear another's width.
let inlineRightPanelOwner: object | null = null;

/** Reports an open inline right panel, so the list column can make room. */
export function usePublishInlineRightPanelWidth(width: number | null): void {
  const [owner] = useState(() => ({}));
  useEffect(() => {
    const store = useListColumnLayoutStore.getState();
    if (width !== null) {
      inlineRightPanelOwner = owner;
      store.setInlineRightPanelWidth(width);
    } else if (inlineRightPanelOwner === owner) {
      inlineRightPanelOwner = null;
      store.setInlineRightPanelWidth(null);
    }
  }, [owner, width]);
  useEffect(
    () => () => {
      if (inlineRightPanelOwner !== owner) return;
      inlineRightPanelOwner = null;
      useListColumnLayoutStore.getState().setInlineRightPanelWidth(null);
    },
    [owner],
  );
}
