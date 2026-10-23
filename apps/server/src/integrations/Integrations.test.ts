import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, IntegrationName, ProjectLabelId } from "@t3tools/contracts";
import { NodeCrypto } from "@effect/platform-node";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The fake upstream is a plain node:http server; Effect has no test HTTP server for this.
import * as NodeHttp from "node:http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Vault from "../vault/Vault.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Credentials from "./IntegrationCredentials.ts";
import * as Integrations from "./Integrations.ts";
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
  readonly seen: Array<{ method: string; authorization: string | undefined }>;
  readonly close: () => Effect.Effect<void>;
}

/** A real in-process HTTP MCP server speaking streamable-HTTP JSON-RPC. */
const fakeUpstreamWith = (redirectTo?: string) =>
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
            authorization: request.headers.authorization,
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
                url: `http://127.0.0.1:${port}/mcp`,
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

const layerWith = (options: Integrations.IntegrationsOptions = {}) =>
  Integrations.layerWith(options).pipe(
    Layer.provide(credentialsLayer),
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
    Layer.provide(Credentials.layer),
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

describe("Integration credential destinations", () => {
  const tokenHeaders = { authorization: "Bearer {{credential:github.value}}" };
  const reasonOf = (exit: { readonly _tag: string; readonly failure?: unknown }) =>
    exit._tag === "Failure" ? (exit.failure as { readonly reason?: string }).reason : "success";

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
