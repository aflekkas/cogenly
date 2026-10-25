import { loopbackHttpsFetch, loopbackHttpsPolicy } from "./https.testkit.ts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  IntegrationId,
  IntegrationName,
  ProjectLabelId,
  ThreadId,
  SLACK_MCP_USER_SCOPES,
  integrationCatalogEntryFor,
  type Integration,
} from "@t3tools/contracts";
import { NodeCrypto } from "@effect/platform-node";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The fake upstream is a plain node:http server; Effect has no test HTTP server for this.
import * as NodeHttp from "node:http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Vault from "../vault/Vault.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Credentials from "./IntegrationCredentials.ts";
import { availableToConnect } from "./IntegrationCatalog.ts";
import * as Integrations from "./Integrations.ts";
import * as Tokens from "./IntegrationTokens.ts";
import { IntegrationEndpointPolicy } from "./RemoteEndpoint.ts";
import * as Workspace from "../agents/AgentWorkspaceService.ts";
import * as AgentStore from "../agents/AgentStore.ts";
import * as Agents from "../agents/AgentService.ts";
import * as Work from "../work/WorkHandoffService.ts";
import * as Schedules from "../scheduledTasks/ScheduledTaskService.ts";
import { agentFixture } from "../agents/agent.testkit.ts";

const database = Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer));

const secrets = new Map<string, string>([["gmail.apiKey", "SECRET-VALUE-123"]]);
const credentialsLayer = Layer.succeed(Credentials.IntegrationCredentials, {
  resolve: (ref) =>
    Effect.succeed(secrets.has(ref) ? Option.some(secrets.get(ref)!) : Option.none()),
});

interface FakeUpstream {
  readonly url: string;
  readonly seen: Array<{
    method: string;
    path: string | undefined;
    authorization: string | undefined;
    sessionId: string | undefined;
  }>;
  readonly close: () => Effect.Effect<void>;
}

/** A real in-process HTTP MCP server speaking streamable-HTTP JSON-RPC. */
const fakeUpstreamWith = (redirectTo?: string, denyListScope = false) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const seen: FakeUpstream["seen"] = [];
      const server: NodeHttp.Server = NodeHttp.createServer((request, response) => {
        const chunks: Array<Buffer> = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          if (redirectTo) {
            response.writeHead(307, { location: redirectTo });
            response.end();
            return;
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            id: number;
            method: string;
            params?: { name?: string; arguments?: unknown };
          };
          seen.push({
            method: body.method,
            path: request.url,
            authorization: request.headers.authorization,
            sessionId: [request.headers["mcp-session-id"]].flat()[0],
          });
          const reply = (payload: unknown, headers: Record<string, string> = {}) => {
            response.writeHead(200, { "content-type": "application/json", ...headers });
            response.end(JSON.stringify(payload));
          };
          if (body.method === "initialize") {
            reply(
              { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } },
              { "mcp-session-id": "session-1" },
            );
          } else if (body.method === "tools/list" && denyListScope) {
            response.writeHead(403, {
              "content-type": "application/json",
              "www-authenticate": 'Bearer error="insufficient_scope"',
            });
            response.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                error: { code: -32000, message: "insufficient_scope: required read scope missing" },
              }),
            );
          } else if (body.method === "tools/list") {
            reply({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                tools: [
                  {
                    name: "echo",
                    description: "Echoes its input",
                    inputSchema: { type: "object", properties: { text: { type: "string" } } },
                  },
                ],
              },
            });
          } else if (body.method === "tools/call" && body.params?.name === "hang") {
            // Never answers: the gateway timeout must map this.
          } else if (
            body.method === "tools/call" &&
            ["http-error", "tool-error"].includes(body.params?.name ?? "")
          ) {
            const message = `Workspace permission denied for ${request.headers.authorization}. ${"x".repeat(700)}`;
            if (body.params?.name === "http-error") {
              response.writeHead(403, { "content-type": "application/json" });
              response.end(
                JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message } }),
              );
            } else
              reply({
                jsonrpc: "2.0",
                id: body.id,
                result: { isError: true, content: [{ type: "text", text: message }] },
              });
          } else if (body.method === "tools/call" && body.params?.name === "fail") {
            reply({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32000, message: "upstream exploded" },
            });
          } else if (body.method === "tools/call") {
            reply({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                content: [{ type: "text", text: JSON.stringify(body.params?.arguments ?? {}) }],
                isError: false,
              },
            });
          } else {
            reply({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown" } });
          }
        });
      });
      return { server, seen };
    }).pipe(
      Effect.flatMap(({ server, seen }) =>
        Effect.callback<FakeUpstream>((resume) => {
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;
            resume(
              Effect.succeed({
                url: `https://127.0.0.1:${port}/mcp`,
                seen,
                close: () =>
                  Effect.sync(() => {
                    server.closeAllConnections();
                    server.close();
                  }),
              }),
            );
          });
        }),
      ),
    ),
    (upstream) => upstream.close(),
  );
const fakeUpstream = fakeUpstreamWith();

/** These tests never sign in; OAuth has its own suite over the real vault. */
const noTokensLayer = Layer.succeed(Tokens.IntegrationTokens, {
  read: () => Effect.succeed(Option.none()),
  write: () => Effect.die("no OAuth in this suite"),
  remove: () => Effect.void,
});

/** Secrets Settings saved, readable back through `credentialsLayer` like vault items. */
const savedSecrets: Array<Credentials.IntegrationSecretInput> = [];
const secretsLayer = Layer.succeed(Credentials.IntegrationSecrets, {
  save: (input) =>
    Effect.sync(() => {
      savedSecrets.push(input);
      for (const [field, value] of Object.entries(input.fields))
        if (value !== undefined) secrets.set(`${input.item}.${field}`, value);
    }),
});

const layerWith = (
  options: Integrations.IntegrationsOptions = {},
  policy: typeof loopbackHttpsPolicy = loopbackHttpsPolicy,
) =>
  Integrations.layerWith(options).pipe(
    Layer.provide(Layer.succeed(IntegrationEndpointPolicy, policy)),
    Layer.provide(credentialsLayer),
    Layer.provide(secretsLayer),
    Layer.provide(noTokensLayer),
    Layer.provideMerge(database),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provide(NodeServices.layer),
  );

const createInput = (url: string, name = "gmail") => ({
  name: IntegrationName.make(name),
  displayName: "Gmail",
  transport: "http" as const,
  url,
  headers: { authorization: "Bearer {{credential:gmail.apiKey}}" },
  scope: { type: "all" as const },
  hint: "Gmail for aflekkas@example.com",
});

