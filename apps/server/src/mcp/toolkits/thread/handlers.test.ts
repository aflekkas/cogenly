import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../config.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { ThreadToolkit } from "./tools.ts";

const callerId = ThreadId.make("thread:caller");
const otherId = ThreadId.make("thread:other");
const planId = ThreadId.make("thread:plan");
const endedId = ThreadId.make("thread:ended");
const childId = ThreadId.make("thread:child");
const siblingId = ThreadId.make("thread:sibling");
/** A subagent `callerId` delegated to. */
const delegatedBy = (id: ThreadId): OrchestrationV2ThreadShell => ({
  ...liveThreadShell(id),
  lineage: { rootThreadId: callerId, parentThreadId: callerId, relationshipToParent: "subagent" },
});
const shells = new Map<ThreadId, OrchestrationV2ThreadShell>([
  [callerId, liveThreadShell(callerId)],
  [otherId, liveThreadShell(otherId)],
  [planId, liveThreadShell(planId, { interactionMode: "plan" })],
  [endedId, liveThreadShell(endedId, { activeRunId: null })],
  [childId, delegatedBy(childId)],
  [siblingId, delegatedBy(siblingId)],
]);

const threadScope = (threadId: ThreadId): Invocation.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});
const readOnlyClient: Invocation.McpInvocationScope = {
  ...threadScope(callerId),
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Claude Code", access: "read-only" },
};

// Thursday 2026-10-22, 2:19 PM in New York.
const NOW_MS = Date.parse("2026-10-22T18:19:00Z");
const fakeCommandId = CommandId.make("mcp:test");

// The environment's wall clock zone, as COGENLY_TZ would set it.
const newYorkConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.map(ServerConfig.ServerConfig, (config) => ({
    ...config,
    serverTimeZone: "America/New_York",
  })),
).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-tools-test-" })),
  Layer.provide(NodeServices.layer),
);

type Recorded = { readonly method: string; readonly input: Record<string, unknown> };

/** The thread toolkit over a recording `ThreadManagementService`, called as `scope`. */
const callTool = Effect.fn("test.callThreadTool")(function* (
  scope: Invocation.McpInvocationScope,
  tool:
    | "thread_snooze"
    | "thread_unsnooze"
    | "thread_settle"
    | "thread_unsettle"
    | "pending_request_respond",
  params: Record<string, unknown>,
  overrides: Partial<Threads.ThreadManagementServiceShape> = {},
) {
  const calls: Array<Recorded> = [];
  const record =
    <A>(method: string, result: A) =>
    (input: object) =>
      Effect.sync(() => {
        calls.push({ method, input: { ...input, commandId: fakeCommandId } });
        return result;
      });
  const dependencies = Layer.mergeAll(
    Layer.succeed(Invocation.McpInvocationContext, scope),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
      getProjectThreadRecords: (input) =>
        Effect.succeed(idleThreadProjection(shells.get(input.threadId)!)),
      snoozeThread: (input) =>
        record("snoozeThread", {
          sequence: 7,
          snoozedUntil: input.until === "limit_reset" ? "" : input.until.snoozedUntil,
        })(input),
      unsnoozeThread: record("unsnoozeThread", { sequence: 7 }),
      settleThread: record("settleThread", { sequence: 7 }),
      unsettleThread: record("unsettleThread", { sequence: 7 }),
      ...overrides,
    }),
    newYorkConfig,
    Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
    Layer.mock(ThreadSearch.ThreadSearch)({}),
    NodeServices.layer,
  );
  yield* TestClock.setTime(NOW_MS);
  const toolkit = yield* ThreadToolkit.pipe(
    Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
  );
  const results = yield* toolkit
    .handle(tool, params as never)
    .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
  return {
    result: results.at(-1)?.result as Record<string, unknown> | undefined,
    calls: calls.map(({ method, input }) => ({ method, input })),
  };
});

const spaced = (value: unknown) => String(value).replace(/\s/g, " ");

it.effect("resolves a preset in the environment's time zone and returns a receipt", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* callTool(threadScope(callerId), "thread_snooze", {
      threadId: otherId,
      until: "tomorrow",
    });
    expect(calls).toEqual([
      {
        method: "snoozeThread",
        input: {
          commandId: fakeCommandId,
          threadId: otherId,
          until: { snoozedUntil: "2026-10-23T13:00:00.000Z" },
          byOwnAgent: false,
        },
      },
    ]);
    expect(result).toMatchObject({ timeZone: "America/New_York", sequence: 7 });
    expect(spaced(result?.receipt)).toBe("Snoozed until Fri 9:00 AM");
  }),
);

it.effect("resolves a typed phrase for the calling thread and defers to its turn", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* callTool(
      threadScope(callerId),
      "thread_snooze",
      { until: "next mon 10am" },
      {
        snoozeThread: (input) =>
          Effect.succeed({
            snoozedUntil: input.until === "limit_reset" ? "" : input.until.snoozedUntil,
            snoozesWhenTurnEnds: true as const,
          }),
      },
    );
    expect(result).toMatchObject({
      snoozedUntil: "2026-10-26T14:00:00.000Z",
      snoozesWhenTurnEnds: true,
    });
    expect(spaced(result?.receipt)).toBe("Snoozes until Mon 10:00 AM when this turn ends");
    expect(calls).toEqual([]);
  }),
);

