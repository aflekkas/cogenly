import { describe, expect, it } from "vite-plus/test";

import {
  latestSubagentForChild,
  subagentResumedSince,
  subagentRowLines,
  subagentStatusVisual,
} from "./subagentRow.logic";

describe("subagentStatusVisual", () => {
  it("colours in-flight states blue and settled ones by outcome", () => {
    expect(subagentStatusVisual("pending")).toEqual({ tone: "info", label: "Queued" });
    expect(subagentStatusVisual("running").tone).toBe("info");
    expect(subagentStatusVisual("waiting").tone).toBe("info");
    expect(subagentStatusVisual("completed").tone).toBe("success");
    expect(subagentStatusVisual("failed").tone).toBe("destructive");
    expect(subagentStatusVisual("interrupted")).toEqual({ tone: "muted", label: "Stopped" });
    expect(subagentStatusVisual("idle").label).toBe("Idle · resumable");
  });
});

describe("subagentRowLines", () => {
  const base = { statusLabel: "Running", event: false } as const;

  it("shows progress while working and the result once settled", () => {
    expect(
      subagentRowLines({
        ...base,
        status: "running",
        liveStatus: "running",
        result: "final",
        progress: "reading files",
      }),
    ).toEqual({ detail: "reading files", titleStatus: "Running" });
    expect(
      subagentRowLines({
        ...base,
        statusLabel: "Completed",
        status: "completed",
        liveStatus: "completed",
        result: "**Done**: shipped",
        progress: "reading files",
      }),
    ).toEqual({ detail: "Done: shipped", titleStatus: null });
  });

  it("falls back to the status when there is nothing to say", () => {
    expect(
      subagentRowLines({
        ...base,
        statusLabel: "Failed",
        status: "failed",
        liveStatus: "failed",
        result: "Child task ended with status failed",
        progress: undefined,
      }),
    ).toEqual({ detail: null, titleStatus: null });
  });

  it("keeps a notification's status beside the title even when completed", () => {
    expect(
      subagentRowLines({
        statusLabel: "Finished",
        event: true,
        status: "completed",
        liveStatus: "completed",
        result: "ok",
        progress: undefined,
      }).titleStatus,
    ).toBe("Finished");
  });
});

describe("subagentResumedSince", () => {
  it("treats an active subagent or a later start as resumed", () => {
    const at = "2026-10-20T10:00:00.000Z";
    expect(subagentResumedSince({ status: "running", startedAt: null }, at)).toBe(true);
    expect(
      subagentResumedSince({ status: "completed", startedAt: "2026-10-20T11:00:00.000Z" }, at),
    ).toBe(true);
    expect(
      subagentResumedSince({ status: "completed", startedAt: "2026-10-20T09:00:00.000Z" }, at),
    ).toBe(false);
    expect(subagentResumedSince({ status: "completed", startedAt: null }, at)).toBe(false);
  });
});

describe("latestSubagentForChild", () => {
  it("picks the latest of several records for one child, not the first", () => {
    const agents = [
      { id: "a", childThreadId: "pane", at: 1 },
      { id: "b", childThreadId: "pane", at: 3 },
      { id: "c", childThreadId: "other", at: 9 },
      { id: "d", childThreadId: "pane", at: 2 },
    ];
    expect(latestSubagentForChild(agents, "pane", (agent) => agent.at)?.id).toBe("b");
    expect(latestSubagentForChild(agents, "missing", (agent) => agent.at)).toBeNull();
  });
});