describe("resolveHeaderTemplates", () => {
  it.effect("preserves dollar replacement sequences in credential values", () =>
    Effect.gen(function* () {
      const secret = "key-$&-$$-$`-$'";
      const headers = yield* Integrations.resolveHeaderTemplates(
        { authorization: "Bearer {{credential:gmail.apiKey}}" },
        () => Effect.succeed(Option.some(secret)),
      );
      expect(headers.authorization).toBe(`Bearer ${secret}`);
    }),
  );

  it.effect("resolves credential references and fails closed when missing", () =>
    Effect.gen(function* () {
      const resolved = yield* Integrations.resolveHeaderTemplates(
        { authorization: "Bearer {{credential:gmail.apiKey}}", "x-static": "yes" },
        (ref) => Effect.succeed(secrets.has(ref) ? Option.some(secrets.get(ref)!) : Option.none()),
      );
      expect(resolved).toEqual({ authorization: "Bearer SECRET-VALUE-123", "x-static": "yes" });

      const missing = yield* Integrations.resolveHeaderTemplates(
        { authorization: "Bearer {{credential:gmail.missing}}" },
        (ref) => Effect.succeed(secrets.has(ref) ? Option.some(secrets.get(ref)!) : Option.none()),
      ).pipe(Effect.result);
      expect(missing._tag).toBe("Failure");

      const malformed = yield* Integrations.resolveHeaderTemplates(
        { authorization: "Bearer {{credential:no-field}}" },
        (ref) => Effect.succeed(secrets.has(ref) ? Option.some(secrets.get(ref)!) : Option.none()),
      ).pipe(Effect.result);
      expect(malformed._tag).toBe("Failure");

      const unknownTemplate = yield* Integrations.resolveHeaderTemplates(
        { authorization: "Bearer {{env:TOKEN}}" },
        (ref) => Effect.succeed(secrets.has(ref) ? Option.some(secrets.get(ref)!) : Option.none()),
      ).pipe(Effect.result);
      expect(unknownTemplate._tag).toBe("Failure");
    }),
  );
});