it.effect("refuses a time it cannot read without touching the thread", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* callTool(threadScope(callerId), "thread_snooze", {
      until: "whenever works",
    });
    expect(result).toMatchObject({ code: "invalid_request" });
    expect(calls).toEqual([]);
  }),
);

it.effect("snoozes until a usage-limit reset, and says when there is none", () =>
  Effect.gen(function* () {
    const { result } = yield* callTool(
      threadScope(callerId),
      "thread_snooze",
      { threadId: otherId, until: "limit_reset" },
      {
        snoozeThread: (input) =>
          input.until === "limit_reset"
            ? Effect.fail(new Threads.ThreadManagementNoLimitResetError({ threadId: otherId }))
            : Effect.die("expected limit_reset"),
      },
    );
    expect(result).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("usage limit"),
    });
  }),
);

it.effect.each([
  { tool: "thread_settle", method: "settleThread", receipt: "Settled the thread" },
  { tool: "thread_unsettle", method: "unsettleThread", receipt: "Moved back to active" },
  { tool: "thread_unsnooze", method: "unsnoozeThread", receipt: "Woke the thread" },
] as const)("$tool reaches another thread in the environment", ({ tool, method, receipt }) =>
  Effect.gen(function* () {
    const { result, calls } = yield* callTool(threadScope(callerId), tool, { threadId: otherId });
    expect(result).toEqual({ sequence: 7, receipt });
    expect(calls).toEqual([
      {
        method,
        input: {
          commandId: fakeCommandId,
          threadId: otherId,
          ...(method === "settleThread" ? { byOwnAgent: false } : {}),
        },
      },
    ]);
  }),
);

it.effect("settles the calling thread when its turn ends", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* callTool(
      threadScope(callerId),
      "thread_settle",
      {},
      { settleThread: () => Effect.succeed({ settlesWhenTurnEnds: true as const }) },
    );
    expect(result).toEqual({ settlesWhenTurnEnds: true, receipt: "Settles when this turn ends" });
    expect(calls).toEqual([]);
  }),
);

it.effect.each(
  (["thread_snooze", "thread_unsnooze", "thread_settle", "thread_unsettle"] as const).flatMap(
    (tool) => [
      {
        tool,
        who: "a read-only client",
        scope: readOnlyClient,
        target: otherId,
        code: "capability_denied",
      },
      // A plan-mode caller cannot reach a thread running in default mode.
      {
        tool,
        who: "a plan-mode thread",
        scope: threadScope(planId),
        target: otherId,
        code: "interaction_mode_escalation_denied",
      },
      {
        tool,
        who: "an ended turn",
        scope: threadScope(endedId),
        target: otherId,
        code: "parent_not_active",
      },
    ],
  ),
)("$tool from $who: $code", ({ tool, scope, target, code }) =>
  Effect.gen(function* () {
    const { result, calls } = yield* callTool(scope, tool, { threadId: target, until: "tomorrow" });
    expect(result).toMatchObject({ code });
    expect(calls).toEqual([]);
  }),
);

const requestId = RuntimeRequestId.make("request:question");

/** Every thread waiting on one user-input question, `requestId`. */
const withQuestion = (shell: OrchestrationV2ThreadShell): OrchestrationV2ThreadProjection => {
  const projection = idleThreadProjection(shell);
  return {
    ...projection,
    runtimeRequests: [
      { id: requestId, kind: "user_input", status: "pending" },
    ] as unknown as OrchestrationV2ThreadProjection["runtimeRequests"],
    turnItems: [
      { type: "user_input_request", requestId, questions: [] },
    ] as unknown as OrchestrationV2ThreadProjection["turnItems"],
  };
};

const respond = (scope: Invocation.McpInvocationScope, threadId: ThreadId) =>
  callTool(
    scope,
    "pending_request_respond",
    { threadId, requestId, answers: { choice: "yes" } },
    {
      getProjectThreadRecords: (input) => Effect.succeed(withQuestion(shells.get(input.threadId)!)),
      dispatch: () => Effect.succeed({ sequence: 9, storedEvents: [] }),
    },
  );

it.effect("pending_request_respond lets the delegating parent answer its child", () =>
  Effect.gen(function* () {
    const { result } = yield* respond(threadScope(callerId), childId);
    expect(result).toEqual({ sequence: 9 });
  }),
);

it.effect.each([
  { who: "the asking thread itself", scope: threadScope(childId), target: childId },
  { who: "a sibling subagent", scope: threadScope(siblingId), target: childId },
  { who: "an unrelated thread", scope: threadScope(otherId), target: childId },
])("pending_request_respond refuses $who", ({ scope, target }) =>
  Effect.gen(function* () {
    const { result } = yield* respond(scope, target);
    expect(result).toMatchObject({ code: "capability_denied" });
  }),
);
