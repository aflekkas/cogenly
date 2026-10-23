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

let trickleStarted: (() => void) | undefined;

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
          } else if (body.method === "tools/call" && body.params?.name === "huge") {
            reply({ jsonrpc: "2.0", id: body.id, result: { text: "x".repeat(4096) } });
          } else if (body.method === "tools/call" && body.params?.name === "huge-chunked") {
            // No content-length: only counting the streamed bytes catches it.
            response.writeHead(200, { "content-type": "application/json" });
            for (let chunk = 0; chunk < 4; chunk += 1) response.write(" ".repeat(1024));
            response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }));
          } else if (body.method === "tools/call" && body.params?.name === "trickle") {
            // Headers and a first byte, then nothing: the body read must time out.
            response.writeHead(200, { "content-type": "application/json" });
            response.write("{", () => trickleStarted?.());
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

describe("parseRpcBody", () => {
  it("reads JSON-RPC from SSE events whatever order their fields come in", () => {
    const result = { jsonrpc: "2.0", id: 1, result: { tools: [] } };
    for (const body of [
      `data: ${JSON.stringify(result)}\n\n`,
      `event: message\nid: 7\ndata: ${JSON.stringify(result)}\n\n`,
      `: keep-alive\r\nevent: message\r\ndata: ${JSON.stringify(result)}\r\n\r\n`,
      `event: message\ndata: {"jsonrpc":"2.0","id":1,\ndata: "result":{"tools":[]}}\n\n`,
    ]) {
      expect(Integrations.parseRpcBody(body)).toMatchObject({ result: result.result });
    }
  });

  it("treats a malformed envelope as no reply instead of failing on it", () => {
    for (const body of [
      `{"jsonrpc":"2.0","id":1,"error":null}`,
      `{"jsonrpc":"2.0","id":1,"error":"boom"}`,
      `[1, 2]`,
      `data: null\n\n`,
    ]) {
      expect(Integrations.parseRpcBody(body)).toBeUndefined();
    }
  });
});

describe("resolveHeaderTemplates", () => {
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

  it.effect("inserts a credential literally, even with replacement patterns in it", () =>
    Effect.gen(function* () {
      const literal = new Map([
        ["a.value", "pa$&ss$'$`$1"],
        ["b.value", "{{credential:a.value}}"],
      ]);
      const resolved = yield* Integrations.resolveHeaderTemplates(
        { authorization: "Bearer {{credential:a.value}}", other: "{{credential:b.value}}" },
        (ref) => Effect.succeed(Option.fromNullishOr(literal.get(ref))),
      );
      expect(resolved).toEqual({
        authorization: "Bearer pa$&ss$'$`$1",
        other: "{{credential:a.value}}",
      });
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

  it.effect("refuses oversized replies and times out a body that stalls", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const upstream = yield* fakeUpstream;
        const service = yield* Integrations.Integrations;
        yield* service.create(createInput(upstream.url, "biggw"));
        for (const tool of ["huge", "huge-chunked"]) {
          const failed = yield* service
            .callTool(IntegrationName.make("biggw"), tool, {}, null)
            .pipe(Effect.result);
          expect(failed._tag).toBe("Failure");
          if (failed._tag === "Failure")
            expect(JSON.stringify(failed.failure)).toContain("upstream_error");
        }
        const started = new Promise<void>((resolve) => (trickleStarted = resolve));
        const fiber = yield* service
          .callTool(IntegrationName.make("biggw"), "trickle", {}, null)
          .pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() => started);
        yield* TestClock.adjust(Duration.millis(100));
        const timedOut = yield* Fiber.join(fiber);
        expect(timedOut._tag).toBe("Failure");
        if (timedOut._tag === "Failure")
          expect(JSON.stringify(timedOut.failure)).toContain("upstream_timeout");
      }).pipe(Effect.provide(layerWith({ upstreamTimeoutMs: 50, maxUpstreamBodyBytes: 2048 }))),
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
