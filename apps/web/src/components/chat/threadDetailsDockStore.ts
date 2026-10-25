import { parseScopedThreadKey, scopedThreadKey } from "@cogenly/client-runtime/environment";
import { type ScopedThreadRef } from "@cogenly/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { setRecentThreadEntry, withoutThreadEntry } from "../../lib/recentThreadEntries";
import { resolveStorage } from "../../lib/storage";

/**
 * Thread details docked beside the chat. Docking is the user's choice per
 * thread: a thread they docked it in keeps it across switches and reloads,
 * and every other thread starts undocked. `available` is whether the open
 * chat has room for the card right now (ThreadDetailsDock measures it). The
 * header button docks while there is room, and opens the popover otherwise.
 */
interface ThreadDetailsDockState {
  /** Threads with the card docked, most recently docked last. */
  dockedByThreadKey: Record<string, true>;
  available: boolean;
  setDocked: (ref: ScopedThreadRef, docked: boolean) => void;
  setAvailable: (available: boolean) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

export function migratePersistedThreadDetailsDockState(persisted: unknown): {
  dockedByThreadKey: Record<string, true>;
} {
  // v1 held one docked flag for every thread; it belongs to no thread in particular.
  if (!persisted || typeof persisted !== "object" || !("dockedByThreadKey" in persisted)) {
    return { dockedByThreadKey: {} };
  }
  const stored = persisted.dockedByThreadKey;
  if (!stored || typeof stored !== "object") return { dockedByThreadKey: {} };
  const dockedByThreadKey: Record<string, true> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (value === true && parseScopedThreadKey(key)) dockedByThreadKey[key] = true;
  }
  return { dockedByThreadKey };
}

export const useThreadDetailsDockStore = create<ThreadDetailsDockState>()(
  persist(
    (set) => ({
      dockedByThreadKey: {},
      available: false,
      setDocked: (ref, docked) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          if ((state.dockedByThreadKey[key] === true) === docked) return state;
          return {
            dockedByThreadKey: docked
              ? setRecentThreadEntry(state.dockedByThreadKey, key, true)
              : withoutThreadEntry(state.dockedByThreadKey, key),
          };
        }),
      setAvailable: (available) =>
        set((state) => (state.available === available ? state : { available })),
      removeThread: (ref) =>
        set((state) => {
          const dockedByThreadKey = withoutThreadEntry(
            state.dockedByThreadKey,
            scopedThreadKey(ref),
          );
          return dockedByThreadKey === state.dockedByThreadKey ? state : { dockedByThreadKey };
        }),
    }),
    {
      name: "cogenly:thread-details-dock:v1",
      version: 2,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ dockedByThreadKey: state.dockedByThreadKey }),
      migrate: migratePersistedThreadDetailsDockState,
    },
  ),
);

/** Whether the user docked the details card in this thread; undocked until they do. */
export function selectThreadDetailsDocked(
  state: Pick<ThreadDetailsDockState, "dockedByThreadKey">,
  ref: ScopedThreadRef,
): boolean {
  return state.dockedByThreadKey[scopedThreadKey(ref)] === true;
}
