import { describe, expect, it } from "vite-plus/test";

import { scheduledTaskLastRun } from "./scheduledTasksSettings.logic";

describe("scheduledTaskLastRun", () => {
  it("says nothing for a task that never ran", () => {
    expect(scheduledTaskLastRun("never", null)).toBeNull();
  });

  it("reads a success as plain text and problems as toned badges", () => {
    expect(scheduledTaskLastRun("succeeded", "2h ago")).toEqual({ text: "Ran 2h ago", tone: null });
    expect(scheduledTaskLastRun("failed", "5m ago")).toEqual({
      text: "Failed 5m ago",
      tone: "error",
    });
    expect(scheduledTaskLastRun("running", "just now")).toEqual({ text: "Running", tone: "info" });
  });

  it("explains a skipped run instead of showing the raw status", () => {
    expect(scheduledTaskLastRun("skipped_already_queued", null)).toEqual({
      text: "Skipped, the last run was still queued",
      tone: "warning",
    });
  });
});

it.each([
  "skipped_busy",
  "skipped_backoff",
  "skipped_daily_cap",
  "skipped_not_owner",
  "skipped_disabled",
  "skipped_ineligible",
] as const)("explains %s", (status) => {
  expect(scheduledTaskLastRun(status, null)).toMatchObject({ tone: "warning" });
});
