import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import { HttpClient } from "effect/http";
import { VcsProcessSpawnError } from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";

const layerSourceControlProviderRegistryTest = (input: {
  readonly process: Partial<VcsProcess.VcsProcess["Service"]>;
}) =>
  SourceControlProviderRegistry.layer
    .pipe(
      Layer.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "t3-source-control-registry-test-",
          }).pipe(Layer.provide(NodeServices.layer)),
          ServerSettings.ServerSettingsService.layerTest(),
          Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({}),
          Layer.mock(GitHubRest.GitHubRest)({}),
          // The GitHub provider's GraphQL reads go through these; no test here makes one.
          Layer.mock(GitHubRequestPolicy.GitHubRequestPolicy)({}),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die(new Error("Unexpected GitHub GraphQL read"))),
          ),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({}),
          Layer.mock(VcsProcess.VcsProcess)(input.process),
          ServerSourceControlHost.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(VcsProcess.VcsProcess)(input.process),
                ServerSettings.ServerSettingsService.layerTest(),
                Layer.mock(GitVcsDriver.GitVcsDriver)({}),
                Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({}),
              ),
            ),
          ),
        ),
      ),
    )
    .pipe(Layer.provideMerge(NodeServices.layer));

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

it.effect("discovers GitHub as the only built-in hosting integration", () =>
  Effect.gen(function* () {
    const registry = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
    const providers = yield* registry.discover;
    assert.deepStrictEqual(
      providers.map((provider) => provider.kind),
      ["github"],
    );
  }).pipe(
    Effect.provide(
      layerSourceControlProviderRegistryTest({
        process: {
          run: (input) =>
            Effect.fail(
              new VcsProcessSpawnError({
                operation: input.operation,
                command: input.command,
                cwd: input.cwd,
                cause: "not installed",
              }),
            ),
        },
      }),
    ),
    Effect.scoped,
  ),
);
