import { scopedThreadKey } from "@cogenly/client-runtime/environment";
import type { ScopedThreadRef } from "@cogenly/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";

import {
  type FloatingPreviewCorner,
  type FloatingPreviewPoint,
  floatingPreviewTabKey,
  migratePersistedPosition,
} from "./floatingBrowserPreview.logic";

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
  /**
   * The chat-pane corner the user docked the card in; null until they position
   * it, when it rests at DEFAULT_FLOATING_PREVIEW_CORNER. Ignored while
   * `freePosition` is set.
   */
  readonly corner: FloatingPreviewCorner | null;
  /** Where the user dropped the card, in window coordinates; null when docked to a corner. */
  readonly freePosition: FloatingPreviewPoint | null;
  readonly dismiss: (key: string) => void;
  readonly setCorner: (corner: FloatingPreviewCorner) => void;
  readonly setFreePosition: (position: FloatingPreviewPoint) => void;
}

export const useFloatingBrowserPreviewStore = create<FloatingBrowserPreviewState>()(
  persist(
    (set) => ({
      target: null,
      shownCounts: {},
      dismissedKey: null,
      corner: null,
      freePosition: null,
      dismiss: (key) => set({ dismissedKey: key }),
      setCorner: (corner) => set({ corner, freePosition: null }),
      setFreePosition: (position) => set({ freePosition: position }),
    }),
    {
      name: "cogenly:floating-browser-preview:v1",
      version: 2,
      migrate: migratePersistedPosition,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      // Only where the user put the card survives a reload.
      partialize: (state) => ({ corner: state.corner, freePosition: state.freePosition }),
    },
  ),
);

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
