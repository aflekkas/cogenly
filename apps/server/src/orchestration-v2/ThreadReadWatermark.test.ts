import { expect, it } from "@effect/vitest";
import {
  AgentId,
  CommandId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { makeControllableProvider } from "./testkit/ControllableProvider.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const parentThreadId = ThreadId.make("thread:read-parent");

const create = (
  key: string,
  extra: Partial<Extract<OrchestrationV2Command, { type: "thread.create" }>> = {},
): Extract<OrchestrationV2Command, { type: "thread.create" }> => ({
  type: "thread.create",
  commandId: CommandId.make(`create:${key}`),
  threadId: ThreadId.make(`thread:read-${key}`),
  projectId: ProjectId.make("project:test"),
  title: key,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdBy: "user",
  creationSource: "web",
  ...extra,
});

const lastVisitedAt = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { thread } = yield* orchestrator.getThreadProjection(threadId);
    return { lastVisitedAt: thread.lastVisitedAt, createdAt: thread.createdAt };
  });

const runtime = () =>
  layerWithRegistry(
    { name: "thread-read-watermark" },
    makeControllableProvider(CodexProviderCapabilitiesV2).registry,
    { runEffectWorker: false },
  );

it.effect("a new user-facing thread starts read at creation, so its first reply is news", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch(create("chat"));
    yield* orchestrator.dispatch(
      create("agent-work", {
        createdBy: "agent",
        agent: { id: AgentId.make("agent:a"), role: "work" },
      }),
    );
    for (const key of ["chat", "agent-work"]) {
      const thread = yield* lastVisitedAt(ThreadId.make(`thread:read-${key}`));
      expect(thread.lastVisitedAt).not.toBeNull();
      expect(DateTime.toEpochMillis(thread.lastVisitedAt!)).toBe(
        DateTime.toEpochMillis(thread.createdAt),
      );
    }
  }).pipe(Effect.provide(runtime())),
);

it.effect("subagent children and agent conversations keep no thread read watermark", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch(create("parent", { threadId: parentThreadId }));
    yield* orchestrator.dispatch(
      create("child", {
        subagent: {
          parentThreadId,
          rootThreadId: parentThreadId,
          taskNodeId: NodeId.make("node:task"),
        },
      }),
    );
    yield* orchestrator.dispatch(
      create("conversation", { agent: { id: AgentId.make("agent:a"), role: "conversation" } }),
    );
    expect((yield* lastVisitedAt(ThreadId.make("thread:read-child"))).lastVisitedAt).toBeNull();
    expect(
      (yield* lastVisitedAt(ThreadId.make("thread:read-conversation"))).lastVisitedAt,
    ).toBeNull();
  }).pipe(Effect.provide(runtime())),
);
