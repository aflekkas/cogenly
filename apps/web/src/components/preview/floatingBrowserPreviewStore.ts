import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { type FloatingPreviewCorner, floatingPreviewTabKey } from "./floatingBrowserPreview.logic";

export interface FloatingPreviewTarget {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly key: string;
}

interface FloatingBrowserPreviewState {
  /** The tab a browser panel showed last; the card floats it once no panel does. */
  readonly target: FloatingPreviewTarget | null;
  /** Tabs a browser panel shows right now, counted so overlapping mounts settle cleanly. */
  readonly shownCounts: Readonly<Record<string, number>>;
  /** The tab whose card the user closed; looking at the tab again clears it. */
  readonly dismissedKey: string | null;
  readonly corner: FloatingPreviewCorner;
  readonly dismiss: (key: string) => void;
  readonly setCorner: (corner: FloatingPreviewCorner) => void;
}

export const useFloatingBrowserPreviewStore = create<FloatingBrowserPreviewState>()((set) => ({
  target: null,
  shownCounts: {},
  dismissedKey: null,
  corner: "bottom-right",
  dismiss: (key) => set({ dismissedKey: key }),
  setCorner: (corner) => set((state) => (state.corner === corner ? state : { corner })),
}));

/**
 * A browser panel reports the tab it shows while visible. That tab becomes the
 * one the card floats when the panel closes, switches surface, or the user
 * leaves the thread. Returns the release for when the panel stops showing it.
 */
export function showBrowserTabInPanel(threadRef: ScopedThreadRef, tabId: string): () => void {
  const key = floatingPreviewTabKey(scopedThreadKey(threadRef), tabId);
  useFloatingBrowserPreviewStore.setState((state) => ({
    target: state.target?.key === key ? state.target : { threadRef, tabId, key },
    shownCounts: { ...state.shownCounts, [key]: (state.shownCounts[key] ?? 0) + 1 },
    dismissedKey: state.dismissedKey === key ? null : state.dismissedKey,
  }));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    useFloatingBrowserPreviewStore.setState((state) => {
      const count = state.shownCounts[key] ?? 0;
      const { [key]: _released, ...rest } = state.shownCounts;
      return { shownCounts: count <= 1 ? rest : { ...rest, [key]: count - 1 } };
    });
  };
}
