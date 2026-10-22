import { createMemoryHistory, type HistoryLocation } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import {
  applyNavigationHistoryAction,
  canGoBack,
  canGoForward,
  createNavigationHistoryTracker,
  initialNavigationHistoryPosition,
} from "./navigationHistory";

function entry(index: number | undefined, key = `key-${index}`): HistoryLocation {
  return {
    href: "/",
    pathname: "/",
    search: "",
    hash: "",
    state: { __TSR_index: index as number, __TSR_key: key, key },
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("applyNavigationHistoryAction", () => {
  it("can go back once it has left the first entry, and forward after going back", () => {
    let position = initialNavigationHistoryPosition(entry(0), null);
    expect(canGoBack(position)).toBe(false);
    expect(canGoForward(position)).toBe(false);

    position = applyNavigationHistoryAction(position, "PUSH", entry(1));
    position = applyNavigationHistoryAction(position, "PUSH", entry(2));
    expect(canGoBack(position)).toBe(true);
    expect(canGoForward(position)).toBe(false);

    position = applyNavigationHistoryAction(position, "BACK", entry(1));
    expect(canGoBack(position)).toBe(true);
    expect(canGoForward(position)).toBe(true);

    position = applyNavigationHistoryAction(position, "GO", entry(0));
    expect(canGoBack(position)).toBe(false);
    expect(canGoForward(position)).toBe(true);

    position = applyNavigationHistoryAction(position, "FORWARD", entry(1));
    expect(position).toEqual({ index: 1, maxIndex: 2 });
  });

  it("drops forward history on a push after going back", () => {
    let position = { index: 3, maxIndex: 3 };
    position = applyNavigationHistoryAction(position, "BACK", entry(2));
    position = applyNavigationHistoryAction(position, "BACK", entry(1));
    position = applyNavigationHistoryAction(position, "PUSH", entry(2));
    expect(position).toEqual({ index: 2, maxIndex: 2 });
    expect(canGoForward(position)).toBe(false);
  });

  it("keeps forward history across a replace", () => {
    let position = { index: 2, maxIndex: 4 };
    position = applyNavigationHistoryAction(position, "REPLACE", entry(2));
    expect(position).toEqual({ index: 2, maxIndex: 4 });
  });

  it("places an entry pushed outside the router one past the current one", () => {
    const position = applyNavigationHistoryAction(
      { index: 1, maxIndex: 3 },
      "PUSH",
      entry(undefined),
    );
    expect(position).toEqual({ index: 2, maxIndex: 2 });
  });
});

describe("initialNavigationHistoryPosition", () => {
  it("restores forward reach on a reload of the same entry", () => {
    const position = initialNavigationHistoryPosition(entry(1, "same"), {
      entryKey: "same",
      maxIndex: 3,
    });
    expect(position).toEqual({ index: 1, maxIndex: 3 });
  });

  it("ignores reach stored for another entry, from an earlier load in the tab", () => {
    const position = initialNavigationHistoryPosition(entry(0, "fresh"), {
      entryKey: "stale",
      maxIndex: 5,
    });
    expect(position).toEqual({ index: 0, maxIndex: 0 });
  });
});

describe("createNavigationHistoryTracker", () => {
  it("follows the router history and only notifies when availability changes", () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const tracker = createNavigationHistoryTracker(history, memoryStorage());
    let notifications = 0;
    tracker.subscribe(() => notifications++);
    expect(tracker.getSnapshot()).toEqual({ canGoBack: false, canGoForward: false });

    history.push("/settings");
    expect(tracker.getSnapshot()).toEqual({ canGoBack: true, canGoForward: false });
    history.replace("/settings/general");
    history.push("/usage");
    expect(notifications).toBe(1);

    tracker.back();
    expect(history.location.pathname).toBe("/settings/general");
    expect(tracker.getSnapshot()).toEqual({ canGoBack: true, canGoForward: true });

    tracker.back();
    expect(tracker.getSnapshot()).toEqual({ canGoBack: false, canGoForward: true });
    // Never steps out of the app's first entry.
    tracker.back();
    expect(history.location.pathname).toBe("/");

    tracker.forward();
    tracker.forward();
    expect(history.location.pathname).toBe("/usage");
    tracker.forward();
    expect(history.location.pathname).toBe("/usage");
    expect(tracker.getSnapshot()).toEqual({ canGoBack: true, canGoForward: false });
  });

  it("remembers forward reach for a reload", () => {
    const storage = memoryStorage();
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const tracker = createNavigationHistoryTracker(history, storage);
    history.push("/settings");
    history.push("/usage");
    tracker.back();

    const reloaded = createNavigationHistoryTracker(history, storage);
    expect(reloaded.getSnapshot()).toEqual({ canGoBack: true, canGoForward: true });
  });
});
