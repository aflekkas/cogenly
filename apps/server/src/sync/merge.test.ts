import { describe, expect, it } from "vitest";
import { EnvironmentId, type SharedDocumentChange } from "@t3tools/contracts";
import { compareClock, mergeDocument, tickClock } from "./merge.ts";
const clock = (node: string, wall = 10, logical = 0) => ({ node, wall, logical });
const edit = (
  node: string,
  fields: SharedDocumentChange["fields"],
  wall = 10,
): SharedDocumentChange => ({
  kind: "project",
  id: "label:one",
  fields,
  clocks: Object.fromEntries(Object.keys(fields).map((key) => [key, clock(node, wall)])),
  tombstone: null,
  updatedBy: EnvironmentId.make(node),
});
describe("hybrid logical clocks and document merge", () => {
  it("ticks monotonically through backwards clocks and receive ties", () => {
    let local = tickClock("a", 100);
    for (const now of [90, 100, 0, 101, 1]) {
      const next = tickClock("a", now, local);
      expect(compareClock(next, local)).toBeGreaterThan(0);
      local = next;
    }
    expect(tickClock("a", 1, clock("a", 100, 2), clock("b", 100, 7))).toEqual(clock("a", 100, 8));
    expect(tickClock("a", 1, clock("a", 100), clock("b", 200, 4))).toEqual(clock("a", 200, 5));
    expect(tickClock("a", 300, clock("a", 100), clock("b", 200))).toEqual(clock("a", 300));
  });
  it("converges concurrent same-field and independent-field edits", () => {
    const a = edit("a", { name: "A", instructions: "Keep" });
    const b = edit("b", { name: "B" });
    expect(mergeDocument(a, b)).toEqual(mergeDocument(b, a));
    expect(mergeDocument(a, b).fields).toEqual({ name: "B", instructions: "Keep" });
  });
  it("is associative, idempotent and insensitive to delivery order with clock skew", () => {
    const changes = [
      edit("a", { name: "A" }, 1000),
      edit("b", { name: "B", instructions: "B" }, 10),
      edit("c", { instructions: "C" }, 500),
    ];
    const merge = (xs: typeof changes) =>
      xs.reduce((state, change) => mergeDocument(state, change));
    const expected = merge(changes);
    for (const xs of [changes, [...changes].reverse(), [changes[1]!, changes[0]!, changes[2]!]]) {
      expect(merge(xs)).toEqual(expected);
      expect(merge([...xs, ...xs])).toEqual(expected);
    }
    expect(mergeDocument(changes[0], mergeDocument(changes[1], changes[2]!))).toEqual(expected);
  });
  it("keeps tombstones against older, concurrent and later edits", () => {
    const deletion = { ...edit("a", {}), tombstone: clock("a", 20) };
    for (const wall of [10, 20, 1000]) {
      const change = edit("b", { name: "Cannot revive" }, wall);
      expect(mergeDocument(deletion, change)).toEqual(mergeDocument(change, deletion));
      expect(mergeDocument(deletion, change).tombstone).toEqual(deletion.tombstone);
    }
    expect(mergeDocument(deletion, deletion)).toEqual(deletion);
  });
  it("rejects identity mixing and clock overflow", () => {
    expect(() => mergeDocument(edit("a", {}), { ...edit("b", {}), id: "other" })).toThrow();
    expect(() => tickClock("a", 1, clock("a", 1, Number.MAX_SAFE_INTEGER))).toThrow();
  });
});
