import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  defaultAgentPermissions,
  EnvironmentId,
  IntegrationId,
  ProjectLabelId,
  ProviderInstanceId,
  type AgentApprovalAction,
  type Integration,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectFiles from "../projectLabels/ProjectFiles.ts";
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
let persistent = true;
const proposals: AgentApprovalAction[] = [];
let current: Integration = {
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
const layer = AgentMcpPolicy.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(Store.AgentStore)({
        forThread: () => Effect.succeed(persistent ? agent : null),
      }),
      Layer.mock(Workspace.AgentWorkspaceService)({
        requestThreadIntegrationApproval: (_thread, action) => {
          proposals.push(action);
          return Effect.succeed({ approval: { id: "approval:thread" } as never });
        },
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
            integrations: [{ integration: current, status: "unknown", toolCount: null }],
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
  it.effect.each([
    { kind: "remote", input: addInput },
    {
      kind: "Google preset",
      input: {
        preset: "google-workspace",
        accountLabel: "personal",
        callbackOrigin: "https://cogenly.example.com",
      },
    },
  ])("requires owner approval for a persistent agent's $kind, never for the owner", ({ input }) =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      // AgentAccessScope resolves the agent and every label/repository id.
      yield* sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled, daily_run_cap) VALUES (${agent.id}, ${agent.conversationThreadId}, ${JSON.stringify(agent)}, 1, 2)`;
      const policy = yield* AgentMcpPolicy.AgentMcpPolicy;

      approvalRequests = 0;
      const denied = yield* policy
        .beforeTool(scopeFor(true), "integration_add", input, false)
        .pipe(Effect.result);
      expect(denied._tag).toBe("Failure");
      if (denied._tag === "Failure") {
        expect(denied.failure.code).toBe("agent_approval_required");
        expect(denied.failure.message).toContain("approval:test");
      }
      expect(approvalRequests).toBe(1);

      // The owner's own turn has no agent actor, so no approval is requested.
      const owner = yield* policy.beforeTool(scopeFor(false), "integration_add", input, false);
      expect(owner).toEqual({ handled: false });
      expect(approvalRequests).toBe(1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("proposes a catalog entry as the definition it resolves to", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled, daily_run_cap) VALUES (${agent.id}, ${agent.conversationThreadId}, ${JSON.stringify(agent)}, 1, 2)`;
      const policy = yield* AgentMcpPolicy.AgentMcpPolicy;

      proposals.length = 0;
      const denied = yield* policy
        .beforeTool(
          scopeFor(true),
          "integration_add",
          { catalogId: "linear", accountLabel: "Support" },
          false,
        )
        .pipe(Effect.result);
      expect(denied).toMatchObject({
        _tag: "Failure",
        failure: { code: "agent_approval_required" },
      });
      expect(proposals).toEqual([
        {
          actionKind: "integration_add",
          threadId: agent.conversationThreadId,
          payload: expect.objectContaining({
            name: "linear-support",
            url: "https://mcp.linear.app/mcp",
            accountLabel: "Support",
            auth: { type: "oauth" },
          }),
        },
      ]);

      // A missing input is the agent's next step, not a proposal.
      const missing = yield* policy
        .beforeTool(scopeFor(true), "integration_add", { catalogId: "slack" }, false)
        .pipe(Effect.result);
      expect(missing).toMatchObject({
        _tag: "Failure",
        failure: { code: "invalid_request", message: expect.stringContaining("request_secret") },
      });
      expect(proposals).toHaveLength(1);
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
          { accountLabel: "Attacker" },
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
        expect(proposals).toHaveLength(7);
        expect(proposals[1]).toMatchObject({
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
        expect(proposals).toHaveLength(7);
      }).pipe(Effect.provide(layer)),
  );
});

it.effect("scope widening requests owner approval for a visible integration", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled, daily_run_cap) VALUES (${agent.id}, ${agent.conversationThreadId}, ${JSON.stringify(agent)}, 1, 2)`;
    const policy = yield* AgentMcpPolicy.AgentMcpPolicy;
    const original = current;
    current = { ...current, scope: { type: "projects", labelIds: [ProjectLabelId.make("a")] } };
    const result = yield* policy
      .beforeTool(
        scopeFor(true),
        "integration_update",
        { name: current.name, scope: { type: "all" } },
        false,
      )
      .pipe(Effect.result);
    current = original;
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.code).toBe("agent_approval_required");
  }).pipe(
    Effect.provide(
      Layer.merge(
        layer,
        Layer.mock(ProjectFiles.ProjectFiles)({
          folderForThread: () => Effect.succeed({ labelId: ProjectLabelId.make("a") } as never),
        }),
      ),
    ),
  ),
);

it.effect("ordinary chats propose exact executable definitions before any process can start", () =>
  Effect.gen(function* () {
    const policy = yield* AgentMcpPolicy.AgentMcpPolicy;
    persistent = false;
    proposals.length = 0;
    const original = current;
    const command = {
      command: "/bin/sh",
      args: ["-c", "printf synthetic"],
      env: { API_KEY: "{{credential:synthetic.value}}" },
    };
    try {
      const added = yield* policy
        .beforeTool(
          scopeFor(true),
          "integration_add",
          { ...addInput, transport: "stdio", command },
          false,
        )
        .pipe(Effect.result);
      expect(added).toMatchObject({
        _tag: "Failure",
        failure: { code: "agent_approval_required" },
      });
      expect(proposals[0]).toMatchObject({ actionKind: "integration_add", payload: { command } });
      current = { ...current, transport: "stdio", command };
      for (const next of [
        { ...command, command: "npx" },
        { ...command, args: ["-y", "synthetic-package@1.2.3"] },
        { ...command, env: { API_KEY: "{{credential:other.value}}" } },
      ]) {
        const changed = yield* policy
          .beforeTool(
            scopeFor(true),
            "integration_update",
            { name: current.name, command: next },
            false,
          )
          .pipe(Effect.result);
        expect(changed).toMatchObject({
          _tag: "Failure",
          failure: { code: "agent_approval_required" },
        });
        expect(proposals.at(-1)).toMatchObject({
          actionKind: "integration_update",
          payload: { command: next },
        });
      }
      expect(
        yield* policy.beforeTool(
          scopeFor(true),
          "integration_update",
          { name: current.name, hint: "metadata" },
          false,
        ),
      ).toEqual({ handled: false });
    } finally {
      persistent = true;
      current = original;
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("default agents can run lookup commands while sensitive tools retain their grants", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const limited = { ...agent, permissions: defaultAgentPermissions };
    yield* sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled, daily_run_cap) VALUES (${agent.id}, ${agent.conversationThreadId}, ${JSON.stringify(limited)}, 1, 2)`;
    const policy = yield* AgentMcpPolicy.AgentMcpPolicy;
    expect(
      yield* policy.beforeTool(scopeFor(true), "terminal_run", { command: "cat README" }, false),
    ).toEqual({ handled: false });
    for (const name of [
      "merge_pull_request",
      "deploy",
      "delete_file",
      "create_pull_request",
      "send_email",
    ]) {
      expect(
        yield* policy.beforeTool(scopeFor(true), name, {}, false).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { code: "agent_permission_denied" } });
    }
  }).pipe(Effect.provide(layer)),
);
