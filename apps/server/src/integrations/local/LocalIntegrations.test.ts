import * as GoogleTokens from "./GoogleTokenStore.ts";
import { loopbackHttpsPolicy } from "../https.testkit.ts";
import { describe, expect, it } from "@effect/vitest";
import { NodeCrypto, NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, IntegrationName, ProjectLabelId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer.layer takes a node:http server factory.
import * as NodeHttp from "node:http";
import * as ServerConfig from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as Credentials from "../IntegrationCredentials.ts";
import * as Integrations from "../Integrations.ts";
import * as Tokens from "../IntegrationTokens.ts";
import { IntegrationEndpointPolicy } from "../RemoteEndpoint.ts";
import * as Local from "./LocalIntegrations.ts";
import * as Runner from "./LocalMcpRunner.ts";
import * as Installer from "./RuntimeInstaller.ts";
import * as LocalHttp from "./LocalIntegrationHttp.ts";
import { GOOGLE_CALLBACK_PATH, GOOGLE_WORKSPACE_VERSION } from "./GoogleWorkspace.ts";
import * as AgentStore from "../../agents/AgentStore.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../mcp/McpInvocationContext.ts";
import * as Access from "../../mcp/McpToolAccess.ts";
import * as Handlers from "../../mcp/toolkits/integrations/handlers.ts";
import { IntegrationsToolkit } from "../../mcp/toolkits/integrations/tools.ts";

const fixture = new URL("./fixtures/fake-mcp.mjs", import.meta.url).pathname;
const credentials = (missing = false, format: "json" | "login" = "json", project?: string) =>
  Layer.succeed(Credentials.IntegrationCredentials, {
    resolve: (ref, destination) =>
      Effect.succeed(
        missing || (project !== undefined && destination.scopeProjectId !== project)
          ? Option.none<string>()
          : format === "json"
            ? ref.endsWith("value")
              ? Option.some(
                  JSON.stringify({
                    web: { client_id: "fake-client-id", client_secret: "fake-client-secret" },
                  }),
                )
              : Option.none<string>()
            : ref.endsWith("value")
              ? Option.none<string>()
              : Option.some(ref.endsWith("username") ? "fake-client-id" : "fake-client-secret"),
      ),
  });
const testLayer = (
  specs: Array<Runner.LocalMcpSpec>,
  missing = false,
  format: "json" | "login" = "json",
  /** Lets a remote integration reach a mock server on loopback, as production never does. */
  allowLoopback = false,
  /** Fixed, or a switch a test flips (an install). */
  runtime: boolean | { missing: boolean } = false,
  diagnostics?: { readonly state: "running" | "failed"; readonly tail: string },
  callbacks?: Array<string>,
  installer?: Layer.Layer<Installer.RuntimeInstaller>,
  credentialProject?: string,
) => {
  const grants = new Map<string, GoogleTokens.GoogleGrant>();
  const grant: GoogleTokens.GoogleGrant = {
    email: "fixture@example.com",
    credentials: {
      token: "fixture-access",
      refresh_token: "fixture-refresh",
      token_uri: "https://oauth2.googleapis.com/token",
      client_id: "fake-client-id",
      client_secret: "fake-client-secret",
      scopes: [],
      expiry: null,
    },
  };
  const tokenStore = GoogleTokens.GoogleTokenStore.of({
    read: (id) => Effect.sync(() => Option.fromUndefinedOr(grants.get(id))),
    write: (id, value) =>
      Effect.sync(() => {
        grants.set(id, value);
      }),
    remove: (id) =>
      Effect.sync(() => {
        grants.delete(id);
      }),
  });
  const runtimeIsMissing = () => (typeof runtime === "boolean" ? runtime : runtime.missing);
  // Replace the external package at the process boundary; exercise the real supervisor and gateway.
  const runner = Layer.effect(
    Runner.LocalMcpRunner,
    Effect.gen(function* () {
      const actual = yield* Runner.LocalMcpRunner;
      return Runner.LocalMcpRunner.of({
        ...actual,
        callback: (id, query) => {
          callbacks?.push(query);
          return actual
            .callback(id, query)
            .pipe(
              Effect.tap((ok) =>
                ok ? tokenStore.write(id, grant).pipe(Effect.orDie) : Effect.void,
              ),
            );
        },
        status:
          diagnostics === undefined
            ? actual.status
            : () =>
                Effect.succeed({
                  state: diagnostics.state,
                  version: "test",
                  stderrTail: diagnostics.tail,
                }),
        start: (spec) => {
          specs.push(spec);
          const missing = runtimeIsMissing();
          return actual.start({
            ...spec,
            runtime: missing ? "uvx" : process.execPath,
            args: [fixture],
            portEnvironment: { ...spec.portEnvironment, FIXTURE_PORT: "{port}" },
            env: {
              ...spec.env,
              FIXTURE_TRANSPORT: spec.transport,
              FIXTURE_PORT: String(spec.port),
              FIXTURE_SECRET: "fake-client-secret",
              ...(missing ? { PATH: spec.directory } : {}),
            },
          });
        },
      });
    }),
  ).pipe(Layer.provide(Runner.layerWith({ restartDelayMs: 10, requestTimeoutMs: 2000 })));
  const infrastructure = Layer.mergeAll(
    Layer.succeed(GoogleTokens.GoogleTokenStore, tokenStore),
    NodeServices.layer,
    NodeCrypto.layer,
    FetchHttpClient.layer,
    credentials(missing, format, credentialProject),
    // Remote OAuth tokens are only read once a remote sign-in completes, which no test here does.
    Layer.mock(Tokens.IntegrationTokens)({}),
    Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer)),
    ServerConfig.layerTest(process.cwd(), { prefix: "local-integrations-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  );
  const local = Local.layer.pipe(Layer.provideMerge(runner), Layer.provideMerge(infrastructure));
  return Integrations.layer.pipe(
    Layer.provide(
      allowLoopback ? Layer.succeed(IntegrationEndpointPolicy, loopbackHttpsPolicy) : Layer.empty,
    ),
    Layer.provide(installer ?? Layer.empty),
    Layer.provideMerge(local),
  );
};
const echoResult = Schema.decodeUnknownSync(
  Schema.Struct({
    content: Schema.Array(Schema.Struct({ text: Schema.String })),
  }),
);

describe("managed Google integrations", () => {
  it.live.each(["json", "login"] as const)(
    "isolates two accounts with %s credentials and routes tools, sign-in, disable and remove through the gateway",
    (format) => {
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
        expect(Integrations.integrationTitle(personal.integration)).toBe("Google · personal");
        expect(personal.integration.accountLabel).toBe("personal");
        expect(work.integration.local?.version).toBe(GOOGLE_WORKSPACE_VERSION);
        expect(specs).toHaveLength(2);
        expect(specs[0]?.directory).not.toBe(specs[1]?.directory);
        expect(specs[0]?.port).not.toBe(specs[1]?.port);
        expect(specs[0]?.env.WORKSPACE_MCP_CREDENTIALS_DIR).not.toBe(
          specs[1]?.env.WORKSPACE_MCP_CREDENTIALS_DIR,
        );
        expect(specs[0]?.args).toEqual([
          "--from",
          `workspace-mcp@${GOOGLE_WORKSPACE_VERSION}`,
          "python",
          "-c",
          expect.any(String),
          "--transport",
          "stdio",
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
        expect(yield* fs.realPath(`${specs[0]!.directory}/logs/mcp_server_debug.log`)).toBe(
          "/dev/null",
        );
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
        expect(echoResult(response).content[0]?.text).toContain("account routing");
        const listed = yield* gateway.list();
        expect(listed.integrations.every((item) => item.managed?.state === "running")).toBe(true);
        expect(listed.integrations.map((item) => item.status)).toEqual([
          "needs_sign_in",
          "needs_sign_in",
        ]);
        const signIn = yield* gateway.beginSignIn(personal.integration.id, { origin: undefined });
        expect(signIn.redirectUri).toBe(`https://cogenly.example.com${GOOGLE_CALLBACK_PATH}`);
        const ticket = new URL(signIn.authorizationUrl).searchParams.get("ticket")!;
        const route = yield* HttpRouter.toHttpEffect(LocalHttp.layer);
        const get = (url: string) =>
          route.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(new Request(url)),
            ),
            Effect.map(HttpServerResponse.toWeb),
          );
        const [auth, concurrentAuth] = yield* Effect.all(
          [local.authorize(ticket), local.authorize(ticket)],
          { concurrency: "unbounded" },
        );
        const http = yield* HttpClient.HttpClient;
        const networkMcp = yield* http.execute(
          HttpClientRequest.post(`http://127.0.0.1:${specs[0]!.port}/mcp`),
        );
        expect(networkMcp.status).toBe(404);
        expect(concurrentAuth.url).toBe(auth.url);
        expect(auth.connected).toBe(false);
        expect(new URL(auth.url!).hostname).toBe("accounts.google.com");
        expect(new URL(auth.url!).searchParams.get("client_id")).toBe("fake-client-id");
        // Reopening the link reuses the outstanding consent flow rather than minting another refresh token.
        expect((yield* local.authorize(ticket)).url).toBe(auth.url);
        const signInResponse = yield* get(signIn.authorizationUrl);
        expect(signInResponse.headers.get("location")).toBe(auth.url);
        expect(signInResponse.headers.get("cache-control")).toBe("no-store");
        expect(yield* local.callback("state=unknown&code=fake")).toBe(false);
        const state = new URL(auth.url!).searchParams.get("state")!;
        const callbackUrl = `https://cogenly.example.com${GOOGLE_CALLBACK_PATH}?${new URLSearchParams({ state, code: "fake-code" })}`;
        expect((yield* get(callbackUrl)).status).toBe(200);
        expect((yield* get(callbackUrl)).status).toBe(400);
        expect((yield* local.authorize(ticket)).connected).toBe(true);
        expect(yield* local.signInLink(personal.integration)).toBeUndefined();
        const signedIn = (yield* gateway.list()).integrations.find(
          (item) => item.integration.id === personal.integration.id,
        );
        expect(signedIn?.status).toBe("connected");
        // Asking again for a link changes nothing, so the other account's pending sign-in survives.
        expect((yield* gateway.update({ id: work.integration.id })).integration.updatedAt).toBe(
          work.integration.updatedAt,
        );
        expect(yield* local.signInLink(work.integration)).toBeDefined();
        yield* gateway.update({ id: personal.integration.id, enabled: false });
        expect(yield* local.status(personal.integration.id)).toBeUndefined();
        // A tool request which read the enabled definition before the update must not resurrect it.
        expect(
          (yield* local.rpc(personal.integration, "tools/list", {}).pipe(Effect.result))._tag,
        ).toBe("Failure");
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
        expect(
          (yield* local.rpc(work.integration, "tools/list", {}).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* local.signInLink(work.integration)).toBeUndefined();
        expect(yield* local.status(work.integration.id)).toBeUndefined();
        expect((yield* gateway.list()).integrations).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(testLayer(specs, false, format)));
    },
    15_000,
  );

  it.live("uses an explicit reachable Google callback origin supplied by an agent", () => {
    const specs: Array<Runner.LocalMcpSpec> = [];
    return Effect.gen(function* () {
      yield* runMigrations();
      const gateway = yield* Integrations.Integrations;
      const { integration } = yield* gateway.create(
        { preset: "google-workspace", accountLabel: "work", callbackOrigin: "https://vps.example" },
        { fromAgent: true },
      );
      const link = yield* gateway.beginSignIn(integration.id, {
        origin: undefined,
        fromAgent: true,
      });
      expect(link.redirectUri).toBe(`https://vps.example${GOOGLE_CALLBACK_PATH}`);
      expect(specs[0]?.env.GOOGLE_OAUTH_REDIRECT_URI).toBe(link.redirectUri);
    }).pipe(Effect.scoped, Effect.provide(testLayer(specs)));
  });

  it.live("uses the server's Google callback origin instead of an agent's input", () => {
    const specs: Array<Runner.LocalMcpSpec> = [];
    return Effect.gen(function* () {
      yield* runMigrations();
      const gateway = yield* Integrations.Integrations;
      const { integration } = yield* gateway.create(
        {
          preset: "google-workspace",
          accountLabel: "work",
          callbackOrigin: "https://attacker.example",
        },
        { fromAgent: true },
      );
      const link = yield* gateway.beginSignIn(integration.id, {
        origin: "https://attacker.example",
        callbackOrigin: "https://attacker.example",
        fromAgent: true,
      });
      expect(link.redirectUri).toBe(`https://owner.example${GOOGLE_CALLBACK_PATH}`);
      expect(specs[0]?.env.GOOGLE_OAUTH_REDIRECT_URI).toBe(link.redirectUri);
    }).pipe(
      Effect.scoped,
      Effect.provide(testLayer(specs)),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ COGENLY_GOOGLE_CALLBACK_ORIGIN: "https://owner.example" }),
      ),
    );
  });

  it.live("remembers Google's successful browser origin privately across restarts", () => {
    const specs: Array<Runner.LocalMcpSpec> = [];
    return Effect.gen(function* () {
      yield* runMigrations();
      const gateway = yield* Integrations.Integrations;
      const local = yield* Local.LocalIntegrations;
      const fs = yield* FileSystem.FileSystem;
      const { integration } = yield* gateway.create({
        preset: "google-workspace",
        accountLabel: "work",
      });
      const missing = yield* gateway
        .beginSignIn(integration.id, { origin: "http://localhost:3000", fromAgent: true })
        .pipe(Effect.result);
      expect(missing._tag).toBe("Failure");
      const link = yield* gateway.beginSignIn(integration.id, {
        origin: "https://vps.example",
      });
      const auth = yield* local.authorize(
        new URL(link.authorizationUrl).searchParams.get("ticket")!,
      );
      expect(
        yield* local.callback(`state=${new URL(auth.url!).searchParams.get("state")}&code=test`),
      ).toBe(true);
      expect(yield* fs.readFileString(`${specs[0]!.directory}/browser-origin.json`)).toBe(
        JSON.stringify("https://vps.example"),
      );
      yield* local.stop(integration.id, integration);
      const restarted = Context.get(
        yield* Layer.build(Layer.fresh(Local.layer)),
        Local.LocalIntegrations,
      );
      yield* restarted.start(integration);
      expect(
        yield* restarted.signInLink(integration, true, {
          origin: "http://localhost:3000",
          fromAgent: true,
        }),
      ).toHaveProperty("authorizationUrl");
      const retry = yield* restarted.signInLink(integration, true, {
        origin: "https://vps.example",
      });
      expect(retry?.redirectUri).toBe(`https://vps.example${GOOGLE_CALLBACK_PATH}`);
      expect(specs.at(-1)?.env.GOOGLE_OAUTH_REDIRECT_URI).toBe(retry?.redirectUri);
      expect(JSON.stringify(yield* gateway.list())).not.toContain("browserOrigin");
    }).pipe(Effect.scoped, Effect.provide(testLayer(specs)));
  });

  it.live.each(["reject-grant", "reject-grant-output"])(
    "recovers a revoked Google grant reported by %s",
    (tool) => {
      const specs: Array<Runner.LocalMcpSpec> = [];
      return Effect.gen(function* () {
        yield* runMigrations();
        const gateway = yield* Integrations.Integrations;
        const local = yield* Local.LocalIntegrations;
        const fs = yield* FileSystem.FileSystem;
        const { integration } = yield* gateway.create({
          preset: "google-workspace",
          accountLabel: "work",
          callbackOrigin: "https://cogenly.example.com",
        });
        const signIn = yield* gateway.beginSignIn(integration.id, { origin: undefined });
        const auth = yield* local.authorize(
          new URL(signIn.authorizationUrl).searchParams.get("ticket")!,
        );
        const state = new URL(auth.url!).searchParams.get("state")!;
        expect(yield* local.callback(`state=${state}&code=first`)).toBe(true);
        const credential = `${specs[0]!.env.WORKSPACE_MCP_CREDENTIALS_DIR}/fixture@example.com.json`;
        expect(yield* local.signedIn(integration.id)).toBe(true);
        const rejected = yield* local.changes.pipe(
          Stream.filterEffect(() =>
            local.signedIn(integration.id).pipe(Effect.map((signedIn) => !signedIn)),
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* gateway.callTool(integration.name, tool, {}, undefined).pipe(Effect.result);
        if (tool === "reject-grant") expect(yield* local.signedIn(integration.id)).toBe(false);
        yield* Fiber.join(rejected);
        expect((yield* gateway.list()).integrations[0]?.status).toBe("needs_sign_in");
        expect((yield* (yield* GoogleTokens.GoogleTokenStore).read(integration.id))._tag).toBe(
          "Some",
        );
        const retry = yield* gateway.beginSignIn(integration.id, { origin: undefined });
        expect((yield* (yield* GoogleTokens.GoogleTokenStore).read(integration.id))._tag).toBe(
          "None",
        );
        const next = yield* local.authorize(
          new URL(retry.authorizationUrl).searchParams.get("ticket")!,
        );
        expect(next.connected).toBe(false);
        expect(
          yield* local.callback(
            `state=${new URL(next.url!).searchParams.get("state")}&code=second`,
          ),
        ).toBe(true);
        expect(yield* local.signedIn(integration.id)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(testLayer(specs)));
    },
  );

  it.live.each([
    { missing: false, runtimeMissing: false, form: { preset: "google-workspace" } },
    { missing: true, runtimeMissing: false, form: { preset: "google-workspace" } },
    { missing: false, runtimeMissing: false, form: { catalogId: "google-workspace" } },
    { missing: true, runtimeMissing: false, form: { catalogId: "google-workspace" } },
    { missing: false, runtimeMissing: true, form: { preset: "google-workspace" } },
    { missing: false, runtimeMissing: true, form: { catalogId: "google-workspace" } },
  ] as const)(
    "integration_add $form exposes a sign-in link or private vault instructions (missing client: $missing)",
    ({ missing, runtimeMissing, form }) =>
      Effect.gen(function* () {
        yield* runMigrations();
        const dependencies = Layer.mergeAll(
          Layer.succeed(Invocation.McpInvocationContext, {
            environmentId: EnvironmentId.make("env:test"),
            requestNamespace: "client:owner",
            thread: undefined,
            client: { sessionId: "owner", label: "Owner", access: "full-access" },
            capabilities: new Set(["orchestration"] as const),
            issuedAt: 0,
          }),
          Layer.mock(Threads.ThreadManagementService)({}),
          Layer.mock(AgentStore.AgentStore)({}),
        );
        const toolkit = yield* IntegrationsToolkit.pipe(
          Effect.provide(
            Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
          ),
        );
        const replies = yield* toolkit
          .handle("integration_add", {
            ...form,
            accountLabel: "personal",
            callbackOrigin: "https://cogenly.example.com",
          })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
        const reply = replies.at(-1)?.result as {
          integration?: unknown;
          setup?: { type: string };
          nextStep?: string;
          settingsUrl?: string;
        };
        if (missing) {
          // Nothing is created; the agent relays Settings' guided steps or collects the client privately.
          expect(reply.integration).toBeUndefined();
          expect(reply.setup?.type).toBe("oauth_client");
          expect(reply.settingsUrl).toBe("/settings/integrations?setup=google-workspace");
          expect(reply.nextStep).toContain("request_secret");
          expect(reply.nextStep).toContain("google-oauth-client");
          expect(reply.nextStep).toContain("Retry integration_add");
        } else if (runtimeMissing) {
          // The account is saved; installing uv is the step before sign-in.
          expect(reply.integration).toBeDefined();
          expect(reply.setup?.type).toBe("install_runtime");
          expect(reply.nextStep).toContain("brew install uv");
        } else {
          expect(reply.integration).toBeDefined();
          expect(reply).toHaveProperty("signIn.authorizationUrl");
        }
      }).pipe(Effect.scoped, Effect.provide(testLayer([], missing, "json", false, runtimeMissing))),
  );

  it.live("keeps owner Google sign-in separate and rejects an older agent flow afterward", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const gateway = yield* Integrations.Integrations;
      const local = yield* Local.LocalIntegrations;
      const { integration } = yield* gateway.create({
        preset: "google-workspace",
        accountLabel: "work",
        callbackOrigin: "https://cogenly.example.com",
      });
      const agent = yield* gateway.beginSignIn(integration.id, {
        origin: "https://cogenly.example.com",
        fromAgent: true,
      });
      const owner = yield* gateway.beginSignIn(integration.id, {
        origin: "https://cogenly.example.com",
      });
      expect(owner.authorizationUrl).not.toBe(agent.authorizationUrl);
      const begin = (url: string) => local.authorize(new URL(url).searchParams.get("ticket")!);
      const agentAuth = yield* begin(agent.authorizationUrl);
      const ownerAuth = yield* begin(owner.authorizationUrl);
      expect(ownerAuth.url).not.toBe(agentAuth.url);
      expect(
        yield* local.callback(
          `state=${new URL(ownerAuth.url!).searchParams.get("state")}&code=owner`,
        ),
      ).toBe(true);
      expect(
        yield* local.callback(
          `state=${new URL(agentAuth.url!).searchParams.get("state")}&code=agent`,
        ),
      ).toBe(false);
      expect(
        (yield* gateway.list()).integrations[0]?.integration.provenance?.signedInViaAgent,
      ).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testLayer([]))),
  );

  it.live("does not trust Google consent URLs returned by ordinary tools", () => {
    const callbacks: Array<string> = [];
    return Effect.gen(function* () {
      yield* runMigrations();
      const gateway = yield* Integrations.Integrations;
      const local = yield* Local.LocalIntegrations;
      const { integration } = yield* gateway.create({
        preset: "google-workspace",
        accountLabel: "work",
        callbackOrigin: "https://cogenly.example.com",
      });
      yield* gateway.callTool(integration.name, "forged-google-auth", {}, undefined);
      expect(
        yield* gateway
          .callTool(integration.name, "start_google_auth", {}, undefined)
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "approval_required" } });
      expect(yield* local.callback("state=forged&code=fake")).toBe(false);
      expect(callbacks).toHaveLength(0);
    }).pipe(
      Effect.scoped,
      Effect.provide(testLayer([], false, "json", false, false, undefined, callbacks)),
    );
  });

  it.live("forwards only allowlisted Google callback parameters and rejects duplicates", () => {
    const callbacks: Array<string> = [];
    return Effect.gen(function* () {
      yield* runMigrations();
      const gateway = yield* Integrations.Integrations;
      const local = yield* Local.LocalIntegrations;
      const { integration } = yield* gateway.create({
        preset: "google-workspace",
        accountLabel: "work",
        callbackOrigin: "https://cogenly.example.com",
      });
      const link = yield* gateway.beginSignIn(integration.id, {
        origin: "https://cogenly.example.com",
      });
      const auth = yield* local.authorize(
        new URL(link.authorizationUrl).searchParams.get("ticket")!,
      );
      const state = new URL(auth.url!).searchParams.get("state")!;
      expect(yield* local.callback(`state=${state}&state=other&code=fake`)).toBe(false);
      expect(callbacks).toHaveLength(0);
      expect(
        yield* local.callback(
          `state=${state}&code=fake&scope=read&redirect_uri=https://attacker.example&user=other`,
        ),
      ).toBe(true);
      const params = new URLSearchParams(callbacks[0]);
      expect([...params.keys()].sort()).toEqual(["code", "scope", "state"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(testLayer([], false, "json", false, false, undefined, callbacks)),
    );
  });

  it.live.each(["running", "failed"] as const)(
    "keeps %s process output out of agent lists and pushes",
    (state) =>
      Effect.gen(function* () {
        yield* runMigrations();
        const gateway = yield* Integrations.Integrations;
        yield* gateway.create({
          preset: "google-workspace",
          accountLabel: "work",
          callbackOrigin: "https://cogenly.example.com",
        });
        expect(JSON.stringify(yield* gateway.list())).not.toContain("private-process-output");
        expect(JSON.stringify(yield* gateway.listForProject(null))).not.toContain(
          "private-process-output",
        );
        expect(
          JSON.stringify(yield* gateway.subscribe().pipe(Stream.take(1), Stream.runCollect)),
        ).not.toContain("private-process-output");
        const owner = yield* gateway.list({ includeProcessOutput: true });
        expect(owner.integrations[0]?.managed?.stderrTail).toBe(
          state === "failed" ? "private-process-output" : undefined,
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          testLayer([], false, "json", false, false, { state, tail: "private-process-output" }),
        ),
      ),
  );

  it.live("reports a redacted local tool error in Settings and agent status", () => {
    const specs: Array<Runner.LocalMcpSpec> = [];
    return Effect.gen(function* () {
      yield* runMigrations();
      const gateway = yield* Integrations.Integrations;
      const fs = yield* FileSystem.FileSystem;
      const { integration } = yield* gateway.create({
        preset: "google-workspace",
        accountLabel: "work",
        callbackOrigin: "https://cogenly.example.com",
      });
      yield* (yield* GoogleTokens.GoogleTokenStore).write(integration.id, {
        email: "work@example.com",
        credentials: {
          token: "access",
          refresh_token: "grant",
          token_uri: "https://oauth2.googleapis.com/token",
          client_id: "id",
          client_secret: "secret",
          scopes: [],
          expiry: null,
        },
      });
      const result = yield* gateway.callTool(integration.name, "tool-error", {}, undefined);
      expect(result.isError).toBe(true);
      const summary = (yield* gateway.list()).integrations[0]!;
      expect(summary.status).toBe("error");
      expect(summary.message).toContain("Workspace permission denied");
      expect(JSON.stringify([result, summary])).not.toContain("fake-client-secret");
    }).pipe(Effect.scoped, Effect.provide(testLayer(specs)));
  });

  it.live("removing an account erases its grants while disabling preserves them", () => {
    const specs: Array<Runner.LocalMcpSpec> = [];
    return Effect.gen(function* () {
      yield* runMigrations();
      const gateway = yield* Integrations.Integrations;
      const fs = yield* FileSystem.FileSystem;
      const { integration } = yield* gateway.create({
        preset: "google-workspace",
        accountLabel: "work",
        callbackOrigin: "https://cogenly.example.com",
      });
      const directory = specs[0]!.directory;
      const credentials = specs[0]!.env.WORKSPACE_MCP_CREDENTIALS_DIR!;
      yield* fs.writeFileString(
        `${credentials}/work.json`,
        JSON.stringify({ refresh_token: "private-grant" }),
      );
      yield* fs.makeDirectory(`${credentials}.previous`);
      yield* fs.writeFileString(
        `${credentials}.previous/work.json`,
        JSON.stringify({ refresh_token: "previous-grant" }),
      );
      yield* gateway.update({ id: integration.id, enabled: false });
      expect(yield* fs.exists(`${credentials}/work.json`)).toBe(true);
      expect(yield* fs.exists(`${credentials}.previous/work.json`)).toBe(true);
      yield* gateway.remove(integration.id);
      expect(yield* fs.exists(directory)).toBe(false);
      expect((yield* gateway.remove(integration.id)).deleted).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testLayer(specs)));
  });

  it.live("connects the Google catalog entry and hands back its sign-in link", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const gateway = yield* Integrations.Integrations;
      const connected = yield* gateway.connectFromCatalog(
        { catalogId: "google-workspace", accountLabel: "personal" },
        { approveCredentials: true, origin: { origin: "https://cogenly.example.com" } },
      );
      expect(connected.integration).toMatchObject({
        name: "google-personal",
        transport: "local",
        local: { callbackOrigin: "https://cogenly.example.com" },
      });
      expect(connected.signIn?.authorizationUrl).toContain(
        "https://cogenly.example.com/oauth/integrations/google/start?ticket=",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer([]))),
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

  it.live("connecting Google without its client returns the guided steps instead of failing", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const gateway = yield* Integrations.Integrations;
      const result = yield* gateway.connectFromCatalog(
        { catalogId: "google-workspace", accountLabel: "personal" },
        { approveCredentials: true, origin: { origin: "https://cogenly.example.com" } },
      );
      expect(result.integration).toBeUndefined();
      expect(result.setup?.type).toBe("oauth_client");
      const steps = result.setup?.type === "oauth_client" ? result.setup.steps : [];
      // The exact redirect URI this server will use, ready to paste into Google Cloud.
      expect(steps.map((step) => step.copy?.value)).toContain(
        `https://cogenly.example.com${GOOGLE_CALLBACK_PATH}`,
      );
      expect(steps.some((step) => step.text.includes("In production"))).toBe(true);
      expect((yield* gateway.list()).integrations).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(testLayer([], true))),
  );

  it.live("installing uv from Settings lets a waiting account start without a restart", () => {
    const runtime = { missing: true };
    const ran: Array<ReadonlyArray<string>> = [];
    // The installer's process boundary: nothing is installed, the switch flips instead.
    const installer = Layer.effect(
      Installer.RuntimeInstaller,
      Installer.make({
        platform: "darwin",
        runner: {
          exists: (path) => Effect.succeed(path === "/opt/homebrew/bin/brew"),
          run: (program, args) =>
            Effect.sync(() => {
              ran.push([program, ...args]);
              runtime.missing = false;
              return { exitCode: 0, output: "" };
            }),
        },
      }),
    );
    return Effect.gen(function* () {
      yield* runMigrations();
      const gateway = yield* Integrations.Integrations;
      const { integration } = yield* gateway.create({
        preset: "google-workspace",
        accountLabel: "work",
        callbackOrigin: "https://cogenly.example.com",
      });
      const before = (yield* gateway.list()).integrations[0];
      expect(before?.status).toBe("error");
      expect(before?.setup).toMatchObject({
        type: "install_runtime",
        integrationId: integration.id,
        runtime: "uv",
        canInstall: true,
        command: "brew install uv",
      });
      expect(yield* gateway.installRuntime("uv")).toEqual({
        installed: true,
        message: "uv is installed.",
      });
      expect(ran).toEqual([["/opt/homebrew/bin/brew", "install", "uv"]]);
      const after = (yield* gateway.list()).integrations[0];
      expect(after?.status).toBe("needs_sign_in");
      expect(after?.setup).toMatchObject({ type: "sign_in", integrationId: integration.id });
    }).pipe(
      Effect.scoped,
      Effect.provide(testLayer([], false, "json", false, runtime, undefined, undefined, installer)),
    );
  });

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

  it.live(
    "lists a managed Google account beside a remote OAuth server, each with its own sign-in",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        // The smallest OAuth server that discovery and dynamic registration accept.
        let base = "";
        const routes = Layer.mergeAll(
          HttpRouter.add("POST", "/mcp", () =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe({ error: "invalid_token" }, { status: 401 }),
            ),
          ),
          HttpRouter.add("GET", "/.well-known/oauth-authorization-server", () =>
            Effect.sync(() =>
              HttpServerResponse.jsonUnsafe({
                issuer: base,
                authorization_endpoint: `${base}/authorize`,
                token_endpoint: `${base}/token`,
                registration_endpoint: `${base}/register`,
                code_challenge_methods_supported: ["S256"],
              }),
            ),
          ),
          HttpRouter.add("POST", "/register", () =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe(
                { client_id: "linear-client", token_endpoint_auth_method: "none" },
                { status: 201 },
              ),
            ),
          ),
        );
        const server = yield* Layer.build(
          HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
            Layer.provideMerge(
              NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" }),
            ),
          ),
        );
        base = HttpServer.formatAddress(Context.get(server, HttpServer.HttpServer).address).replace(
          /^http:/,
          "https:",
        );

        const gateway = yield* Integrations.Integrations;
        const google = yield* gateway.create({
          preset: "google-workspace",
          accountLabel: "personal",
          callbackOrigin: "https://cogenly.example.com",
        });
        const linear = yield* gateway.create({
          name: IntegrationName.make("linear"),
          displayName: "Linear",
          accountLabel: "Spawn Partners",
          transport: "http",
          url: `${base}/mcp`,
          headers: {},
          scope: { type: "all" },
          hint: "",
          auth: { type: "oauth" },
        });

        const listed = (yield* gateway.list()).integrations;
        expect(
          listed.map((item) => ({
            title: Integrations.integrationTitle(item.integration),
            transport: item.integration.transport,
            status: item.status,
            managed: item.managed !== undefined,
          })),
        ).toEqual([
          // Starting or running, a process without a Google grant needs sign-in.
          {
            title: "Google · personal",
            transport: "local",
            status: "needs_sign_in",
            managed: true,
          },
          {
            title: "Linear · Spawn Partners",
            transport: "http",
            status: "needs_sign_in",
            managed: false,
          },
        ]);

        const googleSignIn = yield* gateway.beginSignIn(google.integration.id, {
          origin: "https://elsewhere.example.com",
        });
        // A managed account always returns to the callback origin Google has registered.
        expect(new URL(googleSignIn.authorizationUrl).pathname).toBe(
          "/oauth/integrations/google/start",
        );
        expect(googleSignIn.redirectUri).toBe(`https://cogenly.example.com${GOOGLE_CALLBACK_PATH}`);

        const linearSignIn = yield* gateway.beginSignIn(linear.integration.id, {
          origin: "https://elsewhere.example.com",
        });
        const authorize = new URL(linearSignIn.authorizationUrl);
        expect(authorize.origin + authorize.pathname).toBe(`${base}/authorize`);
        expect(authorize.searchParams.get("client_id")).toBe("linear-client");
        expect(linearSignIn.redirectUri).toBe(
          "https://elsewhere.example.com/oauth/integrations/callback",
        );
      }).pipe(Effect.scoped, Effect.provide(testLayer([], false, "json", true))),
  );
});

