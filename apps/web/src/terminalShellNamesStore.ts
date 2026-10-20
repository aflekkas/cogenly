import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/**
 * Names the user gave their shells, on this device. The server labels a shell
 * by its number or foreground command; a rename only changes the tab title.
 */
interface TerminalShellNamesState {
  readonly names: Readonly<Record<string, string>>;
  rename: (ref: ScopedThreadRef, terminalId: string, name: string) => void;
  forget: (ref: ScopedThreadRef, terminalId: string) => void;
}

export const shellNameKey = (ref: ScopedThreadRef, terminalId: string) =>
  `${scopedThreadKey(ref)}:${terminalId}`;

export const useTerminalShellNamesStore = create<TerminalShellNamesState>()(
  persist(
    (set) => ({
      names: {},
      rename: (ref, terminalId, name) =>
        set((state) => {
          const key = shellNameKey(ref, terminalId);
          const trimmed = name.trim().slice(0, 64);
          const { [key]: _previous, ...rest } = state.names;
          return { names: trimmed.length > 0 ? { ...rest, [key]: trimmed } : rest };
        }),
      forget: (ref, terminalId) =>
        set((state) => {
          const key = shellNameKey(ref, terminalId);
          if (!(key in state.names)) return state;
          const { [key]: _removed, ...rest } = state.names;
          return { names: rest };
        }),
    }),
    {
      name: "cogenly:terminal-shell-names:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      partialize: (state) => ({ names: state.names }),
    },
  ),
);
