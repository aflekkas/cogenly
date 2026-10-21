import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Receipts from "./CommandReceiptStore.ts";
import {
  classifyDelegatedTaskFailure,
  deliverDelegatedTaskFailureNotice,
} from "./DelegatedTaskFailureNotice.ts";
import * as Events from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as Registry from "./ProviderAdapterRegistry.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const at = DateTime.makeUnsafe("2026-10-21T19:00:00.000Z");
const resetAt = "2026-10-21T20:20:00.000Z";

const childRun = (overrides: Partial<OrchestrationV2Run> = {}) =>
  ({
    id: RunId.make("run:child"),
    status: "failed",
    rootNodeId: NodeId.make("node:child-root"),
    startedAt: at,
    completedAt: at,
    ...overrides,
  }) as OrchestrationV2Run;

const usageLimitError = {
  id: "item:limit",
  type: "error",
  status: "failed",
  runId: RunId.make("run:child"),
  nodeId: NodeId.make("node:child-root"),
  ordinal: 1,
  updatedAt: at,
  failure: {
    class: "usage_limit",
    message: "You've hit your session limit · resets 3:20pm",
    code: null,
    retryable: true,
    resetAt,
  },
} as unknown as OrchestrationV2TurnItem;

const interruptRequest = {
  id: "item:stop",
  type: "run_interrupt_request",
  runId: RunId.make("run:child"),
  message: "Interrupt requested",
} as unknown as OrchestrationV2TurnItem;

describe("classifyDelegatedTaskFailure", () => {
  it("reads a usage limit as a rate limit with its reset", () => {
    expect(
      classifyDelegatedTaskFailure({
        run: childRun(),
        turnItems: [usageLimitError],
        afterRestart: false,
      }),
    ).toEqual({
      kind: "rate_limit",
      message: "You've hit your session limit · resets 3:20pm",
      resetAt,
    });
  });

  it("ignores a deliberate Stop or task_cancel", () => {
    for (const status of ["cancelled", "interrupted", "failed"] as const) {
      expect(
        classifyDelegatedTaskFailure({
          run: childRun({ status }),
          turnItems: [interruptRequest],
          afterRestart: true,
        }),
      ).toBeNull();
    }
  });

  it("separates restart cuts, crashes and runs cancelled before they started", () => {
    expect(
      classifyDelegatedTaskFailure({
        run: childRun({ status: "cancelled" }),
        turnItems: [],
        afterRestart: true,
      })?.kind,
    ).toBe("interrupted_by_restart");
    expect(
      classifyDelegatedTaskFailure({
        run: childRun({ status: "interrupted" }),
        turnItems: [],
        afterRestart: false,
      })?.kind,
    ).toBe("crashed");
    expect(
      classifyDelegatedTaskFailure({
        run: childRun({ status: "cancelled", startedAt: null }),
        turnItems: [],
        afterRestart: false,
      }),
    ).toBeNull();
    expect(
      classifyDelegatedTaskFailure({
        run: childRun({ status: "completed" }),
        turnItems: [],
        afterRestart: false,
      }),
    ).toBeNull();
  });
});

const parentId = ThreadId.make("thread:parent");
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const database = Sqlite.layerMemory;
const layerRegistry = Layer.mock(Registry.ProviderAdapterRegistryV2)({
  list: () => Effect.succeed([selection.instanceId]),
  getMetadata: () =>
    Effect.succeed({
      driver: ProviderDriverKind.make("codex"),
      continuationKey: "codex",
      enabled: true,
      capabilities: CodexProviderCapabilitiesV2,
    }),
  get: (instanceId) =>
    Effect.succeed(
      ProviderAdapter.ProviderAdapterV2.of({
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.die("No selection transition in this test"),
        openSession: (request) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: ProviderDriverKind.make("codex"),
              providerSessionId: request.providerSessionId,
              cause: "Provider unavailable in test",
            }),
          ),
      }),
    ),
});
const runtime = Layer.mergeAll(
  database,
  // The effect worker stays off, so the parent's first turn stays live.
  layerWithRegistry({ name: "delegated-task-failure" }, layerRegistry, {
    databaseLayer: database,
    runEffectWorker: false,
  }),
  Events.layer.pipe(Layer.provide(database)),
  Receipts.layer.pipe(Layer.provide(database)),
);

const createParent: OrchestrationV2Command = {
  type: "thread.create",
  commandId: CommandId.make("create:parent"),
  threadId: parentId,
  projectId: ProjectId.make("project:failure"),
  title: "Parent",
  modelSelection: selection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdBy: "user",
  creationSource: "web",
};

const startParentTurn: OrchestrationV2Command = {
  type: "message.dispatch",
  commandId: CommandId.make("send:parent"),
  threadId: parentId,
  messageId: MessageId.make("message:parent-user"),
  text: "Split this into tasks.",
  attachments: [],
  dispatchMode: { type: "start_immediately" },
  createdBy: "user",
  creationSource: "web",
};

interface Child {
  readonly taskId: NodeId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly run: OrchestrationV2Run;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}

const child = (name: string, overrides: Partial<Child> = {}): Child => ({
  taskId: NodeId.make(`task:${name}`),
  threadId: ThreadId.make(`thread:${name}`),
  title: `Task ${name}`,
  run: childRun({ id: RunId.make(`run:${name}`) }),
  turnItems: [{ ...usageLimitError, runId: RunId.make(`run:${name}`) } as OrchestrationV2TurnItem],
  ...overrides,
});

