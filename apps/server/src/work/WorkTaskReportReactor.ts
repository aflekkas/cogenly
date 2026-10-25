import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type ThreadId,
  type WorkTask,
  type WorkTaskOutcome,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

/** Run states that end a task's Work for its report. A stop (interrupted) is the user's own act. */
const REPORTED_STATUSES = ["completed", "failed", "cancelled"] as const;
type ReportedStatus = (typeof REPORTED_STATUSES)[number];
const isReportedStatus = (status: OrchestrationV2Run["status"]): status is ReportedStatus =>
  (REPORTED_STATUSES as ReadonlyArray<string>).includes(status);

const LIVE_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/** How much of the task agent's final reply the chat agent reads. */
const REPORT_TEXT_CHARS = 6000;
/** How much of it the card shows. */
const CARD_SUMMARY_CHARS = 280;

const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();

const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;

const VERB: Record<ReportedStatus, string> = {
  completed: "finished",
  failed: "failed",
  cancelled: "was cancelled",
};

/**
 * The `work.task.report` a task's settled Work sends its chat: the card's
 * outcome and the turn that tells the chat's agent, built from the Work's
 * final reply. Keyed by the task, so it is sent once however often it is tried.
 */
export function workTaskReportFor(input: {
  readonly chatThreadId: ThreadId;
  readonly task: WorkTask;
  readonly workThreadId: ThreadId;
  readonly run: Pick<OrchestrationV2Run, "id" | "status">;
  readonly finalReply: string | null;
  readonly reportedAt: string;
  /** The Work thread settled because the task asked to, from `workTaskSettleFor`. */
  readonly settled?: boolean;
}): Extract<OrchestrationV2InternalCommand, { readonly type: "work.task.report" }> | null {
  const status = input.run.status;
  if (!isReportedStatus(status)) return null;
  const reply = input.finalReply?.trim() ?? "";
  const outcome: WorkTaskOutcome = {
    status,
    summary: clip(oneLine(reply), CARD_SUMMARY_CHARS),
    runId: input.run.id,
    reportedAt: input.reportedAt,
  };
  const link = `[${input.task.title}](cogenly-thread://v1/${input.workThreadId})`;
  const text = [
    `The task "${input.task.title}" that you handed off ${VERB[status]}. Its Work thread: ${link}.`,
    reply.length === 0
      ? "It ended without a final reply."
      : `Its final reply:\n\n${clip(reply, REPORT_TEXT_CHARS)}`,
    ...(input.settled === true
      ? ["Its Work thread was settled, as you asked; the user can un-settle it to continue there."]
      : []),
    status === "completed"
      ? "Tell the user the outcome in a sentence or two. Do not start another task for this unless they ask."
      : "Tell the user briefly what went wrong and offer a next step, such as retrying the task or opening its Work thread. Do not retry on your own.",
  ].join("\n\n");
  const key = `${input.chatThreadId}:${input.task.id}`;
  return {
    type: "work.task.report",
    commandId: CommandId.make(`server:work-task-report:${key}`),
    threadId: input.chatThreadId,
    taskId: input.task.id,
    outcome,
    wake: {
      messageId: MessageId.make(`message:work-task-report:${key}`),
      text,
      notification: {
        source: { kind: "work_task", taskId: input.task.id, childThreadId: input.workThreadId },
        outcome: status,
        summary: `Task "${clip(input.task.title, 80)}" ${VERB[status]}`,
      },
    },
  };
}

/**
 * The `thread.settle` for a task that asked to settle when done. Only a
 * completed task settles: a failed or cancelled one stays for the user to see.
 */
export function workTaskSettleFor(input: {
  readonly chatThreadId: ThreadId;
  readonly task: WorkTask;
  readonly workThreadId: ThreadId;
  readonly run: Pick<OrchestrationV2Run, "status">;
}): Extract<OrchestrationV2ServerCommand, { readonly type: "thread.settle" }> | null {
  if (input.task.settleWhenDone !== true || input.run.status !== "completed") return null;
  return {
    type: "thread.settle",
    commandId: CommandId.make(`server:work-task-settle:${input.chatThreadId}:${input.task.id}`),
    threadId: input.workThreadId,
  };
}

/**
 * Reports a chat's started task back once its Work thread settles: no run is
 * live and the latest one ended. The card records the outcome and the chat's
 * agent gets a notification turn, queued behind any turn it is running, so a
 * chat never polls its tasks. Events missed while the server was down are not
 * replayed; the card still shows the Work's live state.
 */
export class WorkTaskReportReactor extends Context.Service<
  WorkTaskReportReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("cogenly-server/work/WorkTaskReportReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const handle: WorkTaskReportReactor["Service"]["handle"] = (event) =>
    Effect.gen(function* () {
      if (event.type !== "run.updated" || !isReportedStatus(event.payload.status)) return;
      const work = yield* projections.getThreadShell(event.threadId);
      const chatThreadId = work?.sourceThreadId;
      if (work === null || work.surface !== "work" || chatThreadId === undefined) return;
      const chat = yield* projections.getThread(chatThreadId);
      const task = (chat.workTasks ?? []).find(
        (candidate) =>
          candidate.threadId === event.threadId &&
          candidate.status === "started" &&
          candidate.outcome === undefined,
      );
      if (task === undefined || chat.deletedAt !== null) return;
      const { runs } = yield* projections.getThreadRecords(event.threadId, ["runs"]);
      const latest = runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
      // Settled: the run that ended is the latest, and nothing else is live or queued.
      if (
        latest?.id !== event.payload.id ||
        latest.startedAt === null ||
        runs.some((run) => LIVE_STATUSES.has(run.status))
      ) {
        return;
      }
      const { messages } = yield* projections.getThreadRecords(event.threadId, ["messages"], {
        messageRoles: ["assistant"],
      });
      const finalReply =
        messages.findLast(
          (message) => message.runId === latest.id && !message.streaming && message.text.trim(),
        )?.text ?? null;
      // Settle before reporting, so the chat hears whether it happened. A
      // refusal, such as a message queued on the Work, leaves it active.
      const settle = workTaskSettleFor({
        chatThreadId,
        task,
        workThreadId: event.threadId,
        run: latest,
      });
      const settled =
        settle !== null &&
        (yield* engine.dispatch(settle).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("settling a finished chat task failed", {
              threadId: event.threadId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        ));
      const command = workTaskReportFor({
        chatThreadId,
        task,
        workThreadId: event.threadId,
        run: latest,
        finalReply,
        reportedAt: DateTime.formatIso(yield* DateTime.now),
        settled,
      });
      if (command !== null) yield* engine.dispatch(command);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("reporting a chat task's result failed", {
          threadId: event.threadId,
          cause,
        }),
      ),
    );

  const start: WorkTaskReportReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("chat task report event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies WorkTaskReportReactor["Service"];
});

export const layer = Layer.effect(WorkTaskReportReactor, make);
