import {
  CommandId,
  WorkHandoffError,
  WorkTaskId,
  type AgentId,
  type MessageId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type WorkStartInput,
  type WorkStartResult,
  type WorkHandoffDraft,
  type ProjectId,
  type RunId,
  type WorkTask,
  type WorkTaskHandoffResult,
  type WorkTaskMode,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type OrchestrationV2ThreadProjection,
  type Project,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as ManagedFolders from "../project/ManagedProjectFolders.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as AgentStore from "../agents/AgentStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as HandoffContext from "./WorkHandoffContext.ts";

/** Transport-owned provenance: RPC clients cannot impersonate an agent or choose its run. */
export interface WorkHandoffActor {
  readonly threadId?: ThreadId;
  readonly workspaceStrategy?: OrchestrationV2ThreadLaunchWorkspaceStrategy;
  readonly origin: "chat" | "agent";
  readonly sourceAgentId?: AgentId;
  readonly sourceAgentRunId?: string;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  /** A chat's own agent started this on the user's behalf, so the thread records an agent creator. */
  readonly createdByAgent?: boolean;
}

/** A chat agent's request to hand work off as a task card. */
export interface WorkTaskHandoffInput {
  /** Stable across retries: one request makes one card and at most one Work thread. */
  readonly machine?: import("@cogenly/contracts").EnvironmentId | undefined;
  readonly commandId: CommandId;
  readonly sourceThreadId: ThreadId;
  readonly mode: WorkTaskMode;
  readonly title: string;
  readonly brief: string;
  /** Absent: "No project", the scratch project on this machine. */
  readonly targetProjectId?: ProjectId | undefined;
  readonly workspace?: "worktree" | "local" | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  /** The chat run asking, so the card sits after its turn. */
  readonly runId?: RunId | undefined;
  /** Settle the Work thread once the task completes; a failed one stays. */
  readonly settleWhenDone?: boolean | undefined;
}

/** The card brief: the scope, cut to what a card carries. */
const cardBrief = (text: string) => text.trim().slice(0, 4000);
type ChatMessages = OrchestrationV2ThreadProjection["messages"];

const settledText = (messages: ChatMessages) =>
  messages.filter((message) => !message.streaming && message.text.trim());

/** Turn items that can summarize what the chat looked at, ran, or delegated. */
const handoffArtifactItemTypes = [
  "user_message",
  "assistant_message",
  "command_execution",
  "file_search",
  "web_search",
  "subagent",
  "dynamic_tool",
  "file_change",
  "proposed_plan",
] as const;

export class WorkHandoffService extends Context.Service<
  WorkHandoffService,
  {
    /** `task` records a new card for this Work, started, as an agent's direct start does. */
    readonly start: (
      input: WorkStartInput,
      actor?: WorkHandoffActor,
      task?: WorkTask,
    ) => Effect.Effect<WorkStartResult, WorkHandoffError>;
    /**
     * A chat agent hands work off as a task card: `propose` waits for the
     * user's approval on the card, `start` launches the Work at once.
     */
    readonly handoffTask: (
      input: WorkTaskHandoffInput,
      actor: WorkHandoffActor,
    ) => Effect.Effect<WorkTaskHandoffResult, WorkHandoffError>;
    /** `throughMessageId` drafts from the chat up to and including that message. */
    readonly proposeHandoff: (
      sourceThreadId: ThreadId,
      options?: { readonly throughMessageId?: MessageId | undefined },
    ) => Effect.Effect<WorkHandoffDraft, WorkHandoffError>;
  }
>()("cogenly-server/work/WorkHandoffService") {}

const make = Effect.gen(function* () {
  const threads = yield* Threads.ThreadManagementService;
  const launches = yield* Launch.ThreadLaunchService;
  const projects = yield* Projects.ProjectService;
  const text = yield* TextGeneration.TextGeneration;
  const settings = yield* ServerSettings.ServerSettingsService;
  const agents = yield* AgentStore.AgentStore;
  const folders = yield* ManagedFolders.ManagedProjectFolders;
  const git = yield* GitWorkflow.GitWorkflowService;
  const sourceThread = Effect.fn("WorkHandoffService.sourceThread")(function* (
    sourceThreadId: ThreadId,
  ) {
    const source = yield* threads
      .getThreadRecords(sourceThreadId, [])
      .pipe(
        Effect.mapError(
          (cause) =>
            new WorkHandoffError({ sourceThreadId: sourceThreadId, stage: "read-source", cause }),
        ),
      );
    if (source.thread.deletedAt !== null)
      return yield* new WorkHandoffError({ sourceThreadId, stage: "read-source" });
    return source;
  });
  const start: WorkHandoffService["Service"]["start"] = Effect.fn("WorkHandoffService.start")(
    function* (startInput, actor, newTask) {
      const source = yield* sourceThread(startInput.sourceThreadId);
      // Approving a proposed card starts what it describes, with the user's edits on top.
      const proposed =
        startInput.taskId === undefined
          ? undefined
          : (source.thread.workTasks ?? []).find((task) => task.id === startInput.taskId);
      if (startInput.taskId !== undefined) {
        if (proposed?.status === "started" && proposed.threadId !== undefined) {
          return { threadId: proposed.threadId };
        }
        if (proposed?.status !== "proposed") {
          return yield* new WorkHandoffError({
            sourceThreadId: startInput.sourceThreadId,
            stage: "task-unavailable",
          });
        }
      }
      const input: WorkStartInput =
        proposed === undefined
          ? startInput
          : {
              ...startInput,
              machine: startInput.machine ?? proposed.machine,
              title: startInput.title ?? proposed.title,
              scopeSummary: startInput.scopeSummary ?? proposed.brief,
              ...((startInput.workspace ?? proposed.workspace) === undefined
                ? {}
                : { workspace: startInput.workspace ?? proposed.workspace }),
              ...((startInput.modelSelection ?? proposed.modelSelection) === undefined
                ? {}
                : { modelSelection: startInput.modelSelection ?? proposed.modelSelection }),
            };
      if (input.machine === undefined && input.projectFolderId != null)
        yield* launches
          .validateProjectRepository({
            projectId: input.targetProjectId,
            projectFolderId: input.projectFolderId,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new WorkHandoffError({
                  sourceThreadId: input.sourceThreadId,
                  stage: "resolve-project",
                  ...(cause._tag === "ProjectRepositoryMismatchError"
                    ? { repositoryMismatch: cause }
                    : {}),
                  cause,
                }),
            ),
          );
      const task: WorkTask | undefined =
        newTask ??
        (proposed === undefined
          ? undefined
          : {
              ...proposed,
              title: input.title ?? proposed.title,
              brief: cardBrief(input.scopeSummary ?? proposed.brief),
              targetProjectId: input.targetProjectId,
              ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
              ...(input.modelSelection === undefined
                ? {}
                : { modelSelection: input.modelSelection }),
            });
      const origin = actor?.origin ?? "chat";
      const sourceAgentId =
        origin === "agent"
          ? (actor?.sourceAgentId ??
            source.thread.agent?.id ??
            (yield* agents.forThread(input.sourceThreadId).pipe(
              Effect.mapError(
                (cause) =>
                  new WorkHandoffError({
                    sourceThreadId: input.sourceThreadId,
                    stage: "read-source",
                    cause,
                  }),
              ),
            ))?.id)
          : undefined;
      // Work with no repository runs in the scratch project, which has no git
      // to make a worktree from, so it always launches at the root (its own folder).
      // Without an explicit workspace, Work gets a worktree only where there is git to make one.
      const scratchRoot = yield* folders.scratchRoot;
      const chooseByGit = input.workspace === undefined && actor?.workspaceStrategy === undefined;
      const target =
        Option.isSome(scratchRoot) || chooseByGit
          ? yield* projects
              .getById(input.targetProjectId)
              .pipe(Effect.orElseSucceed(() => Option.none<Project>()))
          : Option.none<Project>();
      const targetIsScratch =
        Option.isSome(scratchRoot) &&
        Option.exists(target, (project) => project.workspaceRoot === scratchRoot.value);
      const useWorktree =
        input.workspace === "worktree" ||
        (chooseByGit &&
          (Option.isNone(target) ||
            (yield* git
              .isRepository(target.value.workspaceRoot)
              .pipe(Effect.orElseSucceed(() => true)))));
      const workspaceStrategy =
        actor?.workspaceStrategy ??
        (!useWorktree || targetIsScratch
          ? { type: "root" as const }
          : { type: "worktree" as const, baseRef: "HEAD", startFromOrigin: false });
      const cwd = Option.isNone(target) ? undefined : target.value.workspaceRoot;
      // Every handoff carries the source transcript as first-turn context; without
      // a caller scope the visible message is a short generated brief of it, and
      // the Work thread titles itself from that, as a new thread does.
      const { carried, handoffContext } = yield* handoffContextFor(
        input.sourceThreadId,
        input.throughMessageId,
        source.thread,
        cwd,
      );
      const scopeSummary = input.scopeSummary ?? (yield* generateBrief(carried, cwd));
      const cutOff =
        input.throughMessageId === undefined
          ? ""
          : `\nThe handoff covers the source conversation through message ${input.throughMessageId}; ignore anything after it.`;
      // The existing launch service owns repository validation, provisioning, setup,
      // deferred execution, receipts and retries.
      const result = yield* launches
        .launch({
          commandId: input.commandId,
          ...(input.machine === undefined ? {} : { machine: input.machine }),
          ...(actor?.threadId === undefined ? {} : { threadId: actor.threadId }),
          projectId: input.targetProjectId,
          ...(input.projectFolderId == null ? {} : { projectFolderId: input.projectFolderId }),
          title: input.title ?? source.thread.title,
          ...(input.title === undefined ? { generateTitle: true } : {}),
          surface: "work" as const,
          workOrigin: origin,
          sourceThreadId: input.sourceThreadId,
          ...(sourceAgentId === undefined
            ? {}
            : { sourceAgentId, agent: { id: sourceAgentId, role: "work" as const } }),
          ...(actor?.sourceAgentRunId === undefined
            ? {}
            : { sourceAgentRunId: actor.sourceAgentRunId }),
          modelSelection: input.modelSelection ?? source.thread.modelSelection,
          runtimeMode: actor?.runtimeMode ?? source.thread.runtimeMode,
          interactionMode: actor?.interactionMode ?? source.thread.interactionMode,
          workspaceStrategy,
          handoffContext,
          handoffSummary: scopeSummary,
          createdBy: origin === "agent" || actor?.createdByAgent === true ? "agent" : "user",
          creationSource: origin === "agent" || actor?.createdByAgent === true ? "mcp" : "web",
          initialMessage: {
            text: `${scopeSummary}\n\nSource conversation: [${source.thread.title}](cogenly-thread://v1/${input.sourceThreadId})\nSource thread ID: ${input.sourceThreadId}${cutOff}\n${input.scopeSummary === undefined ? "The chat's transcript was carried as handoff context; consult it before asking about anything already discussed." : "Use this approved scope; follow the source reference if more context is needed."}`,
            senderThreadId: input.sourceThreadId,
            attachments: [],
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new WorkHandoffError({
                sourceThreadId: input.sourceThreadId,
                stage: "launch",
                ...(cause._tag === "ProjectRepositoryMismatchError"
                  ? { repositoryMismatch: cause }
                  : {}),
                ...(cause._tag === "ThreadManagementProviderInstanceDisabledError"
                  ? { disabledProviderInstanceId: cause.instanceId }
                  : {}),
                machineOffline: Launch.remoteLaunchFailure(cause)?.reason === "offline",
                cause,
              }),
          ),
        );
      // Separate stable receipt: retry after a lost launch response repairs the link
      // without starting another thread or another provider turn in the source chat.
      yield* threads
        .dispatch({
          type: "work.handoff.record",
          commandId: CommandId.make(`${input.commandId}:work-handoff`),
          threadId: input.sourceThreadId,
          targetThreadId: result.threadId,
          scopeSummary,
          ...(input.throughMessageId === undefined
            ? {}
            : { throughMessageId: input.throughMessageId }),
          handoffContext,
          ...(task === undefined ? {} : { task }),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new WorkHandoffError({
                sourceThreadId: input.sourceThreadId,
                stage: "record-link",
                cause,
              }),
          ),
        );
      return { threadId: result.threadId };
    },
  );
  /**
   * The chat's messages up to and including `throughMessageId`. The recent
   * window answers most cut-offs; an older one reads the source's own user
   * messages up to that point. A message that is not in the chat fails.
   */
  const messagesThrough = Effect.fn("WorkHandoffService.messagesThrough")(function* (
    sourceThreadId: ThreadId,
    recent: ChatMessages,
    throughMessageId: MessageId | undefined,
  ) {
    if (throughMessageId === undefined) return recent;
    const index = recent.findIndex((message) => message.id === throughMessageId);
    if (index !== -1) return recent.slice(0, index + 1);
    const cutOff = (yield* threads.getThreadRecords(sourceThreadId, ["messages"], {
      messageIds: [throughMessageId],
    })).messages[0];
    if (cutOff === undefined) return yield* Effect.fail("Cut-off message is not in this chat.");
    const users = (yield* threads.getThreadRecords(sourceThreadId, ["messages"], {
      messageRoles: ["user"],
    })).messages;
    // Records come in chat order, which also breaks ties between equal timestamps.
    const cutOffIndex = users.findIndex((message) => message.id === cutOff.id);
    return cutOffIndex !== -1
      ? users.slice(0, cutOffIndex + 1)
      : users
          .filter((message) => DateTime.isLessThanOrEqualTo(message.createdAt, cutOff.createdAt))
          .concat(cutOff);
  });
  /**
   * The chat's whole user/assistant transcript up to and including
   * `throughMessageId`, in chat order. A message that is not in the chat fails.
   */
  const carriedThrough = Effect.fn("WorkHandoffService.carriedThrough")(function* (
    sourceThreadId: ThreadId,
    throughMessageId: MessageId | undefined,
  ) {
    const records = yield* threads
      .getThreadRecords(sourceThreadId, ["messages"], { messageRoles: ["user", "assistant"] })
      .pipe(
        Effect.mapError(
          (cause) => new WorkHandoffError({ sourceThreadId, stage: "read-source", cause }),
        ),
      );
    if (throughMessageId === undefined) return records.messages;
    const index = records.messages.findIndex((message) => message.id === throughMessageId);
    if (index === -1)
      return yield* new WorkHandoffError({
        sourceThreadId,
        stage: "read-source",
        cause: "Cut-off message is not in this chat.",
      });
    return records.messages.slice(0, index + 1);
  });
  /**
   * The visible first message when the caller wrote no scope: a one-line goal
   * plus short bullets, generated from the transcript, with a deterministic
   * fallback that skips greetings and filler.
   */
  const generateBrief = Effect.fn("WorkHandoffService.generateBrief")(function* (
    carried: ChatMessages,
    cwd: string | undefined,
  ) {
    const fallback = HandoffContext.fallbackHandoffBrief(carried);
    const fallbackText = HandoffContext.formatHandoffBrief(fallback.goal, fallback.bullets);
    const lines = HandoffContext.handoffTranscriptLines(
      carried,
      HandoffContext.HANDOFF_BRIEF_MODEL_MESSAGES,
      HandoffContext.HANDOFF_BRIEF_MODEL_CHARS,
    );
    if (cwd === undefined || lines.length === 0) return fallbackText;
    const brief = yield* settings.getSettings.pipe(
      Effect.flatMap((config) =>
        text.generateHandoffBrief({
          cwd,
          transcript: JSON.stringify(lines),
          modelSelection: config.textGenerationModelSelection,
        }),
      ),
      Effect.map((result) => {
        const goal = result.goal.trim().slice(0, HandoffContext.HANDOFF_BRIEF_GOAL_CHARS);
        if (goal.length === 0) return "";
        const bullets = HandoffContext.cleanHandoffSummaryLines(
          result.bullets.join("\n"),
          HandoffContext.HANDOFF_BRIEF_BULLETS,
        );
        return HandoffContext.formatHandoffBrief(goal, bullets);
      }),
      Effect.orElseSucceed(() => ""),
    );
    return brief || fallbackText;
  });
  /** Older turns as coverage lines: a cheap summary, or one line per turn. */
  const summarizeOlder = Effect.fn("WorkHandoffService.summarizeOlder")(function* (
    older: ChatMessages,
    cwd: string | undefined,
  ) {
    const fallback = HandoffContext.compactOlderTurns(older);
    const lines = HandoffContext.handoffTranscriptLines(
      older,
      HandoffContext.HANDOFF_OLDER_MODEL_TURNS,
      HandoffContext.HANDOFF_OLDER_MODEL_CHARS,
    );
    if (cwd === undefined || lines.length === 0) return fallback;
    const summary = yield* settings.getSettings.pipe(
      Effect.flatMap((config) =>
        text.generateWorkScopeSummary({
          cwd,
          requirements: JSON.stringify(lines),
          modelSelection: config.textGenerationModelSelection,
        }),
      ),
      Effect.map((result) => HandoffContext.cleanHandoffSummaryLines(result.summary)),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );
    if (summary.length === 0) return fallback;
    const covered = summary.map((line) => `- ${line.replace(/^\s*[-*•]\s*/, "")}`);
    if (older.length > lines.length)
      covered.push(
        `- …plus ${older.length - lines.length} earlier messages (see the source chat).`,
      );
    return covered;
  });
  /**
   * The carried transcript and its prepared handoff context: recent turns in
   * full, older ones summarized, artifacts, and the chat's model. Delivery
   * injects it into the Work thread's first turn within its own budget.
   */
  const handoffContextFor = Effect.fn("WorkHandoffService.handoffContext")(function* (
    sourceThreadId: ThreadId,
    throughMessageId: MessageId | undefined,
    source: { readonly title: string; readonly modelSelection: ModelSelection },
    cwd: string | undefined,
  ) {
    const allThrough = yield* carriedThrough(sourceThreadId, throughMessageId);
    const carried = allThrough.filter(HandoffContext.isHandoffTranscriptMessage);
    const { older, recent } = HandoffContext.splitTranscriptTail(carried);
    const items = yield* threads
      .getThreadRecords(sourceThreadId, ["turnItems"], {
        turnItemTypes: [...handoffArtifactItemTypes],
      })
      .pipe(
        Effect.mapError(
          (cause) => new WorkHandoffError({ sourceThreadId, stage: "read-source", cause }),
        ),
      );
    const scoped = HandoffContext.filterHandoffItemsThroughCutoff(
      items.turnItems,
      new Set(allThrough.map((message) => message.id)),
      throughMessageId,
    );
    const olderSummaryLines = yield* summarizeOlder(older, cwd);
    const coverage = HandoffContext.buildHandoffCoverage({
      sourceThreadId,
      sourceThreadTitle: source.title,
      modelSelection: source.modelSelection,
      messagesCarried: carried.length,
      recentCount: recent.length,
      olderCount: older.length,
      olderSummaryLines,
      links: HandoffContext.extractHandoffLinks(carried),
      attachments: HandoffContext.summarizeHandoffAttachments(carried),
      toolLines: HandoffContext.summarizeHandoffToolItems(scoped),
    });
    const history = HandoffContext.selectHandoffHistory(recent, sourceThreadId, coverage);
    return {
      carried,
      handoffContext: {
        history: {
          messages: [...history.messages],
          coverage,
          omittedItems: history.omittedItems,
          omittedItemIds: [...history.omittedItemIds],
        },
        sourceThreadTitle: source.title,
        messagesCarried: carried.length,
        summaryUsed: older.length > 0,
      },
    };
  });
  /** The chat's recent window, and its messages through `throughMessageId`. */
  const chatThrough = Effect.fn("WorkHandoffService.chatThrough")(function* (
    sourceThreadId: ThreadId,
    throughMessageId: MessageId | undefined,
  ) {
    const readSourceError = (cause?: unknown) =>
      new WorkHandoffError({ sourceThreadId, stage: "read-source", cause });
    const source = (yield* threads
      .getThreadSnapshotWindow(sourceThreadId, { rowLimit: 30, userTurnLimit: 3 })
      .pipe(Effect.mapError(readSourceError))).projection;
    const messages = yield* messagesThrough(sourceThreadId, source.messages, throughMessageId).pipe(
      Effect.mapError(readSourceError),
    );
    return { source, messages };
  });
  const proposeHandoff: WorkHandoffService["Service"]["proposeHandoff"] = Effect.fn(
    "WorkHandoffService.proposeHandoff",
  )(function* (sourceThreadId, options) {
    yield* sourceThread(sourceThreadId);
    const { source, messages } = yield* chatThrough(sourceThreadId, options?.throughMessageId);
    // User messages carry the requirements. Omitting assistant replies also keeps
    // confirmations and other meta-chatter out of both generation and fallback.
    const requirements = settledText(messages)
      .filter((message) => message.role === "user")
      .filter((message) => !HandoffContext.isFillerMessage(message.text))
      .slice(-6)
      .map((message) => message.text.trim().slice(0, 2000));
    const fallback =
      requirements
        .flatMap((message) => message.split(/\n+|(?<=[.!?])\s+/u))
        .map((sentence) =>
          sentence.replace(/^\s*(?:[-*•]\s*|\d+[.)]\s*)?(?:user:\s*|assistant:\s*)?/iu, "").trim(),
        )
        .filter(Boolean)
        .filter((sentence) => !HandoffContext.isFillerMessage(sentence))
        .slice(0, 8)
        .map((sentence) => `- ${sentence.slice(0, 240)}`)
        .join("\n") || "- Confirm the implementation scope before making changes.";
    let scopeSummary = fallback;
    const repos = yield* projects.listShells().pipe(
      Effect.mapError(
        (cause) =>
          new WorkHandoffError({
            sourceThreadId: sourceThreadId,
            stage: "resolve-project",
            cause,
          }),
      ),
    );
    const mentioned = repos.filter((repo) => {
      const name = repo.workspaceRoot.split(/[\\/]/u).findLast(Boolean);
      return [repo.title, name].some(
        (part) =>
          part !== undefined &&
          part.length > 2 &&
          requirements.join("\n").toLowerCase().includes(part.toLowerCase()),
      );
    });
    const suggested =
      mentioned.length === 1
        ? mentioned[0]
        : repos.find((repo) => repo.id === source.thread.projectId);
    const project =
      suggested === undefined
        ? Option.none()
        : yield* projects.getById(suggested.id).pipe(
            Effect.mapError(
              (cause) =>
                new WorkHandoffError({
                  sourceThreadId: sourceThreadId,
                  stage: "resolve-project",
                  cause,
                }),
            ),
          );
    if (Option.isSome(project) && requirements.length > 0) {
      const summary = yield* settings.getSettings.pipe(
        Effect.flatMap((config) =>
          text.generateWorkScopeSummary({
            cwd: project.value.workspaceRoot,
            requirements: JSON.stringify(requirements),
            modelSelection: config.textGenerationModelSelection,
          }),
        ),
        Effect.map((result) => HandoffContext.cleanHandoffSummaryLines(result.summary).join("\n")),
        Effect.orElseSucceed(() => ""),
      );
      scopeSummary = summary || fallback;
    }
    const generated = Option.isSome(project)
      ? yield* settings.getSettings.pipe(
          Effect.flatMap((config) =>
            text.generateThreadTitle({
              cwd: project.value.workspaceRoot,
              message: scopeSummary,
              modelSelection: config.textGenerationModelSelection,
              linkedContext: "",
            }),
          ),
          Effect.map((result) => result.title.trim().slice(0, 200)),
          Effect.orElseSucceed(() => ""),
        )
      : "";
    return {
      title: generated || source.thread.title.slice(0, 200),
      scopeSummary,
      suggestedProjectId: suggested?.id ?? null,
    };
  });
  const handoffTask: WorkHandoffService["Service"]["handoffTask"] = Effect.fn(
    "WorkHandoffService.handoffTask",
  )(function* (input, actor) {
    yield* sourceThread(input.sourceThreadId);
    const resolveError = (cause?: unknown) =>
      new WorkHandoffError({
        sourceThreadId: input.sourceThreadId,
        stage: "resolve-project",
        cause,
      });
    // "No project" is the scratch project, created on first use as the web does.
    const targetProjectId =
      input.targetProjectId ??
      (yield* folders.ensureScratchProject.pipe(Effect.mapError(resolveError))).projectId;
    const project = yield* projects.getById(targetProjectId).pipe(Effect.mapError(resolveError));
    if (Option.isNone(project)) return yield* resolveError("No such project.");
    const taskId = WorkTaskId.make(`task:${input.commandId}`);
    const now = DateTime.formatIso(yield* DateTime.now);
    const task: WorkTask = {
      id: taskId,
      status: input.mode === "start" ? "started" : "proposed",
      requestedMode: input.mode,
      title: input.title.trim().slice(0, 200),
      brief: cardBrief(input.brief),
      targetProjectId,
      ...(input.machine === undefined ? {} : { machine: input.machine }),
      ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
      ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.settleWhenDone === true ? { settleWhenDone: true } : {}),
      createdAt: now,
      updatedAt: now,
    };
    if (input.mode === "propose") {
      yield* threads
        .dispatch({
          type: "work.task.propose",
          commandId: CommandId.make(`${input.commandId}:work-task`),
          threadId: input.sourceThreadId,
          task,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new WorkHandoffError({
                sourceThreadId: input.sourceThreadId,
                stage: "record-link",
                cause,
              }),
          ),
        );
      return {
        taskId,
        status: "proposed" as const,
        note: "A task card is waiting in the chat for the user to approve, edit or dismiss. Nothing has started. Tell them briefly what it will do; you hear back when the task finishes.",
      };
    }
    const result = yield* start(
      {
        commandId: input.commandId,
        sourceThreadId: input.sourceThreadId,
        targetProjectId,
        ...(input.machine === undefined ? {} : { machine: input.machine }),
        title: task.title,
        scopeSummary: input.brief.trim().slice(0, 16000),
        ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      },
      actor,
      task,
    );
    return {
      taskId,
      status: "started" as const,
      threadId: result.threadId,
      note: "The task started in its own Work thread, shown as a card in this chat. Tell the user briefly; you hear back here when it finishes, so do not poll it.",
    };
  });
  return WorkHandoffService.of({ start, proposeHandoff, handoffTask });
});
export const layer = Layer.effect(WorkHandoffService, make);
