import { expect, it } from "@effect/vitest";
import {
  MessageId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  OrchestrationV2ThreadStreamItem,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { boundedSnapshotProjection } from "@cogenly/shared/orchestrationV2BoundedSnapshot";
import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Management from "./ThreadManagementService.ts";
import { subscribeOrchestrationV2Thread } from "../ws.ts";

const streamCodec = Schema.toCodecJson(Schema.Array(OrchestrationV2ThreadStreamItem));
const encodeStream = Schema.encodeSync(streamCodec);
const decodeStream = Schema.decodeUnknownSync(streamCodec);

const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const threadId = ThreadId.make("thread-reducer");
const runId = RunId.make("run-reducer");
const run = {
  id: runId,
  threadId,
  ordinal: 1,
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  providerThreadId: null,
  userMessageId: MessageId.make("message-reducer"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
} satisfies OrchestrationV2Run;

const emptyProjection = {
  thread: {
    id: threadId,
    projectId: ProjectId.make("project-reducer"),
    title: "Reducer",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visualStates: [],
  visibleTurnItems: [],
  updatedAt: now,
} as OrchestrationV2ThreadProjection;

const text = "A long response ".repeat(2_000);
const messageId = MessageId.make("message-body");
const message = {
  id: messageId,
  threadId,
  runId,
  nodeId: null,
  role: "assistant" as const,
  text,
  attachments: [],
  streaming: false,
  createdBy: "agent" as const,
  creationSource: "provider" as const,
  createdAt: now,
  updatedAt: now,
};
const reply = {
  id: TurnItemId.make("item-body"),
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
  type: "assistant_message",
  messageId,
  text,
  streaming: false,
} satisfies OrchestrationV2TurnItem;
const projection: OrchestrationV2ThreadProjection = {
  ...emptyProjection,
  runs: [run],
  messages: [message],
  turnItems: [reply],
  visibleTurnItems: [
    {
      position: 0,
      visibility: "local",
      sourceThreadId: threadId,
      sourceItemId: reply.id,
      item: reply,
    },
  ],
};
const update = (id: string, payload: OrchestrationV2TurnItem): OrchestrationV2DomainEvent => ({
  id: EventId.make(id),
  threadId,
  occurredAt: now,
  type: "turn-item.updated",
  payload,
});
const layer = Layer.mergeAll(
  Layer.mock(Management.ThreadManagementService)({
    ensureLegacyTranscript: () => Effect.void,
    getThreadSnapshot: () => Effect.succeed({ schemaVersion: 1, snapshotSequence: 10, projection }),
    getThreadSnapshotWindow: () =>
      Effect.succeed({ schemaVersion: 1, snapshotSequence: 10, projection }),
    streamStoredEventsFrom: () =>
      Stream.make({ sequence: 11, commandId: null, event: update("live", reply) }),
  }),
  Layer.mock(EventStore.OrchestrationEventStore)({
    latestAgentSequence: () => Effect.succeed(10),
    getAgentReplayStats: () =>
      Effect.succeed({ eventCount: 1, rawPayloadBytes: 100, hasCreateEvent: false }),
    readAgentEvents: (input) =>
      input?.afterSequence === 10
        ? Stream.empty
        : Stream.make({
            sequence: 10,
            commandId: null,
            event: {
              id: EventId.make("record"),
              threadId,
              occurredAt: now,
              type: "message.updated" as const,
              payload: message,
            },
          }),
  }),
);

it.effect(
  "negotiates full and bounded snapshots and seeds their live deduper after compaction",
  () =>
    Effect.gen(function* () {
      for (const bounded of [false, true]) {
        const load = (dedupe: boolean) =>
          subscribeOrchestrationV2Thread({
            threadId,
            acceptBoundedSnapshot: bounded,
            acceptCompactTurnItems: bounded,
            acceptDedupedBodies: dedupe,
            requestCompletionMarker: true,
          }).pipe(Effect.flatMap(Stream.runCollect));
        const plain = Array.from(yield* load(false));
        const compact = decodeStream(
          JSON.parse(JSON.stringify(encodeStream(Array.from(yield* load(true))))),
        );
        expect(compact.map((item) => item.kind)).toEqual(["snapshot", "synchronized", "event"]);
        const snapshot = compact[0]!;
        const legacySnapshot = plain[0]!;
        if (snapshot.kind !== "snapshot" || legacySnapshot.kind !== "snapshot")
          throw new Error("snapshot fixture");
        expect(boundedSnapshotProjection(snapshot)).toEqual(
          boundedSnapshotProjection(legacySnapshot),
        );
        expect(JSON.stringify(compact).length).toBeLessThan(
          JSON.stringify(plain).length - text.length,
        );
        const event = compact[2]!;
        expect(event.kind === "event" && event.event.payload).toMatchObject({
          text: "",
          textOmitted: true,
        });
        expect(JSON.stringify(plain)).not.toContain("textOmitted");
      }
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "shares delivery memory between replay and live, while each subscription starts fresh",
  () =>
    Effect.gen(function* () {
      const replayed = Array.from(
        yield* subscribeOrchestrationV2Thread({
          threadId,
          afterSequence: 9,
          acceptDedupedBodies: true,
        }).pipe(Effect.flatMap(Stream.runCollect)),
      );
      expect(replayed.map((item) => item.kind)).toEqual(["event", "event"]);
      expect(replayed[1]?.kind === "event" && replayed[1].event.payload).toMatchObject({
        text: "",
        textOmitted: true,
      });
      const reconnect = Array.from(
        yield* subscribeOrchestrationV2Thread({
          threadId,
          afterSequence: 10,
          acceptDedupedBodies: true,
        }).pipe(Effect.flatMap(Stream.runCollect)),
      );
      expect(reconnect).toHaveLength(1);
      const live = reconnect[0]!;
      expect(live.kind === "event" && live.event.payload).toMatchObject({ text });
      expect(JSON.stringify(reconnect)).not.toContain("textOmitted");
    }).pipe(Effect.provide(layer)),
);
