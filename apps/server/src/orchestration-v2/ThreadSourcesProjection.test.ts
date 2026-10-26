import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@cogenly/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Receipts from "./CommandReceiptStore.ts";
import * as Worker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as Threads from "./ThreadManagementService.ts";
import { deriveThreadSources, threadSourceRecordsFromProjection } from "./ThreadSources.ts";
import { makeControllableProvider } from "./testkit/ControllableProvider.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

it.effect("reads a thread's sources and outputs from the persisted projection", () => {
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
  const database = Sqlite.layerMemory;
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const threads = yield* Threads.ThreadManagementService;
    const threadId = ThreadId.make("thread:sources");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make("project:test"),
      title: "Sources",
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
      messageId: MessageId.make("message:send"),
      text: "Use the plan",
      context: {
        version: 1,
        records: [
          {
            version: 1,
            contextId: "ctx-thread",
            label: "Plan",
            kind: "thread",
            environmentId: "env-1",
            threadId: "thread:plan",
            title: "Plan",
          },
        ],
      },
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();

    const prompt = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
      (item) => item.type === "user_message",
    )!;
    const now = yield* DateTime.now;
    const sink = yield* EventSink.EventSinkV2;
    const toolEvent = (id: string, toolName: string, input: unknown, output?: unknown) => ({
      id: EventId.make(`event:${id}`),
      type: "turn-item.updated" as const,
      threadId,
      runId: prompt.runId,
      occurredAt: now,
      payload: {
        ...prompt,
        id: TurnItemId.make(`item:${id}`),
        type: "dynamic_tool" as const,
        status: "completed" as const,
        toolName,
        input,
        ...(output === undefined ? {} : { output }),
      },
    });
    yield* sink.write({
      events: [
        toolEvent("gmail", "mcp__cogenly__integration_call", {
          name: "gmail",
          tool: "search",
          arguments: { query: "x".repeat(40_000) },
        }),
        // The written note is far over the input budget; its title still survives.
        toolEvent("note", "mcp__cogenly__project_file_write", {
          title: "Weekly notes",
          text: "y".repeat(200_000),
        }),
        toolEvent(
          "render",
          "mcp__cogenly__html_render",
          { title: "Report", html: "<p>z</p>" },
          {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  htmlRender: { attachmentId: "render-1", title: "Report", height: 300 },
                }),
              },
            ],
          },
        ),
        toolEvent(
          "vault",
          "mcp__cogenly__vault_fill",
          { field: "password" },
          {
            structuredContent: {
              status: "filled",
              item: { id: "vault-1", name: "GitHub", username: "me@example.com" },
              field: "password",
              domain: "github.com",
              message: "Filled",
            },
          },
        ),
      ],
    });

    const result = yield* threads.getThreadSources(threadId);
    expect(result.sources.map((source) => source.key).toSorted()).toEqual([
      "integration:gmail",
      "project:self",
      "thread:thread:plan",
      "vault:vault-1",
    ]);
    expect(result.outputs.map((output) => [output.kind, output.key]).toSorted()).toEqual([
      ["file", "project:self:Weekly notes"],
      ["page", "page:render-1"],
    ]);
    expect(JSON.stringify(result)).not.toContain("me@example.com");

    // The in-memory projection reads the same rows to the same answer.
    const projection = yield* orchestrator.getThreadProjection(threadId);
    expect(deriveThreadSources(threadSourceRecordsFromProjection(projection))).toEqual(result);
  }).pipe(
    Effect.provide(
      Threads.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            layerWithRegistry({ name: "thread-sources" }, provider.registry, {
              databaseLayer: database,
              runEffectWorker: false,
            }),
            Receipts.layer.pipe(Layer.provide(database)),
            ServerSettings.layerTest({}),
          ),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});