/** Real orchestrator for the parent; the children exist only as the records a failure reads. */
const withThreads = (children: ReadonlyArray<Child>) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const tasks = children.map(
      (entry) =>
        ({
          id: entry.taskId,
          threadId: parentId,
          origin: "app_owned",
          childThreadId: entry.threadId,
          title: entry.title,
          prompt: entry.title,
        }) as unknown as OrchestrationV2Subagent,
    );
    const getThreadRecords = ((threadId, fields, filter) => {
      const entry = children.find((candidate) => candidate.threadId === threadId);
      if (entry !== undefined) {
        return Effect.succeed({
          thread: { id: threadId, archivedAt: null, deletedAt: null },
          runs: [entry.run],
          turnItems: entry.turnItems,
        });
      }
      return orchestrator
        .getThreadRecords(threadId, fields, filter)
        .pipe(Effect.map((records) => ({ ...records, subagents: tasks })));
    }) as typeof orchestrator.getThreadRecords;
    const threads = {
      dispatch: (command: OrchestrationV2Command) => orchestrator.dispatch(command),
      getThreadRecords,
    } as unknown as ThreadManagementService.ThreadManagementService["Service"];
    const deliver = (entry: Child, afterRestart = false) =>
      deliverDelegatedTaskFailureNotice({
        parentThreadId: parentId,
        taskId: entry.taskId,
        childThreadId: entry.threadId,
        childRunId: entry.run.id,
        afterRestart,
      }).pipe(Effect.provideService(ThreadManagementService.ThreadManagementService, threads));
    const parent = () =>
      orchestrator.getThreadRecords(parentId, ["runs", "messages"], { messageRoles: ["user"] });
    return { orchestrator, deliver, parent };
  });

describe("deliverDelegatedTaskFailureNotice", () => {
  it.effect("queues one notice behind the parent's live turn, even when replayed", () =>
    Effect.gen(function* () {
      const limited = child("browser");
      const h = yield* withThreads([limited]);
      yield* h.orchestrator.dispatch(createParent);
      yield* h.orchestrator.dispatch(startParentTurn);
      const before = yield* h.parent();
      const active = before.runs.find((run) => run.status !== "queued")!;

      yield* h.deliver(limited);
      // The effect replays after a restart: the deterministic notice already exists.
      yield* h.deliver(limited, true);

      const after = yield* h.parent();
      const notices = after.messages.filter((message) =>
        message.id.startsWith("message:delegated-task-failure:"),
      );
      expect(notices).toHaveLength(1);
      const notice = notices[0]!;
      expect(notice.id).toBe("message:delegated-task-failure:task:browser:run:browser");
      expect(notice.createdBy).toBe("agent");
      expect(notice.text).toContain("rate limit");
      expect(notice.text).toContain(`Resume it after ${resetAt}`);
      expect(notice.notification).toMatchObject({
        source: {
          kind: "delegated_task",
          taskIds: ["task:browser"],
          childThreadId: "thread:browser",
        },
        outcome: "failed",
        summary: 'Agent "Task browser" stopped: rate limit',
        delegatedFailures: [
          {
            taskId: "task:browser",
            childRunId: "run:browser",
            kind: "rate_limit",
            resetAt,
            partialWork: true,
          },
        ],
      });
      // It waits behind the turn that was running, which it did not interrupt.
      const queued = after.runs.find((run) => run.userMessageId === notice.id)!;
      expect(queued.status).toBe("queued");
      expect(after.runs.find((run) => run.id === active.id)?.status).toBe(active.status);
      expect(queued.ordinal).toBeGreaterThan(active.ordinal);
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("sends nothing for a task stopped on purpose", () =>
    Effect.gen(function* () {
      const stopped = child("stopped", {
        run: childRun({ id: RunId.make("run:stopped"), status: "cancelled" }),
        turnItems: [{ ...interruptRequest, runId: RunId.make("run:stopped") }],
      });
      const h = yield* withThreads([stopped]);
      yield* h.orchestrator.dispatch(createParent);
      yield* h.orchestrator.dispatch(startParentTurn);
      yield* h.deliver(stopped, true);
      const after = yield* h.parent();
      expect(after.messages.map((message) => message.id)).toEqual(["message:parent-user"]);
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("folds children one restart cut off into a single queued notice", () =>
    Effect.gen(function* () {
      const cut = (name: string) =>
        child(name, {
          run: childRun({ id: RunId.make(`run:${name}`), status: "cancelled" }),
          turnItems: [],
        });
      const first = cut("one");
      const second = cut("two");
      const h = yield* withThreads([first, second]);
      yield* h.orchestrator.dispatch(createParent);
      yield* h.orchestrator.dispatch(startParentTurn);
      yield* h.deliver(first, true);
      yield* h.deliver(second, true);
      // Replays of either change nothing.
      yield* h.deliver(first, true);
      yield* h.deliver(second, true);

      const after = yield* h.parent();
      const queuedNotices = after.runs
        .filter((run) => run.status === "queued")
        .map((run) => after.messages.find((message) => message.id === run.userMessageId)!)
        .filter((message) => message.notification?.delegatedFailures !== undefined);
      expect(queuedNotices).toHaveLength(1);
      expect(queuedNotices[0]!.notification).toMatchObject({
        outcome: "cancelled",
        summary: '2 agents stopped: "Task one", "Task two"',
        delegatedFailures: [
          { taskId: "task:one", kind: "interrupted_by_restart" },
          { taskId: "task:two", kind: "interrupted_by_restart" },
        ],
      });
    }).pipe(Effect.provide(runtime)),
  );
});
