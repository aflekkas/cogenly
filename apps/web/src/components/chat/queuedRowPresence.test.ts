import { describe, expect, it } from "vite-plus/test";

import { mergeQueuedRowSlots, type QueuedRowSlot } from "./queuedRowPresence";

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
});
