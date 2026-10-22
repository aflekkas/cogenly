import type { HistoryLocation, RouterHistory } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";

type HistoryAction = Parameters<Parameters<RouterHistory["subscribe"]>[0]>[0]["action"]["type"];

/**
 * Where the app sits in its own session history. The router stamps every entry
 * with its index (`__TSR_index`), which answers "can go back" (index > 0: the
 * app's first entry is 0). Browsers expose no forward count, so the tracker
 * remembers the furthest index still reachable: a push truncates forward
 * history there, a replace or a traversal keeps it.
 */
export interface NavigationHistoryPosition {
  readonly index: number;
  readonly maxIndex: number;
}

/** What survives a reload: the furthest index, tied to the entry it was read on. */
export interface StoredNavigationHistory {
  readonly entryKey: string;
  readonly maxIndex: number;
}

function readEntryIndex(location: HistoryLocation): number | null {
  const index = location.state.__TSR_index;
  return typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : null;
}

function readEntryKey(location: HistoryLocation): string | null {
  return location.state.__TSR_key ?? location.state.key ?? null;
}

/**
 * The position on load. A reload keeps the entry (and its key), so its stored
 * forward reach still holds; a fresh load in the same tab is a new entry, and
 * the stored reach belongs to history the browser has already dropped.
 */
export function initialNavigationHistoryPosition(
  location: HistoryLocation,
  stored: StoredNavigationHistory | null,
): NavigationHistoryPosition {
  const index = readEntryIndex(location) ?? 0;
  const key = readEntryKey(location);
  const storedMax =
    stored !== null && key !== null && stored.entryKey === key ? stored.maxIndex : 0;
  return { index, maxIndex: Math.max(index, storedMax) };
}

export function applyNavigationHistoryAction(
  position: NavigationHistoryPosition,
  action: HistoryAction,
  location: HistoryLocation,
): NavigationHistoryPosition {
  // An entry pushed outside the router carries no index: it sits one past the last.
  const index =
    readEntryIndex(location) ?? (action === "PUSH" ? position.index + 1 : position.index);
  if (action === "PUSH") return { index, maxIndex: index };
  return { index, maxIndex: Math.max(position.maxIndex, index) };
}

export function canGoBack(position: NavigationHistoryPosition): boolean {
  return position.index > 0;
}

export function canGoForward(position: NavigationHistoryPosition): boolean {
  return position.index < position.maxIndex;
}

export interface NavigationHistoryAvailability {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

const STORAGE_KEY = "cogenly:navigation-history";

function readStored(storage: Storage | null): StoredNavigationHistory | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "entryKey" in parsed &&
      "maxIndex" in parsed &&
      typeof parsed.entryKey === "string" &&
      typeof parsed.maxIndex === "number"
    ) {
      return { entryKey: parsed.entryKey, maxIndex: parsed.maxIndex };
    }
  } catch {
    // Storage can be unavailable (private mode, sandboxed frames).
  }
  return null;
}

function writeStored(storage: Storage | null, value: StoredNavigationHistory): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Best effort: losing it only drops forward reach across a reload.
  }
}

export interface NavigationHistoryTracker {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => NavigationHistoryAvailability;
  readonly back: () => void;
  readonly forward: () => void;
}

/** Follows the router history from the first navigation; one per history. */
export function createNavigationHistoryTracker(
  history: RouterHistory,
  storage: Storage | null = typeof sessionStorage === "undefined" ? null : sessionStorage,
): NavigationHistoryTracker {
  let position = initialNavigationHistoryPosition(history.location, readStored(storage));
  let snapshot: NavigationHistoryAvailability = {
    canGoBack: canGoBack(position),
    canGoForward: canGoForward(position),
  };
  const listeners = new Set<() => void>();

  history.subscribe(({ location, action }) => {
    position = applyNavigationHistoryAction(position, action.type, location);
    const key = readEntryKey(location);
    if (key !== null) writeStored(storage, { entryKey: key, maxIndex: position.maxIndex });
    const next = { canGoBack: canGoBack(position), canGoForward: canGoForward(position) };
    if (next.canGoBack === snapshot.canGoBack && next.canGoForward === snapshot.canGoForward) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) listener();
  });

  return {
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    getSnapshot: () => snapshot,
    // Guarded so a stray shortcut never leaves the app for the page before it.
    back: () => {
      if (canGoBack(position)) history.back();
    },
    forward: () => {
      if (canGoForward(position)) history.forward();
    },
  };
}

let appTracker: NavigationHistoryTracker | null = null;

/** Starts tracking the app's router history; call once, before the first render. */
export function installNavigationHistoryTracker(history: RouterHistory): NavigationHistoryTracker {
  appTracker ??= createNavigationHistoryTracker(history);
  return appTracker;
}

const UNTRACKED: NavigationHistoryAvailability = { canGoBack: false, canGoForward: false };
const subscribeNone = () => () => {};

export function navigateHistoryBack(): void {
  appTracker?.back();
}

export function navigateHistoryForward(): void {
  appTracker?.forward();
}

export function useNavigationHistoryAvailability(): NavigationHistoryAvailability {
  return useSyncExternalStore(
    appTracker?.subscribe ?? subscribeNone,
    appTracker?.getSnapshot ?? (() => UNTRACKED),
  );
}
