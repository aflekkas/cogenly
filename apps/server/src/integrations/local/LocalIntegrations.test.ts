import { describe, expect, it } from "@effect/vitest";
import { NodeCrypto } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { IntegrationName } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import * as ServerConfig from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as Credentials from "../IntegrationCredentials.ts";
import * as Integrations from "../Integrations.ts";
import * as Local from "./LocalIntegrations.ts";
import * as Runner from "./LocalMcpRunner.ts";
import { GOOGLE_CALLBACK_PATH, GOOGLE_WORKSPACE_VERSION } from "./GoogleWorkspace.ts";

const fixture = new URL("./fixtures/fake-mcp.mjs", import.meta.url).pathname;
const credentials = (missing = false) =>
  Layer.succeed(Credentials.IntegrationCredentials, {
    resolve: (ref) =>
      Effect.succeed(
        missing
          ? Option.none<string>()
          : Option.some(ref.endsWith("username") ? "fake-client-id" : "fake-client-secret"),
      ),
  });
const testLayer = (specs: Array<Runner.LocalMcpSpec>, missing = false) => {
  // Replace the external package at the process boundary; exercise the real supervisor and gateway.
  const runner = Layer.effect(
    Runner.LocalMcpRunner,
    Effect.gen(function* () {
      const actual = yield* Runner.LocalMcpRunner;
      return Runner.LocalMcpRunner.of({
        ...actual,
        start: (spec) => {
          specs.push(spec);
          return actual.start({
            ...spec,
            runtime: process.execPath,
            args: [fixture],
            env: {
              ...spec.env,
              FIXTURE_TRANSPORT: "http",
              FIXTURE_PORT: String(spec.port),
              FIXTURE_SECRET: "fake-client-secret",
            },
          });
        },
      });
    }),
  ).pipe(Layer.provide(Runner.layerWith({ restartDelayMs: 10, requestTimeoutMs: 2000 })));
  const infrastructure = Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    FetchHttpClient.layer,
    credentials(missing),
    Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer)),
    ServerConfig.layerTest(process.cwd(), { prefix: "local-integrations-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  );
  const local = Local.layer.pipe(Layer.provide(runner), Layer.provideMerge(infrastructure));
  return Integrations.layer.pipe(Layer.provideMerge(local));
};
const echoResult = Schema.decodeUnknownSync(
  Schema.Struct({
    content: Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })) }),
  }),
);

