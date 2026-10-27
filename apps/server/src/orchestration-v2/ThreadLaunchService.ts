import * as Membership from "../projectLabels/ProjectRepositoryMembership.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import {
  isRemoteRepositoryPlaceholder,
  ProjectRepositoryMismatchError,
  CommandId,
  type ChatAttachment,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2ProviderThreadNativeMetadata,
  type OrchestrationV2ThreadProjection,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  ProjectId,
  type ProjectLabelId,
  type RunId,
  type RuntimeMode,
  type ScheduledTaskId,
  type EnvironmentId,
  ThreadId,
  ThreadRemoteError,
} from "@cogenly/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  buildWorktreeBranchName,
  flattenTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  WORKTREE_BRANCH_PREFIX,
  worktreeFolderSlug,
} from "@cogenly/shared/git";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryCheckout from "../project/RepositoryCheckout.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectLabelService from "../projectLabels/ProjectLabelService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as RemoteThreadLaunch from "./RemoteThreadLaunch.ts";
import * as IdAllocator from "@cogenly/provider-core/server/IdAllocator";
import type * as Orchestrator from "./Orchestrator.ts";
import { makeProviderFailure } from "@cogenly/provider-core/server/failure";
import * as ThreadManagement from "./ThreadManagementService.ts";

export type ThreadLaunchWorkspaceStrategy =
  | { readonly type: "root"; readonly branch?: string | undefined }
  | {
      readonly type: "existing_worktree";
      readonly worktreePath: string;
      readonly branch?: string | undefined;
    }
  | {
      readonly type: "worktree";
      readonly baseRef: string;
      readonly branch?: string | undefined;
      readonly startFromOrigin?: boolean | undefined;
    };

export interface ThreadLaunchInitialMessage {
  readonly messageId?: MessageId;
  readonly scheduledTaskId?: ScheduledTaskId;
  readonly senderThreadId?: ThreadId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: import("@cogenly/contracts").OrchestrationMessageContext | undefined;
}

export interface ThreadLaunchInput {
  readonly fork?: import("@cogenly/contracts").ThreadLaunchFork;
  readonly repositorySource?: { readonly cwd: string; readonly revision: string };
  readonly subagent?: import("@cogenly/contracts").ThreadLaunchSubagent;
  readonly surface?: import("@cogenly/contracts").ThreadSurface;
  readonly workOrigin?: import("@cogenly/contracts").WorkOrigin;
  readonly sourceThreadId?: ThreadId;
  readonly sourceAgentId?: import("@cogenly/contracts").AgentId;
  readonly sourceAgentRunId?: string;
  readonly agent?: {
    readonly id: import("@cogenly/contracts").AgentId;
    readonly role: "conversation" | "work";
  };
  readonly commandId: CommandId;
  readonly threadId?: ThreadId;
  readonly reuseExistingThread?: boolean;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly generateTitle?: boolean;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceStrategy: ThreadLaunchWorkspaceStrategy;
  /**
   * The project the new thread is filed in before its first message, so a
   * chat starts in its project (and its project dir) rather than being moved
   * there once it has turns, which the re-parenting gate refuses.
   */
  readonly projectFolderId?: ProjectLabelId;
  readonly handoffSummary?: string;
  readonly handoffContext?: import("@cogenly/contracts").OrchestrationV2WorkHandoffContext;
  readonly initialMessage?: ThreadLaunchInitialMessage;
  readonly importedNativeThread?: {
    readonly ref: {
      readonly driver: ProviderDriverKind;
      readonly nativeId: string;
      readonly strength: "strong";
    };
    readonly metadata?: OrchestrationV2ProviderThreadNativeMetadata;
  };
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  /**
   * The paired machine that runs the thread from its first event. Omitted or
   * this machine's id launches here. Another machine gets the launch over the
   * machine link and creates the thread itself; an offline one fails the
   * launch, never queues it.
   */
  readonly machine?: EnvironmentId | undefined;
}

/** What workspace preparation reads from a launch; a retry rebuilds it from the run. */
type PreparationInput = Pick<
  ThreadLaunchInput,
  "commandId" | "projectId" | "workspaceStrategy" | "initialMessage"
> & {
  /**
   * Set when a retry reuses the worktree its failed attempt created and
   * recorded. Its setup is tracked like a new one, but the thread already
   * records the workspace, and a branch rename may still be running.
   */
  readonly reusedWorktree?: { readonly baseRef: string };
};

export interface ThreadLaunchPreparationInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
}

export interface ThreadLaunchResult {
  readonly threadId: ThreadId;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly resumed: boolean;
}

export class ThreadLaunchError extends Schema.TaggedError<ThreadLaunchError>()(
  "ThreadLaunchError",
  {
    operation: Schema.Literals([
      "resolve-project",
      "read-receipt",
      "generate-metadata",
      "provision-worktree",
      "run-setup-script",
      "create-thread",
      "update-thread",
      "dispatch-message",
      "release-run",
      "fail-run",
      // The machine asked to run the thread refused it or could not be reached.
      "launch-remote",
    ]),
    commandId: CommandId,
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const remote = remoteLaunchFailure(this);
    return remote?.message ?? `Thread launch ${this.commandId} failed during ${this.operation}.`;
  }
}

const isThreadRemoteError = Schema.is(ThreadRemoteError);

/** Why another machine did not take a launch; undefined for a launch that failed here. */
export const remoteLaunchFailure = (error: {
  readonly _tag: string;
  readonly operation?: string;
  readonly cause?: unknown;
}): ThreadRemoteError | undefined =>
  error._tag === "ThreadLaunchError" &&
  error.operation === "launch-remote" &&
  isThreadRemoteError(error.cause)
    ? error.cause
    : undefined;

