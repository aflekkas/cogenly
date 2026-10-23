import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import type * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as ClaudeAdapter from "./Adapters/ClaudeAdapterV2.ts";
import * as Registry from "./ProviderAdapterRegistry.ts";
import { runOrchestratorV2Scenario } from "./testkit/OrchestratorScenario.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-sonnet-4-6" };
const threadId = ThreadId.make("thread:steer-during-compaction");
const COMPACTION_GATE = "compaction-finishes";

const promptText = (message: SDKUserMessage): string => {
  const content = message.message.content;
  return typeof content === "string"
    ? content
    : content.map((block) => (block.type === "text" ? block.text : "")).join("");
};

let resultCount = 0;
const resultMessage = (sessionId: string, promptUuid: string | undefined) =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    ...(promptUuid === undefined ? {} : { user_message_uuid: promptUuid }),
    duration_ms: 1,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    stop_reason: null,
    session_id: sessionId,
    uuid: `result-${++resultCount}`,
  }) as unknown as SDKMessage;

const sendMessage = (
  key: string,
  text: string,
  dispatchMode: Extract<OrchestrationV2Command, { type: "message.dispatch" }>["dispatchMode"],
): OrchestrationV2Command => ({
  type: "message.dispatch",
  commandId: CommandId.make(`send:${key}`),
  threadId,
  messageId: MessageId.make(`message:${key}`),
  text,
  attachments: [],
  dispatchMode,
  createdBy: "user",
  creationSource: "web",
});

