import { describe, expect, it } from "@effect/vitest";

import { webSearchQueries } from "./itemDetail";

describe("webSearchQueries", () => {
  it("lists a query the provider repeated once", () => {
    const query = "Kyriakos Mitsotakis latest news October 2026";
    expect(webSearchQueries([query, query])).toEqual([query]);
    expect(webSearchQueries([query, ` ${query.toUpperCase()} `])).toEqual([query]);
  });

  it("keeps distinct queries in order and drops blanks", () => {
    expect(webSearchQueries(["greek election", "  ", "athens weather", "greek election"])).toEqual([
      "greek election",
      "athens weather",
    ]);
    expect(webSearchQueries(undefined)).toEqual([]);
  });
});
