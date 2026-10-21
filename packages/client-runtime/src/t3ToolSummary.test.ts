import { describe, expect, it } from "vite-plus/test";

import { summarizeT3ToolCalls } from "./t3ToolSummary.ts";

describe("summarizeT3ToolCalls for project folders and agents", () => {
  it("counts created, updated, and deleted project folders", () => {
    const label = { id: "label:one", name: "Spawn Partners" };
    expect(
      summarizeT3ToolCalls("project-label-create", [
        { input: { name: "Spawn Partners" }, output: { label }, outcome: "completed" },
      ]).label,
    ).toBe("Created 1 project folder");
    expect(
      summarizeT3ToolCalls("project-label-update", [
        { input: { id: "label:one" }, output: { label }, outcome: "completed" },
        {
          input: { id: "label:two" },
          output: { label: { ...label, id: "label:two" } },
          outcome: "completed",
        },
      ]).label,
    ).toBe("Updated 2 project folders");
    expect(
      summarizeT3ToolCalls("project-label-delete", [
        { input: { id: "label:one" }, output: { deleted: true }, outcome: "completed" },
      ]).label,
    ).toBe("Deleted 1 project folder");
  });

  it("summarizes link updates, clone starts, and agent calls", () => {
    expect(
      summarizeT3ToolCalls("project-label-link", [
        {
          input: { id: "label:one", link: { kind: "github-owner", owner: "acme" } },
          output: { label: { id: "label:one" } },
          outcome: "completed",
        },
      ]).label,
    ).toBe("Updated project links 1 time");
    expect(
      summarizeT3ToolCalls("project-label-clone", [
        {
          input: { id: "label:one", repository: "acme/server" },
          output: { projectId: "project:clone", cwd: "/projects/Spawn Partners/server" },
          outcome: "completed",
        },
      ]).label,
    ).toBe("Started 1 project clone");
    expect(
      summarizeT3ToolCalls("agent-list", [
        { input: {}, output: { agents: [] }, outcome: "completed" },
      ]).label,
    ).toBe("Listed agents 1 time");
    expect(
      summarizeT3ToolCalls("agent-builder-start", [
        {
          input: { text: "Watch my pull requests" },
          output: { threadId: "agent-builder:one", projectId: "project:mcp-test" },
          outcome: "completed",
        },
      ]).label,
    ).toBe("Started 1 agent builder");
  });
});
