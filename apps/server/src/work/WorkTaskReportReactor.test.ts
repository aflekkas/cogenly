import { describe, expect, it } from "@effect/vitest";
import {
  type OrchestrationV2ServerCommand,
  ProjectId,
  RunId,
  ThreadId,
  WorkTaskId,
  type WorkTask,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  WorkTaskReportReactor,
  layer as reactorLayer,
  workTaskReportFor,
  workTaskSettleFor,
} from "./WorkTaskReportReactor.ts";

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

describe("workTaskSettleFor", () => {
  const settling = { ...task, settleWhenDone: true };

  it("settles the Work thread of a completed task that asked for it", () => {
    expect(
      workTaskSettleFor({ ...base, task: settling, run: { status: "completed" } }),
    ).toMatchObject({ type: "thread.settle", threadId: "work:one" });
  });

  it("leaves failed, cancelled and unasked tasks active", () => {
    for (const status of ["failed", "cancelled"] as const) {
      expect(workTaskSettleFor({ ...base, task: settling, run: { status } })).toBeNull();
    }
    expect(workTaskSettleFor({ ...base, run: { status: "completed" } })).toBeNull();
  });
});

describe("WorkTaskReportReactor", () => {
  const chatThreadId = ThreadId.make("chat:one");
  const workThreadId = ThreadId.make("work:one");
  const runId = RunId.make("run:1");

  /** Handles one completed run of `card`'s Work, returning what was dispatched. */
  const handleCompletedRun = (card: WorkTask, refuseSettle = false) =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationV2ServerCommand["type"]> = [];
      const reports: Array<string> = [];
      const engine = Layer.mock(Orchestrator.OrchestratorV2)({
        dispatch: (command) =>
          Effect.gen(function* () {
            dispatched.push(command.type);
            if (command.type === "work.task.report") reports.push(command.wake.text);
            if (refuseSettle && command.type === "thread.settle")
              return yield* Effect.die("a message is queued on the Work thread");
            return { sequence: dispatched.length, storedEvents: [] };
          }),
      });
      const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadShell: () =>
          Effect.succeed({ surface: "work", sourceThreadId: chatThreadId } as never),
        getThread: () => Effect.succeed({ workTasks: [card], deletedAt: null } as never),
        getThreadRecords: () =>
          Effect.succeed({
            runs: [{ id: runId, ordinal: 1, status: "completed", startedAt: "started" }],
            messages: [{ runId, streaming: false, text: "Cleared the cache." }],
          } as never),
      });
      const reactor = yield* WorkTaskReportReactor.pipe(
        Effect.provide(reactorLayer.pipe(Layer.provide(Layer.merge(engine, projections)))),
      );
      yield* reactor.handle({
        type: "run.updated",
        threadId: workThreadId,
        payload: { id: runId, status: "completed" },
      } as never);
      return { dispatched, reports };
    });

  it.effect("settles a finished task's Work before telling the chat", () =>
    Effect.gen(function* () {
      const { dispatched, reports } = yield* handleCompletedRun({ ...task, settleWhenDone: true });
      expect(dispatched).toEqual(["thread.settle", "work.task.report"]);
      expect(reports[0]).toContain("Its Work thread was settled");
    }),
  );

  it.effect("still reports a task whose Work refused to settle, without claiming it did", () =>
    Effect.gen(function* () {
      const { dispatched, reports } = yield* handleCompletedRun(
        { ...task, settleWhenDone: true },
        true,
      );
      expect(dispatched).toEqual(["thread.settle", "work.task.report"]);
      expect(reports[0]).not.toContain("Its Work thread was settled");
    }),
  );

  it.effect("leaves a task's Work active unless it asked to settle", () =>
    Effect.gen(function* () {
      const { dispatched } = yield* handleCompletedRun(task);
      expect(dispatched).toEqual(["work.task.report"]);
    }),
  );
});
