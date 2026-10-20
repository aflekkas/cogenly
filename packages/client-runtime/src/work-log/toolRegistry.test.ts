import { describe, expect, it } from "@effect/vitest";

import {
  normalizeWorkLogToolKey,
  resolveWorkLogTool,
  WORK_LOG_TOOLS,
  workLogToolGroupLabel,
} from "./toolRegistry.ts";

const searchInput = { query: "AI funding", kinds: ["chat", "work"], limit: 8 };
const searchOutput = { results: [{ kind: "chat", title: "Weekly checks" }] };

describe("normalizeWorkLogToolKey", () => {
  it("folds every provider's spelling of a Cogenly tool to one key", () => {
    for (const name of [
      "mcp__cogenly__search", // Claude
      "cogenly.search", // Codex
      "cogenly__search", // Muse and other MCP hosts
      "mcp__t3-code__search", // transcripts from before the rename
      "cogenly/search",
    ]) {
      expect(normalizeWorkLogToolKey(name)).toBe("search");
    }
    expect(normalizeWorkLogToolKey("mcp__cogenly__t3_thread_read")).toBe("t3_thread_read");
    expect(normalizeWorkLogToolKey("t3_thread_read")).toBe("t3_thread_read");
  });

  it("leaves other servers' and native tools alone", () => {
    expect(normalizeWorkLogToolKey("search")).toBeNull();
    expect(normalizeWorkLogToolKey("mcp__github__search")).toBeNull();
    expect(normalizeWorkLogToolKey("Read")).toBeNull();
    expect(normalizeWorkLogToolKey("web_search")).toBeNull();
  });
});

describe("resolveWorkLogTool", () => {
  it("says what a chat search looked for and found, for Claude, Codex and Muse alike", () => {
    // Claude keeps MCP results as text blocks, Codex as objects, Muse as JSON text.
    const outputs = [
      [{ type: "text", text: JSON.stringify(searchOutput) }],
      searchOutput,
      JSON.stringify(searchOutput),
      { resultCount: 1 }, // the compact wire form
    ];
    for (const [toolName, output] of [
      ["mcp__cogenly__search", outputs[0]],
      ["cogenly.search", outputs[1]],
      ["cogenly__search", outputs[2]],
      ["cogenly.search", outputs[3]],
    ] as const) {
      const tool = resolveWorkLogTool({
        toolName,
        input: searchInput,
        output,
        status: "completed",
      });
      expect(tool).toMatchObject({
        key: "search",
        icon: "search",
        label: "Searched chats and work for “AI funding” · 1 result",
        groupKey: "search",
        source: "registry",
      });
      expect(tool?.detail).toEqual([
        { label: "Query", value: "AI funding" },
        { label: "In", value: "chats and work" },
      ]);
    }
  });

  it("follows the call's status in the verb", () => {
    const resolve = (status: "inProgress" | "failed") =>
      resolveWorkLogTool({ toolName: "cogenly.search", input: { query: "x" }, status })?.label;
    expect(resolve("inProgress")).toBe("Searching Cogenly for “x”");
    expect(resolve("failed")).toBe("Failed to search Cogenly for “x”");
  });

  it("links a read chat by id and title instead of showing the raw id", () => {
    const tool = resolveWorkLogTool({
      toolName: "mcp__cogenly__t3_thread_read",
      input: { threadId: "5609dcde", view: "messages" },
      output: { thread: { threadId: "5609dcde", title: "Weekly checks" } },
      status: "completed",
    });
    expect(tool).toMatchObject({
      icon: "message-circle",
      label: "Read chat “Weekly checks”",
      labelPrefix: "Read chat",
      target: { kind: "thread", id: "5609dcde", title: "Weekly checks" },
      detail: [],
    });
    expect(tool?.label).not.toContain("5609dcde");
  });

  it("names an untitled read chat generically until the client supplies its live title", () => {
    const call = {
      toolName: "cogenly.t3_thread_read",
      input: { threadId: "t-1" },
      status: "completed" as const,
    };
    expect(resolveWorkLogTool(call)?.label).toBe("Read a chat");
    expect(resolveWorkLogTool({ ...call, targetTitle: "Renamed" })?.label).toBe(
      "Read chat “Renamed”",
    );
  });

  it("derives a row for T3 tools without an entry and a generic one for unknown Cogenly tools", () => {
    expect(
      resolveWorkLogTool({ toolName: "cogenly.delegate_task", status: "completed" }),
    ).toMatchObject({ label: "Delegated a child task", icon: "t3-code", source: "t3" });
    expect(
      resolveWorkLogTool({ toolName: "cogenly.terminal_read", status: "completed" }),
    ).toMatchObject({ label: "Terminal read", icon: "wrench", source: "generic" });
    expect(resolveWorkLogTool({ toolName: "Bash", status: "completed" })).toBeNull();
  });

  it("gives every registry entry a label for each status", () => {
    for (const key of Object.keys(WORK_LOG_TOOLS)) {
      for (const status of ["inProgress", "completed", "failed"] as const) {
        expect(resolveWorkLogTool({ toolName: `cogenly.${key}`, status })?.label).toMatch(/\S/);
      }
    }
  });
});

describe("workLogToolGroupLabel", () => {
  it("collapses repeated calls into one counted row", () => {
    const call = { toolName: "cogenly.search", input: searchInput, status: "completed" as const };
    expect(workLogToolGroupLabel("search", [call, call, call])).toBe("Searched chats ×3");
    expect(workLogToolGroupLabel("search", [call])).toBe(
      "Searched chats and work for “AI funding”",
    );
  });
});
