import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import {
  DEFAULT_SERVER_SETTINGS,
  VcsProcessSpawnError,
  VcsRepositoryDetectionError,
} from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const processOutput = (
  stdout: string,
  options?: {
    readonly stderr?: string;
    readonly exitCode?: ChildProcessSpawner.ExitCode;
  },
): VcsProcess.VcsProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

function makeRegistry(input: {
  readonly remotes: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
  }>;
  readonly process?: Partial<VcsProcess.VcsProcess["Service"]>;
  readonly githubApi?: Partial<GitHubRest.GitHubRest["Service"]>;
  readonly settings?: Partial<ServerSettings.ServerSettingsService["Service"]>;
  readonly resolve?: VcsDriverRegistry.VcsDriverRegistry["Service"]["resolve"];
}) {
  const driver = {
    listRemotes: () =>
      Effect.succeed({
        remotes: input.remotes.map((remote) => ({
          ...remote,
          pushUrl: Option.none(),
          isPrimary: remote.name === "origin",
        })),
        freshness: {
          source: "live-local" as const,
          observedAt: TEST_EPOCH,
          expiresAt: Option.none(),
        },
      }),
  } satisfies Partial<VcsDriver.VcsDriver["Service"]>;

  const layerRegistry = Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
    get: () => Effect.succeed(driver as unknown as VcsDriver.VcsDriver["Service"]),
    resolve:
      input.resolve ??
      (() =>
        Effect.succeed({
          kind: "git",
          repository: {
            kind: "git",
            rootPath: "/repo",
            metadataPath: null,
            freshness: {
              source: "live-local" as const,
              observedAt: TEST_EPOCH,
              expiresAt: Option.none(),
            },
          },
          driver: driver as unknown as VcsDriver.VcsDriver["Service"],
        })),
  });

  const layerProcess = Layer.mock(VcsProcess.VcsProcess)({
    run: () => Effect.succeed(processOutput("")),
    ...input.process,
  });

  return SourceControlProviderRegistry.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        layerRegistry,
        layerProcess,
        ServerSourceControlHost.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              layerProcess,
              layerRegistry,
              ServerSettings.ServerSettingsService.layerTest(),
              Layer.mock(GitVcsDriver.GitVcsDriver)({}),
            ),
          ),
        ),
        input.settings
          ? Layer.mock(ServerSettings.ServerSettingsService)(input.settings)
          : ServerSettings.ServerSettingsService.layerTest(),
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({}),
        // The GitHub provider's GraphQL reads go through these; no test here makes one.
        Layer.mock(GitHubRequestPolicy.GitHubRequestPolicy)({}),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die(new Error("Unexpected GitHub GraphQL read"))),
        ),
        Layer.mock(GitHubRest.GitHubRest)({
          // No GitHub credential unless a test supplies one, so custom hosts stay unclaimed.
          credential: (host) => Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host })),
          ...input.githubApi,
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-source-control-registry-test-",
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
}

it.effect("routes GitHub remotes to the GitHub provider", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@github.com:pingdotgg/t3code.git" }],
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "github");
  }),
);

it.effect("routes directly by provider kind for remote-first workflows", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [],
    });

    const provider = yield* registry.get(SourceControlProviderKind.make("github"));

    assert.strictEqual(provider.kind, "github");
  }),
);

it.effect("includes the request cwd when an unregistered provider is used", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({ remotes: [] });
    const provider = yield* registry.get(SourceControlProviderKind.make("unknown"));

    const error = yield* provider
      .getChangeRequest({ cwd: "/repo", reference: "#42" })
      .pipe(Effect.flip);

    assert.strictEqual(error.provider, "unknown");
    assert.strictEqual(error.operation, "getChangeRequest");
    assert.strictEqual(error.cwd, "/repo");
    assert.strictEqual(error.reference, "#42");
  }),
);

it.effect("retains VCS detection failures with structured cwd context", () =>
  Effect.gen(function* () {
    const cause = new VcsRepositoryDetectionError({
      operation: "resolve",
      cwd: "/repo",
      detail: "raw VCS detection failure",
      cause: new Error("raw nested failure"),
    });
    const registry = yield* makeRegistry({
      remotes: [],
      resolve: () => Effect.fail(cause),
    });

    const error = yield* registry.resolve({ cwd: "/repo" }).pipe(Effect.flip);

    assert.strictEqual(error.provider, "unknown");
    assert.strictEqual(error.operation, "detectProvider");
    assert.strictEqual(error.cwd, "/repo");
    assert.strictEqual(error.detail, "Failed to detect source control provider.");
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message.includes(cause.message), false);
  }),
);

