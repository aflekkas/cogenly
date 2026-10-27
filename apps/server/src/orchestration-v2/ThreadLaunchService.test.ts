import * as Sqlite from "../persistence/Sqlite.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProjectLabelError,
  ProjectLabelId,
  ProviderInstanceId,
  RunId,
  RuntimeMode,
  ThreadId,
  ThreadRemoteError,
  type OrchestrationV2ThreadProjection,
} from "@cogenly/contracts";
import * as IdAllocator from "@cogenly/provider-core/server/IdAllocator";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as RepositoryCheckout from "../project/RepositoryCheckout.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectLabelService from "../projectLabels/ProjectLabelService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as RemoteThreadLaunch from "./RemoteThreadLaunch.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";

const projectId = ProjectId.make("project:scratch");
const threadId = ThreadId.make("thread:draft");
const folderId = ProjectLabelId.make("label:spawn-partners");
const runId = RunId.make("run:first");
const providerInstanceId = ProviderInstanceId.make("codex");

type Step =
  | { readonly kind: "dispatch"; readonly type: string }
  | { readonly kind: "read-label"; readonly id: ProjectLabelId }
  | { readonly kind: "file"; readonly threadId: ThreadId; readonly folderId: string | null }
  | { readonly kind: "checkout"; readonly repositoryId: ProjectId };

function harness(
  options: {
    readonly repositoryMismatch?: boolean;
    readonly labelMissing?: boolean;
    readonly labelArchived?: boolean;
    readonly checkoutFails?: boolean;
    readonly filedRepository?: boolean;
    readonly runPreparing?: boolean;
    readonly clonePhase?: "running" | "failed" | "cancelled" | null;
    readonly checkoutGate?: Deferred.Deferred<void>;
  } = {},
) {
  const steps: Step[] = [];
  const createdWorktreePaths: Array<string | null> = [];
  const projection = {
    thread: { id: threadId, projectId, worktreePath: "/scratch/draft" },
    runs: [{ id: runId, status: options.runPreparing === true ? "preparing" : "running" }],
    messages: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const database = Sqlite.layerMemory;
  const preparedDatabase = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO project_labels(label_id, name, created_at, updated_at) VALUES (${folderId}, 'Spawn Partners', '2026-01-01', '2026-01-01')`;
      yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${projectId}, 'cogenly', '/repos/cogenly', '[]', '2026-01-01', '2026-01-01')`;
      if (!options.repositoryMismatch)
        yield* sql`INSERT INTO label_repositories(label_id, repository_id) VALUES (${folderId}, ${projectId})`;
    }),
  ).pipe(Layer.provideMerge(database));
  const layer = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome({ id: projectId, workspaceRoot: "/scratch" } as never),
        }),
        Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({
          stageStatus: () => Effect.void,
          markUncancellable: () => Effect.void,
          finish: () => Effect.succeed(null),
        }),
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({
          get: () =>
            Effect.succeed(
              options.clonePhase == null ? null : ({ phase: options.clonePhase } as never),
            ),
        }),
        Layer.mock(TerminalManager.TerminalManager)({}),
        Layer.mock(GitWorkflow.GitWorkflowService)({}),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" } as never),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ServerSettings.ServerSettingsService)({}),
        Layer.mock(TextGeneration.TextGeneration)({}),
        Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
          getByCommandId: () => Effect.succeedNone,
        }),
        // Ids come from the input; nothing is allocated.
        Layer.succeed(IdAllocator.IdAllocatorV2, {} as IdAllocator.IdAllocatorV2["Service"]),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          // Scratch threads filed in a project run in its folder.
          folderForThread: (input) =>
            Effect.succeedSome(
              input.labelId === undefined ? "/scratch/draft" : `/projects/${input.labelId}`,
            ),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          assertProviderInstanceEnabled: () => Effect.void,
          dispatch: (command) =>
            Effect.sync(() => {
              steps.push({ kind: "dispatch", type: command.type });
              if (command.type === "thread.create") {
                createdWorktreePaths.push(command.worktreePath ?? null);
              }
              const event =
                command.type === "message.dispatch"
                  ? { type: "run.created", threadId, payload: { id: runId } }
                  : { type: "thread.created", threadId };
              return { storedEvents: [{ event }] } as never;
            }),
          getThreadProjection: () => Effect.succeed(projection),
          getThreadRecords: () =>
            Effect.succeed({
              runs:
                options.runPreparing === true
                  ? [{ id: runId, status: "preparing" }]
                  : [{ id: runId, status: "running" }],
            } as never),
        }),
        Layer.mock(RepositoryCheckout.RepositoryCheckout)({
          ensureCheckout: (repositoryId) =>
            Effect.suspend(() => {
              steps.push({ kind: "checkout", repositoryId });
              const checked =
                options.checkoutFails === true
                  ? Effect.fail(
                      new RepositoryCheckout.RepositoryCheckoutError({
                        repositoryId,
                        repositoryName: "smile-express",
                        reason: "no_remote",
                      }),
                    )
                  : Effect.void;
              return options.checkoutGate === undefined
                ? checked
                : Deferred.await(options.checkoutGate).pipe(Effect.andThen(checked));
            }),
        }),
        Layer.mock(ProjectLabelService.ProjectLabelService)({
          list: () =>
            Effect.succeed({
              labels:
                options.filedRepository === true
                  ? [
                      {
                        repositories: [
                          {
                            repositoryId: projectId,
                            remote: "github.com/spawn/smile-express",
                            directoryName: "smile-express",
                          },
                        ],
                      },
                    ]
                  : [],
            } as never),
          readActive: (id) =>
            Effect.suspend(() => {
              steps.push({ kind: "read-label", id });
              return options.labelMissing === true
                ? Effect.fail(new ProjectLabelError({ operation: "read", reason: "not_found" }))
                : options.labelArchived === true
                  ? Effect.fail(
                      new ProjectLabelError({
                        operation: "readActive",
                        reason: "archived",
                        projectName: "Spawn Partners",
                      }),
                    )
                  : Effect.succeed({ label: { id } as never });
            }),
          moveThread: (input) =>
            Effect.sync(() => {
              steps.push({ kind: "file", threadId: input.threadId, folderId: input.folderId });
              return { threadId: input.threadId, projectFolderId: input.folderId } as never;
            }),
        }),
      ),
    ),
  );
  return {
    steps,
    createdWorktreePaths,
    layer: layer.pipe(Layer.provide(preparedDatabase), Layer.provide(NodeServices.layer)),
  };
}