describe("Integrations gateway", () => {
  it.effect(
    "binds credentials to the approved origin and refuses unapproved destination edits",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations();
          const original = yield* fakeUpstream;
          const other = yield* fakeUpstream;
          const service = yield* Integrations.Integrations;
          const { integration } = yield* service.create(createInput(original.url));
          const preserve = { preserveCredentialDestination: true };
          for (const change of [
            { url: other.url },
            { headers: { "x-api-key": "{{credential:gmail.apiKey}}" } },
            { headers: { authorization: "{{credential:other.apiKey}}" } },
          ]) {
            expect(
              (yield* service
                .update({ id: integration.id, ...change }, preserve)
                .pipe(Effect.result))._tag,
            ).toBe("Failure");
          }
          yield* service.update({ id: integration.id, hint: "Safe edit" }, preserve);
          yield* service.callTool(integration.name, "echo", {}, null);
          expect(other.seen).toHaveLength(0);
          expect(original.seen[0]?.authorization).toBe("Bearer SECRET-VALUE-123");

          // A stored definition with a mismatched binding fails before resolving or sending.
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE integrations SET payload_json = ${JSON.stringify({ ...integration, url: other.url })} WHERE id = ${integration.id}`;
          expect(
            (yield* service.callTool(integration.name, "echo", {}, null).pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(other.seen).toHaveLength(0);
          // Settings/owner approval authorizes a new origin, keeping existing headers.
          const approved = yield* service.update({ id: integration.id, url: other.url });
          expect(approved.integration.credentialOrigin).toBe(new URL(other.url).origin);
          yield* service.callTool(integration.name, "echo", {}, null);
          expect(other.seen[0]?.authorization).toBe("Bearer SECRET-VALUE-123");
        }).pipe(Effect.provide(layerWith())),
      ),
  );

  it.effect("an agent cannot move a stored literal header to a new destination", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const original = yield* fakeUpstream;
        const other = yield* fakeUpstream;
        const service = yield* Integrations.Integrations;
        const { integration } = yield* service.create(
          { ...createInput(original.url), headers: { authorization: "Bearer LITERAL-TOKEN" } },
          { approveCredentials: true },
        );
        const hold = { fromAgent: true };
        for (const change of [
          { url: other.url },
          { url: other.url, headers: { authorization: Integrations.HEADER_MASK } },
          { headers: { authorization: Integrations.HEADER_MASK, host: "other.test" } },
        ]) {
          const result = yield* service
            .update({ id: integration.id, ...change }, hold)
            .pipe(Effect.flip);
          expect(result.reason).toBe("approval_required");
        }
        yield* service.callTool(integration.name, "echo", {}, null);
        expect(other.seen).toHaveLength(0);
        expect(original.seen[0]?.authorization).toBe("Bearer LITERAL-TOKEN");

        // A token the agent supplies itself may go wherever it points.
        yield* service.update(
          { id: integration.id, url: other.url, headers: { authorization: "Bearer AGENT-OWN" } },
          hold,
        );
        yield* service.callTool(integration.name, "echo", {}, null);
        expect(other.seen.map((request) => request.authorization)).not.toContain(
          "Bearer LITERAL-TOKEN",
        );
        expect(other.seen[0]?.authorization).toBe("Bearer AGENT-OWN");
      }).pipe(Effect.provide(layerWith())),
    ),
  );

  it.effect("never forwards custom secret headers to a redirect destination", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const destination = yield* fakeUpstream;
        const redirect = yield* fakeUpstreamWith(destination.url);
        const service = yield* Integrations.Integrations;
        const { integration } = yield* service.create({
          ...createInput(redirect.url),
          headers: { "x-api-key": "{{credential:gmail.apiKey}}" },
        });
        expect(
          (yield* service.callTool(integration.name, "echo", {}, null).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(destination.seen).toHaveLength(0);
      }).pipe(Effect.provide(layerWith())),
    ),
  );

  it.effect("owner approval applies only the reviewed credential destination", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const upstream = yield* fakeUpstream;
        const service = yield* Integrations.Integrations;
        const workspace = yield* Workspace.AgentWorkspaceService;
        const agent = agentFixture("integration-approval");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled, daily_run_cap) VALUES (${agent.id}, ${agent.conversationThreadId}, ${JSON.stringify(agent)}, 1, 2)`;
        const { integration } = yield* service.create(createInput("https://original.test/mcp"));
        const { approval } = yield* workspace.requestApproval(agent.id, {
          actionKind: "integration_update",
          payload: {
            id: integration.id,
            url: upstream.url,
            headers: integration.headers,
            transport: integration.transport,
          },
        });
        // A subsequent edit must not attach unreviewed credentials to the approved origin.
        yield* service.update({
          id: integration.id,
          headers: { authorization: "{{credential:unreviewed.apiKey}}" },
        });
        yield* workspace.approve(approval.id);
        yield* service.callTool(integration.name, "echo", {}, null);
        expect(upstream.seen[0]?.authorization).toBe("Bearer SECRET-VALUE-123");
        expect((yield* workspace.listApprovals({})).approvals[0]?.status).toBe("approved");
      }).pipe(
        Effect.provide(
          Workspace.layer.pipe(
            Layer.provideMerge(layerWith()),
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(AgentStore.AgentStore)({
                  get: () =>
                    Effect.succeed({
                      ...agentFixture("integration-approval"),
                      unreadCount: 0,
                      latestMessage: null,
                    }),
                }),
                Layer.mock(Agents.AgentService)({}),
                Layer.mock(Work.WorkHandoffService)({}),
                Layer.mock(Schedules.ScheduledTaskService)({}),
              ),
            ),
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    ),
  );

  it.effect("a thread's executable proposal stays unstartable until approved once", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const service = yield* Integrations.Integrations;
      const workspace = yield* Workspace.AgentWorkspaceService;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:executable");
      yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${threadId}, 'project:1', 'Thread', 'codex', 'full-access', 'default', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '{}')`;
      const payload = {
        ...createInput("https://localhost", "worker"),
        transport: "stdio" as const,
        headers: {},
        command: {
          command: "fixture",
          args: ["--synthetic"],
          env: { KEY: "{{credential:fixture.value}}" },
        },
      };
      expect((yield* service.create(payload, { fromAgent: true }).pipe(Effect.flip)).reason).toBe(
        "approval_required",
      );
      const proposal = { actionKind: "integration_add" as const, payload };
      const { approval } = yield* workspace.requestThreadIntegrationApproval(threadId, proposal);
      expect(
        (yield* workspace.requestThreadIntegrationApproval(threadId, proposal)).approval.id,
      ).toBe(approval.id);
      expect((yield* workspace.listThreadApprovals(threadId)).approvals).toHaveLength(1);
      expect((yield* service.list()).integrations).toHaveLength(0);
      yield* workspace.approve(approval.id);
      yield* workspace.approve(approval.id);
      expect((yield* workspace.listThreadApprovals(threadId)).approvals).toHaveLength(0);
      const [created] = (yield* service.list()).integrations;
      expect(created?.integration.command).toEqual(payload.command);
      expect(
        (yield* service
          .update(
            { id: created!.integration.id, command: { ...payload.command, args: ["changed"] } },
            { fromAgent: true },
          )
          .pipe(Effect.flip)).reason,
      ).toBe("approval_required");
      // Direct owner edits retain their existing authority.
      yield* service.update({
        id: created!.integration.id,
        command: { ...payload.command, args: ["owner"] },
      });
    }).pipe(
      Effect.provide(
        Workspace.layer.pipe(
          Layer.provideMerge(layerWith()),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(AgentStore.AgentStore)({}),
              Layer.mock(Agents.AgentService)({}),
              Layer.mock(Work.WorkHandoffService)({}),
              Layer.mock(Schedules.ScheduledTaskService)({}),
            ),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("lists and calls tools, resolving credentials server-side only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const upstream = yield* fakeUpstream;
        const service = yield* Integrations.Integrations;
        const { integration } = yield* service.create(createInput(upstream.url));
        expect(integration.id.startsWith("integration:")).toBe(true);

        const tools = yield* service.listTools(integration.name, null);
        expect(tools.tools.map((tool) => tool.name)).toEqual(["echo"]);
        const callsAfterFirstList = upstream.seen.length;
        yield* service.listTools(integration.name, null);
        expect(upstream.seen.length).toBe(callsAfterFirstList);

        const result = yield* service.callTool(integration.name, "echo", { text: "hi" }, null);
        expect(JSON.stringify(result)).not.toContain("SECRET-VALUE-123");
        expect(JSON.stringify(result)).toContain("hi");
        expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ text: "hi" }) }]);
        expect(
          upstream.seen.some((entry) => entry.authorization === "Bearer SECRET-VALUE-123"),
        ).toBe(true);

        const listed = yield* service.list();
        expect(listed.integrations[0]?.status).toBe("connected");
        expect(listed.integrations[0]?.toolCount).toBe(1);
        expect(JSON.stringify(listed)).not.toContain("SECRET-VALUE-123");
      }).pipe(Effect.provide(layerWith())),
    ),
  );

  it.effect("completes the MCP lifecycle on the session before each request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const upstream = yield* fakeUpstream;
        const service = yield* Integrations.Integrations;
        const { integration } = yield* service.create(createInput(upstream.url));
        yield* service.callTool(integration.name, "echo", { text: "hi" }, null);
        expect(upstream.seen.map(({ method, sessionId }) => [method, sessionId])).toEqual([
          ["initialize", undefined],
          ["notifications/initialized", "session-1"],
          ["tools/call", "session-1"],
        ]);
      }).pipe(Effect.provide(layerWith())),
    ),
  );

  it.effect.each([
    'event: message\nid: 1\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n',
    ': heartbeat\r\nid: 2\r\nevent: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":1,"result":{"tools":[]}}\r\n\r\n',
  ])("accepts SSE fields before data, including multiline data (%#)", (body) =>
    Effect.gen(function* () {
      yield* runMigrations();
      const service = yield* Integrations.Integrations;
      yield* service.create(createInput("https://upstream.example/mcp"));
      expect(yield* service.listTools(IntegrationName.make("gmail"), null)).toEqual({
        name: "gmail",
        tools: [],
      });
    }).pipe(
      Effect.provide(layerWith()),
      Effect.provideService(FetchHttpClient.Fetch, async () => new Response(body)),
    ),
  );

  it.effect.each([
    { jsonrpc: "2.0", id: 1, error: null },
    { jsonrpc: "2.0", id: 1, error: "broken" },
    { jsonrpc: "2.0", id: 1 },
    { jsonrpc: "1.0", id: 1, result: { tools: [] } },
    { jsonrpc: "2.0", id: 1, result: { tools: [] }, error: { code: -1, message: "both" } },
  ])("maps malformed JSON-RPC to upstream_error (%#)", (body) =>
    Effect.gen(function* () {
      yield* runMigrations();
      const service = yield* Integrations.Integrations;
      yield* service.create(createInput("https://upstream.example/mcp"));
      const result = yield* service
        .listTools(IntegrationName.make("gmail"), null)
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.reason).toBe("upstream_error");
    }).pipe(
      Effect.provide(layerWith()),
      Effect.provideService(FetchHttpClient.Fetch, async () => new Response(JSON.stringify(body))),
    ),
  );

  it.effect("rejects an upstream body over 4 MiB", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const service = yield* Integrations.Integrations;
      yield* service.create(createInput("https://upstream.example/mcp"));
      const result = yield* service
        .listTools(IntegrationName.make("gmail"), null)
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.reason).toBe("upstream_error");
    }).pipe(
      Effect.provide(layerWith()),
      Effect.provideService(
        FetchHttpClient.Fetch,
        async () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { padding: "x".repeat(4 * 1024 * 1024), tools: [] },
            }),
          ),
      ),
    ),
  );

  it.effect("times out an upstream body that stalls after headers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const service = yield* Integrations.Integrations;
        yield* service.create(createInput("https://upstream.example/mcp"));
        const fiber = yield* service
          .listTools(IntegrationName.make("gmail"), null)
          .pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust(Duration.millis(100));
        const result = fiber.pollUnsafe();
        expect(result).toBeDefined();
        if (result !== undefined) {
          const outcome = yield* Fiber.join(fiber);
          expect(outcome._tag).toBe("Failure");
          if (outcome._tag === "Failure") expect(outcome.failure.reason).toBe("upstream_timeout");
        }
      }),
    ).pipe(
      Effect.provide(layerWith({ upstreamTimeoutMs: 50 })),
      Effect.provideService(
        FetchHttpClient.Fetch,
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"result":'));
              },
            }),
          ),
      ),
    ),
  );

  it.effect("maps upstream errors and timeouts to clear reasons", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const upstream = yield* fakeUpstream;
        const service = yield* Integrations.Integrations;
        yield* service.create(createInput(upstream.url, "errgw"));
        const failed = yield* service
          .callTool(IntegrationName.make("errgw"), "fail", {}, null)
          .pipe(Effect.result);
        expect(failed._tag).toBe("Failure");
        if (failed._tag === "Failure") {
          expect(JSON.stringify(failed.failure)).toContain("upstream_error");
        }
        // The test clock drives the gateway timeout: start the hanging call,
        // advance past the bound, then collect its failure.
        const fiber = yield* service
          .callTool(IntegrationName.make("errgw"), "hang", {}, null)
          .pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust(Duration.millis(100));
        const timedOut = yield* Fiber.join(fiber);
        expect(timedOut._tag).toBe("Failure");
        if (timedOut._tag === "Failure") {
          expect(JSON.stringify(timedOut.failure)).toContain("upstream_timeout");
        }
      }).pipe(Effect.provide(layerWith({ upstreamTimeoutMs: 50 }))),
    ),
  );

  it.effect("fails closed when a credential cannot be resolved", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const upstream = yield* fakeUpstream;
        const service = yield* Integrations.Integrations;
        yield* service.create({
          ...createInput(upstream.url, "nocred"),
          headers: { authorization: "Bearer {{credential:gmail.missing}}" },
        });
        const result = yield* service
          .listTools(IntegrationName.make("nocred"), null)
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(JSON.stringify(result.failure)).toContain("credential_unresolved");
        }
        expect(upstream.seen).toHaveLength(0);
      }).pipe(Effect.provide(layerWith())),
    ),
  );

  it.effect("masks literal header values and keeps them when an edit sends the mask back", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const service = yield* Integrations.Integrations;
      const created = yield* service.create({
        ...createInput("https://example.com/mcp"),
        headers: {
          authorization: "Bearer {{credential:gmail.apiKey}}",
          "x-api-key": "literal-secret-123",
        },
      });
      const masked = {
        authorization: "Bearer {{credential:gmail.apiKey}}",
        "x-api-key": Integrations.HEADER_MASK,
      };
      expect(created.integration.headers).toEqual(masked);
      const listed = yield* service.list();
      expect(listed.integrations[0]?.integration.headers).toEqual(masked);
      expect(JSON.stringify(listed)).not.toContain("literal-secret-123");

      const updated = yield* service.update({
        id: created.integration.id,
        headers: { ...masked, "x-extra": "visible-change" },
      });
      expect(JSON.stringify(updated)).not.toContain("literal-secret-123");
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM integrations WHERE id = ${created.integration.id}`;
      expect(JSON.parse(row!.payload_json).headers).toEqual({
        authorization: "Bearer {{credential:gmail.apiKey}}",
        "x-api-key": "literal-secret-123",
        "x-extra": "visible-change",
      });

      // A mask names no stored value under a new header name.
      const renamed = yield* service
        .update({ id: created.integration.id, headers: { "x-renamed": Integrations.HEADER_MASK } })
        .pipe(Effect.result);
      expect(renamed._tag).toBe("Failure");
    }).pipe(Effect.provide(layerWith())),
  );

  it.effect(
    "scoped mutations cannot reach hidden integrations or widen access without approval",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const service = yield* Integrations.Integrations;
        const a = ProjectLabelId.make("a"),
          b = ProjectLabelId.make("b");
        const { integration } = yield* service.create({
          ...createInput("https://example.com/mcp"),
          scope: { type: "projects", labelIds: [a] },
        });
        for (const operation of [
          service
            .update({ id: integration.id, hint: "hidden write" }, { callerLabelId: b })
            .pipe(Effect.asVoid),
          service.remove(integration.id, { callerLabelId: b }).pipe(Effect.asVoid),
        ]) {
          expect((yield* operation.pipe(Effect.flip)).reason).toBe("not_found");
        }
        for (const scope of [
          { type: "all" as const },
          { type: "projects" as const, labelIds: [a, b] },
        ]) {
          expect(
            (yield* service
              .update({ id: integration.id, scope }, { callerLabelId: a, preserveScope: true })
              .pipe(Effect.flip)).reason,
          ).toBe("approval_required");
        }
        yield* service.update(
          { id: integration.id, scope: { type: "all" } },
          { approveCredentials: true },
        );
        expect((yield* service.listForProject(b)).integrations).toHaveLength(1);
      }).pipe(Effect.provide(layerWith())),
  );

  it.effect.each(["http-error", "tool-error"])(
    "reports a brief, redacted %s in account status",
    (tool) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations();
          const upstream = yield* fakeUpstreamWith();
          const service = yield* Integrations.Integrations;
          const { integration } = yield* service.create(createInput(upstream.url));
          yield* service.callTool(integration.name, tool, {}, undefined).pipe(Effect.result);
          const summary = (yield* service.list()).integrations[0]!;
          expect(summary.status).toBe("error");
          expect(summary.message).toContain("Workspace permission denied");
          expect(summary.message).not.toContain("SECRET-VALUE-123");
          expect(summary.message!.length).toBeLessThan(600);
        }),
      ).pipe(Effect.provide(layerWith())),
  );

  it.effect.each([
    { auth: { type: "oauth" as const }, headers: {} },
    { headers: { "X-Auth-Token": "{{credential:gmail.apiKey}}" } },
    { headers: { authorization: "Bearer literal-secret" } },
  ])("rejects plaintext remote OAuth and credential headers (%#)", (credentials) =>
    Effect.gen(function* () {
      yield* runMigrations();
      const service = yield* Integrations.Integrations;
      const result = yield* service
        .create({ ...createInput("http://example.com/mcp"), ...credentials })
        .pipe(Effect.result);
      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "invalid_request" } });
    }).pipe(Effect.provide(layerWith())),
  );

  it.effect("requires approval for account-label changes by thread agents", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const service = yield* Integrations.Integrations;
      const { integration } = yield* service.create({
        ...createInput("https://example.com/mcp"),
        headers: {},
        accountLabel: "Owner",
      });
      expect(
        yield* service
          .update({ id: integration.id, accountLabel: "Attacker" }, { holdStoredSecrets: true })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "approval_required" } });
      expect(
        (yield* service.update(
          { id: integration.id, accountLabel: "Owner" },
          { holdStoredSecrets: true },
        )).integration.accountLabel,
      ).toBe("Owner");
      expect(
        (yield* service.update(
          { id: integration.id, accountLabel: "Work" },
          { approveCredentials: true },
        )).integration.accountLabel,
      ).toBe("Work");
    }).pipe(Effect.provide(layerWith())),
  );

  it.effect("never records custom credential headers in HTTP spans", () => {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    return Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const upstream = yield* fakeUpstream;
        const service = yield* Integrations.Integrations;
        const { integration } = yield* service.create({
          ...createInput(upstream.url),
          headers: { "X-Auth-Token": "{{credential:gmail.apiKey}}" },
        });
        yield* service.listTools(integration.name, null).pipe(
          Effect.withSpan("integration-test"),
          Effect.withTracer(tracer),
          Effect.provideService(HttpClient.TracerHeaderFilter, () => true),
        );
        const http = spans.filter((span) => span.attributes.has("http.request.method"));
        expect(http.length).toBeGreaterThanOrEqual(3);
        expect(JSON.stringify(http.map((span) => [...span.attributes]))).not.toContain(
          "SECRET-VALUE-123",
        );
      }),
    ).pipe(Effect.provide(layerWith()));
  });

  it.effect("records agent provenance without accepting it from the integration payload", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const service = yield* Integrations.Integrations;
      const { integration } = yield* service.create(
        { ...createInput("https://example.com/mcp"), headers: {} },
        { addedByAgent: { id: "agent:test", name: "Research" } },
      );
      expect(integration.provenance?.addedByAgent).toEqual({ id: "agent:test", name: "Research" });
      expect((yield* service.list()).integrations[0]?.integration.provenance).toEqual(
        integration.provenance,
      );
    }).pipe(Effect.provide(layerWith())),
  );

  it.effect("gives additional unlabeled accounts a distinguishing default label", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const service = yield* Integrations.Integrations;
      const first = yield* service.create({
        ...createInput("https://mcp.linear.app/mcp", "linear"),
        headers: {},
        displayName: "Linear",
      });
      const second = yield* service.create({
        ...createInput("https://mcp.linear.app/mcp", "linear-2"),
        headers: {},
        displayName: "Linear",
      });
      const third = yield* service.create({
        ...createInput("https://mcp.linear.app/mcp", "linear-3"),
        headers: {},
        displayName: "Linear",
      });
      expect(first.integration.accountLabel).toBeUndefined();
      expect(second.integration.accountLabel).toBe("#2");
      expect(third.integration.accountLabel).toBe("#3");
      expect(Integrations.integrationTitle(second.integration)).toBe("Linear · #2");
    }).pipe(Effect.provide(layerWith())),
  );

  it.effect("context reports account health and reserves disabled catalog services", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const upstream = yield* fakeUpstreamWith();
        const service = yield* Integrations.Integrations;
        const working = yield* service.create({
          ...createInput(upstream.url, "working"),
          headers: {},
        });
        const broken = yield* service.create({
          ...createInput(upstream.url, "broken"),
          headers: {},
        });
        yield* service.create({
          ...createInput(upstream.url, "sign-in"),
          headers: {},
          auth: { type: "oauth" },
        });
        yield* service.create({
          ...createInput("https://mcp.notion.com/mcp", "notion"),
          headers: {},
          enabled: false,
        });
        yield* service.testConnection(working.integration.id);
        yield* service.callTool(broken.integration.name, "fail", {}, undefined).pipe(Effect.result);
        const context = yield* service.contextIntegrations(null);
        expect(context.map((entry) => [entry.name, entry.status])).toEqual([
          ["broken", "error"],
          ["notion", "disabled"],
          ["sign-in", "needs_sign_in"],
          ["working", "connected"],
        ]);
        expect(availableToConnect(context)).not.toContain("notion");
      }),
    ).pipe(Effect.provide(layerWith())),
  );

  it.effect("filters by project scope and tombstones on remove", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const service = yield* Integrations.Integrations;
      const labelA = ProjectLabelId.make("label:a");
      const labelB = ProjectLabelId.make("label:b");
      const scoped = yield* service.create({
        ...createInput("https://example.com/mcp", "scoped"),
        headers: {},
        scope: { type: "projects", labelIds: [labelA] },
      });
      yield* service.create({
        ...createInput("https://example.com/mcp", "everywhere"),
        headers: {},
      });

      const forA = yield* service.contextIntegrations(labelA);
      const forB = yield* service.contextIntegrations(labelB);
      const forNone = yield* service.contextIntegrations(null);
      expect(forA.map((i) => i.name).sort()).toEqual(["everywhere", "scoped"]);
      expect(forB.map((i) => i.name)).toEqual(["everywhere"]);
      expect(forNone.map((i) => i.name)).toEqual(["everywhere"]);

      const hidden = yield* service
        .listTools(IntegrationName.make("scoped"), labelB)
        .pipe(Effect.result);
      expect(hidden._tag).toBe("Failure");

      expect(yield* service.remove(scoped.integration.id)).toEqual({ deleted: true });
      expect(yield* service.remove(scoped.integration.id)).toEqual({ deleted: false });
      const after = yield* service.list();
      expect(after.integrations.map((s) => s.integration.name)).toEqual(["everywhere"]);
      // The tombstoned name is reusable.
      yield* service.create({
        ...createInput("https://example.com/mcp", "scoped"),
        headers: {},
        scope: { type: "projects", labelIds: [labelA] },
      });
      const sql = yield* SqlClient.SqlClient;
      const tombstones = yield* sql<{
        n: number;
      }>`SELECT COUNT(*) AS n FROM integrations WHERE deleted_at IS NOT NULL`;
      expect(tombstones[0]?.n).toBe(1);
    }).pipe(Effect.provide(layerWith())),
  );
});

