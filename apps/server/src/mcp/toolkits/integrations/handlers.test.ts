import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  IntegrationError,
  IntegrationId,
  IntegrationName,
  ProviderInstanceId,
  ThreadId,
  type Integration,
  type IntegrationCreateInput,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as AgentStore from "../../../agents/AgentStore.ts";
import * as Integrations from "../../../integrations/Integrations.ts";
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

/** integration_add as a live thread whose MCP request reached `origin`. */
const addIntegration = Effect.fn("test.addIntegration")(function* (
  input: Pick<IntegrationCreateInput, "auth">,
) {
  const signIns: Array<{ id: string; origin: Integrations.SignInOrigin }> = [];
  const integration: Integration = {
    id: IntegrationId.make("integration:linear"),
    name: IntegrationName.make("linear"),
    displayName: "Linear",
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    headers: {},
    enabled: true,
    scope: { type: "all" },
    hint: "",
    ...input,
    createdAt: "2026-10-23T00:00:00.000Z" as Integration["createdAt"],
    updatedAt: "2026-10-23T00:00:00.000Z" as Integration["updatedAt"],
    deletedAt: null,
  };
  const scope = { ...threadScope(liveId), httpOrigin: "http://127.0.0.1:3773" };
  const dependencies = Layer.mergeAll(
    Layer.succeed(Invocation.McpInvocationContext, scope),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
    }),
    Layer.mock(Integrations.Integrations)({
      create: () => Effect.succeed({ integration }),
      list: () =>
        Effect.succeed({
          integrations: [
            {
              integration,
              status: integration.auth ? ("needs_sign_in" as const) : ("unknown" as const),
              toolCount: null,
            },
          ],
        }),
      beginSignIn: (id, origin) =>
        Effect.sync(() => {
          signIns.push({ id, origin });
          return {
            authorizationUrl: "https://mcp.linear.app/authorize?state=s",
            redirectUri: "http://127.0.0.1:3773/oauth/integrations/callback",
          };
        }),
    }),
    Layer.mock(AgentStore.AgentStore)({}),
  );
  const toolkit = yield* IntegrationsToolkit.pipe(
    Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
  );
  const { auth: _, ...fields } = integration;
  const results = yield* toolkit
    .handle("integration_add", { ...fields, ...input })
    .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
  return { result: results.at(-1)?.result, signIns };
});

it.effect("integration_add hands an agent the sign-in link for an OAuth server", () =>
  Effect.gen(function* () {
    const { result, signIns } = yield* addIntegration({ auth: { type: "oauth" } });
    expect(result).toMatchObject({
      signIn: { authorizationUrl: "https://mcp.linear.app/authorize?state=s" },
    });
    expect(signIns).toEqual([
      {
        id: "integration:linear",
        origin: { origin: "http://127.0.0.1:3773", fromAgent: true },
      },
    ]);

    const plain = yield* addIntegration({});
    expect(plain.result).not.toHaveProperty("signIn");
    expect(plain.signIns).toHaveLength(0);
  }),
);

/** integration_add with a catalogId, against a gateway that answers `connect`. */
const addFromCatalog = Effect.fn("test.addFromCatalog")(function* (
  input: Record<string, unknown>,
  connect: Integrations.Integrations["Service"]["connectFromCatalog"],
) {
  const requests: Array<Parameters<typeof connect>> = [];
  const scope = { ...threadScope(liveId), httpOrigin: "https://cogenly.example.com" };
  const dependencies = Layer.mergeAll(
    Layer.succeed(Invocation.McpInvocationContext, scope),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
    }),
    Layer.mock(Integrations.Integrations)({
      connectFromCatalog: (...args) => {
        requests.push(args);
        return connect(...args);
      },
    }),
    Layer.mock(AgentStore.AgentStore)({}),
  );
  const toolkit = yield* IntegrationsToolkit.pipe(
    Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
  );
  const results = yield* toolkit
    .handle("integration_add", input as never)
    .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
  return { result: results.at(-1)?.result, requests };
});

it.effect("integration_add connects a catalog entry and relays its sign-in link", () =>
  Effect.gen(function* () {
    const integration = {
      id: IntegrationId.make("integration:notion"),
      name: IntegrationName.make("notion-work"),
      displayName: "Notion",
      transport: "http" as const,
      url: "https://mcp.notion.com/mcp",
      headers: {},
      enabled: true,
      scope: { type: "all" as const },
      hint: "",
      accountLabel: "work",
      auth: { type: "oauth" as const },
      createdAt: "2026-10-23T00:00:00.000Z" as Integration["createdAt"],
      updatedAt: "2026-10-23T00:00:00.000Z" as Integration["updatedAt"],
      deletedAt: null,
    };
    const signIn = {
      authorizationUrl: "https://mcp.notion.com/authorize?state=s",
      redirectUri: "https://cogenly.example.com/oauth/integrations/callback",
    };
    const { result, requests } = yield* addFromCatalog(
      { catalogId: "notion", accountLabel: " work ", region: "default" },
      () => Effect.succeed({ integration, signIn }),
    );
    expect(result).toEqual({ integration, signIn });
    expect(requests).toEqual([
      [
        { catalogId: "notion", accountLabel: "work", inputs: { region: "default" } },
        { origin: { origin: "https://cogenly.example.com", fromAgent: true } },
      ],
    ]);
  }),
);

it.effect("integration_add tells the agent the next step a catalog entry needs", () =>
  Effect.gen(function* () {
    const { result } = yield* addFromCatalog({ catalogId: "intercom" }, () =>
      Effect.fail(
        new IntegrationError({
          operation: "connect from catalog",
          reason: "invalid_request",
          cause: 'Ask the user where their Intercom workspace is hosted, then pass region: "us".',
        }),
      ),
    );
    expect(result).toMatchObject({
      code: "invalid_request",
      message: 'Ask the user where their Intercom workspace is hosted, then pass region: "us".',
    });
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
