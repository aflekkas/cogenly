import { expect, it } from "@effect/vitest";
import {
  CommandId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread:snooze");
const runId = RunId.make("run:stopped");
const commandId = CommandId.make("command:snooze");
const NOW_MS = Date.parse("2026-10-22T18:00:00Z");
const resetAt = "2026-10-22T20:00:00.000Z";

/** A thread stopped on a usage limit that resets at `resetAt`. */
const limitedShell = (
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  ...liveThreadShell(threadId, { activeRunId: null }),
  status: "failed",
  lastErrorClass: "usage_limit",
  latestRunId: runId,
  usageLimitResetAt: resetAt,
  latestRunCompletedAt: DateTime.makeUnsafe(NOW_MS - 60_000),
  ...overrides,
});

const scopedIt = <E>(name: string, body: () => Effect.Effect<void, E, Scope.Scope>) =>
  it.effect(name, () => Effect.scoped(body()));

const runWithStatus = (status: OrchestrationV2Run["status"]) =>
  ({ id: RunId.make("run:mcp-test"), status }) as OrchestrationV2Run;

/**
 * The service over an orchestrator that records dispatches. Run state comes
 * from `runs`, and each `wake` offer stands in for a stored run update.
 */
const harness = Effect.fn("test.snoozeHarness")(function* (shell: OrchestrationV2ThreadShell) {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const firstDispatch = yield* Deferred.make<OrchestrationV2ServerCommand>();
  const runs = yield* Ref.make([runWithStatus("running")]);
  const wake = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
  const orchestrator = Layer.mock(Orchestrator.OrchestratorV2)({
    getThreadShell: () => Effect.succeed(shell),
    dispatch: (command) =>
      Effect.sync(() => dispatched.push(command)).pipe(
        Effect.tap(() => Deferred.succeed(firstDispatch, command)),
        Effect.map((sequence) => ({ sequence, storedEvents: [] })),
      ),
    getThreadEventSequence: () => Effect.succeed(0),
    getThreadRecords: () =>
      Ref.get(runs).pipe(Effect.map((current) => ({ thread: shell, runs: current }) as never)),
    restartContinuationPending: () => Effect.succeed(false),
    streamStoredEventsFrom: (input) =>
      input?.eventType === "thread.deleted" ? Stream.fromQueue(wake) : Stream.never,
  });
  // Built in the test's scope: a held snooze runs in the service's own scope.
  const context = yield* Layer.build(
    ThreadManagement.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          orchestrator,
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
          Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({}),
          ServerSettings.layerTest({}),
        ),
      ),
    ),
  );
  const service = Context.get(context, ThreadManagement.ThreadManagementService);
  yield* TestClock.setTime(NOW_MS);
  return { service, dispatched, firstDispatch, runs, wake };
});

scopedIt("snoozes until a time with thread.snooze", () =>
  Effect.gen(function* () {
    const { service, dispatched } = yield* harness(liveThreadShell(threadId));
    const result = yield* service.snoozeThread({
      threadId,
      commandId,
      until: { snoozedUntil: "2026-10-23T13:00:00.000Z" },
      byOwnAgent: false,
    });
    expect(result).toEqual({ sequence: 1, snoozedUntil: "2026-10-23T13:00:00.000Z" });
    expect(dispatched).toEqual([
      { type: "thread.snooze", commandId, threadId, snoozedUntil: "2026-10-23T13:00:00.000Z" },
    ]);
  }),
);

scopedIt("snoozes until the usage-limit reset through the recovery record", () =>
  Effect.gen(function* () {
    const { service, dispatched } = yield* harness(limitedShell());
    const result = yield* service.snoozeThread({
      threadId,
      commandId,
      until: "limit_reset",
      byOwnAgent: false,
    });
    expect(result).toEqual({ sequence: 1, snoozedUntil: resetAt });
    expect(dispatched).toEqual([
      {
        type: "thread.metadata.update",
        commandId,
        threadId,
        limitRecovery: { runId, resetAt, snooze: true },
      },
    ]);
  }),
);

scopedIt("refuses a reset snooze for a thread that is not limited", () =>
  Effect.gen(function* () {
    const { service, dispatched } = yield* harness(liveThreadShell(threadId));
    const error = yield* service
      .snoozeThread({ threadId, commandId, until: "limit_reset", byOwnAgent: false })
      .pipe(Effect.flip);
    expect(error._tag).toBe("ThreadManagementNoLimitResetError");
    expect(dispatched).toEqual([]);
  }),
);

scopedIt("wakes a reset-owned snooze through the recovery record, others with unsnooze", () =>
  Effect.gen(function* () {
    const owned = yield* harness(
      limitedShell({
        limitRecovery: { runId, resetAt, autoResume: true, snooze: true },
        snoozedUntil: DateTime.makeUnsafe(resetAt),
      }),
    );
    yield* owned.service.unsnoozeThread({ threadId, commandId });
    expect(owned.dispatched).toEqual([
      {
        type: "thread.metadata.update",
        commandId,
        threadId,
        limitRecovery: { runId, resetAt, snooze: false },
      },
    ]);

    const plain = yield* harness(liveThreadShell(threadId, { activeRunId: null }));
    yield* plain.service.unsnoozeThread({ threadId, commandId });
    yield* plain.service.unsettleThread({ threadId, commandId });
    expect(plain.dispatched).toEqual([
      { type: "thread.unsnooze", commandId, threadId, reason: "user" },
      { type: "thread.unsettle", commandId, threadId, reason: "user" },
    ]);
  }),
);

scopedIt("holds its own agent's snooze until the turn completes", () =>
  Effect.gen(function* () {
    // Snoozing mid-turn would wake as soon as the turn completed.
    const { service, dispatched, firstDispatch, runs, wake } = yield* harness(
      liveThreadShell(threadId),
    );
    const result = yield* service.snoozeThread({
      threadId,
      commandId,
      until: { snoozedUntil: "2026-10-23T13:00:00.000Z" },
      byOwnAgent: true,
    });
    expect(result).toEqual({
      snoozedUntil: "2026-10-23T13:00:00.000Z",
      snoozesWhenTurnEnds: true,
    });
    expect(dispatched).toEqual([]);

    yield* Ref.set(runs, [runWithStatus("completed")]);
    yield* Queue.offer(wake, { event: { type: "thread.deleted" } } as never);
    expect(yield* Deferred.await(firstDispatch)).toEqual({
      type: "thread.snooze",
      commandId,
      threadId,
      snoozedUntil: "2026-10-23T13:00:00.000Z",
    });
  }),
);