it.effect("queues a steer sent during compaction and delivers it when compaction ends", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-steer-compaction-" }),
    );
    const cwd = path.join(root, "chat");
    yield* fs.makeDirectory(cwd, { recursive: true });
    const gate = makeProviderReplayGate([COMPACTION_GATE]);
    const prompts: Array<string> = [];
    let nextSessionId = 1;

    // A Claude CLI stand-in: each open answers one prompt and exits. The
    // /compact prompt is answered only once the test releases the gate.
    const queryRunner: ClaudeAdapter.ClaudeAgentSdkQueryRunnerShape = {
      allocateSessionId: Effect.sync(() => `00000000-0000-4000-8000-00000000000${nextSessionId++}`),
      open: (input) =>
        Effect.gen(function* () {
          const nativeId = input.options.sessionId ?? input.options.resume ?? "unknown";
          const queue = yield* Queue.unbounded<SDKMessage, Cause.Done>();
          return {
            messages: Stream.fromQueue(queue),
            offer: (message: SDKUserMessage) => {
              const text = promptText(message);
              prompts.push(text);
              const answer = Queue.offer(queue, resultMessage(nativeId, message.uuid)).pipe(
                Effect.andThen(Queue.end(queue)),
                Effect.asVoid,
              );
              return text.trim() === "/compact"
                ? Effect.promise(() => gate.beforeEmit(COMPACTION_GATE)).pipe(
                    Effect.andThen(answer),
                    Effect.forkDetach,
                    Effect.asVoid,
                  )
                : answer;
            },
            setModel: () => Effect.void,
            applyFlagSettings: () => Effect.void,
            setPermissionMode: () => Effect.void,
            stopTask: () => Effect.void,
            backgroundTasks: () => Effect.succeed(false),
            interrupt: Effect.void,
            close: Queue.end(queue).pipe(Effect.asVoid),
          } satisfies ClaudeAdapter.ClaudeAgentSdkQuerySession;
        }),
      forkSession: () => Effect.die("unexpected fork"),
      subagentLaunchToolUseId: () => Effect.succeed(null),
      assertComplete: Effect.void,
    };

    const layerRegistry = Layer.effect(
      Registry.ProviderAdapterRegistryV2,
      Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter.makeClaudeAdapterV2({
          instanceId,
          settings: yield* decodeClaudeSettings({}),
          environment: { HOME: root },
          attachmentsDir: root,
          fileSystem: yield* FileSystem.FileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          queryRunner,
        });
        return Registry.ProviderAdapterRegistryV2.of({
          list: () => Effect.succeed([instanceId]),
          getMetadata: () =>
            Effect.succeed({
              driver: ClaudeAdapter.CLAUDE_PROVIDER,
              continuationKey: "claude",
              enabled: true,
              capabilities: ClaudeAdapter.ClaudeProviderCapabilitiesV2,
            }),
          get: () => Effect.succeed(adapter),
        });
      }),
    ).pipe(Layer.provide(Layer.mergeAll(IdAllocator.layer, NodeServices.layer)));

    const compactionRunId = IdAllocator.derive.run({ threadId, ordinal: 2 });
    const steerRunId = IdAllocator.derive.run({ threadId, ordinal: 3 });
    const database = Sqlite.layerMemory;
    const result = yield* runOrchestratorV2Scenario(
      {
        name: "steer-during-compaction",
        commands: [],
        steps: [
          {
            type: "dispatch",
            command: {
              type: "thread.create",
              commandId: CommandId.make("create:steer-during-compaction"),
              threadId,
              projectId: ProjectId.make("project:steer-during-compaction"),
              title: "Steer during compaction",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
              createdBy: "user",
              creationSource: "web",
            },
          },
          {
            type: "dispatch",
            command: sendMessage("first", "Remember the word heliotrope.", {
              type: "start_immediately",
            }),
          },
          { type: "await_thread_idle", threadId },
          {
            type: "dispatch",
            command: sendMessage("compact", "/compact", { type: "start_immediately" }),
          },
          { type: "await_run_steerable", threadId, runId: compactionRunId },
          // The composer's default while a turn runs: steer into it.
          {
            type: "dispatch",
            command: sendMessage("steer", "Which word did I ask for?", {
              type: "steer_active",
              targetRunId: compactionRunId,
            }),
          },
          { type: "release_replay_gate", label: COMPACTION_GATE },
          { type: "await_thread_idle", threadId },
        ],
        projectionThreadIds: [threadId],
      },
      { replayGate: gate },
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          database,
          layerWithRegistry({ name: "steer-during-compaction" }, layerRegistry, {
            databaseLayer: database,
          }),
        ),
      ),
    );

    const projection = result.projections.get(threadId)!;
    // The steer became its own queued run behind the compaction, not a steer into it.
    const steerMessage = projection.messages.find(
      (message) => message.id === MessageId.make("message:steer"),
    );
    assert.equal(steerMessage?.runId, steerRunId);
    const runStatusEvents = result.domainEvents.flatMap((event) =>
      event.type === "run.created" || event.type === "run.updated"
        ? [{ runId: event.payload.id, status: event.payload.status }]
        : [],
    );
    const queuedAt = runStatusEvents.findIndex(
      (entry) => entry.runId === steerRunId && entry.status === "queued",
    );
    const compactionCompletedAt = runStatusEvents.findIndex(
      (entry) => entry.runId === compactionRunId && entry.status === "completed",
    );
    assert.isAtLeast(queuedAt, 0);
    assert.isAbove(compactionCompletedAt, queuedAt);
    // It drained once compaction finished and reached the provider as a turn.
    assert.deepEqual(
      projection.runs.map((run) => run.status),
      ["completed", "completed", "completed"],
    );
    const steerTurnItem = projection.turnItems.find(
      (item) => item.type === "user_message" && item.messageId === steerMessage?.id,
    );
    assert.equal(
      steerTurnItem?.type === "user_message" ? steerTurnItem.inputIntent : undefined,
      "queued_turn",
    );
    assert.isTrue(prompts.some((prompt) => prompt.includes("Which word did I ask for?")));
    assert.isAbove(
      prompts.findIndex((prompt) => prompt.includes("Which word did I ask for?")),
      prompts.findIndex((prompt) => prompt.trim() === "/compact"),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
