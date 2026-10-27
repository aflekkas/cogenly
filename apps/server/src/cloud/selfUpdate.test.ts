import { describe, expect, it } from "@effect/vitest";
import { ServerSelfUpdateError, ThreadId } from "@cogenly/contracts";
import * as HostProcess from "@cogenly/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { FetchHttpClient } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProcessRunner from "../processRunner.ts";
import { pinnedRuntimePaths } from "./pinnedRuntime.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";

const layer = Layer.mergeAll(
  ServerConfig.layerTest("/tmp", { prefix: "cogenly-update-race-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  NodeServices.layer,
  FetchHttpClient.layer,
  ThreadCommandExecutor.layer,
);

describe("automatic update staging", () => {
  it.effect("keeps the runtime staged when work starts before activation, and retries later", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const commands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const runtime = pinnedRuntimePaths(path, config.baseDir, "0.3.4", "darwin");
      yield* fs.makeDirectory(runtime.versionDir, { recursive: true });
      yield* fs.writeFileString(runtime.entryPath, "staged runtime");
      yield* fs.writeFileString(runtime.sentinelPath, "0.3.4\n");
      const validating = yield* Deferred.make<void>();
      const validated = yield* Deferred.make<void>();
      const requested = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<void>();
      let activations = 0;
      let activeWork = false;
      const updater = yield* ServerSelfUpdate.make().pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(DesktopAppUpdate.DesktopAppUpdate)({ available: false }),
            Layer.mock(ServiceLauncherClient.ServiceLauncherClient)({
              managed: true,
              requestUpdate: () =>
                Effect.sync(() => {
                  activations++;
                }).pipe(
                  Effect.andThen(Deferred.succeed(requested, undefined)),
                  Effect.andThen(Deferred.await(accepted)),
                  Effect.as("update-id"),
                ),
            }),
            Layer.mock(ProcessRunner.ProcessRunner)({
              run: () =>
                Deferred.succeed(validating, undefined).pipe(
                  Effect.andThen(Deferred.await(validated)),
                  Effect.as({
                    code: ChildProcessSpawner.ExitCode(0),
                    stdout: JSON.stringify({
                      status: "ready",
                      version: "0.3.4",
                      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
                    }),
                    stderr: "",
                    timedOut: false,
                    stdoutTruncated: false,
                    stderrTruncated: false,
                    stdoutInvalidUtf8: false,
                    stderrInvalidUtf8: false,
                  }),
                ),
            }),
          ),
        ),
      );
      const beforeHandoff = () =>
        activeWork
          ? Effect.fail(
              new ServerSelfUpdateError({ reason: ServerSelfUpdate.AUTO_UPDATE_BUSY_REASON }),
            )
          : Effect.void;
      const update = updater.update(
        { targetVersion: "0.3.4" },
        undefined,
        undefined,
        beforeHandoff,
      );
      const pending = yield* update.pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(validating);
      // A turn is admitted and committed while runtime validation is still staging.
      yield* commands.withLock(
        ThreadId.make("work"),
        Effect.sync(() => {
          activeWork = true;
        }),
      );
      yield* Deferred.succeed(validated, undefined);
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "Failure",
        failure: { reason: ServerSelfUpdate.AUTO_UPDATE_BUSY_REASON },
      });
      expect(activations).toBe(0);
      expect(yield* fs.readFileString(runtime.entryPath)).toBe("staged runtime");
      expect(yield* fs.readFileString(runtime.sentinelPath)).toBe("0.3.4\n");
      // Deferral reset the in-flight flag and reopened admission.
      yield* commands.withLock(
        ThreadId.make("work"),
        Effect.sync(() => {
          activeWork = false;
        }),
      );
      const retry = yield* update.pipe(Effect.forkChild);
      yield* Deferred.await(requested);
      const newTurn = yield* commands
        .withLock(
          ThreadId.make("new-turn"),
          Effect.sync(() => {
            activeWork = true;
          }),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      expect(activeWork).toBe(false);
      yield* Deferred.succeed(accepted, undefined);
      expect(yield* Fiber.join(retry)).toMatchObject({ updateId: "update-id" });
      expect(activations).toBe(1);
      expect(activeWork).toBe(false);
      yield* Fiber.interrupt(newTurn);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