/** A new worktree was asked to start from a ref that gives it no commit. */
export class ThreadLaunchBaseRefError extends Schema.TaggedError<ThreadLaunchBaseRefError>()(
  "ThreadLaunchBaseRefError",
  {
    projectId: ProjectId,
    projectTitle: Schema.String,
    workspaceRoot: Schema.String,
    baseRef: Schema.String,
  },
) {
  override get message(): string {
    return `Base ref "${this.baseRef}" does not resolve to a commit in project "${this.projectTitle}" (${this.workspaceRoot}).`;
  }
}

export class ThreadLaunchService extends Context.Service<
  ThreadLaunchService,
  {
    readonly providers: (
      machine: EnvironmentId,
    ) => Effect.Effect<
      { providers: ReadonlyArray<import("@cogenly/contracts").ServerProvider> },
      ThreadRemoteError
    >;
    readonly validateProjectRepository: Membership.ProjectRepositoryMembership["Service"]["validate"];
    readonly launch: (
      input: ThreadLaunchInput,
    ) => Effect.Effect<
      ThreadLaunchResult,
      | ProjectRepositoryMismatchError
      | ThreadLaunchError
      | ThreadManagement.ThreadManagementProviderInstanceDisabledError
    >;
    /**
     * Fails when a new worktree's base ref cannot give provisioning a commit.
     * `launch` accepts such a launch and reports the failure inside the
     * thread; a caller that needs it before a thread exists checks first.
     */
    readonly checkWorktreeBase: (
      input: Pick<ThreadLaunchInput, "projectId" | "workspaceStrategy">,
    ) => Effect.Effect<void, ThreadLaunchBaseRefError>;
    /** Dispatches prepared-run.retry and prepares the run's workspace again. */
    readonly retryPreparation: (input: ThreadLaunchPreparationInput) => Effect.Effect<
      Orchestrator.OrchestratorV2DispatchResult,
      // Dispatches prepared-run.retry, a command the enablement chokepoint
      // never gates; the type stays accurate anyway.
      | Orchestrator.OrchestratorV2Error
      | ThreadManagement.ThreadManagementProviderInstanceDisabledError
    >;
    readonly prepareRun: (input: ThreadLaunchPreparationInput) => Effect.Effect<void>;
  }
>()("cogenly-server/orchestration-v2/ThreadLaunchService") {}

const isThreadLaunchError = Schema.is(ThreadLaunchError);

