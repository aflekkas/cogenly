import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

/**
 * Whether a browser tab follows the app's theme ("match") or keeps an
 * explicit System / Light / Dark it was given. A tab only carries the scheme
 * it was last told on the wire, so this device remembers which tabs are
 * matching and re-sends the app's theme to them when it changes. A tab with
 * no entry follows the browser default appearance setting.
 */
export type PreviewAppearanceMode = "match" | "explicit";

interface PreviewAppearanceState {
  readonly byTab: Readonly<Record<string, PreviewAppearanceMode>>;
  setMode: (key: string, mode: PreviewAppearanceMode) => void;
  forget: (key: string) => void;
}

export const previewAppearanceKey = (environmentId: EnvironmentId, tabId: string) =>
  `${environmentId}:${tabId}`;

export const usePreviewAppearanceStore = create<PreviewAppearanceState>()(
  persist(
    (set) => ({
      byTab: {},
      setMode: (key, mode) =>
        set((state) =>
          state.byTab[key] === mode ? state : { byTab: { ...state.byTab, [key]: mode } },
        ),
      forget: (key) =>
        set((state) => {
          if (!(key in state.byTab)) return state;
          const { [key]: _removed, ...rest } = state.byTab;
          return { byTab: rest };
        }),
    }),
    {
      name: "cogenly:preview-appearance:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      partialize: (state) => ({ byTab: state.byTab }),
    },
  ),
);
