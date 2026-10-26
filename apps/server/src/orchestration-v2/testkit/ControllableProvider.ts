import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
} from "@cogenly/contracts";
import * as ProviderAdapter from "@cogenly/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Registry from "../ProviderAdapterRegistry.ts";

type EventQueue = Queue.Queue<
  ProviderAdapter.ProviderAdapterV2Event,
  ProviderAdapter.ProviderAdapterV2Error
>;

/**
 * External provider stand-in; orchestration, persistence and effects remain
 * real. Pass more than one instance id to model separate accounts of one
 * driver, each with its own session and native threads.
 */
export const makeControllableProvider = (
  capabilities: OrchestrationV2ProviderCapabilities,
  instanceIds: ReadonlyArray<string> = ["codex"],
  turnIdPrefix = "turn",
) => {
  const driver = ProviderDriverKind.make("codex");
  const defaultInstanceId = ProviderInstanceId.make(instanceIds[0]!);
  const turns: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
  const steers: ProviderAdapter.ProviderAdapterV2SteerInput[] = [];
  // The latest session's queue, for events not tied to a turn input.
  let queue: EventQueue;
  const queues = new Map<ProviderInstanceId, EventQueue>();
  const threadQueues = new Map<string, EventQueue>();
  const sessionQueues: Array<EventQueue> = [];
  let ordinal = 0;
  const publish = (event: ProviderAdapter.ProviderAdapterV2Event) => Queue.offer(queue, event);
  const publishFor = (
    input: ProviderAdapter.ProviderAdapterV2TurnInput,
    event: ProviderAdapter.ProviderAdapterV2Event,
  ) =>
    Queue.offer(
      threadQueues.get(`${input.providerThread.providerInstanceId}:${input.threadId}`) ??
        queues.get(input.providerThread.providerInstanceId) ??
        queue,
      event,
    );
  const begin = (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
    Effect.gen(function* () {
      turns.push(input);
      const id = ProviderTurnId.make(`${turnIdPrefix}:${++ordinal}`);
      yield* publishFor(input, {
        type: "provider_turn.updated",
        driver,
        threadId: input.threadId,
        providerTurn: {
          id,
          providerThreadId: input.providerThread.id,
          nodeId: input.rootNodeId,
          runAttemptId: input.attemptId,
          nativeTurnRef: null,
          ordinal,
          status: "running",
          startedAt: yield* DateTime.now,
          completedAt: null,
        },
      });
      return id;
    });
  const finish = (
    input: ProviderAdapter.ProviderAdapterV2TurnInput,
    id: ProviderTurnId,
    failure: OrchestrationV2ProviderFailure | null = null,
  ) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      yield* publishFor(input, {
        type: "provider_turn.updated",
        driver,
        threadId: input.threadId,
        providerTurn: {
          id,
          providerThreadId: input.providerThread.id,
          nodeId: input.rootNodeId,
          runAttemptId: input.attemptId,
          nativeTurnRef: null,
          ordinal,
          status: failure === null ? "completed" : "failed",
          startedAt: now,
          completedAt: now,
        },
      });
      return yield* publishFor(input, {
        type: "turn.terminal",
        driver,
        providerThreadId: input.providerThread.id,
        providerTurnId: id,
        runOrdinal: input.runOrdinal,
        threadDisposition: "reusable",
        ...(failure === null
          ? { status: "completed", failure: null }
          : {
              status: "failed",
              failure,
              failureItemOrdinal: ordinal * 100 + 1,
            }),
      });
    });
  let start: ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"] = (input) =>
    begin(input).pipe(Effect.asVoid);
  let compact: NonNullable<ProviderAdapter.ProviderAdapterV2SessionRuntime["compactThread"]> = () =>
    Effect.die("Unexpected compaction");
  const resumes: Array<ProviderThreadId> = [];
  let resume: ProviderAdapter.ProviderAdapterV2SessionRuntime["resumeThread"] = ({
    providerThread,
  }) => Effect.succeed(providerThread);
  const registry = Layer.mock(Registry.ProviderAdapterRegistryV2)({
    list: () => Effect.succeed(instanceIds.map((id) => ProviderInstanceId.make(id))),
    // Separate accounts never share native threads.
    getMetadata: (instanceId) =>
      Effect.succeed({
        driver,
        continuationKey: instanceId === defaultInstanceId ? "codex" : instanceId,
        enabled: true,
        capabilities,
      }),
    get: (instanceId) =>
      Effect.succeed(
        ProviderAdapter.ProviderAdapterV2.of({
          instanceId,
          driver,
          getCapabilities: () => Effect.succeed(capabilities),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: (request) =>
            Effect.gen(function* () {
              queue = yield* Queue.unbounded<
                ProviderAdapter.ProviderAdapterV2Event,
                ProviderAdapter.ProviderAdapterV2Error
              >();
              const sessionQueue = queue;
              queues.set(instanceId, queue);
              sessionQueues.push(queue);
              const threadKey = (threadId: string) =>
                instanceId === defaultInstanceId ? threadId : `${instanceId}:${threadId}`;
              const now = yield* DateTime.now;
              return {
                instanceId,
                driver,
                providerSessionId: request.providerSessionId,
                providerSession: {
                  id: request.providerSessionId,
                  providerInstanceId: instanceId,
                  driver,
                  status: "ready",
                  cwd: request.runtimePolicy.cwd ?? process.cwd(),
                  model: request.modelSelection.model,
                  capabilities,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                },
                events: Stream.fromQueue(queue),
                ensureThread: (input) =>
                  Effect.sync(() => {
                    threadQueues.set(`${instanceId}:${input.threadId}`, sessionQueue);
                    return {
                      id:
                        input.existingProviderThread?.id ??
                        ProviderThreadId.make(`provider-thread:${threadKey(input.threadId)}`),
                      driver,
                      providerInstanceId: instanceId,
                      providerSessionId: request.providerSessionId,
                      appThreadId: input.threadId,
                      ownerNodeId: null,
                      nativeThreadRef: {
                        driver,
                        nativeId: `native:${threadKey(input.threadId)}`,
                        strength: "strong",
                      },
                      nativeConversationHeadRef: null,
                      status: "idle",
                      firstRunOrdinal: null,
                      lastRunOrdinal: null,
                      handoffIds: [],
                      forkedFrom: null,
                      createdAt: now,
                      updatedAt: now,
                    };
                  }),
                resumeThread: (input) =>
                  Effect.suspend(() => {
                    if (input.providerThread.appThreadId !== null) {
                      threadQueues.set(
                        `${instanceId}:${input.providerThread.appThreadId}`,
                        sessionQueue,
                      );
                    }
                    resumes.push(input.providerThread.id);
                    return resume(input);
                  }),
                startTurn: (input) => start(input),
                compactThread: (input) => compact(input),
                steerTurn: (input) =>
                  Effect.sync(() => {
                    steers.push(input);
                  }),
                interruptTurn: () => Effect.void,
                respondToRuntimeRequest: () => Effect.void,
                readThreadSnapshot: () => Effect.die("Unexpected snapshot"),
                rollbackThread: () => Effect.die("Unexpected rollback"),
                forkThread: () => Effect.die("Unexpected fork"),
              } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
            }),
        }),
      ),
  });
  return {
    registry,
    turns,
    steers,
    resumes,
    begin,
    finish,
    publish,
    publishFor,
    /** Publishes on the nth session opened, such as a parent's after its child opened one. */
    publishOn: (session: number, event: ProviderAdapter.ProviderAdapterV2Event) =>
      Queue.offer(sessionQueues[session]!, event),
    failEvents: (error: ProviderAdapter.ProviderAdapterV2Error) => Queue.fail(queue, error),
    setStart: (value: typeof start) => {
      start = value;
    },
    setCompact: (value: typeof compact) => {
      compact = value;
    },
    setResume: (value: typeof resume) => {
      resume = value;
    },
  };
};
