import { isReplayedCommandId } from "../orchestration-v2/ReplayedCommandIds.ts";
import * as Access from "./AgentAccessScope.ts";
import { canReceiveAgentEvent } from "./agentEventPolicy.ts";
import { agentKickoffText } from "./builderPrompt.ts";
import {
  BUILDER_THREAD_TITLE,
  defaultAgentPermissions,
  AgentError,
  AgentId,
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TurnItemId,
  AgentEventContext,
  ScheduledTaskSchedule,
  type Agent,
  type AgentBuilderProposal,
  type AgentBuilderStartInput,
  type AgentBuilderStartResult,
  type AgentListItem,
  type AgentMarkReadInput,
  type AgentSetProjectInput,
  type ProjectLabelId,
  type AgentUpsertInput,
  type AgentSendInput,
  type AgentWorkRun,
  type ScheduledTask,
} from "@cogenly/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import * as RemoteLaunch from "../orchestration-v2/RemoteThreadLaunch.ts";
import * as SharedState from "../sync/SharedState.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ApprovalChanges from "./ApprovalChanges.ts";
import * as Store from "./AgentStore.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Labels from "../projectLabels/ProjectLabelService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as ServerConfig from "../config.ts";
import * as FileSystem from "effect/FileSystem";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { conversationCarryOver } from "./context.ts";
import {
  advanceFallback,
  chainIndexOf,
  classifyProviderFailure,
  decideFallback,
  fallbackChainOf,
} from "./providerFallback.ts";

const encodeEventContext = Schema.encodeEffect(Schema.fromJsonString(AgentEventContext));
const encodeEventSchedule = Schema.encodeEffect(Schema.fromJsonString(ScheduledTaskSchedule));
const isAgentError = Schema.is(AgentError);
const failure = (cause: unknown) =>
  isAgentError(cause)
    ? cause
    : new AgentError({ message: "Could not complete agent operation.", cause });
export class AgentService extends Context.Service<
  AgentService,
  {
    readonly list: () => Effect.Effect<{ agents: ReadonlyArray<AgentListItem> }, AgentError>;
    readonly subscribe: () => Stream.Stream<{ agents: ReadonlyArray<AgentListItem> }, AgentError>;
    readonly markRead: (
      input: AgentMarkReadInput,
    ) => Effect.Effect<{ agent: AgentListItem }, AgentError>;
    readonly upsert: (
      input: AgentUpsertInput,
      creationId?: AgentId,
    ) => Effect.Effect<{ agent: Agent }, AgentError>;
    /** Re-file the agent's conversation in a project folder, or unfile it with null. */
    readonly setProject: (
      input: AgentSetProjectInput,
    ) => Effect.Effect<{ agent: Agent }, AgentError>;
    readonly builderStart: (
      input: AgentBuilderStartInput,
    ) => Effect.Effect<AgentBuilderStartResult, AgentError>;
    /** Replace a builder thread's proposal item; latest call wins. */
    readonly recordProposal: (input: {
      readonly threadId: ThreadId;
      readonly proposal: AgentBuilderProposal;
    }) => Effect.Effect<{ proposal: AgentBuilderProposal }, AgentError>;
    readonly delete: (id: AgentId) => Effect.Effect<{ deleted: boolean }, AgentError>;
    readonly send: (input: AgentSendInput) => Effect.Effect<
      {
        threadId: ThreadId;
        runId: import("@cogenly/contracts").RunId;
        delivery: Threads.ThreadManagementSendResult["delivery"];
      },
      AgentError
    >;
    readonly trigger: (
      task: ScheduledTask,
      fireKey: string,
      prompt: string,
      context?: AgentEventContext,
    ) => Effect.Effect<boolean, AgentError>;
    /** Also called on startup; terminal runs with undelivered postbacks survive restarts. */
    readonly reconcile: (options?: {
      readonly afterRestart?: boolean;
    }) => Effect.Effect<void, AgentError>;
  }
