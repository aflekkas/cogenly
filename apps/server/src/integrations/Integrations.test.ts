import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { IntegrationName, ProjectLabelId } from "@t3tools/contracts";
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

import * as Sqlite from "../persistence/Sqlite.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Credentials from "./IntegrationCredentials.ts";
import * as Integrations from "./Integrations.ts";

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
const fakeUpstream = Effect.acquireRelease(
  Effect.sync(() => {
    const seen: FakeUpstream["seen"] = [];
    const server: NodeHttp.Server = NodeHttp.createServer((request, response) => {
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
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
