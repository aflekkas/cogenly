import {
  AgentError,
  AgentId,
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TurnItemId,
  type Agent,
  type AgentUpsertInput,
  type AgentSendInput,
  type AgentWorkRun,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./AgentStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { conversationCarryOver } from "./context.ts";

const isAgentError = Schema.is(AgentError);
const failure = (cause: unknown) =>
  isAgentError(cause)
    ? cause
    : new AgentError({ message: "Could not complete agent operation.", cause });
export class AgentService extends Context.Service<
  AgentService,
  {
    readonly list: () => Effect.Effect<{ agents: ReadonlyArray<Agent> }, AgentError>;
    readonly subscribe: () => Stream.Stream<{ agents: ReadonlyArray<Agent> }, AgentError>;
    readonly upsert: (input: AgentUpsertInput) => Effect.Effect<{ agent: Agent }, AgentError>;
    readonly delete: (id: AgentId) => Effect.Effect<{ deleted: boolean }, AgentError>;
    readonly send: (input: AgentSendInput) => Effect.Effect<
      {
        threadId: ThreadId;
        runId: import("@t3tools/contracts").RunId;
        delivery: Threads.ThreadManagementSendResult["delivery"];
      },
      AgentError
    >;
    readonly trigger: (
      task: ScheduledTask,
      fireKey: string,
      prompt: string,
    ) => Effect.Effect<boolean, AgentError>;
    /** Also called on startup; terminal runs with undelivered postbacks survive restarts. */
    readonly reconcile: () => Effect.Effect<void, AgentError>;
  }
>()("t3/agents/AgentService") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const store = yield* Store.AgentStore;
  const launch = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* Threads.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const events = yield* EventSink.EventSinkV2;
  const scheduler = yield* Scheduler.Scheduler;
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.sliding<void>(1);
  const changed = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  const list = () => store.list().pipe(Effect.map((agents) => ({ agents })));
  const workspace = (agent: Agent) =>
    projections.getThread(agent.conversationThreadId).pipe(Effect.map((t) => t.projectId));
  // This is a passive assistant message: no message.dispatch and no provider effect.
  // A stable command receipt makes replay after a crash exactly-once in the conversation.
  const post = (agent: Agent, run: AgentWorkRun) =>
    Effect.gen(function* () {
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
  const reconcile = () =>
    Effect.gen(function* () {
      const runs = yield* store.runs();
      for (const record of runs) {
        yield* Effect.gen(function* () {
          const agent = yield* store.get(record.agentId);
          if (record.status === "completed" || record.status === "failed") {
            yield* post(agent, record);
            return;
          }
          const projection = yield* projections
            .getThreadRecords(record.workThreadId, ["runs", "messages"])
            .pipe(
              Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
            );
          if (projection === null) {
            if (
              DateTime.toEpochMillis(yield* DateTime.now) - Date.parse(record.createdAt) >
              300000
            ) {
              const next = yield* store.outcome(agent.id, false);
              yield* store.finishRun(
                record.id,
                "failed",
                ["This job was interrupted before it could start.", next.pauseReason]
                  .filter(Boolean)
                  .join("\n\n"),
              );
            }
            return;
          }
          const run = projection.runs.at(-1);
          if (
            run === undefined &&
            DateTime.toEpochMillis(yield* DateTime.now) - Date.parse(record.createdAt) > 300000
          ) {
            const next = yield* store.outcome(agent.id, false);
            yield* store.finishRun(
              record.id,
              "failed",
              ["This job was interrupted before its first turn started.", next.pauseReason]
                .filter(Boolean)
                .join("\n\n"),
            );
            return;
          }
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
          const succeeded = run.status === "completed";
          const response = projection.messages
            .filter((m) => m.role === "assistant" && m.runId === run.id)
            .map((m) => m.text)
            .join("\n")
            .trim();
          const updated = yield* sql.withTransaction(
            Effect.gen(function* () {
              const next = yield* store.outcome(agent.id, succeeded);
              const summary = [
                response.slice(0, 1200) ||
                  (succeeded
                    ? "Work finished."
                    : "This run failed. Open the work details to inspect it."),
                next.pauseReason,
              ]
                .filter(Boolean)
                .join("\n\n");
              yield* store.finishRun(record.id, succeeded ? "completed" : "failed", summary);
              return {
                ...record,
                status: succeeded ? ("completed" as const) : ("failed" as const),
                summary,
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
    subscribe: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(list()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(list)),
          );
        }),
      ),
    upsert: (input) =>
      Effect.gen(function* () {
        const at = DateTime.formatIso(yield* DateTime.now);
        const existing = input.id === undefined ? null : yield* store.get(input.id);
        const id = existing?.id ?? AgentId.make(`agent:${yield* crypto.randomUUIDv4()}`);
        const conversationThreadId =
          existing?.conversationThreadId ?? ThreadId.make(`agent-conversation:${id}`);
        if (existing === null) {
          if (input.projectId === null)
            return yield* new AgentError({ message: "Choose a project to create an agent." });
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
        const agent = yield* store.save({
          ...input,
          id,
          conversationThreadId,
          createdAt: existing?.createdAt ?? at,
          updatedAt: at,
          consecutiveFailures: existing?.consecutiveFailures ?? 0,
          backoffUntil: existing?.backoffUntil ?? null,
          pauseReason: existing?.pauseReason ?? null,
        });
        if (existing !== null) {
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
        yield* changed;
        return { agent };
      }).pipe(Effect.mapError(failure)),
    delete: (id) =>
      Effect.gen(function* () {
        const agent = (yield* store.list()).find((candidate) => candidate.id === id);
        if (agent === undefined) return { deleted: false };
        // Disable before stopping work so a due trigger cannot launch while deletion waits.
        yield* store.save({ ...agent, enabled: false });
        const runs = yield* store.runs(id);
        const threadIds = [
          agent.conversationThreadId,
          ...runs
            .filter((run) => run.status === "starting" || run.status === "running")
            .map((run) => run.workThreadId),
        ];
        for (const threadId of threadIds) {
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
      }).pipe(Effect.mapError(failure)),
    send: (input) =>
      Effect.gen(function* () {
        const agent = yield* store.get(input.id);
        const result = yield* threads.sendToThread({
          projectId: yield* workspace(agent),
          commandId: input.commandId,
          messageId: input.messageId,
          threadId: agent.conversationThreadId,
          text: input.text,
          attachments: [],
          modelSelection: agent.modelSelection,
          mode: input.mode ?? "auto",
          createdBy: "user",
          creationSource: "web",
        });
        return {
          threadId: agent.conversationThreadId,
          runId: result.run.id,
          delivery: result.delivery,
        };
      }).pipe(Effect.mapError(failure)),
    trigger: (task, fireKey, prompt) =>
      Effect.gen(function* () {
        if (task.agentId == null) return false;
        const agent = yield* store.get(task.agentId);
        const id = `agent-work:${fireKey}`;
        const workThreadId = ThreadId.make(id);
        const accepted = yield* sql.withTransaction(
          Effect.gen(function* () {
            if (!(yield* store.reserve(agent.id))) return false;
            yield* store.createRun({
              id,
              agentId: agent.id,
              triggerId: task.id,
              workThreadId,
              status: "starting",
              createdAt: DateTime.formatIso(yield* DateTime.now),
              completedAt: null,
              summary: null,
              posted: false,
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
            commandId: CommandId.make(id),
            threadId: workThreadId,
            projectId: agent.projectId ?? task.projectId,
            title: `${agent.name}: ${task.title}`,
            modelSelection: agent.modelSelection,
            runtimeMode: agent.runtimeMode,
            interactionMode: task.interactionMode,
            workspaceStrategy: task.workspaceStrategy,
            createdBy: "agent",
            creationSource: "server",
            initialMessage: {
              messageId: MessageId.make(id),
              scheduledTaskId: task.id,
              text: `Background job for ${agent.name}. Finish with a short owner-facing result, question, or approval request. Details stay in this work thread.\n\nConversation summary:\n${carry.summary}\nRecent conversation:\n${carry.recent}\n\nTrigger:\n${prompt}`,
              attachments: [],
            },
          }),
        );
        if (result._tag === "Success") yield* store.markRunning(id);
        if (result._tag === "Failure") {
          const next = yield* store.outcome(agent.id, false);
          yield* store.finishRun(
            id,
            "failed",
            ["I could not start this job. Open its work details to inspect it.", next.pauseReason]
              .filter(Boolean)
              .join("\n\n"),
          );
        }
        yield* changed;
        return true;
      }).pipe(Effect.mapError(failure)),
    reconcile,
  });
});
export const layer = Layer.effect(AgentService, make);
