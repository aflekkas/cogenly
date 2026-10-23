import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  IntegrationName,
  ProviderInstanceId,
  ThreadId,
  IntegrationId,
  type Integration,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as AgentStore from "../../../agents/AgentStore.ts";
import * as Integrations from "../../../integrations/Integrations.ts";
import * as ProjectFiles from "../../../projectLabels/ProjectFiles.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { IntegrationsToolkit } from "./tools.ts";

const liveId = ThreadId.make("thread:live");
const endedId = ThreadId.make("thread:ended");
const shells = new Map<ThreadId, OrchestrationV2ThreadShell>([
  [liveId, liveThreadShell(liveId)],
  [endedId, liveThreadShell(endedId, { activeRunId: null })],
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
  ...threadScope(liveId),
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Claude Code", access: "read-only" },
};

/** integration_tools as `scope`, and how many times it reached the upstream. */
const listTools = Effect.fn("test.listIntegrationTools")(function* (
  scope: Invocation.McpInvocationScope,
) {
  let upstreamCalls = 0;
  const dependencies = Layer.mergeAll(
    Layer.succeed(Invocation.McpInvocationContext, scope),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
    }),
    Layer.mock(Integrations.Integrations)({
      listTools: (name) =>
        Effect.sync(() => {
          upstreamCalls += 1;
          return { name, tools: [] };
        }),
    }),
    Layer.mock(AgentStore.AgentStore)({}),
  );
  const toolkit = yield* IntegrationsToolkit.pipe(
    Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
  );
  const results = yield* toolkit
    .handle("integration_tools", { name: IntegrationName.make("gmail") })
    .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
  return { result: results.at(-1)?.result, upstreamCalls };
});

it.effect("integration_tools lists an integration's tools for a live thread", () =>
  Effect.gen(function* () {
    const { result, upstreamCalls } = yield* listTools(threadScope(liveId));
    expect(result).toEqual({ name: "gmail", tools: [] });
    expect(upstreamCalls).toBe(1);
  }),
);

it.effect.each([
  { who: "a read-only client", scope: readOnlyClient, code: "capability_denied" },
  { who: "an ended turn", scope: threadScope(endedId), code: "parent_not_active" },
])("integration_tools makes no credentialed call for $who", ({ scope, code }) =>
  Effect.gen(function* () {
    const { result, upstreamCalls } = yield* listTools(scope);
    expect(result).toMatchObject({ code });
    expect(upstreamCalls).toBe(0);
  }),
);

const integration = (name: string, scope: Integration["scope"]): Integration => ({
  id: IntegrationId.make(`integration:${name}`),
  name: IntegrationName.make(name),
  displayName: name,
  transport: "http",
  url: "https://example.com/mcp",
  headers: {},
  scope,
  hint: "",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z" as never,
  updatedAt: "2026-01-01T00:00:00.000Z" as never,
  deletedAt: null,
});

it.effect("a thread manages only integrations in its project and cannot widen their reach", () =>
  Effect.gen(function* () {
    const mine = integration("mine", { type: "projects", labelIds: ["label:a" as never] });
    const theirs = integration("theirs", { type: "projects", labelIds: ["label:b" as never] });
    const writes: Array<string> = [];
    const dependencies = Layer.mergeAll(
      Layer.succeed(Invocation.McpInvocationContext, threadScope(liveId)),
      Layer.mock(Threads.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
      }),
      Layer.mock(ProjectFiles.ProjectFiles)({
        folderForThread: () => Effect.succeed({ labelId: "label:a" } as never),
      }),
      Layer.mock(Integrations.Integrations)({
        list: () =>
          Effect.succeed({
            integrations: [mine, theirs].map((entry) => ({
              integration: entry,
              status: "unknown" as const,
              toolCount: null,
            })),
          }),
        update: (input) =>
          Effect.sync(() => {
            writes.push(`update:${input.id}`);
            return { integration: mine };
          }),
        remove: (id) =>
          Effect.sync(() => {
            writes.push(`remove:${id}`);
            return { deleted: true };
          }),
      }),
      Layer.mock(AgentStore.AgentStore)({ forThread: () => Effect.succeed(null) }),
    );
    const toolkit = yield* IntegrationsToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    const call = (name: string, args: object) =>
      toolkit
        .handle(name as never, args as never)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies))
        .pipe(Effect.map((results) => results.at(-1)?.result));

    expect(yield* call("integration_update", { name: "theirs", hint: "x" })).toMatchObject({
      code: "invalid_request",
    });
    expect(yield* call("integration_remove", { name: "theirs" })).toEqual({ deleted: false });
    expect(
      yield* call("integration_update", { name: "mine", scope: { type: "all" } }),
    ).toMatchObject({ code: "invalid_request", message: expect.stringContaining("owner") });
    expect(writes).toEqual([]);

    yield* call("integration_update", { name: "mine", hint: "x" });
    yield* call("integration_remove", { name: "mine" });
    expect(writes).toEqual([`update:${mine.id}`, `remove:${mine.id}`]);
  }),
);