/** The gateway over the real vault, so credential destinations are checked as in production. */
const vaultLayer = () => {
  const stored = new Map<string, Uint8Array>();
  return Integrations.layer.pipe(
    Layer.provide(Layer.succeed(IntegrationEndpointPolicy, loopbackHttpsPolicy)),
    Layer.provide(Credentials.layer),
    Layer.provide(Tokens.layer),
    Layer.provideMerge(Vault.layer),
    Layer.provide(
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) => Effect.succeed(Option.fromUndefinedOr(stored.get(name))),
        create: (name, value) => Effect.sync(() => void stored.set(name, value)),
      }),
    ),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("env:test")),
      }),
    ),
    Layer.provideMerge(database),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(NodeServices.layer),
  );
};

describe("Default catalog", () => {
  const owner = { approveCredentials: true, origin: { origin: undefined } };

  it.effect("connects a remote entry once per account and approves its vault key", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const service = yield* Integrations.Integrations;
      const request = {
        catalogId: "linear" as const,
        inputs: { apiKey: "{{credential:linear-key.value}}" },
      };
      const first = yield* service.connectFromCatalog(request, owner);
      expect(first.signIn).toBeUndefined();
      expect(first.integration).toMatchObject({
        name: "linear",
        displayName: "Linear",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer {{credential:linear-key.value}}" },
        approvedCredentialItems: ["linear-key"],
      });
      const second = yield* service.connectFromCatalog(
        { ...request, accountLabel: "Personal" },
        owner,
      );
      expect(second.integration).toMatchObject({
        name: "linear-personal",
        accountLabel: "Personal",
      });
      expect((yield* service.list()).integrations.map((item) => item.integration.name)).toEqual([
        "linear",
        "linear-personal",
      ]);
    }).pipe(Effect.provide(layerWith())),
  );

  it.effect("returns the setup step, and creates nothing, while a key or app is missing", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const service = yield* Integrations.Integrations;
      const github = yield* service.connectFromCatalog({ catalogId: "github" }, owner);
      expect(github).toEqual({
        setup: expect.objectContaining({
          type: "api_key",
          catalogId: "github",
          label: "Personal access token",
          url: "https://github.com/settings/personal-access-tokens/new",
        }),
      });
      const slack = yield* service.connectFromCatalog(
        { catalogId: "slack", accountLabel: "Acme" },
        { ...owner, origin: { origin: "https://cogenly.example.com" } },
      );
      expect(slack.setup?.type).toBe("oauth_client");
      const manifest =
        slack.setup?.type === "oauth_client" ? slack.setup.steps[0]?.copy?.value : undefined;
      expect(manifest).toContain("https://cogenly.example.com/oauth/integrations/callback");
      // Any other missing input is still the caller's to fix.
      const unlabeled = yield* service
        .connectFromCatalog({ catalogId: "google-workspace" }, owner)
        .pipe(Effect.flip);
      expect(unlabeled).toMatchObject({ reason: "invalid_request" });
      expect((yield* service.list()).integrations).toHaveLength(0);
    }).pipe(Effect.provide(layerWith())),
  );
});

