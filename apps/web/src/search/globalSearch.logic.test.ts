import {
  EnvironmentId,
  ProjectLabelId,
  ThreadId,
  type SearchQueryResult,
} from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  cleanSnippet,
  commitmentTarget,
  globalSearchQuery,
  globalSearchTarget,
  groupGlobalSearchResults,
  highlightSnippet,
  type GlobalSearchResult,
} from "./globalSearch.logic";

type Result = SearchQueryResult["results"][number];
const local = EnvironmentId.make("local");
const vps = EnvironmentId.make("vps");
const result = (kind: Result["kind"], id: string, extra: Partial<Result> = {}): Result => ({
  kind,
  id,
  title: id,
  snippet: "",
  labelIds: [],
  ...extra,
});
const noAgents = () => null;

describe("globalSearchQuery", () => {
  it("waits for two characters and leaves the actions filter alone", () => {
    expect(globalSearchQuery(" a ")).toBeNull();
    expect(globalSearchQuery(">release")).toBeNull();
    expect(globalSearchQuery("  release notes ")).toBe("release notes");
  });
});

describe("groupGlobalSearchResults", () => {
  it("orders kinds fixedly, keeps server rank, and alternates environments", () => {
    const groups = groupGlobalSearchResults([
      {
        environmentId: local,
        results: [result("pr", "p1"), result("chat", "a"), result("chat", "b")],
      },
      { environmentId: vps, results: [result("chat", "x"), result("agent", "bot")] },
    ]);
    expect(groups.map((group) => group.kind)).toEqual(["chat", "agent", "pr"]);
    expect(groups[0]!.results.map((entry) => `${entry.environmentId}:${entry.id}`)).toEqual([
      "local:a",
      "vps:x",
      "local:b",
    ]);
  });

  it("caps each kind and drops duplicates", () => {
    const many = Array.from({ length: 8 }, (_, index) => result("work", `w${index}`));
    const [work] = groupGlobalSearchResults(
      [{ environmentId: local, results: [...many, result("work", "w0")] }],
      3,
    );
    expect(work!.results.map((entry) => entry.id)).toEqual(["w0", "w1", "w2"]);
  });
});

describe("highlightSnippet", () => {
  it("marks every query word case-insensitively", () => {
    expect(highlightSnippet("Ship the Release notes", "release ship")).toEqual([
      { text: "Ship", match: true },
      { text: " the ", match: false },
      { text: "Release", match: true },
      { text: " notes", match: false },
    ]);
  });

  it("keeps markup as plain text and strips control and bidi characters", () => {
    const parts = highlightSnippet("<img src=x onerror=alert(1)>‮evil\u0000\n  tail", "img");
    expect(parts.map((part) => part.text).join("")).toBe("<img src=x onerror=alert(1)>evil tail");
    expect(parts.find((part) => part.match)?.text).toBe("img");
    expect(cleanSnippet("a​\tb")).toBe("a b");
  });

  it("prefers the longest overlapping word", () => {
    expect(highlightSnippet("deployment", "deploy deployment")).toEqual([
      { text: "deployment", match: true },
    ]);
  });
});

describe("globalSearchTarget", () => {
  const at = (entry: Result): GlobalSearchResult => ({ ...entry, environmentId: local });

  it("opens threads, agents and projects where they live", () => {
    const thread = ThreadId.make("t1");
    expect(globalSearchTarget(at(result("chat", "m1", { threadId: thread })), noAgents)).toEqual({
      kind: "thread",
      environmentId: local,
      threadId: thread,
    });
    expect(
      globalSearchTarget(at(result("agent", "a1")), () => ThreadId.make("conversation")),
    ).toMatchObject({ kind: "agent", threadId: "conversation", tab: "chat" });
    expect(globalSearchTarget(at(result("project", "label-1")), noAgents)).toEqual({
      kind: "project",
      environmentId: local,
      labelId: ProjectLabelId.make("label-1"),
    });
  });

  it("only opens http(s) pull request links", () => {
    expect(globalSearchTarget(at(result("pr", "https://github.com/o/r/pull/4")), noAgents)).toEqual(
      { kind: "external", href: "https://github.com/o/r/pull/4" },
    );
    expect(
      globalSearchTarget(
        at(result("pr", "javascript:alert(1)", { threadId: ThreadId.make("t") })),
        noAgents,
      ),
    ).toMatchObject({ kind: "thread", threadId: "t" });
  });

  it("routes an open item to its agent's Open items, else what it references", () => {
    const agentThread = (_: unknown, agentId: string) =>
      agentId === "bot" ? ThreadId.make("bot-chat") : null;
    const base = { agentId: null, sourceRefs: [], evidenceRefs: [] } as const;
    expect(
      commitmentTarget(local, { ...base, agentId: "bot" as never }, agentThread),
    ).toMatchObject({ kind: "agent", threadId: "bot-chat", tab: "items" });
    expect(
      commitmentTarget(
        local,
        {
          ...base,
          sourceRefs: [{ kind: "url", id: "https://example.com" }],
          evidenceRefs: [{ kind: "thread", id: "t9" }],
        },
        agentThread,
      ),
    ).toMatchObject({ kind: "thread", threadId: "t9" });
    expect(commitmentTarget(local, base, agentThread).kind).toBe("unavailable");
    expect(commitmentTarget(local, null, agentThread).kind).toBe("unavailable");
  });
});
