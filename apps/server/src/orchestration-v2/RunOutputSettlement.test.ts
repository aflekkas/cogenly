import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Worker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { makeControllableProvider } from "./testkit/ControllableProvider.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

it.effect.each([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "stream-error",
  "failed-before-output",
] as const)("settles root activity after %s without final output events", (outcome) => {
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
  const driver = ProviderDriverKind.make("codex");
  provider.setStart((input) =>
    Effect.gen(function* () {
      if (outcome === "failed-before-output")
        return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
          driver,
          threadId: input.threadId,
          runId: input.runId,
          providerThreadId: input.providerThread.id,
          cause: "Provider failed before output",
        });
      const turn = yield* provider.begin(input);
      const threadId = input.threadId;
      const now = yield* DateTime.now;
      const base = {
        threadId,
        runId: input.runId,
        nodeId: input.rootNodeId,
        providerThreadId: input.providerThread.id,
        providerTurnId: turn,
        nativeItemRef: null,
        parentItemId: null,
        status: "running" as const,
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };
      yield* provider.publish({
        type: "turn_item.updated",
        driver,
        turnItem: {
          ...base,
          id: TurnItemId.make("reasoning"),
          ordinal: 100,
          type: "reasoning",
          text: "Thinking through it\n\n",
          streaming: true,
        },
      });
      yield* provider.publish({
        type: "turn_item.updated",
        driver,
        turnItem: {
          ...base,
          id: TurnItemId.make("reply"),
          ordinal: 101,
          type: "assistant_message",
          messageId: MessageId.make("message:reply"),
          text: "Partial reply\n\n",
          streaming: true,
          attachments: [],
        },
      });
      if (outcome === "stream-error") {
        yield* provider.failEvents(
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver,
            providerSessionId: input.providerThread.providerSessionId!,
            cause: "Provider exited",
          }),
        );
      } else if (outcome === "completed" || outcome === "failed") {
        yield* provider.finish(
          input,
          turn,
          outcome === "failed"
            ? makeProviderFailure({
                class: "usage_limit",
                message: "Claude API rate limit reached",
              })
            : null,
        );
      } else {
        yield* provider.publish({
          type: "turn.terminal",
          driver,
          providerThreadId: input.providerThread.id,
          providerTurnId: turn,
          runOrdinal: input.runOrdinal,
          threadDisposition: "reusable",
          status: outcome,
          failure: null,
        });
      }
    }),
  );
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const threadId = ThreadId.make("thread:output-settlement");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make("project:test"),
      title: "Root activity",
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
      messageId: MessageId.make("message:prompt"),
      text: "Work",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    const terminalStatus =
      outcome === "stream-error" || outcome === "failed-before-output" ? "failed" : outcome;
    yield* orchestrator.streamStoredEventsFrom({ afterSequence: 0, threadId }).pipe(
      Stream.filter(
        (row) =>
          row.event.type === "run.updated" &&
          row.event.payload.status ===
            (terminalStatus === "completed" ? "waiting" : terminalStatus),
      ),
      Stream.take(1),
      Stream.runDrain,
    );
    yield* worker.drain();
    const projection = yield* orchestrator.getThreadProjection(threadId);
    expect(projection.runs[0]?.status).toBe(terminalStatus);
    const output = projection.turnItems.filter(
      (item) => item.type === "reasoning" || item.type === "assistant_message",
    );
    expect(output).toHaveLength(outcome === "failed-before-output" ? 0 : 2);
    for (const item of output) {
      expect(item.status).toBe(terminalStatus);
      expect(item.completedAt).not.toBeNull();
      if (item.type === "assistant_message") expect(item.streaming).toBe(false);
    }
  }).pipe(
    Effect.provide(
      layerWithRegistry({ name: `output-settlement-${outcome}` }, provider.registry, {
        runEffectWorker: false,
        responseStreamingMode: "paragraph",
      }),
    ),
  );
});