/** Every request leaves the test process only for loopback fixtures, or for `routes`. */
const routedPolicy =
  (routes: Record<string, { target: string }>): typeof loopbackHttpsPolicy =>
  (raw) => {
    const route = routes[new URL(raw).origin];
    if (route !== undefined)
      return Effect.succeed(((_input, init) =>
        loopbackHttpsFetch(route.target, init)) satisfies typeof globalThis.fetch);
    return loopbackHttpsPolicy(raw).pipe(
      Effect.map(
        (fetch) =>
          fetch ??
          ((() => Promise.reject(new Error("offline in tests"))) satisfies typeof globalThis.fetch),
      ),
    );
  };

describe("Services the catalog dropped", () => {
  const atlassian = { target: "" };

  it.effect("keep working as custom integrations, with no catalog entry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const upstream = yield* fakeUpstream;
        atlassian.target = upstream.url;
        const sql = yield* SqlClient.SqlClient;
        const service = yield* Integrations.Integrations;
        // Exactly what connecting the old Atlassian entry stored.
        const stored = {
          id: IntegrationId.make("integration:atlassian-1"),
          name: IntegrationName.make("atlassian"),
          displayName: "Atlassian",
          transport: "http",
          url: "https://mcp.atlassian.com/v1/mcp",
          headers: { Authorization: "Bearer {{credential:gmail.apiKey}}" },
          credentialOrigin: "https://mcp.atlassian.com",
          approvedCredentialItems: ["gmail"],
          enabled: true,
          scope: { type: "all" },
          hint: "",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
          deletedAt: null,
        };
        yield* sql`INSERT INTO integrations(id, name, payload_json, deleted_at, updated_at) VALUES (${stored.id}, ${stored.name}, ${JSON.stringify(stored)}, NULL, ${stored.updatedAt})`;

        const [summary] = (yield* service.list()).integrations;
        expect(summary?.integration).toMatchObject({ name: "atlassian", displayName: "Atlassian" });
        expect(integrationCatalogEntryFor(summary!.integration)).toBeUndefined();
        const result = yield* service.callTool(stored.name, "echo", { text: "hi" }, null);
        expect(result.content).toEqual([{ type: "text", text: '{"text":"hi"}' }]);
        expect(upstream.seen.at(-1)?.authorization).toBe("Bearer SECRET-VALUE-123");
        // It is listed as a source, with no catalog icon.
        const [sources] = yield* service.subscribeSources().pipe(Stream.take(1), Stream.runCollect);
        expect(sources?.sources).toEqual([
          {
            id: "integration:atlassian-1",
            name: "atlassian",
            displayName: "Atlassian",
            icon: null,
            serviceName: "Atlassian",
            accountLabel: null,
            status: "connected",
            scope: { type: "all" },
          },
        ]);
      }),
    ).pipe(Effect.provide(layerWith({}, routedPolicy({ "https://mcp.atlassian.com": atlassian })))),
  );
});

