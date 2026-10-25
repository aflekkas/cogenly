import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VisualStateError,
  VISUAL_STATE_MAX_BYTES,
  type OrchestrationV2Command,
} from "@cogenly/contracts";
import { formatVisualSubmitMessage } from "@cogenly/shared/htmlRender";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderAdapter from "@cogenly/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { layerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ProviderDriverKind } from "@cogenly/contracts";
import * as Events from "../orchestration-v2/EventStore.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as VisualState from "./VisualState.ts";

const threadId = ThreadId.make("thread:visual-state");
const renderId = "thread:visual-state-html-1";
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

const create = (id: ThreadId): Extract<OrchestrationV2Command, { type: "thread.create" }> => ({
  type: "thread.create",
  commandId: CommandId.make(`create:${id}`),
  threadId: id,
  projectId: ProjectId.make("project:visual"),
  title: "Visual",
  modelSelection: selection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdBy: "user",
  creationSource: "web",
});

const database = Sqlite.layerMemory;
const layerRegistry = Layer.mock(Registry.ProviderAdapterRegistryV2)({
  list: () => Effect.succeed([selection.instanceId]),
  getMetadata: () =>
    Effect.succeed({
      driver: ProviderDriverKind.make("codex"),
      continuationKey: "codex",
      enabled: true,
      capabilities: CodexProviderCapabilitiesV2,
    }),
  // No provider CLI is spawned by these integration tests.
  get: (instanceId) =>
    Effect.succeed(
      ProviderAdapter.ProviderAdapterV2.of({
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.die("No selection transition in this test"),
        openSession: (request) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: ProviderDriverKind.make("codex"),
              providerSessionId: request.providerSessionId,
              cause: "Provider unavailable in test",
            }),
          ),
      }),
    ),
});
const runtime = Layer.mergeAll(
  database,
  layerWithRegistry({ name: "visual-state" }, layerRegistry, {
    databaseLayer: database,
    runEffectWorker: false,
  }),
  Events.layer.pipe(Layer.provide(database)),
  Receipts.layer.pipe(Layer.provide(database)),
);

const makeHarness = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = Layer.mock(Threads.ThreadManagementService)({
    dispatch: (command) => orchestrator.dispatch(command),
    getThreadRecords: (id, fields, filter) => orchestrator.getThreadRecords(id, fields, filter),
  });
  const visual = VisualState.layer.pipe(Layer.provide(Layer.mergeAll(threads, NodeServices.layer)));
  return { orchestrator, visual };
});
const harness = makeHarness;

const withService = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const h = yield* harness;
    return yield* effect.pipe(Effect.provide(h.visual));
  });

const isVisualStateError = Schema.is(VisualStateError);

