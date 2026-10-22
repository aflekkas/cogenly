import { describe, expect, it } from "@effect/vitest";

import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

import {
  normalizeWorkLogToolKey,
  resolveWorkLogNotice,
  resolveWorkLogTool,
  WORK_LOG_TOOLS,
  workLogCallFromItem,
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

  it("folds native tool names from Claude, Codex and Muse to one key each", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["Bash", "command"],
      ["exec_command", "command"],
      ["shell", "command"],
      ["Read", "read"],
      ["read_file", "read"],
      ["Write", "write"],
      ["Edit", "edit"],
      ["MultiEdit", "edit"],
      ["apply_patch", "edit"],
      ["Grep", "code-search"],
      ["Glob", "code-search"],
      ["LS", "list"],
      ["list_dir", "list"],
      ["WebSearch", "web-search"],
      ["WebFetch", "web-fetch"],
      ["TodoWrite", "todo"],
      ["update_plan", "todo"],
      ["Task", "subagent"],
      ["Agent", "subagent"],
      ["view_image", "view-image"],
      ["Skill", "skill"],
    ];
    for (const [name, key] of cases) expect(normalizeWorkLogToolKey(name)).toBe(key);
  });

  it("leaves integrations' tools to the generic entry", () => {
    expect(normalizeWorkLogToolKey("search")).toBeNull();
    expect(normalizeWorkLogToolKey("mcp__github__search")).toBeNull();
    expect(normalizeWorkLogToolKey("github.read_file")).toBeNull();
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

  it("derives a row for T3 tools without an entry and a generic one for unknown tools", () => {
    expect(
      resolveWorkLogTool({ toolName: "cogenly.delegate_task", status: "completed" }),
    ).toMatchObject({ label: "Delegated a child task", icon: "bot", source: "t3" });
    expect(
      resolveWorkLogTool({ toolName: "mcp__linear__create_issue", status: "completed" }),
    ).toMatchObject({ label: "Create issue", icon: "wrench", source: "generic" });
    expect(
      resolveWorkLogTool({ toolName: "cogenly.terminal_read", status: "completed" }),
    ).toMatchObject({ label: "Terminal read", icon: "wrench", source: "generic" });
    expect(resolveWorkLogTool({ toolName: undefined, status: "completed" })).toBeNull();
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
    expect(workLogToolGroupLabel([call, call, call])).toBe("Searched chats ×3");
    expect(workLogToolGroupLabel([call])).toBe("Searched chats and work for “AI funding”");
  });
});