describe("Settings secret forms", () => {
  const offline = layerWith({}, routedPolicy({}));
  const nowhere = { origin: { origin: "https://cogenly.example.com" } };

  it.effect("store an API key in the vault and reference it, per account", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      savedSecrets.length = 0;
      const service = yield* Integrations.Integrations;
      const first = yield* service.saveApiKey(
        { catalogId: "linear", apiKey: "lin_api_FIRST-SECRET" },
        nowhere,
      );
      const second = yield* service.saveApiKey(
        { catalogId: "linear", accountLabel: "Work", apiKey: "lin_api_SECOND-SECRET" },
        nowhere,
      );
      expect(first.integration).toMatchObject({
        name: "linear",
        headers: { Authorization: "Bearer {{credential:linear-api-key.value}}" },
        approvedCredentialItems: ["linear-api-key"],
      });
      expect(second.integration).toMatchObject({
        name: "linear-work",
        accountLabel: "Work",
        headers: { Authorization: "Bearer {{credential:linear-work-api-key.value}}" },
      });
      expect(savedSecrets).toEqual([
        expect.objectContaining({
          item: "linear-api-key",
          type: "api_key",
          domains: ["mcp.linear.app"],
        }),
        expect.objectContaining({ item: "linear-work-api-key", domains: ["mcp.linear.app"] }),
      ]);
      // The values live only in the vault.
      const visible = JSON.stringify([first, second, yield* service.list()]);
      expect(visible).not.toContain("FIRST-SECRET");
      expect(visible).not.toContain("SECOND-SECRET");

      // Saving again for an existing account rewires that account only.
      const again = yield* service.saveApiKey(
        { catalogId: "linear", integrationId: first.integration!.id, apiKey: "lin_api_NEW" },
        nowhere,
      );
      expect(again.integration?.name).toBe("linear");
      expect(savedSecrets.at(-1)?.item).toBe("linear-api-key");
      // A form for one service cannot rewrite another's account.
      expect(
        yield* service
          .saveApiKey(
            { catalogId: "github", integrationId: first.integration!.id, apiKey: "x" },
            nowhere,
          )
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid_request" });
    }).pipe(Effect.provide(offline)),
  );

  it.effect(
    "save a custom server's manual OAuth client privately without replacing its account",
    () =>
      Effect.gen(function* () {
        savedSecrets.length = 0;
        const service = yield* Integrations.Integrations;
        const { integration } = yield* service.create({
          ...createInput("https://mcp.custom.test/mcp", "custom-work"),
          headers: {},
          auth: { type: "oauth", scope: "read" },
        });
        const result = yield* service.saveOAuthClient(
          {
            integrationId: integration.id,
            clientId: "custom-client",
            clientSecret: "custom-PRIVATE-SECRET",
          },
          nowhere,
        );
        expect(result.integration).toMatchObject({
          id: integration.id,
          name: "custom-work",
          auth: {
            type: "oauth",
            scope: "read",
            clientId: "custom-client",
            clientSecret: "{{credential:custom-work-client-secret.value}}",
          },
          approvedCredentialItems: ["custom-work-client-secret"],
        });
        expect(savedSecrets).toEqual([
          expect.objectContaining({
            item: "custom-work-client-secret",
            fields: { value: "custom-PRIVATE-SECRET" },
            domains: ["mcp.custom.test"],
          }),
        ]);
        expect(result.setup).toMatchObject({ type: "retry", button: "sign_in" });
        const listed = yield* service.list();
        expect(listed.integrations).toHaveLength(1);
        expect(JSON.stringify([result, listed])).not.toContain("custom-PRIVATE-SECRET");

        const { integration: plain } = yield* service.create(
          createInput("https://plain.custom.test/mcp", "plain"),
        );
        expect(
          yield* service
            .saveOAuthClient(
              { integrationId: plain.id, clientId: "id", clientSecret: "secret" },
              nowhere,
            )
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "invalid_request" });
        expect(savedSecrets).toHaveLength(1);
      }).pipe(Effect.provide(offline)),
  );

  it.effect("store an app's client secret and point the account's sign-in at it", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      savedSecrets.length = 0;
      const service = yield* Integrations.Integrations;
      const result = yield* service.saveOAuthClient(
        {
          catalogId: "slack",
          accountLabel: "Acme",
          clientId: "123.456",
          clientSecret: "slack-CLIENT-SECRET",
        },
        nowhere,
      );
      expect(result.integration).toMatchObject({
        name: "slack-acme",
        auth: {
          type: "oauth",
          clientId: "123.456",
          clientSecret: "{{credential:slack-acme-client-secret.value}}",
          scope: SLACK_MCP_USER_SCOPES.join(" "),
        },
      });
      expect(savedSecrets).toEqual([
        expect.objectContaining({
          item: "slack-acme-client-secret",
          domains: ["slack.com"],
          fields: { value: "slack-CLIENT-SECRET" },
        }),
      ]);
      // Slack is unreachable here, so the account is saved with the step that retries sign-in.
      expect(result.setup).toMatchObject({ type: "retry", button: "sign_in" });
      expect(JSON.stringify([result, yield* service.list()])).not.toContain("slack-CLIENT-SECRET");

      // Google's client is one shared item, in the preset's login shape.
      yield* service.saveOAuthClient(
        {
          catalogId: "google-workspace",
          clientId: "google-id.apps.googleusercontent.com",
          clientSecret: "GOCSPX-secret",
        },
        nowhere,
      );
      expect(savedSecrets.at(-1)).toEqual({
        item: "google-oauth-client",
        type: "login",
        fields: { username: "google-id.apps.googleusercontent.com", password: "GOCSPX-secret" },
        domains: ["accounts.google.com"],
        label: "Google OAuth client",
      });
    }).pipe(Effect.provide(offline)),
  );
});

