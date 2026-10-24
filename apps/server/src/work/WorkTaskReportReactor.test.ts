import { describe, expect, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId, WorkTaskId, type WorkTask } from "@cogenly/contracts";

import { workTaskReportFor } from "./WorkTaskReportReactor.ts";

const task: WorkTask = {
  id: WorkTaskId.make("task:one"),
  status: "started",
  requestedMode: "start",
  title: "Uninstall Nook and Ora",
  brief: "Uninstall both browsers.",
  targetProjectId: ProjectId.make("scratch"),
  threadId: ThreadId.make("work:one"),
  createdAt: "2026-10-22T00:00:00.000Z",
  updatedAt: "2026-10-22T00:00:00.000Z",
};
const base = {
  chatThreadId: ThreadId.make("chat:one"),
  task,
  workThreadId: ThreadId.make("work:one"),
  reportedAt: "2026-10-22T01:00:00.000Z",
};

describe("workTaskReportFor", () => {
  it("reports a completed task with its reply, keyed so it is sent once", () => {
    const report = workTaskReportFor({
      ...base,
      run: { id: RunId.make("run:1"), status: "completed" },
      finalReply: "Removed  both\n\napps.",
    })!;
    expect(report.outcome).toMatchObject({ status: "completed", summary: "Removed both apps." });
    expect(report.wake.text).toContain("finished");
    expect(report.wake.text).toContain("cogenly-thread://v1/work:one");
    expect(report.wake.notification.outcome).toBe("completed");
    const again = workTaskReportFor({
      ...base,
      run: { id: RunId.make("run:2"), status: "failed" },
      finalReply: null,
    })!;
    expect(again.commandId).toBe(report.commandId);
    expect(again.wake.messageId).toBe(report.wake.messageId);
  });

  it("asks for a next step when the task failed, and clips the card summary", () => {
    const report = workTaskReportFor({
      ...base,
      run: { id: RunId.make("run:1"), status: "failed" },
      finalReply: "x".repeat(1000),
    })!;
    expect(report.outcome.summary.length).toBeLessThanOrEqual(280);
    expect(report.wake.text).toContain("Do not retry on your own");
  });

  it("does not report a run that is still going or was stopped by the user", () => {
    for (const status of ["running", "interrupted"] as const) {
      expect(
        workTaskReportFor({ ...base, run: { id: RunId.make("run:1"), status }, finalReply: "" }),
      ).toBeNull();
    }
  });
});
