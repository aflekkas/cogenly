import {
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  WorkTaskId,
  type WorkTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  anchorWorkTasks,
  deriveWorkTaskCardState,
  handoffsWithoutTasks,
  workTaskCanStop,
} from "./workTask.logic";

const task = (overrides: Partial<WorkTask> = {}): WorkTask => ({
  id: WorkTaskId.make("task:1"),
  status: "started",
  requestedMode: "start",
  title: "Uninstall browsers",
  brief: "Uninstall Nook and Ora.",
  targetProjectId: ProjectId.make("scratch"),
  threadId: ThreadId.make("work:1"),
  createdAt: "2026-10-22T10:00:00.000Z",
  updatedAt: "2026-10-22T10:00:00.000Z",
  ...overrides,
});

const idle = {
  latestRun: null,
  runtime: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
};

describe("deriveWorkTaskCardState", () => {
  it("keeps proposed and dismissed cards as they are", () => {
    expect(deriveWorkTaskCardState(task({ status: "proposed" }), null)).toBe("proposed");
    expect(deriveWorkTaskCardState(task({ status: "dismissed" }), idle)).toBe("dismissed");
  });

  it("follows the Work thread live once started", () => {
    expect(deriveWorkTaskCardState(task(), null)).toBe("starting");
    expect(deriveWorkTaskCardState(task(), idle)).toBe("starting");
    expect(deriveWorkTaskCardState(task(), { ...idle, runtime: { status: "running" } })).toBe(
      "running",
    );
    expect(deriveWorkTaskCardState(task(), { ...idle, hasPendingUserInput: true })).toBe(
      "attention",
    );
    expect(deriveWorkTaskCardState(task(), { ...idle, latestRun: { status: "completed" } })).toBe(
      "done",
    );
    expect(deriveWorkTaskCardState(task(), { ...idle, latestRun: { status: "failed" } })).toBe(
      "failed",
    );
    expect(deriveWorkTaskCardState(task(), { ...idle, latestRun: { status: "interrupted" } })).toBe(
      "stopped",
    );
  });

  it("falls back to the reported outcome without the thread", () => {
    const outcome = {
      summary: "",
      runId: RunId.make("run:w"),
      reportedAt: "2026-10-22T11:00:00.000Z",
    };
    expect(deriveWorkTaskCardState(task({ outcome: { ...outcome, status: "failed" } }), null)).toBe(
      "failed",
    );
    expect(
      deriveWorkTaskCardState(task({ outcome: { ...outcome, status: "completed" } }), null),
    ).toBe("done");
  });

  it("offers Stop only while the task is working", () => {
    expect(workTaskCanStop("running")).toBe(true);
    expect(workTaskCanStop("done")).toBe(false);
    expect(workTaskCanStop("proposed")).toBe(false);
  });
});

describe("anchorWorkTasks", () => {
  const messages = [
    {
      id: MessageId.make("u1"),
      role: "user" as const,
      runId: RunId.make("run:1"),
      createdAt: "2026-10-22T09:59:00.000Z",
    },
    {
      id: MessageId.make("a1"),
      role: "assistant" as const,
      runId: RunId.make("run:1"),
      createdAt: "2026-10-22T09:59:30.000Z",
    },
    {
      id: MessageId.make("a2"),
      role: "assistant" as const,
      runId: RunId.make("run:1"),
      createdAt: "2026-10-22T10:00:30.000Z",
    },
  ];

  it("sits after the last reply of the turn that created the card", () => {
    const anchors = anchorWorkTasks([task({ runId: RunId.make("run:1") })], messages);
    expect(anchors.byMessageId.get(MessageId.make("a2"))?.map((t) => t.id)).toEqual(["task:1"]);
  });

  it("falls back to the turn that had ended, and to the footer before any message", () => {
    const anchors = anchorWorkTasks(
      [task({ runId: RunId.make("run:gone"), createdAt: "2026-10-22T09:59:40.000Z" })],
      messages,
    );
    expect(anchors.byMessageId.get(MessageId.make("a2"))).toHaveLength(1);
    expect(anchorWorkTasks([task()], []).unanchored).toHaveLength(1);
  });
});

describe("handoffsWithoutTasks", () => {
  it("drops the handoff marker a task card already shows", () => {
    const links = [
      { threadId: ThreadId.make("work:1"), title: "A", createdAt: "2026-10-22T10:00:00.000Z" },
      { threadId: ThreadId.make("work:2"), title: "B", createdAt: "2026-10-22T10:00:00.000Z" },
    ];
    expect(handoffsWithoutTasks(links, [task()]).map((link) => link.threadId)).toEqual(["work:2"]);
  });
});
