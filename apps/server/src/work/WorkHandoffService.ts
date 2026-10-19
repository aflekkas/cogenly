import {
  CommandId,
  WorkHandoffError,
  type AgentId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type WorkStartInput,
  type WorkStartResult,
  type WorkHandoffDraft,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Projects from "../project/ProjectService.ts";
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
export class WorkHandoffService extends Context.Service<
  WorkHandoffService,
  {
    readonly start: (
      input: WorkStartInput,
      actor?: WorkHandoffActor,
    ) => Effect.Effect<WorkStartResult, WorkHandoffError>;
    readonly proposeHandoff: (
      sourceThreadId: ThreadId,
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
      const workspaceStrategy =
        actor?.workspaceStrategy ??
        (input.workspace === "local"
          ? { type: "root" as const }
          : { type: "worktree" as const, baseRef: "HEAD", startFromOrigin: false });
      // The existing launch service owns repository validation, provisioning, setup,
      // deferred execution, receipts and retries. No transcript is copied into Work.
      const result = yield* launches
        .launch({
          commandId: input.commandId,
          ...(actor?.threadId === undefined ? {} : { threadId: actor.threadId }),
          projectId: input.targetProjectId,
          title: input.title,
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
            text: `${input.scopeSummary}\n\nSource conversation: [${source.thread.title}](t3-thread://v1/${input.sourceThreadId})\nSource thread ID: ${input.sourceThreadId}\nUse this approved scope; follow the source reference if more context is needed.`,
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
          scopeSummary: input.scopeSummary,
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
  const proposeHandoff: WorkHandoffService["Service"]["proposeHandoff"] = Effect.fn(
    "WorkHandoffService.proposeHandoff",
  )(function* (sourceThreadId) {
    yield* sourceThread(sourceThreadId);
    const source = (yield* threads
      .getThreadSnapshotWindow(sourceThreadId, { rowLimit: 30, userTurnLimit: 3 })
      .pipe(
        Effect.mapError(
          (cause) =>
            new WorkHandoffError({ sourceThreadId: sourceThreadId, stage: "read-source", cause }),
        ),
      )).projection;
    // Extractive draft: requirements stay attributable to the chat and editable.
    // The text-generation interface currently offers titles, not arbitrary summaries.
    const recent = source.messages
      .filter((message) => !message.streaming && message.text.trim().length > 0)
      .slice(-6);
    const scopeSummary =
      recent.length === 0
        ? `Continue the work discussed in “${source.thread.title}”. Confirm the implementation scope before making changes.`
        : recent
            .map((message) => `${message.role}: ${message.text.trim().slice(0, 2000)}`)
            .join("\n\n")
            .slice(0, 12000);
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
          scopeSummary.toLowerCase().includes(part.toLowerCase()),
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