describe("integrationSource", () => {
  const base = {
    id: IntegrationId.make("integration:1"),
    name: IntegrationName.make("google-work"),
    displayName: "Google",
    transport: "local" as const,
    local: { preset: "google-workspace" as const, version: "2.1.2", callbackOrigin: "x" },
    url: "https://accounts.google.com",
    headers: { Authorization: "Bearer {{credential:never-shown.value}}" },
    enabled: true,
    scope: { type: "projects" as const, labelIds: [ProjectLabelId.make("label:1")] },
    hint: "",
    accountLabel: "work",
    createdAt: "2026-10-01T00:00:00.000Z" as Integration["createdAt"],
    updatedAt: "2026-10-01T00:00:00.000Z" as Integration["updatedAt"],
    deletedAt: null,
  };

  it("names the service and account, and reads anything unusable as sign-in or error", () => {
    expect(
      Integrations.integrationSource({
        integration: base,
        status: "needs_sign_in",
        toolCount: null,
        syncedFrom: { machineLabel: "Studio Mac" },
      }),
    ).toEqual({
      id: "integration:1",
      name: "google-work",
      displayName: "Google",
      icon: "google-workspace",
      serviceName: "Google Workspace",
      accountLabel: "work",
      status: "needs_sign_in",
      scope: base.scope,
      syncedFrom: { machineLabel: "Studio Mac" },
    });
    expect(
      Integrations.integrationSource({
        integration: base,
        status: "disconnected",
        toolCount: null,
        message: "The server could not be reached.",
      }),
    ).toMatchObject({ status: "error", message: "The server could not be reached." });
    expect(
      Integrations.integrationSource({ integration: base, status: "unknown", toolCount: null }),
    ).not.toHaveProperty("message");
  });
});

