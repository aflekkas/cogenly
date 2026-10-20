import {
  CommandId,
  WorkHandoffError,
  type AgentId,
  type MessageId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type WorkStartInput,
  type WorkStartResult,
  type WorkHandoffDraft,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type OrchestrationV2ThreadProjection,
  type Project,
} from "@t3tools/contracts";
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

/** Transport-owned provenance: RPC clients cannot impersonate an agent or choose its run. */
export interface WorkHandoffActor {
  readonly threadId?: ThreadId;
  readonly workspaceStrategy?: OrchestrationV2ThreadLaunchWorkspaceStrategy;
  readonly origin: "chat" | "agent";
  readonly sourceAgentId?: AgentId;
  readonly sourceAgentRunId?: string;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}
type ChatMessages = OrchestrationV2ThreadProjection["messages"];

const settledText = (messages: ChatMessages) =>
  messages.filter((message) => !message.streaming && message.text.trim());

/**
 * The scope a handoff carries when the caller wrote none: the chat's own words,
 * so Work can start at once. The user's latest requests, oldest first, and the
 * assistant's reply when the handoff stops at one (often the plan to build).
 */
export function chatHandoffScope(messages: ChatMessages): string {
  const settled = settledText(messages);
  const requests = settled
    .filter((message) => message.role === "user")
    .slice(-6)
    .map((message, index) => `${index + 1}. ${message.text.trim().slice(0, 1500)}`);
  const last = settled.at(-1);
  const sections = [
    ...(requests.length > 0
      ? [`Requests from the chat, oldest first:\n\n${requests.join("\n\n")}`]
      : []),
    ...(last?.role === "assistant"
      ? [`The chat's reply this handoff starts from:\n\n${last.text.trim().slice(0, 6000)}`]
      : []),
  ];
  return (sections.join("\n\n") || "Continue the work discussed in the source conversation.").slice(
    0,
    16000,
  );
}

export class WorkHandoffService extends Context.Service<
  WorkHandoffService,
  {
    readonly start: (
      input: WorkStartInput,
      actor?: WorkHandoffActor,
    ) => Effect.Effect<WorkStartResult, WorkHandoffError>;
    /** `throughMessageId` drafts from the chat up to and including that message. */
    readonly proposeHandoff: (
      sourceThreadId: ThreadId,
      options?: { readonly throughMessageId?: MessageId | undefined },
    ) => Effect.Effect<WorkHandoffDraft, WorkHandoffError>;
  }
>()("t3/work/WorkHandoffService") {}

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
    function* (input, actor) {
      const source = yield* sourceThread(input.sourceThreadId);
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
      // No scope or title from the caller: carry the chat's own words over and
      // let the Work thread title itself from them, as a new thread does.
      const scopeSummary =
        input.scopeSummary ??
        chatHandoffScope(
          (yield* chatThrough(input.sourceThreadId, input.throughMessageId)).messages,
        );
      const cutOff =
        input.throughMessageId === undefined
          ? ""
          : `\nThe handoff covers the source conversation through message ${input.throughMessageId}; ignore anything after it.`;
      // The existing launch service owns repository validation, provisioning, setup,
      // deferred execution, receipts and retries. No transcript is copied into Work.
      const result = yield* launches
        .launch({
          commandId: input.commandId,
          ...(actor?.threadId === undefined ? {} : { threadId: actor.threadId }),
          projectId: input.targetProjectId,
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
          createdBy: origin === "agent" ? "agent" : "user",
          creationSource: origin === "agent" ? "mcp" : "web",
          initialMessage: {
            text: `${scopeSummary}\n\nSource conversation: [${source.thread.title}](cogenly-thread://v1/${input.sourceThreadId})\nSource thread ID: ${input.sourceThreadId}${cutOff}\n${input.scopeSummary === undefined ? "These are the chat's own words; read the source conversation for the rest of its context before making changes." : "Use this approved scope; follow the source reference if more context is needed."}`,
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
      .slice(-6)
      .map((message) => message.text.trim().slice(0, 2000));
    const fallback =
      requirements
        .flatMap((message) => message.split(/\n+|(?<=[.!?])\s+/u))
        .map((sentence) =>
          sentence.replace(/^\s*(?:[-*•]\s*|\d+[.)]\s*)?(?:user:\s*|assistant:\s*)?/iu, "").trim(),
        )
        .filter(Boolean)
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
        Effect.map((result) =>
          result.summary
            .split("\n")
            .map((line) => line.replace(/^\s*(?:[-*•]\s*)?(?:user|assistant):\s*/iu, "").trim())
            .filter((line) => line.length > 0 && !line.startsWith("```"))
            .slice(0, 8)
            .map((line) => line.slice(0, 240))
            .join("\n"),
        ),
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
  return WorkHandoffService.of({ start, proposeHandoff });
});
export const layer = Layer.effect(WorkHandoffService, make);