function failureDetail(error: unknown): string {
  if (isThreadLaunchError(error)) {
    const cause = error.cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    return `Workspace preparation failed during ${error.operation.replaceAll("-", " ")}: ${detail}`;
  }
  return `Workspace preparation failed: ${error instanceof Error ? error.message : String(error)}`;
}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const membership = yield* Membership.ProjectRepositoryMembership;
  const setupTracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
  const terminals = yield* TerminalManager.TerminalManager;
  const git = yield* GitWorkflow.GitWorkflowService;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  // Optional so launch-only test layers still resolve; production provides
  // it, and a launch that names a project fails without it.
  const projectLabels = yield* Effect.serviceOption(ProjectLabelService.ProjectLabelService);
  // Optional for the same reason: without it launches keep their old
  // behavior; production always provides it.
  const repositoryCheckout = yield* Effect.serviceOption(RepositoryCheckout.RepositoryCheckout);
  // Optional too: without it a launch naming a machine fails.
  const remoteLaunch = yield* Effect.serviceOption(RemoteThreadLaunch.RemoteThreadLaunch);
  const preparationScope = yield* Scope.make("sequential");
  const scheduledLaunches = yield* Ref.make<ReadonlySet<CommandId>>(new Set());
  yield* Effect.addFinalizer(() => Scope.close(preparationScope, Exit.void));

  const mapError =
    (input: PreparationInput, operation: ThreadLaunchError["operation"], threadId?: ThreadId) =>
    (cause: unknown) =>
      new ThreadLaunchError({
        operation,
        commandId: input.commandId,
        projectId: input.projectId,
        ...(threadId === undefined ? {} : { threadId }),
        cause,
      });

  const readReceipt = (input: ThreadLaunchInput, commandId: CommandId) =>
    receipts
      .getByCommandId(commandId)
      .pipe(Effect.mapError(mapError(input, "read-receipt", input.threadId)));

  /**
   * A launch into a repository must land in a real checkout: clone a
   * missing or empty one in place first, or fail before an agent starts.
   * Applies to worktree launches (which need git) and to launches into a
   * repository filed in a project; repository-less launches (Scratch and
   * project folders) are untouched. Every launch path funnels through
   * here: Work handoffs and `work_start`, `thread_launch`, delegated
   * worktree tasks (via `prepareRun`), and scheduled tasks.
   */
  const ensureLaunchCheckout = (
    input: PreparationInput,
    threadId?: ThreadId,
  ): Effect.Effect<void, ThreadLaunchError> =>
    Effect.gen(function* () {
      if (Option.isNone(repositoryCheckout)) return;
      const filed =
        input.workspaceStrategy.type === "worktree"
          ? true
          : yield* Option.match(projectLabels, {
              onNone: () => Effect.succeed(false),
              onSome: (labels) =>
                labels.list().pipe(
                  Effect.map(({ labels: all }) =>
                    all.some((label) =>
                      (label.repositories ?? []).some(
                        (link) => link.repositoryId === input.projectId,
                      ),
                    ),
                  ),
                  Effect.orElseSucceed(() => false),
                ),
            });
      if (!filed) return;
      yield* repositoryCheckout.value.ensureCheckout(input.projectId);
    }).pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));

  const validateReusableThread = Effect.fn("ThreadLaunchService.validateReusableThread")(function* (
    input: ThreadLaunchInput,
    threadId: ThreadId,
  ) {
    const projection = yield* threads
      .getThreadRecords(threadId, ["runs"])
      .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
    if (
      projection.thread.projectId !== input.projectId ||
      projection.thread.archivedAt !== null ||
      projection.thread.deletedAt !== null ||
      (yield* threads
        .getMessageCount(threadId)
        .pipe(Effect.mapError(mapError(input, "update-thread", threadId)))) > 0 ||
      projection.runs.length > 0
    ) {
      return yield* mapError(
        input,
        "update-thread",
        threadId,
      )("Only an empty active thread in the target project can change workspace during launch.");
    }
  });

  const checkWorktreeBase: ThreadLaunchService["Service"]["checkWorktreeBase"] = Effect.fn(
    "ThreadLaunchService.checkWorktreeBase",
  )(function* (input) {
    const strategy = input.workspaceStrategy;
    // `:/text` is a commit search, which cannot be asked for a commit type.
    if (strategy.type !== "worktree" || strategy.baseRef.startsWith(":")) return;
    const { baseRef } = strategy;
    // Anything this cannot establish is left for the launch to report: a
    // missing project, a folder that is not a repository, a failing Git.
    const unresolved = yield* Effect.gen(function* () {
      const project = Option.getOrUndefined(yield* projects.getById(input.projectId));
      if (project === undefined) return undefined;
      const cwd = project.workspaceRoot;
      // `git worktree add` reads `-` as the previous checkout.
      if (yield* git.hasCommit({ cwd, refName: baseRef === "-" ? "@{-1}" : baseRef }))
        return undefined;
      // Provisioning fetches the base from origin when it can, and runs a
      // repository with no commits yet without a worktree.
      if (
        strategy.startFromOrigin === true &&
        (yield* git.remoteExists({ cwd, remoteName: "origin" }))
      )
        return undefined;
      // `git worktree add` also starts from a remote-tracking branch of that
      // name; any ref carrying it is reason enough to let Git decide.
      if (yield* git.hasRefNamed({ cwd, refName: baseRef })) return undefined;
      return (yield* git.hasCommit({ cwd, refName: "HEAD" })) ? project : undefined;
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (unresolved !== undefined)
      return yield* new ThreadLaunchBaseRefError({
        projectId: unresolved.id,
        projectTitle: unresolved.title,
        workspaceRoot: unresolved.workspaceRoot,
        baseRef,
      });
  });

  const prepareInBackground = Effect.fn("ThreadLaunchService.prepareInBackground")(function* (
    input: PreparationInput,
    threadId: ThreadId,
    runId: RunId | null,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError(mapError(input, "resolve-project", threadId)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(mapError(input, "resolve-project", threadId)("Project no longer exists.")),
          onSome: Effect.succeed,
        }),
      ),
    );

    yield* ensureLaunchCheckout(input, threadId);

    const reused = input.reusedWorktree;
    const tracked = input.workspaceStrategy.type === "worktree" || reused !== undefined;
    let createdWorktreePath: string | null = null;
    let setupTerminalId: string | null = null;
    let workspaceRecorded = false;
    let runReleased = false;
    if (input.workspaceStrategy.type === "worktree") {
      yield* setupTracker.begin({
        threadId,
        branch: input.workspaceStrategy.branch ?? null,
        baseRef: input.workspaceStrategy.baseRef,
        stages: ["fetch", "checkout", "setup-script", "agent"],
        fiber: yield* Effect.fiber,
      });
    } else if (reused !== undefined) {
      yield* setupTracker.begin({
        threadId,
        branch: input.workspaceStrategy.branch ?? null,
        baseRef: reused.baseRef,
        stages: ["setup-script", "agent"],
        fiber: yield* Effect.fiber,
      });
    }
    yield* Effect.gen(function* () {
      const initialMessage = input.initialMessage;
      const generateBranchNameFor = (cwd: string, message: ThreadLaunchInitialMessage) =>
        Effect.gen(function* () {
          const settings = yield* serverSettings.getSettings;
          const modelSelection =
            settings.sourceControlWriterModelSelection === null
              ? settings.textGenerationModelSelection
              : ServerSettings.resolveSourceControlWriterModelSelection(
                  settings,
                  yield* providerRegistry.getProviders,
                );
          return yield* textGeneration
            .generateBranchName({
              naming: {
                mode: settings.branchNamingMode,
                prefix: settings.branchNamePrefix,
                instructions: settings.branchNameInstructions,
              },
              cwd,
              message: message.text,
              attachments: message.attachments,
              ...(message.context ? { context: message.context } : {}),
              modelSelection,
            })
            .pipe(
              Effect.map((result) => ({
                branch: result.branch,
                exactName: settings.branchNamingMode === "custom",
              })),
            );
        });

      // The server owns worktree naming: without an explicit branch, decide
      // the final name before the worktree exists (a deterministic
      // `c/<slug>` from the request text), so the worktree folder, named by
      // the slug, never has to move and no rename follows. Temporary
      // branches sent by older clients are still renamed in the background
      // below.
      const requestedBranch = input.workspaceStrategy.branch;
      let branch: string | null;
      if (input.workspaceStrategy.type === "worktree" && requestedBranch === undefined) {
        const existing = yield* git.listLocalBranchNames(project.workspaceRoot).pipe(
          // Dedup is best-effort: an unreadable branch list just means the
          // first slug is tried and Git reports a real collision.
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed([] as Array<string>),
          ),
        );
        branch = buildWorktreeBranchName(initialMessage?.text ?? "", {
          branches: existing,
          folders: existing.map(worktreeFolderSlug),
        }).branch;
      } else {
        branch = requestedBranch ?? null;
      }
      let worktreePath =
        input.workspaceStrategy.type === "existing_worktree"
          ? input.workspaceStrategy.worktreePath
          : null;
      if (input.workspaceStrategy.type === "worktree") {
        if (runId !== null) {
          yield* threads
            .dispatch({
              type: "prepared-run.progress",
              commandId: CommandId.make(`${input.commandId}:progress:worktree`),
              threadId,
              runId,
              phase: "worktree",
            })
            .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
        }
        let startRef = input.workspaceStrategy.baseRef;
        // "Start from origin" is a stored default; repos without the requested
        // remote branch fall back to the local base branch.
        const startFromOrigin =
          input.workspaceStrategy.startFromOrigin === true &&
          (yield* git
            .remoteExists({ cwd: project.workspaceRoot, remoteName: "origin" })
            .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId))));
        yield* setupTracker.stageStatus(threadId, "fetch", startFromOrigin ? "running" : "skipped");
        if (startFromOrigin) {
          yield* git
            .fetchRemote({
              cwd: project.workspaceRoot,
              remoteName: "origin",
              refName: input.workspaceStrategy.baseRef,
            })
            .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
          const remoteBaseExists = yield* git
            .remoteBranchExists({
              cwd: project.workspaceRoot,
              refName: input.workspaceStrategy.baseRef,
              remoteName: "origin",
            })
            .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
          if (remoteBaseExists) {
            startRef = yield* git
              .resolveRemoteTrackingCommit({
                cwd: project.workspaceRoot,
                refName: input.workspaceStrategy.baseRef,
                fallbackRemoteName: "origin",
              })
              .pipe(
                Effect.map((resolved) => resolved.commitSha),
                Effect.mapError(mapError(input, "provision-worktree", threadId)),
              );
          }
        }
        if (startFromOrigin) yield* setupTracker.stageStatus(threadId, "fetch", "done");
        if (
          branch !== null &&
          isTemporaryWorktreeBranch(branch) &&
          (yield* git
            .hasCommit({
              cwd: project.workspaceRoot,
              refName: `refs/heads/${WORKTREE_BRANCH_PREFIX}`,
            })
            .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId))))
        ) {
          branch = flattenTemporaryWorktreeBranchName(branch);
        }
        yield* setupTracker.stageStatus(threadId, "checkout", "running");
        const worktree = yield* git
          .createWorktree(
            {
              cwd: project.workspaceRoot,
              refName: startRef,
              newRefName: branch!,
              baseRefName: input.workspaceStrategy.baseRef,
              path: null,
            },
            {
              progress: {
                onWorktreeClaimed: (path) =>
                  Effect.sync(() => {
                    createdWorktreePath = path;
                  }),
                onCheckoutProgress: (progress) =>
                  setupTracker.stage(threadId, "checkout", { percent: progress.percent }),
              },
            },
          )
          .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
        worktreePath = worktree.worktree.path;
        branch = worktree.worktree.refName;
        createdWorktreePath = worktreePath;
        yield* setupTracker.update(threadId, (snapshot) => ({ ...snapshot, worktreePath, branch }));
        yield* setupTracker.stageStatus(threadId, "checkout", "done");
      }

      // A reused worktree is already recorded, and rewriting it could undo
      // the first attempt's branch rename.
      if (reused === undefined) {
        yield* threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`${input.commandId}:workspace`),
            threadId,
            branch,
            worktreePath,
          })
          .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
      }
      workspaceRecorded = true;

      // Rename legacy temporary branches (sent by clients that name
      // worktrees themselves) in the background so generation latency
      // never delays provisioning or the provider turn. The temporary name
      // simply sticks if generation or the rename fails. Server-decided
      // `c/` branches are final and never renamed, so their folder stays.
      if (
        reused === undefined &&
        worktreePath !== null &&
        branch !== null &&
        initialMessage !== undefined &&
        isTemporaryWorktreeBranch(branch)
      ) {
        const oldBranch = branch;
        const worktreeCwd = worktreePath;
        yield* generateBranchNameFor(worktreeCwd, initialMessage).pipe(
          Effect.flatMap(({ branch: newBranch, exactName }) =>
            git.renameBranch({
              cwd: worktreeCwd,
              oldBranch,
              newBranch,
              ...(exactName ? { exactName: true } : {}),
            }),
          ),
          Effect.flatMap((renamed) =>
            Effect.gen(function* () {
              yield* threads
                .dispatch({
                  type: "thread.metadata.update",
                  commandId: CommandId.make(`${input.commandId}:branch-rename`),
                  threadId,
                  branch: renamed.branch,
                  worktreePath: worktreeCwd,
                  expectedBranch: oldBranch,
                  expectedWorktreePath: worktreeCwd,
                })
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Parent thread worktree branch update failed", {
                      threadId,
                      cause,
                    }),
                  ),
                );
              // Updating the parent first makes later subagents inherit the new name.
              // Re-read after each pass for children of subagents updated in that pass.
              const visited = new Set([threadId]);
              while (true) {
                const snapshot = yield* threads.getShellSnapshot();
                const sharing = [...snapshot.threads, ...snapshot.archivedThreads].filter(
                  (thread) =>
                    !visited.has(thread.id) &&
                    thread.worktreePath === worktreeCwd &&
                    thread.branch === oldBranch,
                );
                if (sharing.length === 0) break;
                for (const thread of sharing) {
                  visited.add(thread.id);
                  yield* threads
                    .dispatch({
                      type: "thread.metadata.update",
                      commandId: CommandId.make(`${input.commandId}:branch-rename:${thread.id}`),
                      threadId: thread.id,
                      branch: renamed.branch,
                      expectedBranch: oldBranch,
                      expectedWorktreePath: worktreeCwd,
                    })
                    .pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning("Shared thread worktree branch update failed", {
                          threadId: thread.id,
                          cause,
                        }),
                      ),
                    );
                }
              }
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Thread worktree branch rename failed", {
              commandId: input.commandId,
              threadId,
              oldBranch,
              cause,
            }),
          ),
          Effect.forkIn(preparationScope),
        );
      }

      const cwd = worktreePath ?? project.workspaceRoot;
      if (runId !== null) {
        yield* threads
          .dispatch({
            type: "prepared-run.progress",
            commandId: CommandId.make(`${input.commandId}:progress:setup`),
            threadId,
            runId,
            phase: "setup",
          })
          .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
      }
      yield* setupTracker.stageStatus(threadId, "setup-script", "running");
      const setup = yield* setupScripts
        .runForThread({
          threadId,
          projectId: input.projectId,
          projectCwd: project.workspaceRoot,
          worktreePath: cwd,
          ...(tracked
            ? {
                observeCompletion: {
                  onOutputLine: (line: string) =>
                    setupTracker.appendTail(threadId, "setup-script", line),
                },
              }
            : {}),
          project: {
            id: project.id,
            workspaceRoot: project.workspaceRoot,
            scripts: project.scripts,
          },
        })
        .pipe(Effect.mapError(mapError(input, "run-setup-script", threadId)));

      let awaitAsyncSetup = Effect.void;
      if (setup.status === "started") {
        setupTerminalId = setup.terminalId;
        yield* setupTracker.update(threadId, (snapshot) => ({
          ...snapshot,
          setupScript: {
            name: setup.scriptName,
            command: setup.scriptCommand,
            terminalId: setup.terminalId,
          },
        }));
        if (setup.completion) {
          const awaitCompletion = Effect.gen(function* () {
            const completion = yield* setup.completion!;
            yield* setupTracker.stage(threadId, "setup-script", {
              status: completion.exitCode === 0 ? "done" : "failed",
              detail: `exited with ${completion.exitCode ?? "no exit code"}`,
            });
            if (completion.exitCode !== 0 && !setup.async)
              return yield* mapError(
                input,
                "run-setup-script",
                threadId,
              )(`Setup script exited with ${completion.exitCode ?? "no exit code"}.`);
          });
          if (setup.async) {
            awaitAsyncSetup = awaitCompletion.pipe(
              Effect.catchCause((cause) =>
                setupTracker.stage(threadId, "setup-script", {
                  status: "failed",
                  detail: failureDetail(Cause.squash(cause)),
                }),
              ),
            );
          } else {
            yield* awaitCompletion;
          }
        } else {
          yield* setupTracker.stageStatus(threadId, "setup-script", "done");
        }
      } else {
        yield* setupTracker.stageStatus(threadId, "setup-script", "skipped");
      }
      yield* setupTracker.markUncancellable(threadId);
      yield* setupTracker.stageStatus(threadId, "agent", "running");
      if (runId !== null) {
        yield* threads
          .dispatch({
            type: "prepared-run.release",
            commandId: CommandId.make(`${input.commandId}:release`),
            threadId,
            runId,
          })
          .pipe(
            Effect.mapError(mapError(input, "release-run", threadId)),
            Effect.tap(() =>
              Effect.sync(() => {
                runReleased = true;
              }),
            ),
            Effect.uninterruptible,
          );
      }
      yield* setupTracker.stageStatus(threadId, "agent", "done");
      yield* awaitAsyncSetup;
      yield* setupTracker.finish(threadId, "done");
    }).pipe(
      Effect.onError((cause) =>
        Effect.gen(function* () {
          const cancelled = Cause.hasInterruptsOnly(cause);
          yield* setupTracker.finish(
            threadId,
            cancelled ? "cancelled" : "failed",
            cancelled ? null : failureDetail(Cause.squash(cause)),
          );
          if (cancelled && setupTerminalId)
            yield* terminals
              .close({ threadId, terminalId: setupTerminalId, deleteHistory: true })
              .pipe(Effect.ignore);
          if (
            tracked &&
            createdWorktreePath &&
            ((cancelled && !runReleased) || !workspaceRecorded)
          ) {
            const removedPath = createdWorktreePath;
            // The thread forgets the worktree only once it is gone; a failed
            // removal leaves the directory for the user to clean up rather than
            // reusing a checkout that may be half written.
            yield* git
              .removeWorktree({ cwd: project.workspaceRoot, path: removedPath, force: true })
              .pipe(
                Effect.andThen(
                  threads
                    .dispatch({
                      type: "thread.metadata.update",
                      commandId: CommandId.make(`${input.commandId}:cancel-workspace`),
                      threadId,
                      worktreePath: null,
                      branch: null,
                    })
                    .pipe(Effect.ignore),
                ),
                Effect.catchCause((removeCause) =>
                  Effect.logWarning("Failed to remove an abandoned thread worktree", {
                    commandId: input.commandId,
                    threadId,
                    path: removedPath,
                    cause: removeCause,
                  }),
                ),
              );
          }
        }),
      ),
    );
  });

  const failPreparedRun = (
    input: Pick<PreparationInput, "commandId">,
    threadId: ThreadId,
    runId: RunId | null,
    cause: unknown,
  ) =>
    runId === null
      ? Effect.logWarning("Thread workspace preparation failed", {
          commandId: input.commandId,
          threadId,
          cause,
        })
      : threads
          .dispatch({
            type: "prepared-run.fail",
            commandId: CommandId.make(`${input.commandId}:fail`),
            threadId,
            runId,
            failure: makeProviderFailure({
              cause,
              message: failureDetail(cause),
              class: "validation_error",
              retryable: false,
            }),
          })
          .pipe(
            Effect.catchCause((persistCause) =>
              Effect.logWarning("Failed to persist thread workspace preparation failure", {
                commandId: input.commandId,
                threadId,
                cause,
                persistCause,
              }),
            ),
          );

  const reservePreparation = (commandId: CommandId) =>
    Ref.modify(scheduledLaunches, (scheduled) => {
      if (scheduled.has(commandId)) return [false, scheduled] as const;
      const next = new Set(scheduled);
      next.add(commandId);
      return [true, next] as const;
    });

  const releasePreparation = (commandId: CommandId) =>
    Ref.update(scheduledLaunches, (scheduled) => {
      const next = new Set(scheduled);
      next.delete(commandId);
      return next;
    });

  const schedulePreparation = Effect.fn("ThreadLaunchService.schedulePreparation")(function* (
    input: PreparationInput,
    threadId: ThreadId,
    runId: RunId | null,
  ) {
    const preparation = Effect.gen(function* () {
      const prepare = prepareInBackground(input, threadId, runId);
      if (
        runId === null ||
        (input.workspaceStrategy.type !== "worktree" && input.reusedWorktree === undefined)
      ) {
        return yield* prepare;
      }
      const afterSequence = yield* threads.getThreadEventSequence(threadId);
      const projection = yield* threads.getThreadRecords(threadId, ["runs"]);
      if (projection.runs.find((run) => run.id === runId)?.status !== "preparing") return;
      const interruption = threads
        .streamStoredEventsFrom({ threadId, afterSequence, eventType: "run.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === runId &&
              (stored.event.payload.status === "interrupted" ||
                stored.event.payload.status === "cancelled"),
          ),
          Stream.runHead,
          Effect.flatMap((event) => (Option.isSome(event) ? Effect.interrupt : Effect.never)),
        );
      yield* Effect.raceFirst(prepare, interruption);
    });
    yield* preparation.pipe(
      Effect.onError((cause) =>
        failPreparedRun(
          input,
          threadId,
          runId,
          Cause.hasInterruptsOnly(cause) ? "Worktree setup cancelled." : Cause.squash(cause),
        ),
      ),
      Effect.ignoreCause,
      Effect.ensuring(releasePreparation(input.commandId)),
      Effect.forkIn(preparationScope),
    );
  });

  /**
   * A launch naming a repository linked from another machine (a `remote:`
   * placeholder, as a synced scheduled task is bound) starts its clone into
   * the project folder and launches into the new record; preparation then
   * waits on that clone like any other.
   */
  const resolveRemoteRepository = (input: ThreadLaunchInput) =>
    Effect.gen(function* () {
      if (!isRemoteRepositoryPlaceholder(input.projectId) || Option.isNone(repositoryCheckout))
        return input;
      const { repositoryId } = yield* repositoryCheckout.value
        .resolveRepository(input.projectId)
        .pipe(Effect.mapError(mapError(input, "resolve-project")));
      return { ...input, projectId: repositoryId };
    });

  /**
   * Every entry point reaches another machine only through here: thread sync
   * launches on `machine` and answers none when that is this machine.
   */
  const launch: ThreadLaunchService["Service"]["launch"] = Effect.fn("ThreadLaunchService.launch")(
    function* ({ machine, ...requested }) {
      if (machine === undefined) return yield* launchHere(requested);
      const remote = yield* Option.match(remoteLaunch, {
        onNone: () =>
          Effect.fail(
            new ThreadRemoteError({
              reason: "rejected",
              detail: "This server cannot reach other machines.",
            }),
          ),
        onSome: (launcher) => launcher.launch(machine, requested),
      }).pipe(Effect.mapError(mapError(requested, "launch-remote", requested.threadId)));
      return Option.isSome(remote) ? remote.value : yield* launchHere(requested);
    },
  );

  const launchHere = Effect.fn("ThreadLaunchService.launchHere")(function* (
    requested: ThreadLaunchInput,
  ) {
    if (requested.importedNativeThread === undefined)
      yield* membership
        .validate(requested)
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "ProjectRepositoryMismatchError"
              ? cause
              : mapError(requested, "resolve-project")(cause),
          ),
        );
    const input = yield* resolveRemoteRepository(requested);
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError(mapError(input, "resolve-project")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(mapError(input, "resolve-project")("Project not found.")),
          onSome: Effect.succeed,
        }),
      ),
    );
    // No checkout here: a clone can take minutes, so the launch returns
    // with the thread preparing and `prepareInBackground` ensures the
    // checkout there (retrying a failed clone, waiting on a running one).
    // A checkout failure fails the prepared run in the thread, and the
    // clone tracker shows it on the project. Rejecting the launch while a
    // clone runs or after one failed would strand the retry in the tracker.
    if (input.reuseExistingThread === true && input.threadId === undefined) {
      return yield* mapError(
        input,
        "update-thread",
      )("Reusing an existing thread requires a thread id.");
    }

    // Resolve the project before anything is created, so a bad pick or an
    // archived project fails the launch instead of leaving an unfiled
    // thread behind.
    const fileInProject =
      input.projectFolderId === undefined
        ? null
        : yield* Option.match(projectLabels, {
            onNone: () =>
              Effect.fail(mapError(input, "resolve-project")("Projects are unavailable.")),
            onSome: (labels) => {
              const folderId = input.projectFolderId!;
              return labels.readActive(folderId).pipe(
                Effect.mapError(mapError(input, "resolve-project")),
                Effect.as((threadId: ThreadId) =>
                  labels
                    .moveThread({ threadId, folderId })
                    .pipe(Effect.mapError(mapError(input, "create-thread", threadId))),
                ),
              );
            },
          });

    const launchReceipt = yield* readReceipt(input, input.commandId);
    yield* threads.assertProviderInstanceEnabled({
      projectId: input.projectId,
      commandId: input.commandId,
      instanceId: input.modelSelection.instanceId,
    });
    return yield* Effect.gen(function* () {
      // A retried launch has no client-supplied id to replay against, so
      // recover the thread id its accepted create was recorded under before
      // allocating another one; a fresh id would only collide with the
      // recorded receipt.
      const reusableLaunchReceipt =
        input.threadId === undefined &&
        Option.isSome(launchReceipt) &&
        launchReceipt.value.status === "accepted" &&
        launchReceipt.value.commandType === "thread.create"
          ? launchReceipt.value
          : undefined;
      const candidateThreadId =
        input.threadId ??
        reusableLaunchReceipt?.threadId ??
        (yield* ids.allocate
          .thread({ projectId: input.projectId })
          .pipe(Effect.mapError(mapError(input, "create-thread"))));

      if (reusableLaunchReceipt !== undefined) {
        const shell = yield* threads
          .getThreadShell(candidateThreadId)
          .pipe(Effect.mapError(mapError(input, "create-thread", candidateThreadId)));
        if (shell === null) {
          return yield* mapError(input, "create-thread", candidateThreadId)("Thread not found.");
        }
        if (shell.projectId !== input.projectId) {
          return yield* mapError(
            input,
            "resolve-project",
            candidateThreadId,
          )("Project identity changed.");
        }
      }

      if (input.reuseExistingThread === true && Option.isNone(launchReceipt)) {
        yield* validateReusableThread(input, candidateThreadId);
      }

      // A Scratch thread launched at the project root runs in a folder of its
      // own, or in its project's folder when it is filed in one. Only the
      // first attempt claims one; a retry replays its create.
      const forkWorkspace =
        input.fork?.repository === undefined || Option.isSome(launchReceipt)
          ? undefined
          : yield* Effect.gen(function* () {
              if (Option.isSome(repositoryCheckout))
                yield* repositoryCheckout.value.ensureCheckout(input.projectId);
              return yield* git.forkCheckout({
                cwd: project.workspaceRoot,
                ...input.fork!.repository!,
              });
            }).pipe(Effect.mapError(mapError(input, "provision-worktree", candidateThreadId)));
      const workspaceStrategy: ThreadLaunchWorkspaceStrategy =
        forkWorkspace !== undefined
          ? {
              type: "existing_worktree",
              ...forkWorkspace,
              ...(forkWorkspace.branch === null ? { branch: undefined } : {}),
            }
          : input.workspaceStrategy.type === "root" && Option.isNone(launchReceipt)
            ? Option.match(
                yield* managedFolders
                  .folderForThread({
                    projectId: input.projectId,
                    threadId: candidateThreadId,
                    text: input.initialMessage?.text ?? input.title,
                    ...(input.projectFolderId === undefined
                      ? {}
                      : { labelId: input.projectFolderId }),
                  })
                  .pipe(Effect.mapError(mapError(input, "provision-worktree", candidateThreadId))),
                {
                  onNone: () => input.workspaceStrategy,
                  onSome: (worktreePath) => ({ type: "existing_worktree", worktreePath }),
                },
              )
            : input.workspaceStrategy;
      const initialBranch = workspaceStrategy.branch ?? null;
      const initialWorktreePath =
        workspaceStrategy.type === "existing_worktree" ? workspaceStrategy.worktreePath : null;
      const claimDispatch =
        input.reuseExistingThread === true
          ? threads.dispatch({
              type: "thread.metadata.update",
              commandId: input.commandId,
              threadId: candidateThreadId,
              expectedEmpty: true,
            })
          : threads.dispatch({
              type: "thread.create",
              ...(input.projectFolderId === undefined
                ? {}
                : { projectFolderId: input.projectFolderId }),
              ...(input.fork === undefined ? {} : { fork: input.fork }),
              ...(input.subagent === undefined ? {} : { subagent: input.subagent }),
              ...(input.surface === undefined ? {} : { surface: input.surface }),
              ...(input.workOrigin === undefined ? {} : { workOrigin: input.workOrigin }),
              ...(input.sourceThreadId === undefined
                ? {}
                : { sourceThreadId: input.sourceThreadId }),
              ...(input.sourceAgentId === undefined ? {} : { sourceAgentId: input.sourceAgentId }),
              ...(input.sourceAgentRunId === undefined
                ? {}
                : { sourceAgentRunId: input.sourceAgentRunId }),
              ...(input.agent === undefined ? {} : { agent: input.agent }),
              commandId: input.commandId,
              threadId: candidateThreadId,
              projectId: input.projectId,
              title: input.title,
              modelSelection: input.modelSelection,
              runtimeMode: input.runtimeMode,
              interactionMode: input.interactionMode,
              branch: initialBranch,
              worktreePath: initialWorktreePath,
              ...(input.importedNativeThread === undefined
                ? {}
                : { importedNativeThread: input.importedNativeThread }),
              createdBy: input.createdBy,
              creationSource: input.creationSource,
            });
      const claimed = yield* claimDispatch.pipe(
        Effect.mapError(
          mapError(
            input,
            input.reuseExistingThread === true ? "update-thread" : "create-thread",
            candidateThreadId,
          ),
        ),
      );
      const threadId =
        claimed.storedEvents.find((stored) => stored.event.type.startsWith("thread."))?.event
          .threadId ?? candidateThreadId;
      if (project.id !== input.projectId) {
        return yield* mapError(input, "resolve-project", threadId)("Project identity changed.");
      }

      const messageCommandId = CommandId.make(`${input.commandId}:initial-message`);
      // File it while it is still turnless: the first turn then resolves
      // the project dir as its cwd. A retry whose message already landed
      // was filed by its first attempt.
      if (
        fileInProject !== null &&
        (input.initialMessage === undefined ||
          Option.isNone(yield* readReceipt(input, messageCommandId)))
      ) {
        yield* fileInProject(threadId);
      }

      let runId: RunId | null = null;
      let messageWasAlreadyAccepted = false;
      if (input.initialMessage !== undefined) {
        const messageReceipt = yield* readReceipt(input, messageCommandId);
        messageWasAlreadyAccepted = Option.isSome(messageReceipt);
        const messageId =
          input.initialMessage.messageId ??
          (yield* ids.allocate
            .message({ threadId, ordinal: 1 })
            .pipe(Effect.mapError(mapError(input, "dispatch-message", threadId))));
        const dispatched = yield* threads
          .dispatch({
            type: "message.dispatch",
            commandId: messageCommandId,
            threadId,
            messageId,
            text: input.initialMessage.text,
            ...(input.initialMessage.scheduledTaskId === undefined
              ? {}
              : { scheduledTaskId: input.initialMessage.scheduledTaskId }),
            ...(input.initialMessage.senderThreadId === undefined
              ? {}
              : { senderThreadId: input.initialMessage.senderThreadId }),
            attachments: input.initialMessage.attachments,
            ...(input.initialMessage.context ? { context: input.initialMessage.context } : {}),
            ...(input.generateTitle === true ? { titleSeed: input.title } : {}),
            modelSelection: input.modelSelection,
            dispatchMode: { type: "defer_start", workspaceStrategy },
            createdBy: input.createdBy,
            creationSource: input.creationSource,
          })
          .pipe(Effect.mapError(mapError(input, "dispatch-message", threadId)));
        const runCreated = dispatched.storedEvents.find(
          (stored) => stored.event.type === "run.created",
        );
        runId = runCreated?.event.type === "run.created" ? runCreated.event.payload.id : null;
        if (runId === null) {
          return yield* mapError(
            input,
            "dispatch-message",
            threadId,
          )("Initial message was accepted without a durable run.");
        }
      }

      if (input.handoffContext !== undefined && input.sourceThreadId !== undefined) {
        yield* threads
          .dispatch({
            type: "work.handoff.context",
            commandId: CommandId.make(`${input.commandId}:work-context`),
            threadId,
            sourceThreadId: input.sourceThreadId,
            scopeSummary: input.handoffSummary ?? input.initialMessage?.text ?? input.title,
            handoffContext: input.handoffContext,
          })
          .pipe(Effect.mapError(mapError(input, "dispatch-message", threadId)));
      }
      const projection = yield* threads
        .getThreadProjection(threadId)
        .pipe(Effect.mapError(mapError(input, "create-thread", threadId)));
      const runIsPreparing =
        runId !== null &&
        projection.runs.some((run) => run.id === runId && run.status === "preparing");
      const shouldSchedule = runId === null ? Option.isNone(launchReceipt) : runIsPreparing;
      // A retried root launch prepares the folder its first attempt bound, so
      // a Scratch thread keeps its own. Other root launches bind no folder.
      const boundWorktreePath = projection.thread.worktreePath;
      const preparationStrategy: ThreadLaunchWorkspaceStrategy =
        Option.isSome(launchReceipt) &&
        workspaceStrategy.type === "root" &&
        boundWorktreePath !== null
          ? {
              type: "existing_worktree",
              worktreePath: boundWorktreePath,
              branch: workspaceStrategy.branch,
            }
          : workspaceStrategy;
      if (shouldSchedule) {
        const ownsPreparation = yield* reservePreparation(input.commandId);
        if (ownsPreparation) {
          yield* Effect.gen(function* () {
            const preparationStillRequired =
              runId === null
                ? true
                : yield* threads.getThreadRecords(threadId, ["runs"], { runIds: [runId] }).pipe(
                    Effect.map((current) =>
                      current.runs.some((run) => run.id === runId && run.status === "preparing"),
                    ),
                    Effect.mapError(mapError(input, "update-thread", threadId)),
                  );
            if (preparationStillRequired) {
              yield* schedulePreparation(
                { ...input, workspaceStrategy: preparationStrategy },
                threadId,
                runId,
              );
            } else {
              yield* releasePreparation(input.commandId);
            }
          }).pipe(Effect.onError(() => releasePreparation(input.commandId)));
        }
      }

      return {
        threadId,
        projection,
        resumed: Option.isSome(launchReceipt) || messageWasAlreadyAccepted,
      };
    });
  });

  const prepareRun: ThreadLaunchService["Service"]["prepareRun"] = Effect.fn(
    "ThreadLaunchService.prepareRun",
  )(function* (input) {
    const scheduled = yield* Effect.gen(function* () {
      const projection = yield* threads.getThreadProjection(input.threadId);
      // The owner's peer handler schedules remote retries. Paths and worker commands
      // belong there; a replica must never prepare the same run a second time.
      if (projection.thread.ownerMachine != null) return;
      const run = projection.runs.find((candidate) => candidate.id === input.runId);
      const workspacePreparation = run?.workspacePreparation;
      if (run?.status !== "preparing" || workspacePreparation === undefined) return;
      if (!(yield* reservePreparation(input.commandId))) return;
      yield* scheduleRunPreparation(input, projection, run, workspacePreparation).pipe(
        Effect.onError(() => releasePreparation(input.commandId)),
      );
    }).pipe(Effect.exit);
    if (Exit.isFailure(scheduled)) {
      yield* failPreparedRun(input, input.threadId, input.runId, Cause.squash(scheduled.cause));
    }
  });

  const retryPreparation: ThreadLaunchService["Service"]["retryPreparation"] = Effect.fn(
    "ThreadLaunchService.retryPreparation",
  )(function* (input) {
    const dispatched = yield* threads.dispatch({
      type: "prepared-run.retry",
      commandId: input.commandId,
      threadId: input.threadId,
      runId: input.runId,
    });
    yield* prepareRun(input);
    return dispatched;
  });

  const scheduleRunPreparation = (
    input: ThreadLaunchPreparationInput,
    projection: OrchestrationV2ThreadProjection,
    run: OrchestrationV2ThreadProjection["runs"][number],
    workspacePreparation: ThreadLaunchWorkspaceStrategy,
  ) => {
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    // A worktree the failed attempt already created is reused, not created again.
    const reuse =
      workspacePreparation.type === "worktree" &&
      projection.thread.worktreePath !== null &&
      projection.thread.branch !== null
        ? {
            strategy: {
              type: "existing_worktree" as const,
              worktreePath: projection.thread.worktreePath,
              branch: projection.thread.branch,
            },
            reusedWorktree: { baseRef: workspacePreparation.baseRef },
          }
        : null;
    return schedulePreparation(
      {
        commandId: input.commandId,
        projectId: projection.thread.projectId,
        workspaceStrategy: reuse?.strategy ?? workspacePreparation,
        ...(reuse === null ? {} : { reusedWorktree: reuse.reusedWorktree }),
        ...(message === undefined
          ? {}
          : {
              initialMessage: {
                text: message.text,
                attachments: message.attachments,
                ...(message.context ? { context: message.context } : {}),
              },
            }),
      },
      input.threadId,
      run.id,
    );
  };

  const providers = Effect.fn("ThreadLaunchService.providers")(function* (machine: EnvironmentId) {
    if (Option.isNone(remoteLaunch)) return { providers: yield* providerRegistry.getProviders };
    const remote = yield* remoteLaunch.value.catalog(machine);
    return {
      providers: Option.isSome(remote) ? remote.value : yield* providerRegistry.getProviders,
    };
  });
  return ThreadLaunchService.of({
    providers,
    validateProjectRepository: membership.validate,
    launch,
    checkWorktreeBase,
    retryPreparation,
    prepareRun,
  });
});

export const layer = Layer.effect(ThreadLaunchService, make).pipe(Layer.provide(Membership.layer));
