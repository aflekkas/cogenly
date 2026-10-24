import { describe, expect, it } from "vite-plus/test";

import {
  focusKeyAfterRemoval,
  mergeQueuedRowSlots,
  retainQueuedCancels,
  type QueuedRowSlot,
} from "./queuedRowPresence";

const shown = (...keys: string[]): QueuedRowSlot<string>[] =>
  keys.map((key) => ({ key, item: key, leaving: false, animateEnter: false }));
const next = (...keys: string[]) => keys.map((key) => ({ key, item: key }));
const summary = (slots: ReadonlyArray<QueuedRowSlot<string>>) =>
  slots.map((slot) => `${slot.key}${slot.leaving ? "-" : ""}${slot.animateEnter ? "+" : ""}`);

describe("mergeQueuedRowSlots", () => {
  it("lets the tray grow its first rows instead of each row", () => {
    expect(summary(mergeQueuedRowSlots([], next("a", "b")))).toEqual(["a", "b"]);
  });

  it("grows a row that arrives once the tray is up", () => {
    expect(summary(mergeQueuedRowSlots(shown("a"), next("a", "b")))).toEqual(["a", "b+"]);
  });

  it("keeps a row that left in its place while it collapses", () => {
    expect(summary(mergeQueuedRowSlots(shown("a", "b", "c"), next("a", "c")))).toEqual([
      "a",
      "b-",
      "c",
    ]);
    expect(summary(mergeQueuedRowSlots(shown("a", "b"), next("b")))).toEqual(["a-", "b"]);
  });

  it("keeps a leaving row after the row it followed when the rest reorder", () => {
    const leaving = mergeQueuedRowSlots(shown("a", "b", "c"), next("a", "c"));
    expect(summary(mergeQueuedRowSlots(leaving, next("c", "a")))).toEqual(["c", "a", "b-"]);
  });

  it("brings a leaving row back when it returns", () => {
    const leaving = mergeQueuedRowSlots(shown("a", "b"), next("a"));
    expect(summary(mergeQueuedRowSlots(leaving, next("a", "b")))).toEqual(["a", "b"]);
  });

  it("keeps each rapidly removed row in its own place", () => {
    // Three quick removals down the list, each before the server answers.
    let slots = mergeQueuedRowSlots(shown("a", "b", "c", "d"), next("b", "c", "d"));
    slots = mergeQueuedRowSlots(slots, next("c", "d"));
    slots = mergeQueuedRowSlots(slots, next("d"));
    expect(summary(slots)).toEqual(["a-", "b-", "c-", "d"]);
    // The server catching up with the same queue changes nothing.
    expect(summary(mergeQueuedRowSlots(slots, next("d")))).toEqual(["a-", "b-", "c-", "d"]);
  });
});

describe("retainQueuedCancels", () => {
  it("keeps the same set while every cancel is still queued", () => {
    const cancelled = new Set(["a", "b"]);
    expect(retainQueuedCancels(cancelled, ["a", "b", "c"])).toBe(cancelled);
  });

  it("drops cancels the server has already removed from the queue", () => {
    expect([...retainQueuedCancels(new Set(["a", "b"]), ["b", "c"])]).toEqual(["b"]);
  });
});

describe("focusKeyAfterRemoval", () => {
  it("moves to the next row, else the previous, else nowhere", () => {
    expect(focusKeyAfterRemoval(["a", "b", "c"], "b")).toBe("c");
    expect(focusKeyAfterRemoval(["a", "b", "c"], "c")).toBe("b");
    expect(focusKeyAfterRemoval(["a"], "a")).toBeNull();
    expect(focusKeyAfterRemoval(["a"], "z")).toBeNull();
  });
});
