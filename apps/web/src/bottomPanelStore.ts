/**
 * The bottom panel under the chat: its agent-command tabs, per thread. Like
 * T3 Code's terminal drawer, whether it is open and how tall it is are kept
 * per thread, so a thread comes back the way it was left.
 *
 * Every action here is a user's: the panel never opens because an agent
 * started a command. New runs only add or update tabs (derived from the
 * thread's terminals in bottomPanel.logic), and the header toggle shows a dot.
 */
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export interface ThreadBottomPanelState {
  open: boolean;
  /** The height the user dragged to; unset is the default height. */
  height?: number;
  /** The agent tab showing; the first tab when unset or gone. */
  activeTabId?: string;
  /** The command selected in each agent tab; the newest when unset. */
  selectedRunByTabId?: Record<string, string>;
  /** Closed tabs, holding their newest run key when closed (see bottomPanelTabs). */
  hiddenTabs?: Record<string, string>;
}

interface BottomPanelStoreState {
  byThreadKey: Record<string, ThreadBottomPanelState>;
  toggle: (ref: ScopedThreadRef) => void;
  setOpen: (ref: ScopedThreadRef, open: boolean) => void;
  setHeight: (ref: ScopedThreadRef, height: number) => void;
  selectTab: (ref: ScopedThreadRef, tabId: string) => void;
  selectRun: (ref: ScopedThreadRef, tabId: string, terminalId: string) => void;
  /**
   * Opens the panel on one agent command, for a click on a run in the
   * timeline or the composer's Running bar. Un-hides the tab.
   */
  showRun: (ref: ScopedThreadRef, tabId: string, terminalId: string) => void;
  /** Closes a tab until its agent runs another command. */
  hideTab: (ref: ScopedThreadRef, tabId: string, latestRunKey: string) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

const EMPTY_STATE: ThreadBottomPanelState = { open: false };

function withoutKey<T>(
  record: Record<string, T> | undefined,
  key: string,
): Record<string, T> | undefined {
  if (!record || !(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function compact(state: ThreadBottomPanelState): ThreadBottomPanelState {
  const next: ThreadBottomPanelState = { open: state.open };
  if (state.height !== undefined) next.height = state.height;
  if (state.activeTabId !== undefined) next.activeTabId = state.activeTabId;
  if (state.selectedRunByTabId && Object.keys(state.selectedRunByTabId).length > 0) {
    next.selectedRunByTabId = state.selectedRunByTabId;
  }
  if (state.hiddenTabs && Object.keys(state.hiddenTabs).length > 0) {
    next.hiddenTabs = state.hiddenTabs;
  }
  return next;
}

function update(
  byThreadKey: Record<string, ThreadBottomPanelState>,
  ref: ScopedThreadRef,
  updater: (current: ThreadBottomPanelState) => ThreadBottomPanelState,
): { byThreadKey: Record<string, ThreadBottomPanelState> } | Record<string, never> {
  const key = scopedThreadKey(ref);
  const current = byThreadKey[key] ?? EMPTY_STATE;
  const next = updater(current);
  if (next === current) return {};
  return { byThreadKey: { ...byThreadKey, [key]: compact(next) } };
}

export function migratePersistedBottomPanelState(persisted: unknown): {
  byThreadKey: Record<string, ThreadBottomPanelState>;
} {
  if (!persisted || typeof persisted !== "object" || !("byThreadKey" in persisted)) {
    return { byThreadKey: {} };
  }
  const stored = persisted.byThreadKey;
  if (!stored || typeof stored !== "object") return { byThreadKey: {} };
  const byThreadKey: Record<string, ThreadBottomPanelState> = {};
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    if (!parseScopedThreadKey(key) || !value || typeof value !== "object") continue;
    const entry = value as Partial<ThreadBottomPanelState>;
    byThreadKey[key] = compact({
      open: entry.open === true,
      ...(typeof entry.height === "number" && Number.isFinite(entry.height)
        ? { height: entry.height }
        : {}),
      ...(typeof entry.activeTabId === "string" ? { activeTabId: entry.activeTabId } : {}),
      ...(entry.selectedRunByTabId && typeof entry.selectedRunByTabId === "object"
        ? { selectedRunByTabId: entry.selectedRunByTabId }
        : {}),
      ...(entry.hiddenTabs && typeof entry.hiddenTabs === "object"
        ? { hiddenTabs: entry.hiddenTabs }
        : {}),
    });
  }
  return { byThreadKey };
}

export const useBottomPanelStore = create<BottomPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      toggle: (ref) =>
        set((state) =>
          update(state.byThreadKey, ref, (current) => ({ ...current, open: !current.open })),
        ),
      setOpen: (ref, open) =>
        set((state) =>
          update(state.byThreadKey, ref, (current) =>
            current.open === open ? current : { ...current, open },
          ),
        ),
      setHeight: (ref, height) =>
        set((state) =>
          update(state.byThreadKey, ref, (current) =>
            current.height === height ? current : { ...current, height },
          ),
        ),
      selectTab: (ref, tabId) =>
        set((state) =>
          update(state.byThreadKey, ref, (current) =>
            current.activeTabId === tabId ? current : { ...current, activeTabId: tabId },
          ),
        ),
      selectRun: (ref, tabId, terminalId) =>
        set((state) =>
          update(state.byThreadKey, ref, (current) =>
            current.selectedRunByTabId?.[tabId] === terminalId && current.activeTabId === tabId
              ? current
              : {
                  ...current,
                  activeTabId: tabId,
                  selectedRunByTabId: { ...current.selectedRunByTabId, [tabId]: terminalId },
                },
          ),
        ),
      showRun: (ref, tabId, terminalId) =>
        set((state) =>
          update(state.byThreadKey, ref, (current) => {
            const { hiddenTabs, ...rest } = current;
            const stillHidden = withoutKey(hiddenTabs, tabId);
            return {
              ...rest,
              open: true,
              activeTabId: tabId,
              selectedRunByTabId: { ...current.selectedRunByTabId, [tabId]: terminalId },
              ...(stillHidden ? { hiddenTabs: stillHidden } : {}),
            };
          }),
        ),
      hideTab: (ref, tabId, latestRunKey) =>
        set((state) =>
          update(state.byThreadKey, ref, (current) => {
            const { activeTabId, ...rest } = current;
            return {
              ...rest,
              ...(activeTabId !== undefined && activeTabId !== tabId ? { activeTabId } : {}),
              hiddenTabs: { ...current.hiddenTabs, [tabId]: latestRunKey },
            };
          }),
        ),
      removeThread: (ref) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          if (!(key in state.byThreadKey)) return state;
          const { [key]: _removed, ...byThreadKey } = state.byThreadKey;
          return { byThreadKey };
        }),
    }),
    {
      name: "cogenly:bottom-panel-state:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
      migrate: migratePersistedBottomPanelState,
    },
  ),
);

export function selectThreadBottomPanelState(
  byThreadKey: Record<string, ThreadBottomPanelState>,
  ref: ScopedThreadRef | null | undefined,
): ThreadBottomPanelState {
  if (!ref) return EMPTY_STATE;
  return byThreadKey[scopedThreadKey(ref)] ?? EMPTY_STATE;
}
