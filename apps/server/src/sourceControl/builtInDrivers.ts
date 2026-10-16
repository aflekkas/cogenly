/**
 * The source control drivers this build ships with. Both registries, repository operations and
 * pull requests, iterate this list; a host with no driver here shows up as unsupported.
 *
 * Adding a host means writing its `@t3tools/source-control-<host>` package, adding its driver
 * here, and providing its services' layers in `layer` below.
 *
 * @module sourceControl/builtInDrivers
 */
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";
import * as GitHubDriver from "@t3tools/source-control-github/server/driver";
import type { SourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Layer from "effect/Layer";

import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";

const drivers = [GitHubDriver.driver];

/** Every service a built-in driver's `make` needs; the server's layers must provide them all. */
export type BuiltInSourceControlDriversEnv =
  (typeof drivers)[number] extends SourceControlDriver<infer R> ? R : never;

/** Ordered as the hosts appear in discovery. */
export const BUILT_IN_SOURCE_CONTROL_DRIVERS: ReadonlyArray<
  SourceControlDriver<BuiltInSourceControlDriversEnv>
> = drivers;

/** The services the built-in drivers' packages own, plus the host port they all run against. */
export const layer = Layer.mergeAll(
  // `GitHubRest.layerWithDependencies` carries the quota reserve and rate-limit pause every GitHub
  // reader shares, so the server builds it once, here.
  GitHubPullRequestApi.layer.pipe(Layer.provideMerge(GitHubRest.layerWithDependencies)),
).pipe(Layer.provideMerge(ServerSourceControlHost.layer));
