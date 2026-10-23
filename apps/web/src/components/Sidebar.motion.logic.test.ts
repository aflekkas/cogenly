import { describe, expect, it } from "vite-plus/test";

import { findRowWipe, rowWipeKeyframes } from "./Sidebar.motion.logic";

// Rows are 72px cards stacked from y=0, as named.
const layout = (names: readonly string[]) =>
  new Map(names.map((name, index) => [name, { top: index * 72, height: 72 }]));

describe("findRowWipe", () => {
  it("closes a gap from the top when the rows above it move down", () => {
    const order = ["header", "a", "b", "c"];
    const geometry = layout(order);
    const wipe = findRowWipe({
      order,
      index: 2,
      geometry: (name) => geometry.get(name),
      isNeighbour: (name) => name !== "b",
      displacement: (name) => (name === "a" ? -72 : 0),
    });
    expect(wipe).toEqual({ edge: "top", before: 0, distance: 72 });
  });

  it("closes a gap from the bottom when the rows below it move up", () => {
    const order = ["a", "b", "c"];
    const geometry = layout(order);
    const wipe = findRowWipe({
      order,
      index: 1,
      geometry: (name) => geometry.get(name),
      isNeighbour: (name) => name !== "b",
      displacement: (name) => (name === "c" ? 72 : 0),
    });
    expect(wipe).toEqual({ edge: "bottom", before: 0, distance: 72 });
  });

  it("measures the rows leaving together between this one and the neighbour", () => {
    const order = ["a", "b1", "b2"];
    const geometry = layout(order);
    const wipe = findRowWipe({
      order,
      index: 2,
      geometry: (name) => geometry.get(name),
      isNeighbour: (name) => name === "a",
      displacement: () => 144,
    });
    expect(wipe).toEqual({ edge: "top", before: 72, distance: 144 });
  });

  it("leaves the row fading in place when no neighbour moves", () => {
    const order = ["a", "b", "c"];
    const geometry = layout(order);
    const wipe = findRowWipe({
      order,
      index: 1,
      geometry: (name) => geometry.get(name),
      isNeighbour: (name) => name !== "b",
      displacement: () => 0,
    });
    expect(wipe).toBeNull();
  });

  it("has nothing to close against at the end of an anchored list", () => {
    const order = ["a", "b"];
    const geometry = layout(order);
    const wipe = findRowWipe({
      order,
      index: 0,
      geometry: (name) => geometry.get(name),
      isNeighbour: (name) => name !== "a",
      displacement: () => 0,
    });
    expect(wipe).toBeNull();
  });
});

describe("rowWipeKeyframes", () => {
  it("clips a leaving row away at the neighbour's pace", () => {
    expect(rowWipeKeyframes({ edge: "top", before: 0, distance: 72 }, 72, "out")).toEqual([
      { offset: 0, clipPath: "inset(0px 0px 0px 0px)" },
      { offset: 1, clipPath: "inset(72px 0px 0px 0px)" },
    ]);
  });

  it("waits for the rows between it and the neighbour to go first", () => {
    expect(rowWipeKeyframes({ edge: "bottom", before: 72, distance: 144 }, 72, "out")).toEqual([
      { offset: 0, clipPath: "inset(0px 0px 0px 0px)" },
      { offset: 0.5, clipPath: "inset(0px 0px 0px 0px)" },
      { offset: 1, clipPath: "inset(0px 0px 72px 0px)" },
    ]);
  });

  it("plays a joining row's wipe back to front", () => {
    expect(rowWipeKeyframes({ edge: "top", before: 0, distance: 72 }, 72, "in")).toEqual([
      { offset: 0, clipPath: "inset(72px 0px 0px 0px)" },
      { offset: 1, clipPath: "inset(0px 0px 0px 0px)" },
    ]);
  });

  it("stops where a short move ends and skips a row it never reaches", () => {
    expect(rowWipeKeyframes({ edge: "top", before: 0, distance: 40 }, 72, "out")).toEqual([
      { offset: 0, clipPath: "inset(0px 0px 0px 0px)" },
      { offset: 1, clipPath: "inset(40px 0px 0px 0px)" },
    ]);
    expect(rowWipeKeyframes({ edge: "top", before: 80, distance: 72 }, 72, "out")).toBeNull();
  });
});