const launchInput = (overrides: Partial<ThreadLaunch.ThreadLaunchInput> = {}) =>
  ({
    commandId: CommandId.make("command:first-send"),
    threadId,
    projectId,
    title: "Plan the offsite",
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.5" },
    runtimeMode: Schema.decodeSync(RuntimeMode)("full-access"),
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: {
      messageId: MessageId.make("message:first"),
      text: "Plan the offsite",
      attachments: [],
    },
    createdBy: "user",
    creationSource: "web",
    ...overrides,
  }) satisfies ThreadLaunch.ThreadLaunchInput;

describe("ThreadLaunchService project filing", () => {
  it.effect(
    "rejects a repository outside the explicit project before creating or filing a thread",
    () => {
      const { steps, layer } = harness({ repositoryMismatch: true });
      return Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const error = yield* Effect.flip(
          launches.launch(launchInput({ projectFolderId: folderId })),
        );
        expect(userFacingDispatchErrorMessage(error)).toBe(
          "cogenly is not in the Spawn Partners project. Add it to the project first, or start without a project.",
        );
        expect(steps).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("files a chat in its project while it is turnless, before the first message", () => {
    const { steps, layer } = harness();
    return Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      yield* launches.launch(launchInput({ projectFolderId: folderId }));
      expect(steps).toEqual([
        { kind: "read-label", id: folderId },
        { kind: "dispatch", type: "thread.create" },
        { kind: "file", threadId, folderId },
        { kind: "dispatch", type: "message.dispatch" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("runs repository-less Work filed in a project in the project's folder", () => {
    const { createdWorktreePaths, layer } = harness();
    return Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      yield* launches.launch(launchInput({ surface: "work", projectFolderId: folderId }));
      expect(createdWorktreePaths).toEqual([`/projects/${folderId}`]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("runs unfiled repository-less Work in a scratch folder of its own", () => {
    const { createdWorktreePaths, layer } = harness();
    return Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      yield* launches.launch(launchInput({ surface: "work" }));
      expect(createdWorktreePaths).toEqual(["/scratch/draft"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("files nothing when no project was picked", () => {
    const { steps, layer } = harness();
    return Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      yield* launches.launch(launchInput());
      expect(steps).toEqual([
        { kind: "dispatch", type: "thread.create" },
        { kind: "dispatch", type: "message.dispatch" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a missing project before creating the thread", () => {
    const { steps, layer } = harness({ labelMissing: true });
    return Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const error = yield* Effect.flip(launches.launch(launchInput({ projectFolderId: folderId })));
      expect(error._tag).toBe("ThreadLaunchError");
      expect(steps).toEqual([{ kind: "read-label", id: folderId }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("creates the thread immediately and checks out in background preparation", () =>
    Effect.gen(function* () {
      // Background preparation may start the checkout before the launch
      // returns; the gate holds it so the test sees the launch finish first.
      const gate = yield* Deferred.make<void>();
      const { steps, layer } = harness({
        filedRepository: true,
        runPreparing: true,
        checkoutGate: gate,
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        yield* launches.launch(launchInput({ surface: "work" }));
        // The launch itself never waits for a clone, and the run stays held.
        expect(steps).toContainEqual({ kind: "dispatch", type: "thread.create" });
        expect(steps).not.toContainEqual({ kind: "dispatch", type: "prepared-run.release" });
        yield* Deferred.succeed(gate, undefined);
        // Background preparation ensures the checkout, then releases the run.
        for (let i = 0; i < 50 && !steps.some((step) => step.kind === "checkout"); i++) {
          yield* Effect.yieldNow;
        }
        expect(steps).toContainEqual({ kind: "checkout", repositoryId: projectId });
        for (
          let i = 0;
          i < 50 &&
          !steps.some((step) => step.kind === "dispatch" && step.type === "prepared-run.release");
          i++
        ) {
          yield* Effect.yieldNow;
        }
        expect(steps).toContainEqual({ kind: "dispatch", type: "prepared-run.release" });
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not block the launch while a clone is still running", () => {
    return Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const { steps, layer } = harness({
        filedRepository: true,
        runPreparing: true,
        clonePhase: "running",
        checkoutGate: gate,
      });
      const launches = yield* ThreadLaunch.ThreadLaunchService.pipe(Effect.provide(layer));
      const fiber = yield* Effect.forkScoped(launches.launch(launchInput({ surface: "work" })));
      for (let i = 0; i < 50 && fiber.pollUnsafe() === undefined; i++) {
        yield* Effect.yieldNow;
      }
      // The launch completed even though the background checkout is gated.
      expect(fiber.pollUnsafe()).toBeDefined();
      expect(steps).toContainEqual({ kind: "dispatch", type: "thread.create" });
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(fiber);
    });
  });

  it.effect(
    "a launch after a failed clone retries it in preparation, failing the run visibly",
    () => {
      const { steps, layer } = harness({
        filedRepository: true,
        checkoutFails: true,
        runPreparing: true,
        clonePhase: "failed",
      });
      return Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        // No "retry the clone first" rejection: the thread is created and its
        // preparation retries the checkout.
        yield* launches.launch(launchInput({ surface: "work" }));
        expect(steps).toContainEqual({ kind: "dispatch", type: "thread.create" });
        for (
          let i = 0;
          i < 50 &&
          !steps.some((step) => step.kind === "dispatch" && step.type === "prepared-run.fail");
          i++
        ) {
          yield* Effect.yieldNow;
        }
        expect(steps).toContainEqual({ kind: "checkout", repositoryId: projectId });
        expect(steps).toContainEqual({ kind: "dispatch", type: "prepared-run.fail" });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("refuses an archived project before creating the thread, saying why", () => {
    const { steps, layer } = harness({ labelArchived: true });
    return Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const error = yield* Effect.flip(launches.launch(launchInput({ projectFolderId: folderId })));
      expect(error._tag).toBe("ThreadLaunchError");
      expect(userFacingDispatchErrorMessage(error)).toBe(
        "Spawn Partners is archived. Unarchive it to add to it.",
      );
      expect(steps).toEqual([{ kind: "read-label", id: folderId }]);
    }).pipe(Effect.provide(layer));
  });
});

describe("ThreadLaunchService on a chosen machine", () => {
  const laptop = EnvironmentId.make("env:laptop");
  /** A harness whose machine link answers every launch with `answer`. */
  const onMachine = (
    answer: (
      input: ThreadLaunch.ThreadLaunchInput,
    ) => Effect.Effect<Option.Option<ThreadLaunch.ThreadLaunchResult>, ThreadRemoteError>,
  ) => {
    const { steps, layer } = harness();
    const asked: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const run = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        ThreadLaunch.ThreadLaunchService | RemoteThreadLaunch.RemoteThreadLaunch
      >,
    ) =>
      Effect.gen(function* () {
        const registry = yield* RemoteThreadLaunch.RemoteThreadLaunch;
        yield* registry.register((machine, input) => {
          expect(machine).toBe(laptop);
          asked.push(input);
          return answer(input);
        });
        return yield* effect;
      }).pipe(
        Effect.scoped,
        Effect.provide(layer.pipe(Layer.provideMerge(RemoteThreadLaunch.layer))),
      );
    return { steps, asked, run };
  };

  it.effect("hands the launch to the machine link and creates nothing here", () => {
    const remote = { threadId, projection: {} as never, resumed: false };
    const { steps, asked, run } = onMachine(() => Effect.succeedSome(remote));
    return run(
      Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        expect(yield* launches.launch(launchInput({ machine: laptop }))).toBe(remote);
        expect(steps).toEqual([]);
        // The machine is the link's business; the launch it carries is the same.
        expect(asked).toEqual([launchInput()]);
      }),
    );
  });

  it.effect("launches here when the named machine is this one", () => {
    const { steps, run } = onMachine(() => Effect.succeedNone);
    return run(
      Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        yield* launches.launch(launchInput({ machine: laptop }));
        expect(steps.map((step) => step.kind)).toEqual(["dispatch", "dispatch"]);
      }),
    );
  });

  it.effect("fails with the machine's own reason when it is offline", () => {
    const offline = new ThreadRemoteError({
      reason: "offline",
      detail: "Laptop is offline. Launch on this machine instead, or try again when it reconnects.",
    });
    const { steps, run } = onMachine(() => Effect.fail(offline));
    return run(
      Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const error = yield* Effect.flip(launches.launch(launchInput({ machine: laptop })));
        expect(error.message).toBe(offline.detail);
        expect(ThreadLaunch.remoteLaunchFailure(error)?.reason).toBe("offline");
        expect(steps).toEqual([]);
      }),
    );
  });
});
