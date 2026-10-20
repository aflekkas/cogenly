import { describe, expect, it } from "vite-plus/test";

import { gridColumnCount, gridNeighbor } from "./projectGrid.logic";

describe("gridNeighbor", () => {
  // Seven cells, three wide:  0 1 2 / 3 4 5 / 6
  it("moves by one across and by a row down and up, without wrapping", () => {
    expect(gridNeighbor(1, "ArrowRight", 7, 3)).toBe(2);
    expect(gridNeighbor(0, "ArrowLeft", 7, 3)).toBe(0);
    expect(gridNeighbor(1, "ArrowDown", 7, 3)).toBe(4);
    expect(gridNeighbor(4, "ArrowUp", 7, 3)).toBe(1);
    expect(gridNeighbor(1, "ArrowUp", 7, 3)).toBe(1);
  });

  it("stays put going down from a row with nothing under it", () => {
    expect(gridNeighbor(5, "ArrowDown", 7, 3)).toBe(5);
    expect(gridNeighbor(3, "ArrowDown", 7, 3)).toBe(6);
  });

  it("jumps to the ends and ignores other keys", () => {
    expect(gridNeighbor(4, "Home", 7, 3)).toBe(0);
    expect(gridNeighbor(0, "End", 7, 3)).toBe(6);
    expect(gridNeighbor(0, "Enter", 7, 3)).toBeNull();
    expect(gridNeighbor(0, "ArrowRight", 0, 3)).toBeNull();
  });
});

describe("gridColumnCount", () => {
  it("counts the cells on the first row", () => {
    expect(gridColumnCount([10, 10, 10, 200, 200])).toBe(3);
    expect(gridColumnCount([10])).toBe(1);
    expect(gridColumnCount([])).toBe(1);
  });
});