describe("managed Google integrations", () => {
  it.live(
    "isolates two accounts and routes tools, sign-in, disable and remove through the gateway",
    () => {
      const specs: Array<Runner.LocalMcpSpec> = [];
      return Effect.gen(function* () {
        yield* runMigrations();
        const gateway = yield* Integrations.Integrations;
        const local = yield* Local.LocalIntegrations;
        const fs = yield* FileSystem.FileSystem;
        const personal = yield* gateway.create({
          preset: "google-workspace",
          accountLabel: "personal",
          callbackOrigin: "https://cogenly.example.com",
        });
        const work = yield* gateway.create({
          preset: "google-workspace",
          accountLabel: "Spawn Partners",
          callbackOrigin: "https://cogenly.example.com",
        });
        expect(personal.integration.displayName).toBe("Google · personal");
        expect(work.integration.local?.version).toBe(GOOGLE_WORKSPACE_VERSION);
        expect(specs).toHaveLength(2);
        expect(specs[0]?.directory).not.toBe(specs[1]?.directory);
        expect(specs[0]?.port).not.toBe(specs[1]?.port);
        expect(specs[0]?.env.WORKSPACE_MCP_CREDENTIALS_DIR).not.toBe(
          specs[1]?.env.WORKSPACE_MCP_CREDENTIALS_DIR,
        );
        expect(specs[0]?.args).toEqual([
          `workspace-mcp@${GOOGLE_WORKSPACE_VERSION}`,
          "--transport",
          "streamable-http",
          "--single-user",
          "--tool-tier",
          "complete",
          "--tools",
          "gmail",
          "calendar",
          "drive",
          "docs",
          "sheets",
        ]);
        expect(JSON.stringify(specs[0]?.args)).not.toContain("fake-client");
        expect(specs[0]?.env.GOOGLE_OAUTH_REDIRECT_URI).toBe(
          `https://cogenly.example.com${GOOGLE_CALLBACK_PATH}`,
        );
        expect((yield* fs.stat(specs[0]!.directory)).mode & 0o777).toBe(0o700);
        expect((yield* fs.stat(specs[0]!.env.WORKSPACE_MCP_CREDENTIALS_DIR!)).mode & 0o777).toBe(
          0o700,
        );
        expect(
          (yield* gateway.listTools(personal.integration.name, undefined)).tools[0]?.name,
        ).toBe("echo");
        const response = yield* gateway.callTool(
          work.integration.name,
          "echo",
          { text: "account routing" },
          undefined,
        );
        expect(echoResult(response).content.content[0]?.text).toContain("account routing");
        const listed = yield* gateway.list();
        expect(listed.integrations.every((item) => item.managed?.state === "running")).toBe(true);
        const ticket = new URL(personal.signInUrl!).searchParams.get("ticket")!;
        const auth = yield* local.authorize(ticket);
        expect(auth.connected).toBe(false);
        expect(new URL(auth.url!).hostname).toBe("accounts.google.com");
        // Reopening the link reuses the outstanding consent flow rather than minting another refresh token.
        expect((yield* local.authorize(ticket)).url).toBe(auth.url);
        expect(yield* local.callback("state=unknown&code=fake")).toBe(false);
        const state = new URL(auth.url!).searchParams.get("state")!;
        expect(
          yield* local.callback(new URLSearchParams({ state, code: "fake-code" }).toString()),
        ).toBe(true);
        expect(
          yield* local.callback(new URLSearchParams({ state, code: "fake-code" }).toString()),
        ).toBe(false);
        expect((yield* local.authorize(ticket)).connected).toBe(true);
        expect(yield* local.signInLink(personal.integration)).toBeUndefined();
        expect(yield* local.signInLink(work.integration)).toBeDefined();
        yield* gateway.update({ id: personal.integration.id, enabled: false });
        expect(yield* local.status(personal.integration.id)).toBeUndefined();
        expect(
          (yield* gateway.listTools(personal.integration.name, undefined).pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* gateway.update({ id: personal.integration.id, enabled: true });
        expect((yield* gateway.listTools(personal.integration.name, undefined)).tools).toHaveLength(
          1,
        );
        expect(yield* local.signInLink(personal.integration)).toBeUndefined();
        yield* gateway.remove(personal.integration.id);
        yield* gateway.remove(work.integration.id);
        expect(yield* local.status(work.integration.id)).toBeUndefined();
        expect((yield* gateway.list()).integrations).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(testLayer(specs)));
    },
    15_000,
  );

  it.live("does not create an account until the shared OAuth client is stored", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const gateway = yield* Integrations.Integrations;
      const result = yield* gateway
        .create({ preset: "google-workspace", accountLabel: "personal" })
        .pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "google_client_missing" },
      });
      expect((yield* gateway.list()).integrations).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(testLayer([], true))),
  );

  it.live("rejects user-entered remote loopback URLs without sending credentials", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const gateway = yield* Integrations.Integrations;
      const integration = yield* gateway.create({
        name: IntegrationName.make("unsafe"),
        displayName: "Unsafe",
        transport: "http",
        url: "http://127.0.0.1:1/mcp",
        headers: {},
        scope: { type: "all" },
        hint: "",
      });
      expect(yield* gateway.testConnection(integration.integration.id)).toMatchObject({
        status: "disconnected",
        message: "Could not connect (invalid_request).",
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer([]))),
  );
});