describe("Integration credential destinations", () => {
  const tokenHeaders = { authorization: "Bearer {{credential:github.value}}" };
  const reasonOf = (exit: { readonly _tag: string; readonly failure?: unknown }) =>
    exit._tag === "Failure" ? (exit.failure as { readonly reason?: string }).reason : "success";

  it.effect(
    "resolves private endpoints only at call time and keeps them off settings and spans",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations();
          const upstream = yield* fakeUpstream;
          const vault = yield* Vault.Vault;
          const service = yield* Integrations.Integrations;
          const spans: Array<Tracer.NativeSpan> = [];
          const tracer = Tracer.make({
            span(options) {
              const span = new Tracer.NativeSpan(options);
              spans.push(span);
              return span;
            },
          });
          const { integration } = yield* service.create({
            ...createInput(new URL(upstream.url).origin),
            headers: {},
            endpointRef: "private-endpoint.value",
          });
          expect(
            (yield* service.callTool(integration.name, "echo", {}, null).pipe(Effect.flip)).reason,
          ).toBe("credential_unresolved");
          expect(upstream.seen).toHaveLength(0);
          const privatePath = "/mcp/fixture-private-capability-6YpA92x";
          yield* vault.create({
            name: "private-endpoint",
            type: "api_key",
            allowedDomains: ["127.0.0.1"],
            secretFields: { value: new URL(privatePath, upstream.url).href },
          });
          yield* service
            .callTool(integration.name, "echo", {}, null)
            .pipe(Effect.withSpan("private-endpoint-test"), Effect.withTracer(tracer));
          expect(upstream.seen.at(-1)?.path).toBe(privatePath);
          expect(JSON.stringify(yield* service.list())).not.toContain(privatePath);
          expect(JSON.stringify(spans.map((span) => [...span.attributes]))).not.toContain(
            privatePath,
          );
          const calls = upstream.seen.length;
          yield* service.update({ id: integration.id, url: "https://other.example" });
          expect(
            (yield* service.callTool(integration.name, "echo", {}, null).pipe(Effect.flip)).reason,
          ).toBe("credential_not_allowed");
          expect(upstream.seen).toHaveLength(calls);
        }),
      ).pipe(Effect.provide(vaultLayer())),
  );

  it.effect(
    "keeps project-scoped vault credentials inside that project, including cached tools",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations();
          const upstream = yield* fakeUpstream;
          const vault = yield* Vault.Vault,
            service = yield* Integrations.Integrations;
          const a = ProjectLabelId.make("project:a"),
            b = ProjectLabelId.make("project:b");
          yield* vault.create({
            name: "github",
            type: "api_key",
            scopeProjectId: a,
            allowedDomains: ["127.0.0.1"],
            secretFields: { value: "scoped-credential" },
          });
          const { integration } = yield* service.create({
            ...createInput(upstream.url),
            headers: tokenHeaders,
          });
          expect((yield* service.listTools(IntegrationName.make("gmail"), a)).tools).toHaveLength(
            1,
          );
          const calls = upstream.seen.length;
          for (const scope of [b, null]) {
            expect(yield* service.testConnection(integration.id, scope)).toMatchObject({
              status: "disconnected",
              reason: "credential_unresolved",
            });
            for (const operation of [
              service.listTools(IntegrationName.make("gmail"), scope).pipe(Effect.asVoid),
              service
                .callTool(IntegrationName.make("gmail"), "echo", {}, scope)
                .pipe(Effect.asVoid),
            ])
              expect((yield* operation.pipe(Effect.flip)).reason).toBe("credential_unresolved");
          }
          expect(upstream.seen).toHaveLength(calls);
        }),
      ).pipe(Effect.provide(vaultLayer())),
  );

  it.effect("refuses a vault item whose domains do not include the integration's host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const upstream = yield* fakeUpstream;
        const vault = yield* Vault.Vault;
        const service = yield* Integrations.Integrations;
        yield* vault.create({
          name: "github",
          type: "api_key",
          allowedDomains: ["github.com"],
          secretFields: { value: "github-token-123" },
        });
        const { integration } = yield* service.create({
          ...createInput(upstream.url),
          headers: tokenHeaders,
        });
        const call = yield* service
          .callTool(integration.name, "echo", {}, null)
          .pipe(Effect.result);
        expect(reasonOf(call)).toBe("credential_not_allowed");
        expect(upstream.seen).toHaveLength(0);
      }).pipe(Effect.provide(vaultLayer())),
    ),
  );

  it.effect("sends a vault item whose domains include the integration's host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const upstream = yield* fakeUpstream;
        const vault = yield* Vault.Vault;
        const service = yield* Integrations.Integrations;
        yield* vault.create({
          name: "github",
          type: "api_key",
          allowedDomains: ["127.0.0.1"],
          secretFields: { value: "github-token-123" },
        });
        const { integration } = yield* service.create({
          ...createInput(upstream.url),
          headers: tokenHeaders,
        });
        yield* service.callTool(integration.name, "echo", {}, null);
        expect(upstream.seen.at(-1)?.authorization).toBe("Bearer github-token-123");
      }).pipe(Effect.provide(vaultLayer())),
    ),
  );

  it.effect("sends an owner-approved item until the integration's URL changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const upstream = yield* fakeUpstream;
        const other = yield* fakeUpstream;
        const vault = yield* Vault.Vault;
        const service = yield* Integrations.Integrations;
        yield* vault.create({
          name: "github",
          type: "api_key",
          secretFields: { value: "github-token-123" },
        });
        const { integration } = yield* service.create(
          { ...createInput(upstream.url), headers: tokenHeaders },
          { approveCredentials: true },
        );
        yield* service.callTool(integration.name, "echo", {}, null);
        expect(upstream.seen.at(-1)?.authorization).toBe("Bearer github-token-123");

        yield* service.update({ id: integration.id, url: other.url });
        const moved = yield* service
          .callTool(integration.name, "echo", {}, null)
          .pipe(Effect.result);
        expect(reasonOf(moved)).toBe("credential_not_allowed");
        expect(other.seen).toHaveLength(0);

        yield* service.update({ id: integration.id, url: other.url }, { approveCredentials: true });
        yield* service.callTool(integration.name, "echo", {}, null);
        expect(other.seen.at(-1)?.authorization).toBe("Bearer github-token-123");
      }).pipe(Effect.provide(vaultLayer())),
    ),
  );
});

it.effect(
  "verification reports missing scopes separately from authentication and reachability",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const upstream = yield* fakeUpstreamWith(undefined, true);
      const gateway = yield* Integrations.Integrations;
      const { integration } = yield* gateway.create(createInput(upstream.url));
      expect(yield* gateway.testConnection(integration.id)).toMatchObject({
        status: "disconnected",
        reason: "scope_missing",
        toolCount: 0,
      });
      expect((yield* gateway.list()).integrations[0]?.message).toContain(
        "missing a required scope",
      );
    }).pipe(Effect.scoped, Effect.provide(layerWith())),
);
