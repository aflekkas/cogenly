import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ContextHandoffId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@cogenly/contracts";
import * as ProviderAdapter from "@cogenly/provider-core/server/ProviderAdapter";
import {
  ContextHandoffBudgetError,
  makeProviderFailure,
} from "@cogenly/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Worker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { makeControllableProvider } from "./testkit/ControllableProvider.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

it.effect.each([
  "handoff",
  "handoff budget",
  "provider",
  "compaction fails",
  "compaction terminal fails",
  "compaction stream fails",
  "retry overflows",
  "retry start overflows",
] as const)("automatically compacts once: %s", (scenario) => {
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
  let starts = 0;
  let compactions = 0;
  provider.setStart((input) =>
    Effect.gen(function* () {
      starts++;
      if (
        (starts === 1 && scenario !== "provider" && scenario !== "handoff budget") ||
        scenario === "retry start overflows"
      )
        return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
          driver: providerDriver,
          threadId: input.threadId,
          runId: input.runId,
          providerThreadId: input.providerThread.id,
          cause: new ContextHandoffBudgetError(),
        });
      const turn = yield* provider.begin(input);
      yield* provider.finish(
        input,
        turn,
        (starts === 1 && scenario !== "handoff budget") || scenario === "retry overflows"
          ? makeProviderFailure({ code: "contextWindowExceeded", message: "Context is full" })
          : null,
      );
    }),
  );
  const providerDriver = ProviderDriverKind.make("codex");
  provider.setCompact((input) =>
    Effect.gen(function* () {
      compactions++;
      if (scenario === "compaction fails")
        return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
          driver: providerDriver,
          threadId: input.threadId,
          runId: input.runId,
          providerThreadId: input.providerThread.id,
          cause: "Compaction unavailable",
        });
      const turn = yield* provider.begin(input);
      if (scenario === "compaction stream fails") {
        return yield* provider.failEvents(
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver: providerDriver,
            providerSessionId: input.providerThread.providerSessionId!,
            cause: "Compaction process exited",
          }),
        );
      }
      const now = yield* DateTime.now;
      yield* provider.publish({
        type: "turn_item.updated",
        driver: providerDriver,
        turnItem: {
          id: TurnItemId.make("compaction"),
          type: "compaction",
          driver: providerDriver,
          threadId: input.threadId,
          runId: input.runId,
          nodeId: input.rootNodeId,
          providerThreadId: input.providerThread.id,
          providerTurnId: turn,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 101,
          status: "completed",
          title: "Context compacted",
          beforeTokenCount: 190000,
          afterTokenCount: 1000,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      });
      yield* provider.finish(
        input,
        turn,
        scenario === "compaction terminal fails"
          ? makeProviderFailure({ message: "Compaction failed", class: "provider_error" })
          : null,
      );
    }),
  );
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const threadId = ThreadId.make("thread:compaction");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make("project:test"),
      title: "Compaction",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("send"),
      threadId,
      messageId: MessageId.make("message:original"),
      text: "Keep this exact request",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    if (scenario === "handoff budget") {
      const sink = yield* EventSink.EventSinkV2;
      const initial = yield* orchestrator.getThreadProjection(threadId);
      const run = initial.runs[0]!;
      const thread = initial.providerThreads[0]!;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:full-context"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: {
              ...thread,
              nativeThreadRef: {
                driver: providerDriver,
                nativeId: `native:${threadId}`,
                strength: "strong",
              },
              contextUsage: { usedTokens: 195000, maxTokens: 200000 },
            },
          },
          {
            id: EventId.make("event:pending-handoff"),
            type: "context-handoff.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: ContextHandoffId.make("handoff:pending"),
              threadId,
              targetRunId: run.id,
              fromProviderThreadIds: [],
              toProviderThreadId: thread.id,
              coveredRunOrdinals: { from: 1, to: 1 },
              strategy: "full_thread_summary",
              status: "ready",
              summaryMessageId: null,
              summaryText: "",
              history: {
                messages: [],
                coverage: "Preserve this handoff after compacting.",
                omittedItems: 0,
              },
              createdByProviderInstanceId: null,
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
    }
    yield* worker.drain();
    yield* orchestrator.streamStoredEventsFrom({ afterSequence: 0, threadId }).pipe(
      Stream.filter(
        (row) =>
          row.event.type === "run.updated" &&
          ["waiting", "failed"].includes(row.event.payload.status),
      ),
      Stream.take(1),
      Stream.runDrain,
    );
    yield* worker.drain();
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const succeeds =
      scenario === "handoff" || scenario === "handoff budget" || scenario === "provider";
    expect(projection.runs[0]?.status).toBe(succeeds ? "completed" : "failed");
    expect(compactions).toBe(1);
    expect(starts).toBe(scenario.startsWith("compaction") || scenario === "handoff budget" ? 1 : 2);
    if (succeeds) {
      expect(
        projection.turnItems.some(
          (item) => item.type === "compaction" && item.title === "Context compacted",
        ),
      ).toBe(true);
      expect(
        projection.turnItems.some(
          (item) => item.type === "system_notice" && item.message.includes("Retried the request"),
        ),
      ).toBe(true);
      expect(projection.turnItems.filter((item) => item.type === "error")).toHaveLength(0);
      expect(provider.turns.at(-1)?.message.text).toContain("Keep this exact request");
      if (scenario === "handoff budget") {
        expect(provider.turns.at(-1)?.message.text).toContain(
          "Preserve this handoff after compacting.",
        );
        expect(projection.contextHandoffs[0]?.delivery?.status).toBe("inline");
      }
    } else if (scenario.startsWith("compaction")) {
      expect(projection.turnItems.find((item) => item.type === "error")?.failure.message).toContain(
        "Insufficient context allowance",
      );
    }
  }).pipe(
    Effect.provide(
      layerWithRegistry({ name: "automatic-compaction" }, provider.registry, {
        runEffectWorker: false,
      }),
    ),
  );
});
