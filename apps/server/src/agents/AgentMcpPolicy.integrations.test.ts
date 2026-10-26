import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  IntegrationId,
  ProjectLabelId,
  ProviderInstanceId,
  type AgentApprovalAction,
  type Integration,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../persistence/Sqlite.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as AgentMcpPolicy from "./AgentMcpPolicy.ts";
import * as Store from "./AgentStore.ts";
import * as Workspace from "./AgentWorkspaceService.ts";
import { agentFixture } from "./agent.testkit.ts";
import * as Integrations from "../integrations/Integrations.ts";

const database = Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer));
const agent = agentFixture("integrations");
const shell = liveThreadShell(agent.conversationThreadId);

let approvalRequests = 0;
const proposals: AgentApprovalAction[] = [];
const current: Integration = {
  id: IntegrationId.make("integration:test"),
  name: "gmail",
  displayName: "Gmail",
  transport: "http",
  url: "https://example.com/mcp",
  headers: { authorization: "Bearer {{credential:gmail.value}}" },
  scope: { type: "all" },
  hint: "",
  enabled: true,
  createdAt: agent.createdAt,
  updatedAt: agent.updatedAt,
  deletedAt: null,
};
const scoped: Integration = {
  ...current,
  id: IntegrationId.make("integration:scoped"),
  name: "linear",
  scope: { type: "projects", labelIds: [ProjectLabelId.make("label:a")] },
};
const layer = AgentMcpPolicy.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(Store.AgentStore)({
        forThread: () => Effect.succeed(agent),
      }),
      Layer.mock(Workspace.AgentWorkspaceService)({
        requestApproval: (_id, action) => {
          approvalRequests += 1;
          proposals.push(action);
          return Effect.succeed({
            approval: { id: "approval:test" } as never,
          });
        },
      }),
      Layer.mock(Threads.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(shell),
      }),
      Layer.mock(Integrations.Integrations)({
        list: () =>
          Effect.succeed({
            integrations: [
              { integration: current, status: "unknown", toolCount: null },
              { integration: scoped, status: "unknown", toolCount: null },
            ],
          }),
      }),
    ),
  ),
  Layer.provideMerge(database),
  Layer.provide(NodeServices.layer),
);

const scopeFor = (threaded: boolean): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:test"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "test",
  thread: threaded
    ? {
        threadId: agent.conversationThreadId,
        providerSessionId: "session:test",
        providerInstanceId: ProviderInstanceId.make("codex"),
      }
    : undefined,
  client: undefined,
});

const addInput = {
  name: "gmail",
  displayName: "Gmail",
  transport: "http",
  url: "https://example.com/mcp",
  headers: {},
  scope: { type: "all" },
  hint: "",
};

describe("integration_add approval gating", () => {
  it.effect("requires owner approval for a persistent agent, never for the owner", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      // AgentAccessScope resolves the agent and every label/repository id.
      yield* sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled, daily_run_cap) VALUES (${agent.id}, ${agent.conversationThreadId}, ${JSON.stringify(agent)}, 1, 2)`;
      const policy = yield* AgentMcpPolicy.AgentMcpPolicy;

      approvalRequests = 0;
      const denied = yield* policy
        .beforeTool(scopeFor(true), "integration_add", addInput, false)
        .pipe(Effect.result);
      expect(denied._tag).toBe("Failure");
      if (denied._tag === "Failure") {
        expect(denied.failure.code).toBe("agent_approval_required");
        expect(denied.failure.message).toContain("approval:test");
      }
      expect(approvalRequests).toBe(1);

      // The owner's own turn has no agent actor, so no approval is requested.
      const owner = yield* policy.beforeTool(scopeFor(false), "integration_add", addInput, false);
      expect(owner).toEqual({ handled: false });
      expect(approvalRequests).toBe(1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "requires a fresh approval for destinations and credential attachments, but not metadata",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled, daily_run_cap) VALUES (${agent.id}, ${agent.conversationThreadId}, ${JSON.stringify(agent)}, 1, 2)`;
        const policy = yield* AgentMcpPolicy.AgentMcpPolicy;
        proposals.length = 0;
        for (const change of [
          { url: "https://evil.test/mcp" },
          { url: "http://example.com/mcp" },
          { url: "https://example.com/other" },
          { headers: { authorization: "Bearer {{credential:other.value}}" } },
          { headers: { "x-api-key": current.headers.authorization! } },
          { headers: { ...current.headers, host: "evil.test" } },
        ]) {
          const result = yield* policy
            .beforeTool(
              scopeFor(true),
              "integration_update",
              { name: current.name, ...change },
              false,
            )
            .pipe(Effect.flip);
          expect(result.code).toBe("agent_approval_required");
        }
        expect(proposals).toHaveLength(6);
        expect(proposals[0]).toMatchObject({
          actionKind: "integration_update",
          payload: {
            id: current.id,
            url: "https://evil.test/mcp",
            headers: current.headers,
            transport: current.transport,
          },
        });
        for (const change of [
          { hint: "new hint" },
          { enabled: false },
          { displayName: "New name" },
          { url: current.url, headers: current.headers, transport: "http" },
        ]) {
          expect(
            yield* policy.beforeTool(
              scopeFor(true),
              "integration_update",
              { name: current.name, ...change },
              false,
            ),
          ).toEqual({ handled: false });
        }
        expect(
          yield* policy.beforeTool(
            scopeFor(false),
            "integration_update",
            { name: current.name, url: "https://evil.test" },
            false,
          ),
        ).toEqual({ handled: false });
        expect(proposals).toHaveLength(6);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("requires approval to make an integration reach more projects", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled, daily_run_cap) VALUES (${agent.id}, ${agent.conversationThreadId}, ${JSON.stringify(agent)}, 1, 2)`;
      const policy = yield* AgentMcpPolicy.AgentMcpPolicy;
      proposals.length = 0;
      for (const scope of [
        { type: "all" },
        { type: "projects", labelIds: ["label:a", "label:b"] },
      ]) {
        const result = yield* policy
          .beforeTool(scopeFor(true), "integration_update", { name: scoped.name, scope }, false)
          .pipe(Effect.flip);
        expect(result.code).toBe("agent_approval_required");
      }
      expect(proposals).toHaveLength(2);
      // Narrowing reaches nothing new.
      expect(
        yield* policy.beforeTool(
          scopeFor(true),
          "integration_update",
          { name: scoped.name, scope: { type: "projects", labelIds: [] } },
          false,
        ),
      ).toEqual({ handled: false });
    }).pipe(Effect.provide(layer)),
  );
});
