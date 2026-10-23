import * as Schema from "effect/Schema";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import {
  clampThreadSidebarWidth,
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarDragMaximumWidth,
  resolveThreadSidebarMaximumWidth,
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
} from "../components/threadSidebarWidth";
import type { ResizableWidthHandlers } from "./useResizableWidth";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "./useLocalStorage";
import { useResizeDrag } from "./useResizeDrag";

const WidthSchema = Schema.Finite;

function readStoredWidth(): number | null {
  try {
    return getLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, WidthSchema);
  } catch (error) {
    console.error("Could not read persisted sidebar width.", error);
    return null;
  }
}

/**
 * The list column's width: the user's dragged width when there is one,
 * otherwise the viewport-proportional default, always inside the column's
 * bounds. The handle (an EdgeResizeHandle inside the column) drives it.
 *
 * A drag writes `--sidebar-width` on the column's own sidebar root each frame,
 * so only the column and its gap restyle and the layout does not re-render.
 * The width commits to state and localStorage once, when the drag ends; the
 * layout then sets it on the provider as usual. `reset` returns to the default.
 */
export function useThreadSidebarWidth(input: {
  readonly viewportWidth: number;
  /** The window width less the nav rail. */
  readonly availableWidth: number;
  readonly minimumWidth: number;
  /** The open inline right panel's minimum width, or null when none is open. */
  readonly rightPanelMinimumWidth: number | null;
  /** False cancels an active drag, e.g. when the column collapses mid-drag. */
  readonly enabled: boolean;
}): {
  readonly width: number;
  readonly handlers: ResizableWidthHandlers;
  readonly reset: () => void;
} {
  const { viewportWidth, availableWidth, minimumWidth, rightPanelMinimumWidth, enabled } = input;
  // No cross-tab subscription: the column's width is per-window state.
  const [storedWidth, setStoredWidth] = useState(readStoredWidth);
  const width = clampThreadSidebarWidth(
    resolveInitialThreadSidebarWidth(storedWidth, viewportWidth),
    minimumWidth,
    resolveThreadSidebarMaximumWidth(availableWidth, minimumWidth),
  );
  const dragMaximumWidth = resolveThreadSidebarDragMaximumWidth({
    availableWidth,
    minimumWidth,
    currentWidth: width,
    rightPanelMinimumWidth,
  });

  const bounds = useRef({ minimumWidth, maximumWidth: dragMaximumWidth });
  useLayoutEffect(() => {
    bounds.current = { minimumWidth, maximumWidth: dragMaximumWidth };
  }, [dragMaximumWidth, minimumWidth]);

  const { refresh, ...handlers } = useResizeDrag<HTMLElement>((event) => {
    const host = event.currentTarget.closest<HTMLElement>('[data-slot="sidebar"]');
    if (!host) return null;
    return {
      width,
      edge: "right",
      resize(value) {
        const nextWidth = Math.round(
          clampThreadSidebarWidth(value, bounds.current.minimumWidth, bounds.current.maximumWidth),
        );
        host.style.setProperty("--sidebar-width", `${nextWidth}px`);
        return nextWidth;
      },
      finish(finalWidth, moved) {
        if (!moved) return;
        setStoredWidth(finalWidth);
        // Once at drag-end, not on every frame.
        try {
          setLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, finalWidth, WidthSchema);
        } catch (error) {
          console.error("Could not persist sidebar width.", error);
        }
      },
      // The provider's committed width takes over again; finish's state update
      // renders it before the next paint.
      cleanup() {
        host.style.removeProperty("--sidebar-width");
      },
    };
  }, String(enabled));

  // Bounds can change mid-drag (a right panel opens, the window narrows), so
  // re-apply the live pointer position against them.
  useLayoutEffect(refresh, [dragMaximumWidth, minimumWidth, refresh]);

  const reset = useCallback(() => {
    setStoredWidth(null);
    try {
      removeLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY);
    } catch (error) {
      console.error("Could not reset persisted sidebar width.", error);
    }
  }, []);

  return { width, handlers, reset };
}