const base = {
  id: "item-1",
  threadId: "thread-1",
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

function itemRow(item: Record<string, unknown>) {
  const call = workLogCallFromItem({ ...base, ...item } as unknown as OrchestrationV2TurnItem);
  return call ? resolveWorkLogTool(call) : null;
}

describe("native tools", () => {
  it("says what a command ran, for every provider's shell", () => {
    expect(itemRow({ type: "command_execution", input: "pnpm test" })).toMatchObject({
      key: "command",
      icon: "terminal",
      label: "Ran “pnpm test”",
    });
    // Codex wraps commands in a login shell; the label shows the command itself.
    expect(itemRow({ type: "command_execution", input: "/bin/zsh -lc 'pnpm test'" })?.label).toBe(
      "Ran “pnpm test”",
    );
    expect(
      resolveWorkLogTool({ toolName: "exec_command", input: { cmd: "ls" }, status: "inProgress" })
        ?.label,
    ).toBe("Running “ls”");
  });

  it("names the edited file and links it, and counts multi-file edits", () => {
    expect(
      itemRow({ type: "file_change", fileName: "src/Sidebar.tsx", additions: 3, deletions: 1 }),
    ).toMatchObject({
      label: "Edited Sidebar.tsx · +3 −1",
      icon: "square-pen",
      target: { kind: "file", id: "src/Sidebar.tsx", title: "Sidebar.tsx", quoted: false },
    });
    expect(
      itemRow({
        type: "file_change",
        fileName: "a.ts",
        changes: [
          { operation: "update", path: "a.ts" },
          { operation: "update", path: "b.ts" },
        ],
      })?.label,
    ).toBe("Edited 2 files");
    expect(
      itemRow({
        type: "file_change",
        fileName: "new.ts",
        changes: [{ operation: "add", path: "new.ts" }],
      })?.label,
    ).toBe("Wrote new.ts");
  });

  it("reads files by name across Claude and Muse inputs", () => {
    for (const [toolName, input] of [
      ["Read", { file_path: "/repo/src/env.ts" }],
      ["read_file", { path: "src/env.ts" }],
    ] as const) {
      expect(resolveWorkLogTool({ toolName, input, status: "completed" })).toMatchObject({
        label: "Read env.ts",
        icon: "eye",
        target: { kind: "file", title: "env.ts" },
      });
    }
  });

  it("describes code, web and page lookups from their input", () => {
    expect(
      resolveWorkLogTool({
        toolName: "Grep",
        input: { pattern: "useThreadShell", path: "apps/web" },
        status: "completed",
      })?.label,
    ).toBe("Searched code for “useThreadShell” in web");
    expect(
      resolveWorkLogTool({ toolName: "Glob", input: { pattern: "**/*.css" }, status: "completed" })
        ?.label,
    ).toBe("Searched code for “**/*.css”");
    expect(
      itemRow({ type: "web_search", patterns: ["effect schema"], results: [{}, {}] })?.label,
    ).toBe("Searched the web for “effect schema” · 2 results");
    expect(
      itemRow({ type: "web_search", patterns: ["https://www.example.com/docs"] }),
    ).toMatchObject({
      key: "web-fetch",
      label: "Fetched example.com/docs",
      target: { kind: "url", id: "https://www.example.com/docs" },
    });
  });

  it("summarizes plans, subagents and images", () => {
    expect(
      itemRow({
        type: "todo_list",
        planId: "plan-1",
        steps: [
          { id: "1", text: "a", status: "completed" },
          { id: "2", text: "b", status: "pending" },
        ],
      })?.label,
    ).toBe("Updated the plan · 1 of 2 done");
    expect(
      resolveWorkLogTool({
        toolName: "TodoWrite",
        input: { todos: [{ content: "a", status: "completed" }] },
        status: "completed",
      })?.label,
    ).toBe("Updated the plan · 1 of 1 done");
    expect(
      resolveWorkLogTool({
        toolName: "Task",
        input: { description: "Audit icons" },
        status: "inProgress",
      }),
    ).toMatchObject({ label: "Running a subagent: “Audit icons”", icon: "bot" });
    expect(
      itemRow({ type: "dynamic_tool", toolName: "Read", viewedImagePath: "shot.png", input: {} }),
    ).toMatchObject({ label: "Viewed shot.png", icon: "image" });
  });

  it("groups calls the way their rows read", () => {
    const read = (path: string) => ({
      toolName: "Read",
      input: { file_path: path },
      status: "completed" as const,
    });
    expect(workLogToolGroupLabel([read("a.ts"), read("b.ts"), read("a.ts")])).toBe("Read 2 files");
    const run = {
      key: "command",
      toolName: "command",
      input: { command: "ls" },
      status: "completed" as const,
    };
    expect(workLogToolGroupLabel([run, run, run])).toBe("Ran 3 commands");
    const web = { toolName: "WebSearch", input: { query: "x" }, status: "completed" as const };
    expect(workLogToolGroupLabel([web, web])).toBe("Searched the web ×2");
  });
});

describe("resolveWorkLogNotice", () => {
  it("gives system and lifecycle rows a meaningful icon", () => {
    const notice = (item: Record<string, unknown>) =>
      resolveWorkLogNotice({ ...base, ...item } as unknown as OrchestrationV2TurnItem);
    expect(
      notice({
        type: "notification",
        source: { kind: "system" },
        outcome: "updated",
        summary: "Cogenly restarted and resumed this turn",
      }),
    ).toEqual({
      icon: "rotate-ccw",
      label: "Cogenly restarted and resumed this turn",
      tone: "quiet",
    });
    expect(notice({ type: "run_interrupt_result", message: "x" })?.icon).toBe("square-stop");
    expect(notice({ type: "compaction" })).toMatchObject({
      icon: "shrink",
      label: "Context compacted",
    });
    expect(
      notice({ type: "error", failure: { class: "provider_error", message: "Boom" } }),
    ).toMatchObject({ icon: "circle-alert", tone: "danger" });
    expect(notice({ type: "command_execution", input: "ls" })).toBeNull();
  });
});

describe("project change receipts", () => {
  const receipt = (kind: string, label: string, action: string) => ({
    projectFolderId: "spawn",
    kind,
    label,
    action,
  });

  it("reads a completed change as its receipt", () => {
    expect(
      resolveWorkLogTool({
        toolName: "mcp__cogenly__project_repository_add",
        input: { repositoryId: "p1" },
        output: receipt("repository", "spawn-platform", "added"),
        status: "completed",
      })?.label,
    ).toBe("Added repository spawn-platform");
    expect(
      resolveWorkLogTool({
        toolName: "cogenly.project_source_link",
        input: { link: { kind: "github-owner", owner: "spawn-partners" } },
        output: {
          content: [
            {
              type: "text",
              text: JSON.stringify(receipt("source", "spawn-partners", "unchanged")),
            },
          ],
        },
        status: "completed",
      })?.label,
    ).toBe("Source spawn-partners was already linked");
  });

  it("names the attempt from the input before the receipt arrives", () => {
    const call = {
      toolName: "mcp__cogenly__project_source_link",
      input: { link: { kind: "github-repo", owner: "spawn-partners", repo: "mobile" } },
    };
    expect(resolveWorkLogTool({ ...call, status: "inProgress" })?.label).toBe(
      "Linking source spawn-partners/mobile",
    );
    expect(resolveWorkLogTool({ ...call, status: "failed" })?.label).toBe(
      "Failed: link source spawn-partners/mobile",
    );
  });

  it("groups a few changes as their receipts and more as a count", () => {
    const change = (label: string) => ({
      toolName: "mcp__cogenly__project_repository_add",
      output: receipt("repository", label, "added"),
      status: "completed" as const,
    });
    const instructions = {
      toolName: "mcp__cogenly__project_instructions_set",
      output: receipt("instructions", "Instructions", "updated"),
      status: "completed" as const,
    };
    expect(workLogToolGroupLabel([change("a"), instructions])).toBe(
      "Added repository a · Updated the project's instructions",
    );
    expect(workLogToolGroupLabel([change("a"), change("b"), change("c"), change("d")])).toBe(
      "4 project changes",
    );
  });
});

describe("thread lifecycle receipts", () => {
  const snoozedUntil = "2026-10-23T13:00:00.000Z";

  it("reads a snooze of this thread as its wake time", () => {
    const label = resolveWorkLogTool({
      toolName: "mcp__cogenly__t3_thread_snooze",
      input: { until: "tomorrow" },
      output: { snoozedUntil, timeZone: "UTC", receipt: "Snoozed until Fri 9:00 AM", sequence: 4 },
      status: "completed",
    })?.label;
    expect(label).toMatch(/^Snoozed until \w{3}[, ]/);
    expect(
      resolveWorkLogTool({
        toolName: "cogenly.t3_thread_snooze",
        input: { until: "tomorrow" },
        output: { snoozedUntil, timeZone: "UTC", receipt: "", snoozesWhenTurnEnds: true },
        status: "completed",
      })?.label,
    ).toMatch(/^Snoozes until .+ when this turn ends$/);
  });

  it("names another thread and keeps the wake time as the result", () => {
    const row = resolveWorkLogTool({
      toolName: "mcp__cogenly__t3_thread_snooze",
      input: { threadId: "thread-2", until: "friday" },
      output: { snoozedUntil, timeZone: "UTC", receipt: "", sequence: 4 },
      status: "completed",
      targetTitle: "Release notes",
    });
    expect(row?.label).toMatch(/^Snoozed “Release notes” · until /);
    expect(row?.target).toMatchObject({ kind: "thread", id: "thread-2" });
  });

  it("reads settle, wake and unsettle, and their attempts", () => {
    const own = (tool: string, output: Record<string, unknown>) =>
      resolveWorkLogTool({
        toolName: `mcp__cogenly__${tool}`,
        input: {},
        output,
        status: "completed",
      })?.label;
    expect(own("t3_thread_settle", { sequence: 1, receipt: "" })).toBe("Settled this thread");
    expect(own("t3_thread_settle", { settlesWhenTurnEnds: true, receipt: "" })).toBe(
      "Settles when this turn ends",
    );
    expect(own("t3_thread_unsnooze", { sequence: 1, receipt: "" })).toBe("Woke this thread");
    expect(own("t3_thread_unsettle", { sequence: 1, receipt: "" })).toBe(
      "Moved this thread back to active",
    );
    const call = { toolName: "mcp__cogenly__t3_thread_snooze", input: { until: "whenever" } };
    expect(resolveWorkLogTool({ ...call, status: "inProgress" })?.label).toBe(
      "Snoozing this thread",
    );
    expect(resolveWorkLogTool({ ...call, status: "failed" })?.label).toBe(
      "Failed: snooze this thread",
    );
  });

  it("groups a few changes as their rows", () => {
    const settle = {
      toolName: "mcp__cogenly__t3_thread_settle",
      input: {},
      output: { sequence: 1, receipt: "" },
      status: "completed" as const,
    };
    const wake = { ...settle, toolName: "mcp__cogenly__t3_thread_unsnooze" };
    expect(workLogToolGroupLabel([wake, settle])).toBe("Woke this thread · Settled this thread");
  });
});
