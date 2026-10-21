import { describe, expect, it } from "vite-plus/test";

import {
  SCRAMBLE_MAX_INTERVAL_MS,
  SCRAMBLE_MIN_INTERVAL_MS,
  SCRAMBLE_RESOLVE_MS,
  glyphFor,
  initScrambleCells,
  nextChangeDelay,
  resolveScrambleCells,
  resolvedCharacterCount,
  stepScrambleCells,
} from "./scrambleText.logic";

/** A repeating sequence of "random" values, so frames are predictable. */
function sequence(...values: number[]) {
  let index = 0;
  return () => values[index++ % values.length]!;
}
const text = (cells: ReadonlyArray<{ char: string }>) => cells.map((cell) => cell.char).join("");

describe("glyphFor", () => {
  it("keeps each character's case and never scrambles whitespace", () => {
    const random = sequence(0.5);
    expect(glyphFor("a", random)).toMatch(/^[a-z]$/);
    expect(glyphFor("Q", random)).toMatch(/^[A-Z]$/);
    expect(glyphFor("7", random)).toMatch(/^[0-9]$/);
    expect(glyphFor(" ", random)).toBeNull();
  });

  it("stays in its glyph set at the top of the random range", () => {
    expect(glyphFor("a", () => 0.999_999)).toMatch(/^[a-z]$/);
  });
});

describe("nextChangeDelay", () => {
  it("gives each character a slow clock between the two bounds", () => {
    expect(nextChangeDelay(() => 0)).toBe(SCRAMBLE_MIN_INTERVAL_MS);
    expect(nextChangeDelay(() => 1)).toBe(SCRAMBLE_MAX_INTERVAL_MS);
    expect(nextChangeDelay(() => 0.5)).toBeGreaterThan(SCRAMBLE_MIN_INTERVAL_MS);
  });
});

describe("initScrambleCells", () => {
  it("scrambles a character only when it rolls under the ratio", () => {
    const under = initScrambleCells("ab c", 0, () => 0.2, 0.35);
    expect(under.map((cell) => cell.scrambled)).toEqual([true, true, false, true]);
    const over = initScrambleCells("ab c", 0, () => 0.5, 0.35);
    expect(text(over)).toBe("ab c");
    expect(over.some((cell) => cell.scrambled)).toBe(false);
  });

  it("keeps most of a title legible at the default ratio", () => {
    let seed = 1;
    const random = () => {
      seed = (seed * 16_807) % 2_147_483_647;
      return seed / 2_147_483_647;
    };
    const title = "Regenerate the sidebar title animation";
    const cells = initScrambleCells(title, 0, random);
    const scrambled = cells.filter((cell) => cell.scrambled).length;
    expect(scrambled / title.length).toBeLessThan(0.5);
  });
});

describe("stepScrambleCells", () => {
  it("changes nothing before a cell's clock is due", () => {
    const cells = initScrambleCells("abc", 0, sequence(0.9));
    const step = stepScrambleCells(cells, "abc", SCRAMBLE_MIN_INTERVAL_MS - 1, sequence(0.1));
    expect(step.changed).toBe(false);
    expect(step.cells).toEqual(cells);
  });

  it("rerolls a cell once its clock is due", () => {
    const cells = initScrambleCells("abc", 0, sequence(0.9));
    const step = stepScrambleCells(cells, "abc", SCRAMBLE_MAX_INTERVAL_MS + 1, sequence(0.1));
    expect(step.changed).toBe(true);
    expect(step.cells.every((cell) => cell.scrambled)).toBe(true);
  });

  it("follows the source to a new length", () => {
    const cells = initScrambleCells("ab", 0, sequence(0.9));
    const step = stepScrambleCells(cells, "abcd", 1, sequence(0.9));
    expect(text(step.cells)).toBe("abcd");
  });
});

describe("resolvedCharacterCount", () => {
  it("settles left to right over the slower resolve", () => {
    expect(SCRAMBLE_RESOLVE_MS).toBeGreaterThanOrEqual(700);
    expect(SCRAMBLE_RESOLVE_MS).toBeLessThanOrEqual(900);
    expect(resolvedCharacterCount(10, 0)).toBe(0);
    expect(resolvedCharacterCount(10, SCRAMBLE_RESOLVE_MS / 2)).toBe(5);
    expect(resolvedCharacterCount(10, SCRAMBLE_RESOLVE_MS)).toBe(10);
  });

  it("finishes at once for an empty target or no duration", () => {
    expect(resolvedCharacterCount(0, 100)).toBe(0);
    expect(resolvedCharacterCount(8, 0, 0)).toBe(8);
  });
});

describe("resolveScrambleCells", () => {
  const keep = sequence(0.9);

  it("wipes from the old text to the new, left to right", () => {
    const cells = initScrambleCells("old text", 0, keep);
    const halfway = resolveScrambleCells(
      cells,
      "old text",
      "new name",
      SCRAMBLE_RESOLVE_MS / 2,
      1,
      keep,
    );
    expect(halfway.done).toBe(false);
    expect(text(halfway.cells)).toBe("new text");
  });

  it("settled characters stop scrambling", () => {
    const cells = initScrambleCells("abcd", 0, sequence(0.1));
    const step = resolveScrambleCells(
      cells,
      "abcd",
      "wxyz",
      SCRAMBLE_RESOLVE_MS / 2,
      1,
      sequence(0.1),
    );
    expect(step.cells.slice(0, 2)).toEqual([
      { char: "w", scrambled: false, nextChangeAt: Number.POSITIVE_INFINITY },
      { char: "x", scrambled: false, nextChangeAt: Number.POSITIVE_INFINITY },
    ]);
  });

  it("is exactly the new text once the duration has passed", () => {
    const cells = initScrambleCells("old", 0, sequence(0.1));
    const done = resolveScrambleCells(cells, "old", "New title", SCRAMBLE_RESOLVE_MS, 1, keep);
    expect(done.done).toBe(true);
    expect(text(done.cells)).toBe("New title");
    expect(done.cells.some((cell) => cell.scrambled)).toBe(false);
  });
});
