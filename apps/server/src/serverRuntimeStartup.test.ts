import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { CommandId, ProjectId, ProviderInstanceId } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "./config.ts";
import * as Startup from "./serverRuntimeStartup.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "./orchestration-v2/ThreadLaunchService.ts";
import * as ServerSettings from "./serverSettings.ts";

const projectId = ProjectId.make("project:bootstrap");
const failures = [
  new ThreadManagement.ThreadManagementProviderInstanceDisabledError({
    projectId,
    instanceId: ProviderInstanceId.make("claude"),
  }),
  new ThreadLaunch.ThreadLaunchError({
    projectId,
    commandId: CommandId.make("command:bootstrap"),
    operation: "create-thread",
    cause: null,
  }),
];

it.effect.each(failures)(
  "continues startup when the optional bootstrap launch fails with $_tag",
  (failure) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const result = yield* Startup.resolveAutoBootstrapWelcomeTargets.pipe(
        Effect.provideService(ServerConfig.ServerConfig, {
          ...config,
          autoBootstrapProjectFromCwd: true,
        }),
      );
      expect(result).toEqual({ bootstrapProjectId: projectId });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProjectService.ProjectService)({
            bootstrap: () =>
              Effect.succeed({
                created: true,
                project: {
                  id: projectId,
                  title: "Bootstrap",
                  workspaceRoot: "/tmp/bootstrap",
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-01T00:00:00Z",
                  deletedAt: null,
                },
              }),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 2,
                snapshotSequence: 0,
                threads: [],
                archivedThreads: [],
              }),
          }),
          Layer.mock(ThreadLaunch.ThreadLaunchService)({ launch: () => failure }),
          ServerSettings.layerTest(),
          ServerConfig.layerTest("/tmp/bootstrap", { prefix: "cogenly-bootstrap-" }),
        ).pipe(Layer.provideMerge(NodeCrypto.layer), Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);