it.live("injects custom stdio secrets from the vault without placing them on argv", () => {
  const specs: Array<Runner.LocalMcpSpec> = [];
  return Effect.gen(function* () {
    yield* runMigrations();
    const gateway = yield* Integrations.Integrations;
    const { integration } = yield* gateway.create({
      name: IntegrationName.make("custom-worker"),
      displayName: "Worker",
      transport: "stdio",
      url: "https://localhost",
      headers: {},
      scope: { type: "all" },
      hint: "",
      command: {
        command: "npx",
        args: ["-y", "example-mcp@1.0.0"],
        env: { FIXTURE_CUSTOM_KEY: "{{credential:custom.value}}" },
      },
    });
    expect(specs).toHaveLength(0);
    const result = yield* gateway.callTool(integration.name, "echo", {}, undefined);
    expect(specs[0]?.env.FIXTURE_CUSTOM_KEY).toContain("fake-client-secret");
    expect(JSON.stringify(specs[0]?.args)).not.toContain("fake-client-secret");
    expect(JSON.stringify(result)).toContain('customSecretPresent\\\":true');
    expect(specs[0]?.idleTimeoutMs).toBe(300000);
    yield* gateway.update({ id: integration.id, enabled: false });
    expect(yield* (yield* Runner.LocalMcpRunner).status(integration.id)).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(testLayer(specs)));
});

it.live("authorizes the Google vault bridge per process and retires it on disconnect", () => {
  const specs: Array<Runner.LocalMcpSpec> = [];
  return Effect.gen(function* () {
    yield* runMigrations();
    const gateway = yield* Integrations.Integrations;
    const local = yield* Local.LocalIntegrations;
    const { integration } = yield* gateway.create({
      preset: "google-workspace",
      accountLabel: "work",
      callbackOrigin: "https://vps.example",
    });
    const capability = specs[0]!.env.COGENLY_GOOGLE_CREDENTIAL_CAPABILITY!;
    const grant = {
      email: "work@example.com",
      credentials: {
        token: "fixture-access",
        refresh_token: "fixture-refresh",
        client_id: "id",
        client_secret: "secret",
        token_uri: "https://oauth2.googleapis.com/token",
        scopes: [],
        expiry: null,
      },
    };
    expect(
      (yield* local
        .credentialRequest("wrong-capability", { operation: "read" })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    yield* local.credentialRequest(capability, { operation: "write", grant });
    expect(yield* local.credentialRequest(capability, { operation: "read" })).toEqual({ grant });
    expect(yield* local.signedIn(integration.id)).toBe(true);
    expect(JSON.stringify(specs[0]!.args)).not.toContain(capability);
    yield* gateway.update({ id: integration.id, enabled: false });
    expect(
      (yield* local.credentialRequest(capability, { operation: "read" }).pipe(Effect.result))._tag,
    ).toBe("Failure");
  }).pipe(Effect.scoped, Effect.provide(testLayer(specs)));
});

it.live("connection tests cannot reuse another project's credentialed stdio process", () => {
  const specs: Array<Runner.LocalMcpSpec> = [];
  const a = ProjectLabelId.make("project:a");
  const b = ProjectLabelId.make("project:b");
  return Effect.gen(function* () {
    yield* runMigrations();
    const gateway = yield* Integrations.Integrations;
    const { integration } = yield* gateway.create({
      name: IntegrationName.make("scoped-worker"),
      displayName: "Scoped worker",
      transport: "stdio",
      url: "https://localhost",
      headers: {},
      scope: { type: "all" },
      hint: "",
      command: {
        command: "fixture",
        args: [],
        env: { FIXTURE_CUSTOM_KEY: "{{credential:custom.value}}" },
      },
    });
    expect(yield* gateway.testConnection(integration.id, b)).toMatchObject({
      reason: "credential_unresolved",
    });
    expect(specs).toHaveLength(0);
    expect(yield* gateway.testConnection(integration.id, a)).toMatchObject({ status: "connected" });
    expect(yield* gateway.testConnection(integration.id, b)).toMatchObject({
      reason: "credential_unresolved",
    });
    expect(specs).toHaveLength(1);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      testLayer(specs, false, "json", false, false, undefined, undefined, undefined, a),
    ),
  );
});
