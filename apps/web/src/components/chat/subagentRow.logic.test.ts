import { describe, expect, it } from "vite-plus/test";

import { sharedSubagentDriver, subagentGroupLabel, subagentOutcome } from "./subagentRow.logic";

describe("subagentOutcome", () => {
  it("folds every in-flight state into working", () => {
    expect(subagentOutcome("pending")).toBe("working");
    expect(subagentOutcome("running")).toBe("working");
    expect(subagentOutcome("waiting")).toBe("working");
  });

  it("keeps settled states apart", () => {
    expect(subagentOutcome("completed")).toBe("done");
    expect(subagentOutcome("failed")).toBe("failed");
    expect(subagentOutcome("cancelled")).toBe("stopped");
    expect(subagentOutcome("interrupted")).toBe("stopped");
    expect(subagentOutcome("idle")).toBe("idle");
  });
});

describe("subagentGroupLabel", () => {
  it("counts the members and summarizes their states", () => {
    expect(subagentGroupLabel(["running", "running", "completed"])).toEqual({
      count: "3 subagents",
      summary: "2 working · 1 done",
      text: "3 subagents · 2 working · 1 done",
    });
  });

  it("uses the singular for one member", () => {
    expect(subagentGroupLabel(["failed"]).text).toBe("1 subagent · 1 failed");
  });

  it("omits the separator when there is nothing to summarize", () => {
    expect(subagentGroupLabel([]).text).toBe("0 subagents");
  });
});

describe("sharedSubagentDriver", () => {
  it("returns the driver when every member uses it", () => {
    expect(sharedSubagentDriver(["claude", "claude"])).toBe("claude");
  });

  it("returns nothing for mixed providers or no members", () => {
    expect(sharedSubagentDriver(["claude", "codex"])).toBeUndefined();
    expect(sharedSubagentDriver([])).toBeUndefined();
  });
});