>()("cogenly-server/agents/AgentService") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const shared = yield* SharedState.SharedState;
  const remoteLaunch = yield* Effect.serviceOption(RemoteLaunch.RemoteThreadLaunch);
  const store = yield* Store.AgentStore;
  const launch = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* Threads.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const events = yield* EventSink.EventSinkV2;
  const scheduler = yield* Scheduler.Scheduler;
  const sql = yield* SqlClient.SqlClient;
  const folders = yield* Folders.ManagedProjectFolders;
  const labels = yield* Labels.ProjectLabelService;
  const access = yield* Access.AgentAccessScope;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const changes = yield* PubSub.sliding<void>(1);
  const changed = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  // Clients re-read an agent's pending approvals when this list ticks.
  const approvalChanges = yield* ApprovalChanges.optional;
  const list = () => store.list().pipe(Effect.map((agents) => ({ agents })));
  // The conversation's folder membership is the agent's project, so it also
  // decides the conversation's cwd and project manifest. Like every thread
  // it re-files in place (never forks), and not while a run is active.
  const fileConversation = (threadId: ThreadId, folderId: ProjectLabelId | null) =>
    labels.moveThread({ threadId, folderId }).pipe(
      Effect.mapError(
        (cause) =>
          new AgentError({
            message:
              cause.reason === "not_found"
                ? "That project no longer exists."
                : cause.reason === "archived"
                  ? cause.message
                  : "Could not move the agent to that project.",
            cause,
          }),
      ),
    );
  // A pre-check for flows that launch a thread before filing it.
  const requireActiveProject = (folderId: ProjectLabelId) =>
    labels.readActive(folderId).pipe(
      Effect.mapError(
        (cause) =>
          new AgentError({
            message: cause.reason === "archived" ? cause.message : "That project no longer exists.",
            cause,
          }),
      ),
    );
  const workspace = (agent: Agent) =>
    projections.getThread(agent.conversationThreadId).pipe(Effect.map((t) => t.projectId));
  // Shared agent configuration can arrive before its owner has opened the conversation.
  // Only that owner creates the fixed thread id; other machines keep configuration only.
  const ensureConversation = Effect.fn("AgentService.ensureConversation")(function* (agent: Agent) {
    if (agent.ownerMachine !== undefined && agent.ownerMachine !== shared.environmentId) return;
    if ((yield* projections.getThreadShell(agent.conversationThreadId)) !== null) return;
    const projectId = agent.projectId ?? (yield* folders.ensureScratchProject).projectId;
    yield* launch.launch({
      agent: { id: agent.id, role: "conversation" },
      commandId: CommandId.make(`agent-create:${agent.id}`),
      threadId: agent.conversationThreadId,
      projectId,
      title: agent.name,
      modelSelection: agent.modelSelection,
      runtimeMode: agent.runtimeMode,
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      createdBy: "user",
      creationSource: "server",
    });
  });
  // This is a passive assistant message: no message.dispatch and no provider effect.
  // A stable command receipt makes replay after a crash exactly-once in the conversation.
  const post = (agent: Agent, run: AgentWorkRun) =>
    Effect.gen(function* () {
      if (agent.notifyPolicy !== "all" && run.status === "completed") {
        const changes =
          yield* sql`SELECT 1 FROM agent_run_actions a JOIN orchestration_v2_projection_runs r ON r.run_id = a.run_id WHERE r.thread_id = ${run.workThreadId} LIMIT 1`;
        if (agent.notifyPolicy === "action_required" || changes.length === 0) {
          yield* store.markPosted(run.id);
          return;
        }
      }
      const at = yield* DateTime.now;
      const commandId = CommandId.make(`agent-post:${run.id}`);
      const messageId = MessageId.make(`agent-post:${run.id}`);
      yield* events.commitCommand({
        commandId,
        threadId: agent.conversationThreadId,
        commandType: "agent.post",
        acceptedAt: at,
        effects: [],
        events: [
          {
            id: EventId.make(`agent-post:${run.id}`),
            type: "message.updated",
            threadId: agent.conversationThreadId,
            occurredAt: at,
            payload: {
              id: messageId,
              threadId: agent.conversationThreadId,
              runId: null,
              nodeId: null,
              role: "assistant",
              text: run.summary ?? "Work finished.",
              attachments: [],
              streaming: false,
              createdAt: at,
              updatedAt: at,
              createdBy: "agent",
              creationSource: "server",
              senderThreadId: run.workThreadId,
              scheduledTaskId: run.triggerId,
            },
          },
          {
            id: EventId.make(`agent-post-item:${run.id}`),
            type: "turn-item.updated",
            threadId: agent.conversationThreadId,
            occurredAt: at,
            payload: {
              id: TurnItemId.make(`agent-post:${run.id}`),
              type: "assistant_message",
              messageId,
              threadId: agent.conversationThreadId,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "completed",
              title: agent.name,
              text: run.summary ?? "Work finished.",
              streaming: false,
              startedAt: at,
              completedAt: at,
              updatedAt: at,
            },
          },
        ],
      });
      yield* store.markPosted(run.id);
      yield* changed;
    });
  const removeAgent = (id: AgentId) =>
    Effect.gen(function* () {
      const agent = (yield* store.list()).find((candidate) => candidate.id === id);
      if (agent === undefined) return { deleted: false };
      // Retire before stopping work so a due trigger cannot launch while deletion waits.
      yield* store.retire(id);
      const runs = yield* store.runs(id);
      const threadIds = [
        agent.conversationThreadId,
        ...runs
          .filter((run) => run.status === "starting" || run.status === "running")
          .map((run) => run.workThreadId),
      ];
      for (const threadId of agent.ownerMachine === undefined ||
      agent.ownerMachine === shared.environmentId
        ? threadIds
        : []) {
        const thread = yield* projections.getThreadShell(threadId);
        if (thread === null) continue;
        yield* threads.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`agent-delete:${id}:${threadId}`),
          threadId,
          reason: "Agent deleted.",
        });
      }
      const deleted = yield* store.delete(id);
      yield* changed;
      return { deleted };
    }).pipe(Effect.mapError(failure));
  const reconcile: AgentService["Service"]["reconcile"] = (options) =>
    Effect.gen(function* () {
      const deletions = yield* sql<{
        id: string;
      }>`SELECT d.id FROM shared_documents d JOIN agents a ON a.agent_id=d.id WHERE d.kind='agent' AND d.tombstone_json IS NOT NULL`;
      for (const document of deletions) yield* removeAgent(AgentId.make(document.id));
      const runs = yield* store.runs();
      for (const record of runs) {
        yield* Effect.gen(function* () {
          const agent = yield* store.get(record.agentId);
          if (agent.ownerMachine !== undefined && agent.ownerMachine !== shared.environmentId)
            return;
          if (record.status === "completed" || record.status === "failed") {
            yield* post(agent, record);
            return;
          }
          const projection = yield* projections
            .getThreadRecords(record.workThreadId, ["runs", "messages", "turnItems"])
            .pipe(
              Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
            );
          const run = projection?.runs.at(-1);
          if (
            run === undefined &&
            (options?.afterRestart ||
              DateTime.toEpochMillis(yield* DateTime.now) - Date.parse(record.createdAt) > 300000)
          ) {
            const summary = options?.afterRestart
              ? "Cogenly restarted during this run, before its first turn started."
              : "This job was interrupted before its first turn started.";
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* store.outcome(agent.id, false);
                yield* store.finishRun(record.id, "failed", summary);
              }),
            );
            yield* post(agent, { ...record, status: "failed", summary });
            return;
          }
          if (projection === null) return;
          if (run?.status === "waiting") {
            yield* post(agent, {
              ...record,
              id: `${record.id}:approval:${run.id}`,
              summary: "I need your input or approval. Open this job's work details to continue.",
            });
          }
          if (
            run === undefined ||
            ["preparing", "queued", "starting", "running", "waiting"].includes(run.status)
          )
            return;
          // Restart recovery cancels (rather than fails) a job run it resumes.
          // Its outcome is the continuation run's, so wait for that to start.
          if (
            run.status === "cancelled" &&
            (yield* sql`SELECT 1 FROM orchestration_v2_effect_outbox WHERE effect_id = ${`effect:restart-continuation:${run.id}`} AND status IN ('pending', 'running')`)
              .length > 0
          )
            return;
          const succeeded = run.status === "completed";
          const response = projection.messages
            .filter((m) => m.role === "assistant" && m.runId === run.id)
            .map((m) => m.text)
            .join("\n")
            .trim();
          // A usage-limit / signed-out failure advances the fallback chain
          // instead of just backing off on the same provider; other
          // failures keep the normal backoff in `outcome`.
          const failureItem = succeeded
            ? undefined
            : projection.turnItems.find((item) => item.type === "error" && item.runId === run.id);
          const advance =
            failureItem?.type === "error"
              ? advanceFallback({
                  chainLength: fallbackChainOf(agent).length,
                  failedIndex: chainIndexOf(fallbackChainOf(agent), record.modelSelection),
                  reason: classifyProviderFailure(failureItem.failure),
                  resetAt: failureItem.failure.resetAt,
                  nowMs: DateTime.toEpochMillis(yield* DateTime.now),
                  existingUntil: agent.fallbackUntil ?? null,
                })
              : null;
          const updated = yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* store.outcome(agent.id, succeeded);
              if (advance !== null)
                yield* store.setFallback(agent.id, {
                  index: advance.index,
                  reason: advance.reason,
                  until: advance.until,
                });
              const summary = projection.turnItems.some(
                (item) =>
                  item.runId === run.id &&
                  item.type === "error" &&
                  item.failure.code === "server_restarted",
              )
                ? "Cogenly restarted during this run. Open the work details to inspect partial work."
                : response.slice(0, 1200) ||
                  (succeeded
                    ? "Work finished."
                    : "This run failed. Open the work details to inspect it.");
              yield* store.finishRun(
                record.id,
                succeeded ? "completed" : "failed",
                summary,
                advance === null ? undefined : { reason: advance.reason, resetAt: advance.resetAt },
              );
              return {
                ...record,
                status: succeeded ? ("completed" as const) : ("failed" as const),
                summary,
                ...(advance === null
                  ? {}
                  : {
                      fallbackReason: advance.reason,
                      fallbackResetAt: advance.resetAt,
                    }),
              };
            }),
          );
          yield* post(agent, updated);
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not reconcile agent run", {
              agentId: record.agentId,
              runId: record.id,
              cause,
            }),
          ),
        );
      }
    }).pipe(Effect.mapError(failure));
  yield* scheduler.register("agents", reconcile());
  return AgentService.of({
    list,
    markRead: (input) =>
      store.markRead(input).pipe(
        Effect.tap(() => changed),
        Effect.map((agent) => ({ agent })),
      ),
    subscribe: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          // Filing changes from any surface (a thread move, a deleted folder)
          // change an agent's project.
          const folderChanges = yield* labels.subscribeChanges;
          const approvals = yield* approvalChanges.subscribe;
          const afterSequence = yield* events.latestSequence().pipe(Effect.mapError(failure));
          const messages = events
            .stream({ afterSequence, eventType: "message.updated", bounded: true })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "message.updated" &&
                  !isReplayedCommandId(stored.commandId) &&
                  stored.event.payload.role === "assistant" &&
                  !stored.event.payload.streaming,
              ),
              Stream.filterEffect((stored) =>
                store
                  .forThread(stored.event.threadId)
                  .pipe(
                    Effect.map((agent) => agent?.conversationThreadId === stored.event.threadId),
                  ),
              ),
              Stream.map(() => undefined),
              Stream.mapError(failure),
            );
          return Stream.concat(
            Stream.fromEffect(list()),
            Stream.mergeAll(
              [
                Stream.fromSubscription(subscription),
                shared.changes,
                folderChanges,
                approvals,
                messages,
              ],
              {
                concurrency: "unbounded",
              },
            ).pipe(Stream.mapEffect(list)),
          );
        }),
      ),
    upsert: (input, creationId) =>
      Effect.gen(function* () {
        const at = DateTime.formatIso(yield* DateTime.now);
        const existing =
          input.id === undefined
            ? creationId === undefined
              ? null
              : yield* store.get(creationId).pipe(Effect.orElseSucceed(() => null))
            : yield* store.get(input.id);
        const ownerMachine =
          input.ownerMachine ?? existing?.ownerMachine ?? (yield* shared.defaultOwner);
        const ownsAgent = ownerMachine === shared.environmentId;
        const id =
          existing?.id ?? creationId ?? AgentId.make(`agent:${yield* crypto.randomUUIDv4()}`);
        if (existing === null && !ownsAgent) {
          if (Option.isNone(remoteLaunch))
            return yield* new AgentError({
              message: "That machine is unavailable. Create the agent on this machine instead.",
            });
          yield* remoteLaunch.value
            .createAgent(ownerMachine, input, id)
            .pipe(Effect.mapError((cause) => new AgentError({ message: cause.message, cause })));
          yield* changed;
          return { agent: yield* store.get(id) };
        }
        const conversationThreadId =
          existing?.conversationThreadId ?? ThreadId.make(`agent-conversation:${id}`);
        if (existing === null && ownsAgent) {
          if (input.projectId === null)
            return yield* new AgentError({ message: "Choose a project to create an agent." });
          // Before the launch, so a refused project leaves no orphan conversation.
          if (input.projectFolderId !== undefined && input.projectFolderId !== null)
            yield* requireActiveProject(input.projectFolderId);
          yield* launch.launch({
            agent: { id, role: "conversation" },
            commandId: CommandId.make(`agent-create:${id}`),
            threadId: conversationThreadId,
            projectId: input.projectId,
            title: input.name,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            createdBy: "user",
            creationSource: "web",
          });
        }
        if (
          ownsAgent &&
          input.projectFolderId !== undefined &&
          (existing === null
            ? input.projectFolderId !== null
            : input.projectFolderId !== existing.projectFolderId)
        )
          yield* fileConversation(conversationThreadId, input.projectFolderId);
        const { kickoff: _kickoff, projectFolderId: _projectFolderId, ...profile } = input;
        // Editing the primary or the chain restarts fallback from the primary.
        const sameSelection = (a: Agent["modelSelection"], b: Agent["modelSelection"]) => {
          const aOptions = Object.entries(a.options ?? {});
          const bOptions = new Map(Object.entries(b.options ?? {}));
          return (
            a.instanceId === b.instanceId &&
            a.model === b.model &&
            aOptions.length === bOptions.size &&
            aOptions.every(([key, value]) => bOptions.get(key) === value)
          );
        };
        // An edit that omits the chain keeps the stored one; only a chain
        // that actually differs (or a new primary) restarts fallback.
        const nextChain = input.fallbackChain ?? existing?.fallbackChain ?? [];
        const chainChanged =
          existing !== null &&
          (!sameSelection(input.modelSelection, existing.modelSelection) ||
            nextChain.length !== (existing.fallbackChain ?? []).length ||
            nextChain.some(
              (entry, index) => !sameSelection(entry, (existing.fallbackChain ?? [])[index]!),
            ));
        const agent = yield* store.save({
          ...profile,
          ownerMachine,
          fallbackChain: nextChain,
          projectFolderId: null,
          responsibility: input.responsibility ?? existing?.responsibility ?? "",
          permissions: input.permissions ?? existing?.permissions ?? defaultAgentPermissions,
          notifyPolicy: input.notifyPolicy ?? existing?.notifyPolicy ?? "meaningful_changes",
          id,
          conversationThreadId,
          createdAt: existing?.createdAt ?? at,
          updatedAt: at,
          consecutiveFailures: existing?.consecutiveFailures ?? 0,
          backoffUntil: existing?.backoffUntil ?? null,
          fallbackIndex: chainChanged ? 0 : (existing?.fallbackIndex ?? 0),
          fallbackReason: chainChanged ? null : (existing?.fallbackReason ?? null),
          fallbackUntil: chainChanged ? null : (existing?.fallbackUntil ?? null),
        });
        if (existing !== null && ownsAgent) {
          yield* ensureConversation(agent);
          yield* threads.dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make(`agent-mode:${id}:${at}`),
            threadId: conversationThreadId,
            runtimeMode: agent.runtimeMode,
          });
          yield* threads.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`agent-name:${id}:${at}`),
            threadId: conversationThreadId,
            title: agent.name,
          });
        }
        if (existing === null && ownsAgent && input.kickoff === true) {
          // The agent opens with its own turn; clients hide a turn the owner
          // did not write. The agent exists either way, so a lost greeting
          // is a warning, not a failed create.
          yield* threads
            .sendToThread({
              projectId: yield* workspace(agent),
              commandId: CommandId.make(`agent-kickoff:${id}`),
              messageId: MessageId.make(`agent-kickoff:${id}`),
              threadId: conversationThreadId,
              text: agentKickoffText,
              attachments: [],
              modelSelection: agent.modelSelection,
              mode: "auto",
              createdBy: "agent",
              creationSource: "server",
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Agent kickoff turn did not start", { agentId: id, cause }),
              ),
            );
        }
        yield* changed;
        return { agent };
      }).pipe(Effect.mapError(failure)),
    setProject: (input) =>
      Effect.gen(function* () {
        const existing = yield* store.get(input.id);
        if (existing.projectFolderId !== input.projectFolderId)
          yield* fileConversation(existing.conversationThreadId, input.projectFolderId);
        yield* changed;
        return { agent: yield* store.get(input.id) };
      }).pipe(Effect.mapError(failure)),
    builderStart: (input) =>
      Effect.gen(function* () {
        const projectId =
          input.projectId ??
          (yield* folders.ensureScratchProject.pipe(
            Effect.mapBoth({
              onFailure: () =>
                new AgentError({ message: "This machine can't start a conversation right now." }),
              onSuccess: (scratch) => scratch.projectId,
            }),
          ));
        if (input.projectFolderId !== undefined) yield* requireActiveProject(input.projectFolderId);
        const key = yield* crypto.randomUUIDv4();
        const threadId = ThreadId.make(`agent-builder:${key}`);
        yield* launch.launch({
          surface: "builder",
          ...(input.machine === undefined ? {} : { machine: input.machine }),
          ...(input.projectFolderId === undefined
            ? {}
            : { projectFolderId: input.projectFolderId }),
          commandId: CommandId.make(`agent-builder:${key}`),
          threadId,
          projectId,
          title: BUILDER_THREAD_TITLE,
          modelSelection: input.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          createdBy: "user",
          creationSource: "web",
          initialMessage: {
            messageId: MessageId.make(`agent-builder:${key}`),
            text: input.text,
            attachments: [],
          },
        });
        // Builder threads are not gated, so filing after launch is direct; the
        // proposed agent defaults to this project.
        // ThreadLaunchService files it on its owner before its first turn.
        return { threadId, projectId };
      }).pipe(Effect.mapError(failure)),
    recordProposal: (input) =>
      Effect.gen(function* () {
        const thread = yield* projections.getThread(input.threadId);
        if (thread.surface !== "builder")
          return yield* new AgentError({
            message: "propose_agent only runs in a builder thread.",
          });
        const at = yield* DateTime.now;
        // A stable item id keeps one proposal per thread: every call replaces
        // the last. The command and event ids stay unique so each call commits.
        const key = yield* crypto.randomUUIDv4();
        yield* events.commitCommand({
          commandId: CommandId.make(`agent-proposal:${key}`),
          threadId: input.threadId,
          commandType: "agent.propose",
          acceptedAt: at,
          effects: [],
          events: [
            {
              id: EventId.make(`agent-proposal:${key}`),
              type: "turn-item.updated",
              threadId: input.threadId,
              occurredAt: at,
              payload: {
                id: TurnItemId.make(`agent-proposal:${input.threadId}`),
                type: "agent_proposal",
                threadId: input.threadId,
                runId: null,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 0,
                status: "completed",
                title: input.proposal.name,
                proposal: input.proposal,
                startedAt: at,
                completedAt: at,
                updatedAt: at,
              },
            },
          ],
        });
        return { proposal: input.proposal };
      }).pipe(Effect.mapError(failure)),
    delete: removeAgent,
    send: (input) =>
      Effect.gen(function* () {
        const agent = yield* store.get(input.id);
        if (agent.ownerMachine !== undefined && agent.ownerMachine !== shared.environmentId)
          return yield* new AgentError({ message: "This agent runs on another machine." });
        yield* ensureConversation(agent);
        // Backoff and daily caps govern background reservations only.
        // An owner text always reaches the provider. Intake claims its pending
        // uploads into the conversation, as it does for a chat send.
        const result = yield* ThreadMessageIntake.sendToThread({
          projectId: yield* workspace(agent),
          commandId: input.commandId,
          messageId: input.messageId,
          threadId: agent.conversationThreadId,
          text: input.text,
          attachments: input.attachments ?? [],
          modelSelection: agent.modelSelection,
          mode: input.mode ?? "auto",
          createdBy: "user",
          creationSource: "web",
        }).pipe(
          Effect.provideService(Threads.ThreadManagementService, threads),
          Effect.provideService(ServerConfig.ServerConfig, serverConfig),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          // The claim's reason ("not found", "size does not match") is the owner's to read.
          Effect.catchTags({
            AttachmentClaimError: (cause) =>
              Effect.fail(new AgentError({ message: cause.message, cause })),
          }),
        );
        return {
          threadId: agent.conversationThreadId,
          runId: result.run.id,
          delivery: result.delivery,
        };
      }).pipe(Effect.mapError(failure)),
    trigger: (task, fireKey, prompt, context) =>
      Effect.gen(function* () {
        if (task.agentId == null) return false;
        if (task.schedule.type === "event" && context === undefined)
          return yield* new AgentError({
            message: "Event triggers require a source event and cannot be run manually.",
          });
        let agent = yield* store.get(task.agentId);
        if (
          (agent.ownerMachine !== undefined && agent.ownerMachine !== shared.environmentId) ||
          (task.ownerMachine !== undefined && task.ownerMachine !== shared.environmentId)
        )
          return false;
        yield* ensureConversation(agent);
        const id = `agent-work:${fireKey}`;
        const workThreadId = ThreadId.make(id);
        let usedSelection = agent.modelSelection;
        let usedFallbackReason: Agent["fallbackReason"] = null;
        const accepted = yield* sql.withTransaction(
          Effect.gen(function* () {
            if (context !== undefined) {
              agent = yield* store.get(task.agentId!);
              const scheduleJson = yield* encodeEventSchedule(task.schedule);
              const current =
                yield* sql`SELECT 1 FROM scheduled_tasks WHERE task_id = ${task.id} AND enabled = 1 AND agent_id = ${agent.id} AND project_id = ${task.projectId} AND created_at = ${task.createdAt} AND schedule_json = ${scheduleJson}`;
              if (current.length === 0) return false;
              if (!canReceiveAgentEvent(yield* access.resolve(agent.id), task, context))
                return false;
              const prior =
                yield* sql`SELECT 1 FROM agent_event_deliveries WHERE agent_id = ${agent.id} AND event_key = ${context.dedupKey}`;
              if (prior.length) return false;
            }
            if (!(yield* store.reserve(agent.id))) return false;
            const decision = decideFallback(agent, DateTime.toEpochMillis(yield* DateTime.now));
            if (decision.restored)
              yield* store.setFallback(agent.id, { index: 0, reason: null, until: null });
            usedSelection = decision.selection;
            usedFallbackReason = decision.reason;
            if (context !== undefined) {
              const inherited = {
                ...context,
                chainDepth: context.chainDepth + 1,
                chainAgentIds: [...new Set([...context.chainAgentIds, agent.id])],
              };
              const contextJson = yield* encodeEventContext(inherited);
              yield* sql`INSERT INTO agent_event_deliveries(agent_id, event_key, work_thread_id, context_json) VALUES (${agent.id}, ${context.dedupKey}, ${workThreadId}, ${contextJson})`;
              yield* sql`INSERT INTO agent_run_threads(thread_id, agent_id, trigger_kind, source_run_id) VALUES (${workThreadId}, ${agent.id}, 'event', ${context.refs.runId ?? null})`;
            }
            yield* store.createRun({
              id,
              agentId: agent.id,
              triggerId: task.id,
              triggerKind: context === undefined ? "trigger" : "event",
              ...(context === undefined ? {} : { triggerContext: context }),
              workThreadId,
              status: "starting",
              createdAt: DateTime.formatIso(yield* DateTime.now),
              completedAt: null,
              summary: null,
              posted: false,
              modelSelection: usedSelection,
              ...(usedFallbackReason === null ? {} : { fallbackReason: usedFallbackReason }),
            });
            return true;
          }),
        );
        if (!accepted) return false;
        const conversation = yield* projections.getThreadRecords(agent.conversationThreadId, [
          "messages",
        ]);
        const carry = conversationCarryOver("", conversation.messages);
        const result = yield* Effect.result(
          launch.launch({
            agent: { id: agent.id, role: "work" },
            surface: "work",
            workOrigin: "agent",
            sourceAgentId: agent.id,
            sourceAgentRunId: id,
            commandId: CommandId.make(id),
            threadId: workThreadId,
            projectId: agent.projectId ?? task.projectId,
            title: `${agent.name}: ${task.title}`,
            modelSelection: usedSelection,
            runtimeMode: agent.runtimeMode,
            interactionMode: task.interactionMode,
            workspaceStrategy: task.workspaceStrategy,
            createdBy: "agent",
            creationSource: "server",
            initialMessage: {
              messageId: MessageId.make(id),
              scheduledTaskId: task.id,
              text: `Background job for ${agent.name}. Finish with a short owner-facing result, question, or approval request. Details stay in this work thread.\n\nConversation summary:\n${carry.summary}\nRecent conversation:\n${carry.recent}\n\nTrigger:\n${prompt}${context === undefined ? "" : `\n\nEvent context:\n${yield* encodeEventContext(context)}`}`,
              attachments: [],
            },
          }),
        );
        if (result._tag === "Success") yield* store.markRunning(id);
        if (result._tag === "Failure") {
          yield* store.outcome(agent.id, false);
          yield* store.finishRun(
            id,
            "failed",
            "I could not start this job. Open its work details to inspect it.",
          );
        }
        yield* changed;
        return true;
      }).pipe(Effect.mapError(failure)),
    reconcile,
  });
});
export const layer = Layer.effect(AgentService, make)
  .pipe(Layer.provide(SharedState.layer))
  .pipe(Layer.provide(Access.layer));