it.effect("round-trips visual state through events into the thread projection", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.orchestrator.dispatch(create(threadId));
    yield* withService(
      Effect.gen(function* () {
        const service = yield* VisualState.VisualStateService;
        expect(yield* service.get({ threadId, renderId })).toBeNull();
        const first = yield* service.set({
          threadId,
          renderId,
          title: "Quiz",
          state: { answers: [1] },
          expectedVersion: 0,
        });
        expect(first.version).toBe(1);
        expect(first.title).toBe("Quiz");
        const second = yield* service.set({
          threadId,
          renderId,
          state: { answers: [1, 2] },
          expectedVersion: 1,
        });
        expect(second.version).toBe(2);
        // The first write wins the title; later sets keep it unless replaced.
        expect(second.title).toBe("Quiz");
        const projection = yield* h.orchestrator.getThreadProjection(threadId);
        expect(projection.visualStates).toHaveLength(1);
        expect(projection.visualStates[0]).toMatchObject({
          threadId,
          renderId,
          version: 2,
          locked: false,
          submittedAt: null,
          state: { answers: [1, 2] },
        });
        // The document survives a reload: it lives in sqlite, not memory.
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_visual_states
          WHERE thread_id = ${threadId} AND render_id = ${renderId}
        `;
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({ version: 2, locked: false });
        // And the event log carries the transition for every subscriber.
        const stored = yield* h.orchestrator
          .streamStoredEventsFrom({ threadId, eventType: "visual-state.updated" })
          .pipe(Stream.take(2), Stream.runCollect);
        expect(
          stored.map((storedEvent) =>
            storedEvent.event.type === "visual-state.updated"
              ? storedEvent.event.payload.version
              : -1,
          ),
        ).toEqual([1, 2]);
      }),
    );
  }).pipe(Effect.provide(runtime)),
);

it.effect("rejects a stale write with the winning version", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const id = ThreadId.make("thread:visual-state-conflict");
    yield* h.orchestrator.dispatch(create(id));
    yield* withService(
      Effect.gen(function* () {
        const service = yield* VisualState.VisualStateService;
        yield* service.set({ threadId: id, renderId, state: { n: 1 }, expectedVersion: 0 });
        const failure = yield* service
          .set({ threadId: id, renderId, state: { n: 2 }, expectedVersion: 0 })
          .pipe(Effect.flip);
        expect(isVisualStateError(failure)).toBe(true);
        expect(failure).toMatchObject({
          operation: "set",
          reason: "version_conflict",
          expectedVersion: 0,
          actualVersion: 1,
        });
        // The losing write changed nothing.
        expect(yield* service.get({ threadId: id, renderId })).toMatchObject({ version: 1 });
      }),
    );
  }).pipe(Effect.provide(runtime)),
);

it.effect("rejects documents larger than the cap", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const id = ThreadId.make("thread:visual-state-too-large");
    yield* h.orchestrator.dispatch(create(id));
    yield* withService(
      Effect.gen(function* () {
        const service = yield* VisualState.VisualStateService;
        const big = "x".repeat(VISUAL_STATE_MAX_BYTES);
        const setFailure = yield* service
          .set({ threadId: id, renderId, state: { big }, expectedVersion: 0 })
          .pipe(Effect.flip);
        expect(setFailure).toMatchObject({ operation: "set", reason: "too_large" });
        const submitFailure = yield* service
          .submit({ threadId: id, renderId, payload: { big } })
          .pipe(Effect.flip);
        expect(submitFailure).toMatchObject({ operation: "submit", reason: "too_large" });
        expect(yield* service.get({ threadId: id, renderId })).toBeNull();
      }),
    );
  }).pipe(Effect.provide(runtime)),
);

it.effect("delivers a submit as a queued user turn and locks on request", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const id = ThreadId.make("thread:visual-state-submit");
    yield* h.orchestrator.dispatch(create(id));
    yield* withService(
      Effect.gen(function* () {
        const service = yield* VisualState.VisualStateService;
        const payload = { kind: "quiz-result", score: 7, answers: [true, false] };
        const first = yield* service.submit({ threadId: id, renderId, title: "Quiz", payload });
        const expectedFirst = formatVisualSubmitMessage("Quiz", JSON.stringify(payload, null, 2));
        expect(first.state).toMatchObject({ version: 1, locked: false });

        // The first submit starts the thread's turn; the second queues behind it.
        const secondPayload = { decisions: [] };
        const locked = yield* service.submit({
          threadId: id,
          renderId,
          payload: secondPayload,
          lock: true,
        });
        expect(locked.state).toMatchObject({ version: 2, locked: true });
        const expectedSecond = formatVisualSubmitMessage(
          "Quiz",
          JSON.stringify(secondPayload, null, 2),
        );

        const projection = yield* h.orchestrator.getThreadProjection(id);
        const texts = projection.messages.map((message) => message.text);
        expect(texts).toContain(expectedFirst);
        expect(texts).toContain(expectedSecond);
        const queued = projection.runs.filter((run) => run.status === "queued");
        expect(queued).toHaveLength(1);
        const queuedMessage = projection.messages.find(
          (message) => message.id === queued[0]!.userMessageId,
        );
        expect(queuedMessage?.text).toBe(expectedSecond);

        // A locked visual rejects further writes and submits.
        const setFailure = yield* service
          .set({ threadId: id, renderId, state: {}, expectedVersion: 2 })
          .pipe(Effect.flip);
        expect(setFailure).toMatchObject({ reason: "locked" });
        const submitFailure = yield* service
          .submit({ threadId: id, renderId, payload: {} })
          .pipe(Effect.flip);
        expect(submitFailure).toMatchObject({ reason: "locked" });
      }),
    );
  }).pipe(Effect.provide(runtime)),
);
