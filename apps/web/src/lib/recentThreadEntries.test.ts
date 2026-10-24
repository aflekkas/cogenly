import { describe, expect, it } from "vite-plus/test";

import { setRecentThreadEntry, withoutThreadEntry } from "./recentThreadEntries";

describe("setRecentThreadEntry", () => {
  it("keeps only the most recently written threads", () => {
    let record: Record<string, number> = {};
    for (const index of [1, 2, 3, 4]) {
      record = setRecentThreadEntry(record, `env-1:thread-${index}`, index, 3);
    }
    expect(Object.keys(record)).toEqual(["env-1:thread-2", "env-1:thread-3", "env-1:thread-4"]);
  });

  it("treats a rewrite as recent use, so that thread outlives the others", () => {
    let record: Record<string, number> = {};
    record = setRecentThreadEntry(record, "env-1:a", 1, 2);
    record = setRecentThreadEntry(record, "env-1:b", 1, 2);
    record = setRecentThreadEntry(record, "env-1:a", 2, 2);
    record = setRecentThreadEntry(record, "env-1:c", 1, 2);
    expect(record).toEqual({ "env-1:a": 2, "env-1:c": 1 });
  });
});

describe("withoutThreadEntry", () => {
  it("drops a thread and leaves a record without it untouched", () => {
    const record = { "env-1:a": 1, "env-1:b": 2 };
    expect(withoutThreadEntry(record, "env-1:a")).toEqual({ "env-1:b": 2 });
    expect(withoutThreadEntry(record, "env-1:missing")).toBe(record);
  });
});
