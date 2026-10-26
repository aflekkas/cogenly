import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CodexSettings,
  MessageId,
  NodeId,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  RuntimeMode,
  ThreadId,
} from "@cogenly/contracts";
import * as IdAllocator from "@cogenly/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@cogenly/provider-core/server/McpProviderSessions";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as CodexClient from "effect-codex-app-server/client";
import type * as RepoMcpTrust from "../../integrations/RepoMcpTrust.ts";
import { makeReplayServerConfig } from "../testkit/ProviderReplayHarness.ts";
import * as CodexAdapter from "./CodexAdapterV2.ts";

const decodeRuntimeMode = Schema.decodeEffect(RuntimeMode);
const decodeCodexSettings = Schema.decodeEffect(CodexSettings);
const decodeAppThread = Schema.decodeEffect(OrchestrationV2AppThread);

const FULL_CONTEXT = {
  cogenly_project: { kind: "application", value: "manifest v1" },
};

const legacyThread = (
  threadId: ThreadId,
  modelSelection: { instanceId: ProviderInstanceId; model: string },
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    return yield* decodeAppThread({
      id: threadId,
      projectId: ProjectId.make("test"),
      title: "Context thread",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    });
  });

const repoTrust: RepoMcpTrust.RepoMcpTrust["Service"] = {
  review: ({ definitions }) =>
    Effect.succeed({ allowedNames: Object.keys(definitions), waitingNames: [] }),
  subscribe: () => Stream.never,
  respond: () => Effect.void,
};

/**
 * A Codex session whose project context rides in `additionalContext`.
 * `turnStarts` records every wire payload so a test can see exactly what
 * context each turn carried.
 */
const fixture = (input: { readonly failTurnStarts?: number; readonly failInject?: boolean }) =>
  Effect.gen(function* () {
    const serverConfig = yield* makeReplayServerConfig("codex-additional-context");
    const turnStarts: Array<Record<string, unknown>> = [];
    const notifications = new Map<string, (payload: unknown) => Effect.Effect<unknown>>();
    const injectAttempted = yield* Deferred.make<void>();
    let turnStartAttempts = 0;
    const request = (method: string, payload: unknown) =>
      Effect.suspend(() => {
        switch (method) {
          case "initialize":
            return Effect.succeed({});
          case "config/read":
            return Effect.succeed({ config: { mcp_servers: {} }, layers: [], origins: {} });
          case "thread/start":
          case "thread/resume":
            return Effect.succeed({ thread: { id: "native-codex", createdAt: 1, updatedAt: 1 } });
          case "turn/start": {
            turnStarts.push(payload as Record<string, unknown>);
            turnStartAttempts += 1;
            return turnStartAttempts <= (input.failTurnStarts ?? 0)
              ? Effect.fail("turn/start failed")
              : Effect.succeed({ turn: { id: `native-turn-${turnStartAttempts}`, startedAt: 1 } });
          }
          case "thread/inject_items":
            return Deferred.succeed(injectAttempted, undefined).pipe(
              Effect.flatMap(() =>
                input.failInject ? Effect.fail("inject failed") : Effect.succeed({}),
              ),
            );
          default:
            return Effect.fail(`Unexpected request: ${method}`);
        }
      });
    const client = {
      request,
      notify: () => Effect.void,
      handleServerRequest: () => Effect.void,
      handleServerNotification: (
        method: string,
        handler: (payload: unknown) => Effect.Effect<unknown>,
      ) =>
        Effect.sync(() => {
          notifications.set(method, handler);
        }),
      handleUnknownServerRequest: () => Effect.void,
      handleUnknownServerNotification: () => Effect.void,
    } as unknown as CodexClient.CodexAppServerClient["Service"];
    const instanceId = ProviderInstanceId.make("codex");
    const threadId = ThreadId.make("codex-additional-context");
    const modelSelection = { instanceId, model: "gpt-5.5" };
    const runtimePolicy = {
      runtimeMode: yield* decodeRuntimeMode("auto-accept-edits"),
      interactionMode: "default" as const,
      cwd: serverConfig.baseDir,
      projectManifest: "manifest v1",
    };
    const adapter = yield* CodexAdapter.makeCodexAdapterV2({
      repoMcpTrust: repoTrust,
      instanceId,
      settings: yield* decodeCodexSettings({}),
      environment: {},
      clientFactory: { open: () => Effect.succeed(client) },
      crypto: yield* Crypto.Crypto,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig,
    });
    const session = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("codex-context-test"),
      modelSelection,
      runtimePolicy,
    });
    yield* session.events.pipe(Stream.runDrain, Effect.forkChild);
    const providerThread = yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
    const appThread = yield* legacyThread(threadId, modelSelection);
    const startTurn = (ordinal: number) =>
      session.startTurn({
        appThread,
        threadId,
        runId: RunId.make(`run-${ordinal}`),
        runOrdinal: ordinal,
        providerTurnOrdinal: ordinal,
        attemptId: RunAttemptId.make(`attempt-${ordinal}`),
        rootNodeId: NodeId.make(`node-${ordinal}`),
        providerThread,
        modelSelection,
        runtimePolicy,
        message: {
          messageId: MessageId.make(`message-${ordinal}`),
          text: "Continue",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
    return { turnStarts, notifications, injectAttempted, startTurn };
  });

const provide = Effect.provide([McpProviderSessions.layer, IdAllocator.layer, NodeServices.layer]);

it.effect("resends the full additional context when a turn start fails, then only changes", () =>
  Effect.gen(function* () {
    const { turnStarts, startTurn } = yield* fixture({ failTurnStarts: 1 });
    const failed = yield* startTurn(1).pipe(Effect.flip);
    assert.isDefined(failed);
    assert.deepEqual(turnStarts[0]?.additionalContext, FULL_CONTEXT);
    // The failed start recorded nothing, so the retry carries the full set.
    yield* startTurn(2);
    assert.deepEqual(turnStarts[1]?.additionalContext, FULL_CONTEXT);
    // After a successful start the context is recorded: nothing is resent.
    yield* startTurn(3);
    assert.isUndefined(turnStarts[2]?.additionalContext);
  }).pipe(provide),
);

it.effect("resends the full additional context after a failed compaction restore", () =>
  Effect.gen(function* () {
    const { turnStarts, notifications, injectAttempted, startTurn } = yield* fixture({
      failInject: true,
    });
    yield* startTurn(1);
    assert.deepEqual(turnStarts[0]?.additionalContext, FULL_CONTEXT);
    yield* notifications.get("item/completed")!({
      threadId: "native-codex",
      turnId: "native-turn-1",
      item: { type: "contextCompaction", id: "compaction-1" },
    });
    yield* Deferred.await(injectAttempted);
    // Let the forked restore settle; it is all synchronous work once the
    // injected request has failed.
    for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
    // The failed restore forgot the stored entries: full set again.
    yield* startTurn(2);
    assert.deepEqual(turnStarts[1]?.additionalContext, FULL_CONTEXT);
  }).pipe(provide),
);
