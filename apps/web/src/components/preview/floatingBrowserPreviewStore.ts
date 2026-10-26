import { scopedThreadKey } from "@cogenly/client-runtime/environment";
import type { ScopedThreadRef } from "@cogenly/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";

import {
  dismissFloatingPreviewThread,
  type FloatingPreviewCorner,
  type FloatingPreviewDismissals,
  type FloatingPreviewPoint,
  floatingPreviewTabKey,
  migratePersistedFloatingPreview,
  restoreFloatingPreviewThread,
} from "./floatingBrowserPreview.logic";

export interface FloatingPreviewTarget {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly key: string;
}

interface FloatingBrowserPreviewState {
  /**
   * Per thread key, the tab that thread's browser panel showed last. A thread
   * only ever floats its own tab, so browsing in one never follows you to another.
   */
  readonly targets: Readonly<Record<string, FloatingPreviewTarget>>;
  /** Tabs a browser panel shows right now, counted so overlapping mounts settle cleanly. */
  readonly shownCounts: Readonly<Record<string, number>>;
  /**
   * Threads whose card the user closed. Showing the tab in the panel again does
   * not bring it back; only `restore` ("Show mini preview") does.
   */
  readonly dismissedThreads: FloatingPreviewDismissals;
  /**
   * The chat-pane corner the user docked the card in; null until they position
   * it, when it rests at DEFAULT_FLOATING_PREVIEW_CORNER. Ignored while
   * `freePosition` is set.
   */
  readonly corner: FloatingPreviewCorner | null;
  /** Where the user dropped the card, in chat-pane coordinates; null when docked to a corner. */
  readonly freePosition: FloatingPreviewPoint | null;
  /** The card width the user resized to; null until they resize it. */
  readonly width: number | null;
  readonly dismiss: (threadRef: ScopedThreadRef) => void;
  readonly restore: (threadRef: ScopedThreadRef) => void;
  readonly setCorner: (corner: FloatingPreviewCorner) => void;
  readonly setFreePosition: (position: FloatingPreviewPoint) => void;
  readonly setWidth: (width: number) => void;
}

export const useFloatingBrowserPreviewStore = create<FloatingBrowserPreviewState>()(
  persist(
    (set) => ({
      targets: {},
      shownCounts: {},
      dismissedThreads: {},
      corner: null,
      freePosition: null,
      width: null,
      dismiss: (threadRef) =>
        set((state) => ({
          dismissedThreads: dismissFloatingPreviewThread(
            state.dismissedThreads,
            scopedThreadKey(threadRef),
          ),
        })),
      restore: (threadRef) =>
        set((state) => {
          const dismissedThreads = restoreFloatingPreviewThread(
            state.dismissedThreads,
            scopedThreadKey(threadRef),
          );
          return dismissedThreads === state.dismissedThreads ? state : { dismissedThreads };
        }),
      setCorner: (corner) => set({ corner, freePosition: null }),
      setFreePosition: (position) => set({ freePosition: position }),
      setWidth: (width) => set({ width: Math.round(width) }),
    }),
    {
      name: "cogenly:floating-browser-preview:v1",
      version: 3,
      migrate: migratePersistedFloatingPreview,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      // Where the user put the card, how big they made it, and which threads'
      // cards they closed survive a reload. Targets refill as panels show tabs.
      partialize: (state) => ({
        corner: state.corner,
        freePosition: state.freePosition,
        width: state.width,
        dismissedThreads: state.dismissedThreads,
      }),
    },
  ),
);

/** The tab a thread's card floats, if its browser panel has shown one. */
export function selectFloatingPreviewTarget(
  state: Pick<FloatingBrowserPreviewState, "targets">,
  threadRef: ScopedThreadRef | null,
): FloatingPreviewTarget | null {
  return threadRef ? (state.targets[scopedThreadKey(threadRef)] ?? null) : null;
}

export function selectFloatingPreviewDismissed(
  state: Pick<FloatingBrowserPreviewState, "dismissedThreads">,
  threadRef: ScopedThreadRef,
): boolean {
  return scopedThreadKey(threadRef) in state.dismissedThreads;
}

/**
 * A browser panel reports the tab it shows while visible. That tab becomes the
 * one its thread's card floats when the panel closes, switches surface, or the
 * user leaves the thread. Returns the release for when the panel stops showing it.
 */
export function showBrowserTabInPanel(threadRef: ScopedThreadRef, tabId: string): () => void {
  const threadKey = scopedThreadKey(threadRef);
  const key = floatingPreviewTabKey(threadKey, tabId);
  useFloatingBrowserPreviewStore.setState((state) => ({
    targets:
      state.targets[threadKey]?.key === key
        ? state.targets
        : { ...state.targets, [threadKey]: { threadRef, tabId, key } },
    shownCounts: { ...state.shownCounts, [key]: (state.shownCounts[key] ?? 0) + 1 },
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
