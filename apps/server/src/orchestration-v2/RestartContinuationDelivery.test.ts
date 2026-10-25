import { describe, expect, it } from "@effect/vitest";
import { RunId, ThreadId } from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const SETTINGS = {
  getSettings: Effect.succeed({
    projectSettingsOverrides: {},
    projectSettingsFolded: true,
    continueThreadsAfterServerUpdate: true,
  }),
} as never;

const THREAD = {
  id: "thread:test",
  projectId: null,
  providerInstanceId: "instance:a",
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
  snoozedUntil: null,
};

const cancelledSource = (overrides: Record<string, unknown> = {}) => ({
  id: "run:source",
  status: "cancelled",
  activeAttemptId: "attempt:1",
  startedAt: DateTime.makeUnsafe("2026-10-20T09:40:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-10-20T09:55:00.000Z"),
  providerInstanceId: "instance:a",
  userMessageId: "message:user-1",
  ...overrides,
});

const records = (overrides: Record<string, unknown> = {}) => ({
  thread: THREAD,
  messages: [],
  runs: [cancelledSource()],
  providerTurns: [],
  attempts: [{ id: "attempt:1", runId: "run:source", status: "cancelled" }],
  runtimeRequests: [],
  turnItems: [],
  ...overrides,
});

const runDelivery = (first: unknown, second: unknown) =>
  Effect.gen(function* () {
    const calls = { dispatch: [] as Array<unknown>, recover: 0 };
    const threads = {
      getThreadRecords: (_threadId: unknown, fields: ReadonlyArray<string>) =>
        Effect.succeed(fields.includes("runs") ? first : second),
      dispatch: (command: unknown) => {
        calls.dispatch.push(command);
        return Effect.succeed({ sequence: 0, storedEvents: [] });
      },
      recoverDelegatedTask: () => {
        calls.recover += 1;
        return Effect.void;
      },
    } as never;
    yield* continueRestartedRun({
      threadId: ThreadId.make("thread:test"),
      sourceRunId: RunId.make("run:source"),
    }).pipe(
      Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
      Effect.provideService(ServerSettings.ServerSettingsService, SETTINGS),
    );
    return calls;
  });

describe("continueRestartedRun", () => {
  it.effect("dispatches one resume marker for a turn cut mid-flight", () =>
    Effect.gen(function* () {
      const first = records({
        providerTurns: [{ id: "turn:1", runAttemptId: "attempt:1", status: "cancelled" }],
      });
      const calls = yield* runDelivery(first, { messages: [], turnItems: [] });
      expect(calls.dispatch).toHaveLength(1);
      expect(calls.dispatch[0]).toMatchObject({
        type: "message.dispatch",
        messageId: "message:restart-continuation:run:source",
        restartContinuationOfRunId: "run:source",
        notification: {
          source: { kind: "system" },
          outcome: "updated",
          summary: "Cogenly restarted and resumed this turn",
        },
      });
      expect(calls.recover).toBe(1);
    }),
  );

  it.effect("declines a source that never reached the provider", () =>
    Effect.gen(function* () {
      // An unstarted continuation cut by a later restart: chaining it would
      // stack another marker for a turn that never ran. Recovery revives the
      // unstarted run itself instead.
      const first = records({
        runs: [cancelledSource({ startedAt: null, restartContinuationOfRunId: "run:older" })],
      });
      const calls = yield* runDelivery(first, { messages: [], turnItems: [] });
      expect(calls.dispatch).toHaveLength(0);
      expect(calls.recover).toBe(1);
    }),
  );

  it.effect("declines a source whose provider turn already completed", () =>
    Effect.gen(function* () {
      const first = records({
        providerTurns: [{ id: "turn:1", runAttemptId: "attempt:1", status: "completed" }],
      });
      const calls = yield* runDelivery(first, { messages: [], turnItems: [] });
      expect(calls.dispatch).toHaveLength(0);
    }),
  );
});
