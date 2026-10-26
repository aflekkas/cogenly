import { describe, expect, it } from "vite-plus/test";

import {
  cogenlyToolName,
  deriveThreadSources,
  pageOf,
  THREAD_SOURCES_LIMIT,
  type ThreadSourceRecords,
  type ThreadSourceToolRow,
} from "./ThreadSources.ts";

const THREAD = "thread:self";

function tool(
  at: string,
  toolName: string,
  input: unknown,
  extra: Partial<ThreadSourceToolRow> = {},
): ThreadSourceToolRow {
  return {
    type: "dynamic_tool",
    status: "completed",
    at,
    toolName,
    input,
    output: null,
    toolSource: null,
    fileName: null,
    additions: null,
    deletions: null,
    changes: null,
    patterns: null,
    results: null,
    ...extra,
  };
}

function records(partial: Partial<ThreadSourceRecords>): ThreadSourceRecords {
  return {
    threadId: THREAD,
    tools: [],
    messages: [],
    checkpoints: [],
    pullRequests: [],
    ...partial,
  };
}

const mcpResult = (data: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});

describe("deriveThreadSources", () => {
  it("dedupes repeat uses into one row with the latest time and a use count", () => {
    const result = deriveThreadSources(
      records({
        tools: [
          tool("2026-10-26T10:00:00.000Z", "mcp__cogenly__integration_call", {
            name: "gmail",
            tool: "search",
          }),
          tool("2026-10-26T11:00:00.000Z", "cogenly.integration_call", {
            name: "gmail",
            tool: "read",
          }),
          tool("2026-10-26T10:30:00.000Z", "mcp__cogenly__integration_tools", { name: "linear" }),
        ],
      }),
    );
    expect(result.sources.map((source) => [source.key, source.usedAt, source.uses])).toEqual([
      ["integration:gmail", "2026-10-26T11:00:00.000Z", 2],
      ["integration:linear", "2026-10-26T10:30:00.000Z", 1],
    ]);
  });

  it("lists every kind of source, most recent first", () => {
    const result = deriveThreadSources(
      records({
        tools: [
          tool("2026-10-26T10:01:00.000Z", "mcp__cogenly__project_file_read", {
            path: "Resources/brief.md",
          }),
          tool("2026-10-26T10:02:00.000Z", "mcp__cogenly__memory_read", {}),
          tool("2026-10-26T10:03:00.000Z", "mcp__cogenly__fact_search", { query: "x" }),
          tool("2026-10-26T10:04:00.000Z", "mcp__cogenly__preview_navigate", {
            url: "https://www.example.com/a?b=1",
          }),
          tool("2026-10-26T10:05:00.000Z", "mcp__cogenly__preview_navigate", {
            url: "example.com/later",
          }),
          tool("2026-10-26T10:06:00.000Z", "mcp__cogenly__thread_read", {
            threadId: "thread:other",
          }),
          tool("2026-10-26T10:07:00.000Z", "Read", { file_path: "/repo/src/index.ts" }),
          tool(
            "2026-10-26T10:08:00.000Z",
            "mcp__linear__search",
            {},
            { toolSource: { key: "mcp:linear", name: "Linear", kind: "integration" } },
          ),
        ],
        messages: [
          {
            role: "user",
            at: "2026-10-26T09:00:00.000Z",
            attachments: [
              {
                type: "image",
                id: "att-1",
                name: "IMG_2495.jpeg",
                mimeType: "image/jpeg",
                sizeBytes: 9,
              },
              {
                type: "file",
                id: "att-2",
                name: "pasted.txt",
                mimeType: "text/plain",
                sizeBytes: 9,
                source: { type: "pasted-text" },
              },
            ],
            contextRecords: [
              { kind: "thread", threadId: "thread:mentioned", title: "Plan" },
              { kind: "integration", name: "gmail", displayName: "Gmail", serviceName: "Google" },
              { kind: "project-folder", projectFolderId: "label:finances", name: "Finances" },
            ],
          },
        ],
      }),
    );
    expect(result.sources.map((source) => source.key)).toEqual([
      "integration:mcp:linear",
      "workspace:/repo/src/index.ts",
      "thread:thread:other",
      "page:example.com",
      "memory",
      "project:self:Resources/brief.md",
      "project:self",
      "attachment:att-1",
      "thread:thread:mentioned",
      "integration:gmail",
      "project:label:finances",
    ]);
    const page = result.sources.find((source) => source.kind === "page");
    expect(page).toMatchObject({ host: "example.com", url: "https://example.com/later", uses: 2 });
    expect(result.sources.find((source) => source.key === "integration:gmail")).toMatchObject({
      label: "Gmail",
    });
    expect(result.sources.find((source) => source.kind === "memory")?.uses).toBe(2);
  });

  it("names a vault login by its item name only, never its username", () => {
    const filled = tool(
      "2026-10-26T10:00:00.000Z",
      "mcp__cogenly__vault_fill",
      { username: "me@example.com", field: "password" },
      {
        output: mcpResult({
          status: "filled",
          item: { id: "vault:1", name: "GitHub", username: "me@example.com" },
          domain: "github.com",
        }),
      },
    );
    const pending = tool(
      "2026-10-26T10:01:00.000Z",
      "mcp__cogenly__vault_fill",
      { name: "Bank", field: "password" },
      { output: mcpResult({ status: "approval_required", field: "password", domain: null }) },
    );
    const result = deriveThreadSources(records({ tools: [filled, pending] }));
    expect(result.sources).toEqual([
      {
        kind: "vault",
        key: "vault:vault:1",
        name: "GitHub",
        itemId: "vault:1",
        host: "github.com",
        usedAt: "2026-10-26T10:00:00.000Z",
        uses: 1,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("me@example.com");
  });

  it("skips failed calls, searches it did not open, and reads of this thread", () => {
    const result = deriveThreadSources(
      records({
        tools: [
          tool(
            "2026-10-26T10:00:00.000Z",
            "mcp__cogenly__integration_call",
            { name: "gmail" },
            {
              status: "failed",
            },
          ),
          tool("2026-10-26T10:00:00.000Z", "mcp__cogenly__thread_read", { threadId: THREAD }),
          tool("2026-10-26T10:00:00.000Z", "WebSearch", null, {
            type: "web_search",
            patterns: ["cogenly"],
            results: [{ url: "https://search-hit.example" }],
          }),
          tool("2026-10-26T10:01:00.000Z", "WebFetch", null, {
            type: "web_search",
            results: [{ url: "https://docs.example.org/page" }],
          }),
        ],
      }),
    );
    expect(result.sources.map((source) => source.key)).toEqual(["page:docs.example.org"]);
  });

  it("collects outputs and folds edited files into the checkpoint diff", () => {
    const result = deriveThreadSources(
      records({
        tools: [
          tool("2026-10-26T10:00:00.000Z", "Edit", null, {
            type: "file_change",
            fileName: "/repo/a.ts",
            additions: 3,
            deletions: 1,
          }),
          tool(
            "2026-10-26T10:01:00.000Z",
            "mcp__cogenly__html_render",
            { title: "Report" },
            {
              output: mcpResult({
                htmlRender: { attachmentId: "render-1", title: "Report", height: 400 },
              }),
            },
          ),
          tool("2026-10-26T10:02:00.000Z", "mcp__cogenly__project_file_write", { title: "Notes" }),
        ],
        messages: [
          {
            role: "assistant",
            at: "2026-10-26T10:03:00.000Z",
            attachments: [
              { type: "file", id: "att-out", name: "data.csv", mimeType: "text/csv", sizeBytes: 3 },
            ],
            contextRecords: null,
          },
        ],
        checkpoints: [
          {
            at: "2026-10-26T10:04:00.000Z",
            status: "ready",
            files: [
              { path: "a.ts", kind: "modified", additions: 3, deletions: 1 },
              { path: "b.ts", kind: "added", additions: 10, deletions: 0 },
            ],
          },
          {
            at: "2026-10-26T10:05:00.000Z",
            status: "error",
            files: [{ path: "c.ts", additions: 1, deletions: 0 }],
          },
        ],
        pullRequests: [
          {
            url: "https://github.com/o/r/pull/7",
            repository: "o/r",
            number: 7,
            linkedAt: "2026-10-26T10:06:00.000Z",
            source: "created",
            snapshot: { title: "feat: sources" },
          },
          {
            url: "https://github.com/o/r/pull/8",
            repository: "o/r",
            number: 8,
            linkedAt: "2026-10-26T10:07:00.000Z",
            source: "stack-dismissed",
            snapshot: null,
          },
        ],
      }),
    );
    expect(result.outputs).toEqual([
      {
        kind: "pull_request",
        key: "pr:https://github.com/o/r/pull/7",
        at: "2026-10-26T10:06:00.000Z",
        url: "https://github.com/o/r/pull/7",
        repository: "o/r",
        number: 7,
        title: "feat: sources",
      },
      {
        kind: "changes",
        key: "changes",
        at: "2026-10-26T10:04:00.000Z",
        fileCount: 2,
        additions: 13,
        deletions: 1,
      },
      {
        kind: "attachment",
        key: "attachment:att-out",
        at: "2026-10-26T10:03:00.000Z",
        attachmentId: "att-out",
        name: "data.csv",
        mimeType: "text/csv",
      },
      {
        kind: "file",
        key: "project:self:Notes",
        at: "2026-10-26T10:02:00.000Z",
        location: "project",
        name: "Notes",
      },
      {
        kind: "page",
        key: "page:render-1",
        at: "2026-10-26T10:01:00.000Z",
        attachmentId: "render-1",
        title: "Report",
      },
    ]);
  });

  it("lists edited files when the thread has no checkpoints", () => {
    const result = deriveThreadSources(
      records({
        tools: [
          tool("2026-10-26T10:00:00.000Z", "apply_patch", null, {
            type: "file_change",
            fileName: "src/a.ts",
            changes: [
              { operation: "update", path: "src/a.ts" },
              { operation: "add", path: "src/b.ts" },
            ],
          }),
        ],
      }),
    );
    expect(result.outputs.map((output) => output.key)).toEqual([
      "workspace:src/a.ts",
      "workspace:src/b.ts",
    ]);
  });

  it("caps each list and reports the full totals", () => {
    const tools = Array.from({ length: THREAD_SOURCES_LIMIT + 5 }, (_, index) =>
      tool(
        `2026-10-26T10:${String(index % 60).padStart(2, "0")}:00.000Z`,
        "mcp__cogenly__integration_call",
        { name: `service-${index}` },
      ),
    );
    const result = deriveThreadSources(records({ tools }));
    expect(result.sources).toHaveLength(THREAD_SOURCES_LIMIT);
    expect(result.sourceTotal).toBe(THREAD_SOURCES_LIMIT + 5);
  });
});

describe("tool and page names", () => {
  it("reads the bare Cogenly tool from each provider's spelling", () => {
    expect(cogenlyToolName("mcp__cogenly__vault_fill")).toBe("vault_fill");
    expect(cogenlyToolName("cogenly.vault_fill")).toBe("vault_fill");
    expect(cogenlyToolName("mcp__linear__search")).toBeNull();
    expect(cogenlyToolName("Read")).toBeNull();
  });

  it("keeps http pages at host level and drops credentials", () => {
    expect(pageOf("https://user:pw@www.example.com/x")).toEqual({
      host: "example.com",
      url: "https://www.example.com/x",
    });
    expect(pageOf("localhost:5173")).toEqual({
      host: "localhost",
      url: "http://localhost:5173/",
    });
    expect(pageOf("file:///etc/passwd")).toBeNull();
    expect(pageOf(42)).toBeNull();
  });
});
