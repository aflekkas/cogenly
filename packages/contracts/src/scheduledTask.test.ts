import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ScheduledTask } from "./scheduledTask.ts";
import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTaskSchedule.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });

  it("still rejects corrupt non-positive persisted intervals", () => {
    expect(() => decodeSchedule({ type: "interval", everyMs: 0 })).toThrow();
  });
});

describe("ScheduledTaskUpsertSchedule", () => {
  it("accepts interval schedules at the one-minute minimum", () => {
    expect(
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
    });
  });

  it("rejects interval schedules more frequent than once per minute", () => {
    expect(() =>
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toThrow();
  });
});

describe("ScheduledTask across versions", () => {
  const wireTask = {
    id: "task-1",
    agentId: "agent-1",
    title: "Watch CI",
    prompt: "Check CI",
    enabled: true,
    schedule: { type: "interval", everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS },
    projectId: "project-1",
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: "2026-10-01T00:00:00.000Z",
    lastRunStatus: "succeeded",
    lastRunError: null,
    runCount: 1,
  };
  const encode = Schema.encodeSync(ScheduledTask);
  const decode = Schema.decodeUnknownSync(ScheduledTask);
  // The run statuses a 0.3.2 client or peer decodes.
  const decodeLegacyStatus = Schema.decodeUnknownSync(
    Schema.Struct({
      lastRunStatus: Schema.Literals([
        "never",
        "running",
        "succeeded",
        "failed",
        "skipped_already_queued",
      ]),
    }),
  );

  it("sends an agent skip that 0.3.2 reads as skipped and this build reads exactly", () => {
    const task = decode({ ...wireTask, lastRunStatus: "skipped_busy" });
    expect(task.lastRunStatus).toBe("skipped_busy");
    const wire = encode(task);
    expect(decodeLegacyStatus(wire).lastRunStatus).toBe("skipped_already_queued");
    expect(decode(wire).lastRunStatus).toBe("skipped_busy");
  });

  it("reads a task from a 0.3.2 server unchanged and sends ordinary statuses as before", () => {
    const task = decode(wireTask);
    expect(task.lastRunStatus).toBe("succeeded");
    expect(encode(task)).not.toHaveProperty("lastRunSkip");
    expect(decode({ ...wireTask, lastRunStatus: "skipped_already_queued" }).lastRunStatus).toBe(
      "skipped_already_queued",
    );
  });
});
