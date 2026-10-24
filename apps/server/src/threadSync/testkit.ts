import {
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  ThreadId,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as Machines from "../machines/Machines.ts";
import { startMachine } from "../machines/testkit.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RemoteThreadCommands from "../orchestration-v2/RemoteThreadCommands.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ThreadReplication from "./ThreadReplication.ts";
import * as ThreadRouting from "./ThreadRouting.ts";
import * as ThreadSync from "./ThreadSync.ts";
import * as ThreadTransfer from "./ThreadTransfer.ts";

/**
 * A paired-machine server with thread replication and routing over a real
 * peer link. Passes are explicit (no change stream, no scheduler), and the
 * orchestrator is replaced by `dispatch`, which turns a command into events.
 */
export const startThreadMachine = Effect.fn("startThreadMachine")(function* (
  name: string,
  role: "computer" | "cloud-server",
  dispatch: (
    command: OrchestrationV2ServerCommand,
  ) => ReadonlyArray<OrchestrationV2DomainEvent> = () => [],
) {
  const machine = yield* startMachine(name, role);
  const stores = yield* machine.run(
    Layer.build(
      Layer.mergeAll(
        EventSink.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(EventStore.layer, Projections.layer, EffectOutbox.layer),
          ),
        ),
        RemoteThreadCommands.layer,
      ),
    ),
  );
  const inStores = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    machine.run(Effect.provideContext(effect, stores as never));
  const sink = yield* inStores(EventSink.EventSinkV2);
  const replicationContext = yield* inStores(Layer.build(ThreadReplication.layer));
  const replication = yield* ThreadReplication.ThreadReplication.pipe(
    Effect.provideContext(replicationContext),
  );
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    dispatch: (command) =>
      sink.write({ commandId: command.commandId, events: dispatch(command) }).pipe(
        Effect.map((storedEvents) => ({
          sequence: storedEvents.at(-1)?.sequence ?? 0,
          storedEvents,
        })),
        Effect.orDie,
      ),
  });
  const context = yield* inStores(
    Layer.build(
      ThreadTransfer.layer.pipe(
        Layer.provideMerge(ThreadRouting.layer),
        Layer.provideMerge(ThreadSync.layer),
        Layer.provideMerge(
          Layer.succeed(ThreadReplication.ThreadReplication, {
            ...replication,
            changes: Stream.never,
          }),
        ),
        Layer.provide(ProjectStore.layer),
        Layer.provide(
          Layer.succeed(Machines.Machines, { ...machine.machines, subscribe: Stream.never }),
        ),
        Layer.provide(Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void })),
        Layer.provide(threads),
      ),
    ),
  );
  const sync = yield* ThreadSync.ThreadSync.pipe(Effect.provideContext(context));
  const routing = yield* ThreadRouting.ThreadRouting.pipe(Effect.provideContext(context));
  const transfer = yield* ThreadTransfer.ThreadTransfer.pipe(Effect.provideContext(context));
  const remoteCommands = yield* inStores(RemoteThreadCommands.RemoteThreadCommands);
  const projections = yield* inStores(Projections.ProjectionStoreV2);
  const sql = yield* machine.run(SqlClient.SqlClient);
  return {
    ...machine,
    replication,
    sync,
    routing,
    transfer,
    remoteCommands,
    sink,
    projections,
    sql,
  };
});

export const threadId = ThreadId.make("thread:on-laptop");

export const threadCreated = (
  id: string,
  at: DateTime.Utc,
  title = "On the laptop",
): OrchestrationV2DomainEvent => ({
  id: EventId.make(id),
  type: "thread.created",
  threadId,
  occurredAt: at,
  payload: { ...idleThreadProjection(liveThreadShell(threadId)).thread, title },
});

export const userMessage = (
  id: string,
  at: DateTime.Utc,
  text: string,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(id),
  type: "message.updated",
  threadId,
  occurredAt: at,
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: MessageId.make(`message:${id}`),
    threadId,
    runId: null,
    nodeId: null,
    role: "user",
    text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  },
});
