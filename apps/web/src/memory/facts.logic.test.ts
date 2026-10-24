import { FactId, type Fact } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterFacts, principalLabel, resolveFactRefs } from "./facts.logic";

const fact = (id: string, status: Fact["status"], updatedAt: string, text = id): Fact => ({
  id: FactId.make(id),
  subject: id,
  text,
  labelIds: [],
  visibility: "user",
  sourceRefs: [],
  status,
  createdBy: "user",
  createdAt: updatedAt,
  updatedAt,
});

describe("filterFacts", () => {
  const facts = [
    fact("old", "confirmed", "2026-10-01T00:00:00.000Z"),
    fact("new", "confirmed", "2026-10-10T00:00:00.000Z", "Deploys on Thursdays"),
    fact("ask", "proposed", "2026-09-01T00:00:00.000Z"),
    fact("gone", "retracted", "2026-10-11T00:00:00.000Z"),
    fact("was", "superseded", "2026-10-12T00:00:00.000Z"),
  ];

  it("shows current facts with proposals first, then newest", () => {
    expect(filterFacts(facts, { status: "current" }).map((entry) => entry.id)).toEqual([
      "ask",
      "new",
      "old",
    ]);
  });

  it("filters by one status, all, and text", () => {
    expect(filterFacts(facts, { status: "retracted" }).map((entry) => entry.id)).toEqual(["gone"]);
    expect(filterFacts(facts, { status: "all" })).toHaveLength(5);
    expect(
      filterFacts(facts, { status: "all", query: " thursday " }).map((entry) => entry.id),
    ).toEqual(["new"]);
  });
});

describe("resolveFactRefs", () => {
  it("links a message through its thread and only safe web links", () => {
    expect(
      resolveFactRefs([
        { kind: "thread", id: "t1" },
        { kind: "message", id: "m1" },
        { kind: "pr", id: "https://github.com/o/r/pull/12" },
        { kind: "url", id: "file:///etc/passwd" },
        { kind: "run", id: "r1" },
      ]),
    ).toEqual([
      { kind: "thread", label: "Message", threadId: "t1" },
      { kind: "external", label: "PR #12", href: "https://github.com/o/r/pull/12" },
      { kind: "text", label: "Link" },
      { kind: "text", label: "Run" },
    ]);
  });
});

describe("principalLabel", () => {
  it("names the owner and agents", () => {
    const names = (id: string) => (id === "bot" ? "Bartr" : undefined);
    expect(principalLabel("user", names)).toBe("You");
    expect(principalLabel("agent:bot", names)).toBe("Bartr");
    expect(principalLabel("agent:missing", names)).toBe("An agent");
  });
});