it.effect.each([
  { name: "a credential", credential: "found", expected: "github" },
  // Claimed so the error says the host is turned off, not that it is unsupported.
  { name: "a host turned off in Settings", credential: "disabled", expected: "github" },
  { name: "no credential", credential: "missing", expected: "unknown" },
] as const)("resolves custom-host remotes with $name", (scenario) =>
  Effect.gen(function* () {
    const hosts: Array<string> = [];
    const commands: Array<string> = [];
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@code.example.test:team/project.git" }],
      process: {
        run: ({ command }) => {
          commands.push(command);
          return Effect.succeed(processOutput(""));
        },
      },
      githubApi: {
        credential: (host) => {
          hosts.push(host);
          return scenario.credential === "found"
            ? Effect.succeed({ token: Redacted.make("token"), fingerprint: `${host}:fingerprint` })
            : scenario.credential === "disabled"
              ? Effect.fail(new GitHubCredentials.GitHubHostDisabledError({ host }))
              : Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host }));
        },
      },
    });
    const handle = yield* registry.resolveHandle({ cwd: "/repo" });
    assert.strictEqual(handle.provider.kind, SourceControlProviderKind.make(scenario.expected));
    assert.strictEqual(handle.context?.provider.baseUrl, "https://code.example.test");
    assert.deepStrictEqual(hosts, ["code.example.test"]);
    // Recognition goes through the credential layer; gh is only one of its sources.
    assert.notInclude(commands, "gh");
  }),
);

it.effect("skips GitHub discovery for the identity resolver's empty base URL", () =>
  Effect.gen(function* () {
    const hosts: string[] = [];
    const remoteUrl = "git@githubenterprise.dev.example.com:team/workspace.git";
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: remoteUrl }],
      githubApi: {
        credential: (host) => {
          hosts.push(host);
          return Effect.succeed({
            token: Redacted.make("token"),
            fingerprint: `${host}:fingerprint`,
          });
        },
      },
    });
    const context = {
      provider: { kind: SourceControlProviderKind.make("unknown"), name: "Unknown", baseUrl: "" },
      remoteName: "origin",
      remoteUrl,
    };
    const unresolved = yield* registry.resolveHandle({ cwd: "/repo", context });
    assert.deepStrictEqual(unresolved.context, context);
    assert.deepStrictEqual(hosts, []);

    const resolved = yield* registry.resolveHandle({ cwd: "/repo" });
    assert.strictEqual(resolved.provider.kind, "github");
    assert.strictEqual(
      resolved.context?.provider.baseUrl,
      "https://githubenterprise.dev.example.com",
    );
    assert.deepStrictEqual(hosts, ["githubenterprise.dev.example.com"]);
  }),
);

const notFound = (command: string, cwd: string) =>
  new VcsProcessSpawnError({
    operation: "test",
    command,
    cwd,
    cause: PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" }),
  });

const resolveUnknown = (
  registry: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"],
  repository: string,
) =>
  registry.resolveHandle({
    cwd: `/${repository}`,
    context: {
      provider: {
        kind: SourceControlProviderKind.make("unknown"),
        name: "git.example.internal",
        baseUrl: "https://git.example.internal",
      },
      remoteName: "origin",
      remoteUrl: `git@Git.Example.Internal:team/${repository}.git`,
    },
  });

it.effect("asks again once Settings change", () =>
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<typeof DEFAULT_SERVER_SETTINGS>();
    const handled = yield* Deferred.make<void>();
    let signedIn = false;
    const registry = yield* makeRegistry({
      remotes: [],
      settings: {
        subscribeChanges: PubSub.subscribe(changes).pipe(
          Effect.map((subscription) =>
            // A change is handled once the registry asks for the next one.
            Stream.fromSubscription(subscription).pipe(
              Stream.flatMap((settings) =>
                Stream.concat(
                  Stream.make(settings),
                  Stream.fromEffectDrain(Deferred.succeed(handled, undefined)),
                ),
              ),
            ),
          ),
        ),
      },
      process: { run: ({ command, cwd }) => Effect.fail(notFound(command, cwd)) },
      githubApi: {
        credential: (host) =>
          signedIn
            ? Effect.succeed({ token: Redacted.make("token"), fingerprint: `${host}:fingerprint` })
            : Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host })),
      },
    });
    assert.strictEqual((yield* resolveUnknown(registry, "a")).provider.kind, "unknown");
    signedIn = true;
    assert.strictEqual((yield* resolveUnknown(registry, "b")).provider.kind, "unknown");

    // A token saved for the host in Settings.
    yield* PubSub.publish(changes, DEFAULT_SERVER_SETTINGS);
    yield* Deferred.await(handled);
    assert.strictEqual((yield* resolveUnknown(registry, "c")).provider.kind, "github");
  }),
);
