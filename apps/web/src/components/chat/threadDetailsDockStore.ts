import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

/**
 * Thread details docked beside the chat. `docked` is the user's choice and
 * holds across threads and reloads until they toggle it off; `available` is
 * whether the open chat has room for the card right now (ThreadDetailsDock
 * measures it). The header button docks while there is room, and opens the
 * popover otherwise.
 */
interface ThreadDetailsDockState {
  docked: boolean;
  available: boolean;
  setDocked: (docked: boolean) => void;
  setAvailable: (available: boolean) => void;
}

export const useThreadDetailsDockStore = create<ThreadDetailsDockState>()(
  persist(
    (set) => ({
      docked: false,
      available: false,
      setDocked: (docked) => set((state) => (state.docked === docked ? state : { docked })),
      setAvailable: (available) =>
        set((state) => (state.available === available ? state : { available })),
    }),
    {
      name: "cogenly:thread-details-dock:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ docked: state.docked }),
    },
  ),
);
