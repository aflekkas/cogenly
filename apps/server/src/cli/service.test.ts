import { describe, expect, it } from "@effect/vitest";

import { tailLines } from "./service.ts";

describe("tailLines", () => {
  it("returns the whole text when it is shorter than the limit", () => {
    expect(tailLines("one\ntwo\n", 200)).toBe("one\ntwo");
    expect(tailLines("one", 200)).toBe("one");
  });

  it("returns the last lines without a trailing newline", () => {
    expect(tailLines("one\ntwo\nthree\nfour\n", 2)).toBe("three\nfour");
  });

  it("returns nothing for empty input or a non-positive limit", () => {
    expect(tailLines("", 200)).toBe("");
    expect(tailLines("one\ntwo\n", 0)).toBe("");
    expect(tailLines("one\ntwo\n", -3)).toBe("");
  });
});
