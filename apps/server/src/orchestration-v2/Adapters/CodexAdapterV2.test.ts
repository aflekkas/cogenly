import {
  makeProviderTextDeltaCoalescer,
  type ProviderTextDeltaUpdate,
} from "./ProviderTextDeltaCoalescer.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  RuntimeMode,
  type ModelSelection,
  NodeId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";

const decodeRuntimeMode = Schema.decodeUnknownSync(RuntimeMode);

describe("Codex context usage compatibility", () => {
  const previous: ModelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-6-astra",
  };
  it("retains measured usage for reasoning-only changes in either direction", () => {
    const low: ModelSelection = { ...previous, options: [{ id: "reasoningEffort", value: "low" }] };
    assert.isTrue(CodexAdapterV2.canReuseCodexContextUsage(previous, low));
    assert.isTrue(CodexAdapterV2.canReuseCodexContextUsage(low, previous));
    assert.isTrue(
      CodexAdapterV2.canReuseCodexContextUsage(low, {
        ...low,
        options: [{ id: "reasoningEffort", value: "high" }],
      }),
    );
  });
  it("invalidates usage for model, instance, context-window and unknown option changes", () => {
    for (const next of [
      { ...previous, model: "other-model" },
      { ...previous, instanceId: ProviderInstanceId.make("other-codex") },
      { ...previous, options: [{ id: "contextWindow", value: "32k" }] },
      { ...previous, options: [{ id: "customOption", value: "value" }] },
    ])
      assert.isFalse(CodexAdapterV2.canReuseCodexContextUsage(previous, next));
  });
});

describe("CodexAdapterV2 file change approvals", () => {
  it("uses nonblank reasons before sorted file operations and renamed paths", () => {
    const fileChanges = {
      "/tmp/removed.md": { type: "delete" as const, content: "gone" },
      "/tmp/added.ts": { type: "add" as const, content: "export {};" },
      "/tmp/moved.ts": {
        type: "update" as const,
        unified_diff: "@@",
        move_path: "/tmp/renamed.ts",
      },
    };
    assert.equal(
      CodexAdapterV2.codexFileChangeApprovalPrompt({
        reason: "  Update configuration. ",
        fileChanges,
      }),
      "Update configuration.",
    );
    assert.equal(
      CodexAdapterV2.codexFileChangeApprovalPrompt({ reason: " ", fileChanges }),
      "add /tmp/added.ts\nupdate /tmp/moved.ts -> /tmp/renamed.ts\ndelete /tmp/removed.md",
    );
  });

  it("falls back to a nonblank grant root and omits empty details", () => {
    assert.equal(
      CodexAdapterV2.codexFileChangeApprovalPrompt({ reason: " ", grantRoot: " /workspace " }),
      "/workspace",
    );
    assert.equal(
      CodexAdapterV2.codexFileChangeApprovalPrompt({ fileChanges: {}, grantRoot: "/workspace" }),
      "/workspace",
    );
    assert.isUndefined(
      CodexAdapterV2.codexFileChangeApprovalPrompt({
        reason: " ",
        grantRoot: " ",
        fileChanges: {},
      }),
    );
  });

  it("bounds large patch descriptions without losing the remaining count", () => {
    const fileChanges = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [
        `/tmp/file-${String(index).padStart(2, "0")}.ts`,
        { type: "add" as const, content: "" },
      ]),
    );
    const detail = CodexAdapterV2.codexFileChangeApprovalPrompt({ fileChanges });
    assert.equal(detail?.split("\n").length, 21);
    assert.isTrue(detail?.startsWith("add /tmp/file-00.ts") ?? false);
    assert.isTrue(detail?.endsWith("+5 more") ?? false);
    assert.notInclude(detail, "file-20.ts");
  });
});

describe("CodexAdapterV2 context usage", () => {
  it("uses the current context rather than cumulative processed tokens", () => {
    const usage = CodexAdapterV2.codexProviderTurnTokenUsage(
      {
        total: {
          totalTokens: 180_000,
          inputTokens: 160_000,
          cachedInputTokens: 20_000,
          outputTokens: 20_000,
          reasoningOutputTokens: 5_000,
        },
        last: {
          totalTokens: 50_000,
          inputTokens: 45_000,
          cachedInputTokens: 10_000,
          outputTokens: 5_000,
          reasoningOutputTokens: 1_000,
        },
        modelContextWindow: 200_000,
      },
      "2026-08-29T00:00:00.000Z",
    );

    assert.deepEqual(usage, {
      usedTokens: 50_000,
      maxTokens: 200_000,
      inputTokens: 45_000,
      cachedInputTokens: 10_000,
      outputTokens: 5_000,
      reasoningOutputTokens: 1_000,
      updatedAt: "2026-08-29T00:00:00.000Z",
    });
  });
});

describe("CodexAdapterV2 assistant message streaming", () => {
  it.effect("makes accumulated assistant text visible after the bounded flush interval", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<
        ReadonlyArray<{
          readonly turnId: string;
          readonly itemId: string;
          readonly text: string;
          readonly completed: boolean;
        }>
      >([]);
      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) => Ref.update(updates, (current) => [...current, update]),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: "partial" });
      assert.deepEqual(yield* Ref.get(updates), []);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;

      assert.deepEqual(yield* Ref.get(updates), [
        {
          turnId: "turn-1",
          itemId: "message-1",
          text: "partial",
          completed: false,
        },
      ]);
    }),
  );

  it.effect("coalesces multiple token deltas into one assistant update per interval", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<ProviderTextDeltaUpdate>>([]);
      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) => Ref.update(updates, (current) => [...current, update]),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: "one" });
      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: " two" });
      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: " three" });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;

      assert.deepEqual(yield* Ref.get(updates), [
        {
          turnId: "turn-1",
          itemId: "message-1",
          text: "one two three",
          completed: false,
        },
      ]);
    }),
  );

  it.effect("flushes buffered text synchronously before item and turn completion", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<ProviderTextDeltaUpdate>>([]);
      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) => Ref.update(updates, (current) => [...current, update]),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: "item final" });
      const completedText = yield* coalescer.complete({
        turnId: "turn-1",
        itemId: "message-1",
      });
      yield* coalescer.append({ turnId: "turn-1", itemId: "message-2", delta: "turn final" });
      yield* coalescer.flushTurn("turn-1");

      assert.equal(completedText, "item final");
      assert.deepEqual(yield* Ref.get(updates), [
        { turnId: "turn-1", itemId: "message-1", text: "item final", completed: true },
        {
          turnId: "turn-1",
          itemId: "message-2",
          text: "turn final",
          completed: true,
          cutOff: true,
        },
      ]);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;
      assert.equal((yield* Ref.get(updates)).length, 2);
    }),
  );

  it.effect("closes a fragment Codex never completed as interrupted, not as the answer", () =>
    Effect.gen(function* () {
      const closings = yield* Ref.make<
        ReadonlyArray<{ itemId: string; text: string; status: string; recordMessage: boolean }>
      >([]);
      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) =>
          Ref.update(closings, (current) => [
            ...current,
            {
              itemId: update.itemId,
              text: update.text,
              ...CodexAdapterV2.codexAgentMessageClosing(update, false),
            },
          ]),
      });

      // A steer restarts sampling mid-sentence: Codex drops this item and
      // never sends item/completed for it.
      yield* coalescer.append({ turnId: "turn-1", itemId: "fragment", delta: "I'll combine" });
      yield* coalescer.append({ turnId: "turn-1", itemId: "fragment", delta: " the booking" });
      yield* coalescer.append({ turnId: "turn-1", itemId: "answer", delta: "Deleted both" });
      yield* coalescer.complete({
        turnId: "turn-1",
        itemId: "answer",
        finalText: "Deleted both Slack updates.",
      });
      // turn/completed
      yield* coalescer.flushTurn("turn-1");

      assert.deepEqual(yield* Ref.get(closings), [
        {
          itemId: "answer",
          text: "Deleted both Slack updates.",
          status: "completed",
          recordMessage: true,
        },
        {
          itemId: "fragment",
          text: "I'll combine the booking",
          status: "interrupted",
          recordMessage: false,
        },
      ]);
    }),
  );

  it("keeps a fragment in the transcript when the turn itself was cut short", () => {
    assert.deepEqual(
      CodexAdapterV2.codexAgentMessageClosing({ completed: true, cutOff: true }, true),
      { status: "interrupted", recordMessage: true },
    );
    assert.deepEqual(CodexAdapterV2.codexAgentMessageClosing({ completed: false }, true), {
      status: "running",
      recordMessage: false,
    });
  });

  it.effect("retains buffered text until completion updates are emitted", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<ProviderTextDeltaUpdate>>([]);
      const failNext = yield* Ref.make(true);
      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) =>
          Ref.getAndSet(failNext, false).pipe(
            Effect.flatMap((shouldFail) =>
              shouldFail
                ? Effect.die("projection unavailable")
                : Ref.update(updates, (current) => [...current, update]),
            ),
          ),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: "turn final" });
      const failedFlush = yield* coalescer.flushTurn("turn-1").pipe(Effect.exit);
      assert.equal(failedFlush._tag, "Failure");
      yield* coalescer.flushTurn("turn-1");

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-2", delta: "item final" });
      yield* Ref.set(failNext, true);
      const failedComplete = yield* coalescer
        .complete({ turnId: "turn-1", itemId: "message-2" })
        .pipe(Effect.exit);
      assert.equal(failedComplete._tag, "Failure");
      const completedText = yield* coalescer.complete({
        turnId: "turn-1",
        itemId: "message-2",
      });

      assert.equal(completedText, "item final");
      assert.deepEqual(yield* Ref.get(updates), [
        {
          turnId: "turn-1",
          itemId: "message-1",
          text: "turn final",
          completed: true,
          cutOff: true,
        },
        { turnId: "turn-1", itemId: "message-2", text: "item final", completed: true },
      ]);
    }),
  );

  it.effect("can discard an empty completion without emitting an assistant update", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<ProviderTextDeltaUpdate>>([]);
      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) => Ref.update(updates, (current) => [...current, update]),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: "" });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;
      const completedText = yield* coalescer.complete({
        turnId: "turn-1",
        itemId: "message-1",
        finalText: "",
        emitEmpty: false,
      });

      assert.equal(completedText, "");
      assert.deepEqual(yield* Ref.get(updates), []);

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-2", delta: "buffered" });
      assert.equal(
        yield* coalescer.complete({
          turnId: "turn-1",
          itemId: "message-2",
          emitEmpty: false,
        }),
        "buffered",
      );
      assert.deepEqual(yield* Ref.get(updates), [
        {
          turnId: "turn-1",
          itemId: "message-2",
          text: "buffered",
          completed: true,
        },
      ]);
    }),
  );

  it.effect("treats explicit empty final text as authoritative over buffered deltas", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<ProviderTextDeltaUpdate>>([]);
      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) => Ref.update(updates, (current) => [...current, update]),
      });

      yield* coalescer.append({
        turnId: "turn-1",
        itemId: "message-1",
        delta: "stale buffered text",
      });
      const completedText = yield* coalescer.complete({
        turnId: "turn-1",
        itemId: "message-1",
        finalText: "",
      });

      assert.equal(completedText, "");
      assert.deepEqual(yield* Ref.get(updates), [
        {
          turnId: "turn-1",
          itemId: "message-1",
          text: "",
          completed: true,
        },
      ]);
    }),
  );
});

describe("CodexAdapterV2 runtime policy", () => {
  it.effect("derives concrete Codex turn policies from every T3 runtime mode", () =>
    Effect.gen(function* () {
      const build = (
        runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access",
      ) =>
        CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId: `native-${runtimeMode}`,
          codexInput: [{ type: "text", text: "test" }],
          runtimePolicy: {
            runtimeMode: decodeRuntimeMode(runtimeMode),
            interactionMode: "default",
            cwd: null,
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
        });

      const approvalRequired = yield* build("approval-required");
      const autoAcceptEdits = yield* build("auto-accept-edits");
      const auto = yield* build("auto");
      const fullAccess = yield* build("full-access");

      for (const params of [approvalRequired, autoAcceptEdits, auto, fullAccess]) {
        assert.equal(params.approvalPolicy, "never");
        assert.equal(params.approvalsReviewer, "user");
        assert.equal(params.sandboxPolicy?.type, "dangerFullAccess");
      }
    }),
  );

  it.effect("ignores restrictive legacy Codex policy overrides", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-override",
        codexInput: [{ type: "text", text: "test" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
          approvalPolicy: "on-request",
          sandboxPolicy: {
            type: "readOnly",
          },
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
      });

      assert.equal(params.approvalPolicy, "never");
      assert.equal(params.sandboxPolicy?.type, "dangerFullAccess");
    }),
  );

  it.effect("sends MCP app model context as untrusted Codex context", () =>
    Effect.gen(function* () {
      const policy = { runtimeMode: "full-access", interactionMode: "default", cwd: null } as const;
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
      const appContext = [{ key: "mcp_app_todos_list_todos_item-1", text: "Filtered to overdue" }];
      const alone = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-app-context",
        codexInput: [{ type: "text", text: "what's on my list?" }],
        runtimePolicy: policy,
        modelSelection,
        appContext,
      });
      assert.deepEqual(alone.additionalContext, {
        "mcp_app_todos_list_todos_item-1": { kind: "untrusted", value: "Filtered to overdue" },
      });
      // Alongside T3's own context, both are kept.
      const withT3 = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-app-context",
        codexInput: [{ type: "text", text: "what's on my list?" }],
        runtimePolicy: policy,
        modelSelection,
        hasT3Mcp: true,
        appContext,
      });
      assert.deepEqual(withT3.additionalContext?.["mcp_app_todos_list_todos_item-1"], {
        kind: "untrusted",
        value: "Filtered to overdue",
      });
      assert.isDefined(withT3.additionalContext?.["cogenly_runtime"]);
    }),
  );

  it.effect("adds default-mode developer instructions when the T3 MCP server is attached", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-orchestration-instructions",
        codexInput: [{ type: "text", text: "delegate this task" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        hasT3Mcp: true,
      });

      assert.equal(params.collaborationMode?.mode, "default");
      assert.include(
        params.additionalContext?.cogenly_orchestration?.value ?? "",
        "Use `delegate_task`",
      );
      assert.include(
        params.additionalContext?.cogenly_orchestration?.value ?? "",
        "structured object, never as JSON text",
      );
    }),
  );

  it.effect(
    "routes shell commands to the terminal tools only when they are explicitly granted",
    () =>
      Effect.gen(function* () {
        const build = (terminalToolsAvailable?: boolean) =>
          CodexAdapterV2.buildCodexTurnStartParams({
            nativeThreadId: "native-terminal-instructions",
            codexInput: [{ type: "text", text: "run the tests" }],
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: null,
            },
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.4",
            },
            hasT3Mcp: true,
            ...(terminalToolsAvailable === undefined ? {} : { terminalToolsAvailable }),
          });

        const granted = yield* build(true);
        assert.include(
          granted.additionalContext?.cogenly_tools?.value ?? "",
          "Native shell tools are disabled",
        );
        // An explicit denial and a credential that never stated terminal
        // availability both keep the native shell, so the turn must not be
        // told to route commands through terminal tools instead.
        for (const params of [yield* build(false), yield* build()]) {
          assert.notInclude(params.additionalContext?.cogenly_tools?.value ?? "", "terminal_run");
          assert.notInclude(
            params.additionalContext?.cogenly_tools?.value ?? "",
            "Native shell tools are disabled",
          );
        }
      }),
  );

  it.effect("omits default-mode collaboration settings without the T3 MCP server", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-default-without-t3-mcp",
        codexInput: [{ type: "text", text: "implement this task" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        hasT3Mcp: false,
      });

      assert.isUndefined(params.collaborationMode);
    }),
  );

  it.effect("adds T3 plan-mode developer instructions when the T3 MCP server is attached", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-plan-with-t3-mcp",
        codexInput: [{ type: "text", text: "plan this task" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "plan",
          cwd: null,
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        hasT3Mcp: true,
      });

      assert.equal(params.collaborationMode?.mode, "plan");
      assert.include(
        params.collaborationMode?.settings.developer_instructions ?? "",
        "request_user_input",
      );
      assert.include(params.additionalContext?.cogenly_tools?.value ?? "", "preview_status");
    }),
  );

  it.effect("keeps Codex in plan mode without referencing unavailable T3 MCP tools", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-plan-without-t3-mcp",
        codexInput: [{ type: "text", text: "plan this task" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "plan",
          cwd: null,
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        hasT3Mcp: false,
      });

      assert.equal(params.collaborationMode?.mode, "plan");
      assert.notProperty(params.collaborationMode?.settings, "developer_instructions");
    }),
  );

  it.effect("runs chat-surface turns in a read-only sandbox with conversation instructions", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-chat-conversation",
        codexInput: [{ type: "text", text: "explain this idea" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
          conversationMode: true,
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        hasT3Mcp: true,
      });

      assert.equal(params.approvalPolicy, "never");
      assert.equal(params.sandboxPolicy?.type, "readOnly");
      assert.include(
        params.collaborationMode?.settings.developer_instructions ?? "",
        "<conversation_mode>",
      );
      assert.include(params.additionalContext?.cogenly_conversation?.value ?? "", "Start Work");
      assert.include(params.additionalContext?.cogenly_conversation?.value ?? "", "image_search");
      assert.notInclude(params.additionalContext?.cogenly_tools?.value ?? "", "terminal_run");
    }),
  );

  it.effect("keeps conversation instructions without the T3 MCP server", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-chat-no-mcp",
        codexInput: [{ type: "text", text: "explain this idea" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
          conversationMode: true,
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        hasT3Mcp: false,
      });

      assert.equal(params.sandboxPolicy?.type, "readOnly");
      assert.include(params.additionalContext?.cogenly_conversation?.value ?? "", "Start Work");
    }),
  );

  it.effect("keeps work-surface turns on full access without conversation instructions", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-work-full",
        codexInput: [{ type: "text", text: "implement this task" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        hasT3Mcp: true,
      });

      assert.equal(params.sandboxPolicy?.type, "dangerFullAccess");
      assert.notProperty(params.additionalContext ?? {}, "cogenly_conversation");
      assert.notInclude(
        params.collaborationMode?.settings.developer_instructions ?? "",
        "<conversation_mode>",
      );
      assert.notInclude(
        params.collaborationMode?.settings.developer_instructions ?? "",
        "image_search",
      );
    }),
  );

  it.effect("compiles per-turn Codex model options and cwd from their owning inputs", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-model-options",
        codexInput: [{ type: "text", text: "test" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "plan",
          cwd: "/workspace/model-options",
          reasoningEffort: "low",
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
          options: [
            { id: "reasoningEffort", value: "xhigh" },
            { id: "serviceTier", value: "priority" },
          ],
        },
      });

      assert.equal(params.model, "gpt-5.4");
      assert.equal(params.effort, "xhigh");
      assert.equal(params.serviceTier, "priority");
      assert.equal(params.cwd, "/workspace/model-options");
      assert.equal(params.collaborationMode?.settings.model, "gpt-5.4");
      assert.equal(params.collaborationMode?.settings.reasoning_effort, "xhigh");

      // ChatGPT token sharing rejects service tiers, so managed sessions drop a stale pick.
      const managed = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-model-options",
        codexInput: [{ type: "text", text: "test" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace/model-options",
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
          options: [{ id: "serviceTier", value: "priority" }],
        },
        omitServiceTier: true,
      });
      assert.equal(managed.serviceTier, undefined);
    }),
  );
});

describe("CodexAdapterV2 dynamic tool projection", () => {
  it.effect("keeps a failed Sky MCP call in Computer Use when its error has no metadata", () =>
    Effect.gen(function* () {
      const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        type: "mcpToolCall",
        id: "failed-sky-js",
        server: "node_repl",
        tool: "js",
        status: "failed",
        arguments: {
          title: "Restrict the breakpoint to Git actions",
          code: "await sky.type_text({app:'T3 Code (Nightly)',text:'debug(ga.run)'});",
        },
        result: { content: [{ type: "text", text: "Illegal Unicode escape sequence" }] },
      });
      assert.equal(projection.title, "Restrict the breakpoint to Git actions");
      assert.equal(projection.toolSurface, "computer");
      assert.deepEqual(projection.toolSource, {
        key: "computer-use",
        name: "Computer Use",
        kind: "computer",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["inProgress", "completed", "failed"] as const)(
    "preserves a bare js action's title and computer surface when %s without result metadata",
    (status) =>
      Effect.gen(function* () {
        const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem({
          type: "dynamicToolCall",
          id: "bare-js",
          tool: "js",
          status,
          arguments: { code: "await sky.get_app_state(app);", title: "Read the desktop window" },
          contentItems: [],
          success: status !== "failed",
        });
        assert.equal(projection.title, "Read the desktop window");
        assert.equal(projection.toolSurface, "computer");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["cua_repl", "node_repl"])(
    "uses the %s call title while leaving other MCP titles as tool arguments",
    (server) =>
      Effect.gen(function* () {
        const call = {
          type: "mcpToolCall" as const,
          id: "inspect",
          server,
          tool: "js",
          status: "completed" as const,
          arguments: {
            code: "await game.getAXStateAndScreenshot();",
            title: "Inspect Saga music screen",
          },
          result: { content: [] },
        };
        assert.equal(
          (yield* CodexAdapterV2.projectCodexDynamicToolItem(call)).title,
          "Inspect Saga music screen",
        );
        assert.equal(
          (yield* CodexAdapterV2.projectCodexDynamicToolItem({
            ...call,
            arguments: { title: "  " },
          })).title,
          server === "cua_repl" ? "Computer use" : "Run JavaScript",
        );
        assert.equal(
          (yield* CodexAdapterV2.projectCodexDynamicToolItem({ ...call, server: "github" })).title,
          "js",
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["inProgress", "completed", "failed"] as const)(
    "presents ordinary MCP calls when %s",
    (status) =>
      Effect.gen(function* () {
        const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem({
          type: "mcpToolCall",
          id: "weather-call",
          server: "weather",
          tool: "get_weather",
          status,
          arguments: { city: "Berlin" },
        });
        assert.equal(projection.title, "get weather");
        assert.deepEqual(projection.toolSource, {
          key: "mcp:weather",
          name: "weather",
          kind: "integration",
        });
        assert.deepEqual(projection.input, { city: "Berlin" });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses Codex connector names without reading a display title from arguments", () =>
    Effect.gen(function* () {
      const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        type: "mcpToolCall",
        id: "connector-call",
        server: "_apps",
        tool: "connector_get_weather",
        status: "completed",
        arguments: { title: "Argument, not display metadata" },
        appContext: {
          connectorId: "weather-app",
          appName: "Weather",
          actionName: "Check weather",
        },
        result: {
          content: [],
          _meta: { source: { logoUrl: "https://example.com/weather.png" } },
        },
      });
      assert.equal(projection.title, "Check weather");
      assert.equal(projection.toolSource?.name, "Weather");
      assert.deepEqual(projection.toolIcon, {
        _tag: "themed-logo",
        logoUrl: "https://example.com/weather.png",
      });
      assert.deepEqual(projection.toolSource?.icon, projection.toolIcon);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves native browser and app icons alongside MCP tool output", () =>
    Effect.gen(function* () {
      const browser = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        type: "mcpToolCall",
        id: "browser",
        server: "browser",
        tool: "open",
        status: "completed",
        arguments: {},
        result: {
          content: [],
          _meta: {
            "codex/toolSurface": {
              kind: "browserUse",
              browserFamily: "Chrome",
              screenshot: {
                pageUrl: "https://example.com/docs",
                faviconUrl: "https://example.com/icon.png",
              },
            },
          },
        },
      });
      assert.equal(browser.toolSurface, "browser");
      assert.deepEqual(browser.toolIcon, {
        _tag: "website",
        pageUrl: "https://example.com/docs",
        faviconUrl: "https://example.com/icon.png",
      });
      assert.equal(browser.toolSource?.name, "Chrome");
      const app = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        type: "mcpToolCall",
        id: "app",
        server: "computer",
        tool: "click",
        status: "completed",
        arguments: {},
        result: {
          content: [],
          _meta: {
            "codex/toolSurface": {
              kind: "computerUse",
              app: { kind: "appId", appId: "com.apple.finder" },
            },
          },
        },
      });
      assert.deepEqual(app.toolIcon, {
        _tag: "native-app",
        app: { _tag: "app-id", appId: "com.apple.finder" },
      });
      assert.equal(app.toolSource?.name, "Finder");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves MCP arguments and prefers structured output", () =>
    Effect.gen(function* () {
      const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        type: "mcpToolCall",
        id: "call-create-threads",
        server: "cogenly",
        tool: "create_threads",
        status: "completed",
        arguments: {
          threads: [{ title: "Fixture child", prompt: "fixture child prompt" }],
        },
        result: {
          content: [{ type: "text", text: '{"threads":[{"threadId":"thread:mcp:fixture:0"}]}' }],
          structuredContent: {
            threads: [{ threadId: "thread:mcp:fixture:0" }],
          },
        },
      });

      assert.deepEqual(projection, {
        toolName: "cogenly.create_threads",
        input: {
          threads: [{ title: "Fixture child", prompt: "fixture child prompt" }],
        },
        output: {
          threads: [{ threadId: "thread:mcp:fixture:0" }],
        },
        status: "completed",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves namespaced dynamic tool output", () =>
    Effect.gen(function* () {
      const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        type: "dynamicToolCall",
        id: "call-dynamic",
        namespace: "workspace",
        tool: "inspect",
        status: "failed",
        arguments: { path: "package.json" },
        contentItems: [{ type: "inputText", text: "inspection failed" }],
        success: false,
      });

      assert.deepEqual(projection, {
        toolName: "workspace.inspect",
        input: { path: "package.json" },
        output: [{ type: "inputText", text: "inspection failed" }],
        status: "failed",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("CodexAdapterV2 rollback mapping", () => {
  it.effect("derives native rollback count from durable provider turns", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const providerThreadId = ProviderThreadId.make("provider-thread-codex-rollback");
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver: CodexAdapterV2.CODEX_DRIVER_KIND,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: ProviderSessionId.make("provider-session-codex-rollback"),
        appThreadId: ThreadId.make("thread-codex-rollback"),
        ownerNodeId: null,
        nativeThreadRef: {
          driver: CodexAdapterV2.CODEX_DRIVER_KIND,
          nativeId: "native-thread-codex-rollback",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 3,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const providerTurn = (
        id: string,
        ordinal: number,
        status: OrchestrationV2ProviderTurn["status"],
      ): OrchestrationV2ProviderTurn => ({
        id: ProviderTurnId.make(id),
        providerThreadId,
        nodeId: NodeId.make(`node-${id}`),
        runAttemptId: RunAttemptId.make(`run-attempt-${id}`),
        nativeTurnRef: {
          driver: CodexAdapterV2.CODEX_DRIVER_KIND,
          nativeId: `native-${id}`,
          strength: "strong",
        },
        ordinal,
        status,
        startedAt: now,
        completedAt: status === "running" || status === "pending" ? null : now,
      });
      const firstTurn = providerTurn("provider-turn-first", 1, "completed");
      const secondTurn = providerTurn("provider-turn-second", 2, "completed");
      const runningTurn = providerTurn("provider-turn-running", 3, "running");
      const interruptedTurn = providerTurn("provider-turn-interrupted", 4, "interrupted");
      // `/goal` control turns never reached Codex, so revert must not count them.
      const goalCommandTurn = {
        ...providerTurn("provider-turn-goal-command", 5, "completed"),
        nativeTurnRef: null,
      };

      const numTurns = yield* CodexAdapterV2.resolveCodexRollbackTurnCount({
        providerThread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint-first"),
          appRunOrdinal: 1,
          providerTurn: firstTurn,
        },
        providerThreadTurns: [goalCommandTurn, interruptedTurn, runningTurn, secondTurn, firstTurn],
      });

      assert.equal(numTurns, 2);
    }),
  );
});

describe("CodexAdapterV2 fork boundary", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread-codex-fork-boundary");
  const makeProviderThread = (now: DateTime.Utc): OrchestrationV2ProviderThread => ({
    id: providerThreadId,
    driver: CodexAdapterV2.CODEX_DRIVER_KIND,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: ProviderSessionId.make("provider-session-codex-fork-boundary"),
    appThreadId: ThreadId.make("thread-codex-fork-boundary"),
    ownerNodeId: null,
    nativeThreadRef: {
      driver: CodexAdapterV2.CODEX_DRIVER_KIND,
      nativeId: "native-thread-codex-fork-boundary",
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 2,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  });
  const makeProviderTurn = (
    id: string,
    ordinal: number,
    nativeId: string | null,
    now: DateTime.Utc,
  ): OrchestrationV2ProviderTurn => ({
    id: ProviderTurnId.make(id),
    providerThreadId,
    nodeId: NodeId.make(`node-${id}`),
    runAttemptId: RunAttemptId.make(`run-attempt-${id}`),
    nativeTurnRef:
      nativeId === null
        ? { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId: null, strength: "none" }
        : { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId, strength: "strong" },
    ordinal,
    status: "completed",
    startedAt: now,
    completedAt: now,
  });

  it.effect("resolves the selected provider turn to an inclusive native fork boundary", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const firstTurn = makeProviderTurn("provider-turn-first", 1, "native-turn-first", now);
      const secondTurn = makeProviderTurn("provider-turn-second", 2, "native-turn-second", now);

      const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
        sourceProviderThread: makeProviderThread(now),
        sourceProviderTurns: [firstTurn, secondTurn],
        providerTurnId: firstTurn.id,
        targetThreadId: ThreadId.make("thread-codex-fork-target"),
      });

      assert.deepEqual(boundary, {
        lastTurnId: "native-turn-first",
        rollbackTurnCount: 0,
      });
    }),
  );

  it.effect("resolves the latest source turn to a native fork boundary without rollback", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const firstTurn = makeProviderTurn("provider-turn-first", 1, "native-turn-first", now);
      const secondTurn = makeProviderTurn("provider-turn-second", 2, "native-turn-second", now);

      const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
        sourceProviderThread: makeProviderThread(now),
        sourceProviderTurns: [firstTurn, secondTurn],
        providerTurnId: secondTurn.id,
        targetThreadId: ThreadId.make("thread-codex-fork-target"),
      });

      assert.deepEqual(boundary, {
        lastTurnId: "native-turn-second",
        rollbackTurnCount: 0,
      });
    }),
  );

  it.effect("keeps the rollback-count fallback when the boundary turn lacks a native id", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const firstTurn = makeProviderTurn("provider-turn-first", 1, null, now);
      const secondTurn = makeProviderTurn("provider-turn-second", 2, "native-turn-second", now);

      const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
        sourceProviderThread: makeProviderThread(now),
        sourceProviderTurns: [firstTurn, secondTurn],
        providerTurnId: firstTurn.id,
        targetThreadId: ThreadId.make("thread-codex-fork-target"),
      });

      assert.deepEqual(boundary, { lastTurnId: undefined, rollbackTurnCount: 1 });
    }),
  );

  it.effect("keeps the rollback-count fallback when the boundary turn has no native ref", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const firstTurn: OrchestrationV2ProviderTurn = {
        ...makeProviderTurn("provider-turn-first", 1, "native-turn-first", now),
        nativeTurnRef: null,
      };
      const secondTurn = makeProviderTurn("provider-turn-second", 2, "native-turn-second", now);

      const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
        sourceProviderThread: makeProviderThread(now),
        sourceProviderTurns: [firstTurn, secondTurn],
        providerTurnId: firstTurn.id,
        targetThreadId: ThreadId.make("thread-codex-fork-target"),
      });

      assert.deepEqual(boundary, { lastTurnId: undefined, rollbackTurnCount: 1 });
    }),
  );

  it.effect("forks at head without a boundary when no provider turn is selected", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;

      const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
        sourceProviderThread: makeProviderThread(now),
        targetThreadId: ThreadId.make("thread-codex-fork-target"),
      });

      assert.deepEqual(boundary, { lastTurnId: undefined, rollbackTurnCount: 0 });
    }),
  );

  it.effect("fails with a typed error when the selected source turn is missing", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const firstTurn = makeProviderTurn("provider-turn-first", 1, "native-turn-first", now);

      const error = yield* Effect.flip(
        CodexAdapterV2.resolveCodexForkBoundary({
          sourceProviderThread: makeProviderThread(now),
          sourceProviderTurns: [firstTurn],
          providerTurnId: ProviderTurnId.make("provider-turn-missing"),
          targetThreadId: ThreadId.make("thread-codex-fork-target"),
        }),
      );

      assert.instanceOf(error, ProviderAdapter.ProviderAdapterForkThreadError);
      assert.include(String(error.cause), "provider-turn-missing");
    }),
  );
});

describe("CodexAdapterV2 skill mentions", () => {
  it("sends currency-sigil skill mentions as the $ mention Codex parses", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["€review do it", "$review do it"],
      ["£ship", "$ship"],
      ["please ¥review this diff", "please $review this diff"],
      ["first line\n₹ship it", "first line\n$ship it"],
      ["𑿝review then €2spec", "$review then $2spec"],
      ["$review", "$review"],
      ["costs €20", "costs €20"],
      ["€5k", "€5k"],
      ["budget €100M or €1e6", "budget €100M or €1e6"],
      ["5€review", "5€review"],
    ];
    for (const [text, expected] of cases) {
      assert.equal(CodexAdapterV2.codexSkillMentionText(text), expected, text);
    }
  });
});

describe("CodexAdapterV2 background command detail", () => {
  it("summarizes command, exit code, and output tail", () => {
    assert.equal(
      CodexAdapterV2.codexBackgroundCommandDetail({
        command: "sleep 20 && echo CODEX_BG_WAKE_DONE",
        exitCode: 0,
        aggregatedOutput: "CODEX_BG_WAKE_DONE\n",
      }),
      "Background command completed (exit 0): sleep 20 && echo CODEX_BG_WAKE_DONE\n\n" +
        "Output tail:\nCODEX_BG_WAKE_DONE",
    );
  });

  it("omits the output section and exit code when absent", () => {
    assert.equal(
      CodexAdapterV2.codexBackgroundCommandDetail({
        command: "sleep 20",
        exitCode: null,
        aggregatedOutput: null,
      }),
      "Background command completed: sleep 20",
    );
  });

  it("truncates long commands and keeps only the output tail", () => {
    const detail = CodexAdapterV2.codexBackgroundCommandDetail({
      command: "x".repeat(300),
      exitCode: 1,
      aggregatedOutput: `${"y".repeat(2000)}TAIL`,
    });
    assert.include(detail, `(exit 1): ${"x".repeat(200)}...`);
    assert.include(detail, "Output tail:\n...");
    assert.include(detail, "TAIL");
    assert.notInclude(detail, "y".repeat(1001));
  });
});

describe("Codex terminal routing", () => {
  const session = {
    environmentId: "env" as import("@t3tools/contracts").EnvironmentId,
    threadId: ThreadId.make("terminal-test"),
    providerSessionId: "mcp-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
    endpoint: "http://127.0.0.1:1/mcp",
    authorizationHeader: "Bearer test",
    browserToolsAvailable: false,
  };
  it("disables all native shell execution while the terminal MCP server is attached", () => {
    const params = CodexAdapterV2.codexThreadRuntimeParams({
      mcpSession: { ...session, terminalToolsAvailable: true },
    });
    assert.equal(params.config["features.shell_tool"], false);
    assert.deepInclude(params.config.mcp_servers, {
      cogenly: {
        url: session.endpoint,
        tool_timeout_sec: 65 * 60,
        default_tools_approval_mode: "approve",
        http_headers: { Authorization: session.authorizationHeader },
      },
    });
    assert.equal(params.config["apps._default.default_tools_approval_mode"], "approve");
    assert.isUndefined(
      CodexAdapterV2.codexThreadRuntimeParams({ mcpSession: undefined }).config[
        "features.shell_tool"
      ],
    );
  });
  it("leaves shell configuration to the provider when the server setting is off", () => {
    assert.isUndefined(
      CodexAdapterV2.codexThreadRuntimeParams({
        mcpSession: { ...session, terminalToolsAvailable: false },
      }).config["features.shell_tool"],
    );
  });
  it("keeps the native shell when the credential never stated terminal availability", () => {
    // `session` carries no `terminalToolsAvailable`: nothing guarantees the
    // Cogenly terminal tools serve this session, so the shell stays on.
    assert.isUndefined(
      CodexAdapterV2.codexThreadRuntimeParams({ mcpSession: session }).config[
        "features.shell_tool"
      ],
    );
  });
});

describe("Codex provider connector duplicates", () => {
  // As the owner's account lists them: usable ChatGPT apps, and config.toml servers.
  const duplicates = CodexAdapterV2.codexProviderDuplicates({
    apps: [
      { id: "connector_2128aebfecb84f64a069897515042a44", name: "Gmail" },
      { id: "connector_947e0d954944416db111db556030eea6", name: "Google Calendar" },
      { id: "connector_76869538009648d5b282a4bb21c3d157", name: "GitHub" },
      { id: "asdk_app_69a1d78e929881919bba0dbda1f6436d", name: "Slack" },
      { id: "asdk_app_6a5ae9736be0819199d06d61ac171080", name: "Wispr Flow" },
      { id: "connector_68de829bf7648191acd70a907364c67c", name: "Spotify" },
      { id: "asdk_app_6aa2b88dd4e881918d850abcf8b92206", name: "Spawn Partners" },
    ],
    mcpServers: {
      linear: { url: "https://mcp.linear.app/mcp" },
      "notion-sse": { url: "https://mcp.notion.com/sse" },
      "spawn-prod-followups": { url: "https://portal.spawnpartners.com/api/mcp/connect" },
      node_repl: { command: "/Applications/ChatGPT.app/node_repl" },
    },
  });

  it("finds the apps and HTTP servers the Cogenly catalog covers, and only those", () => {
    assert.deepEqual(duplicates, {
      appIds: [
        "connector_2128aebfecb84f64a069897515042a44",
        "connector_947e0d954944416db111db556030eea6",
        "connector_76869538009648d5b282a4bb21c3d157",
        "asdk_app_69a1d78e929881919bba0dbda1f6436d",
        "asdk_app_6a5ae9736be0819199d06d61ac171080",
      ],
      mcpServerNames: ["linear", "notion-sse"],
    });
  });

  it("turns the duplicates off in the thread config without touching the rest", () => {
    const { config } = CodexAdapterV2.codexThreadRuntimeParams({
      mcpSession: undefined,
      providerDuplicates: duplicates,
    });
    assert.equal(config["apps.connector_2128aebfecb84f64a069897515042a44.enabled"], false);
    assert.equal(config["apps.asdk_app_69a1d78e929881919bba0dbda1f6436d.enabled"], false);
    assert.equal(config["mcp_servers.linear.enabled"], false);
    assert.equal(config["mcp_servers.notion-sse.enabled"], false);
    assert.isUndefined(config["apps.connector_68de829bf7648191acd70a907364c67c.enabled"]);
    assert.isUndefined(config["mcp_servers.spawn-prod-followups.enabled"]);
    assert.equal(config["apps._default.default_tools_approval_mode"], "approve");
  });

  it("keeps every provider connector when the user opts in", () => {
    const { config } = CodexAdapterV2.codexThreadRuntimeParams({
      mcpSession: undefined,
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
        useProviderConnectors: true,
      },
      providerDuplicates: duplicates,
    });
    assert.deepEqual(
      Object.keys(config).filter((key) => key.endsWith(".enabled") && !key.startsWith("tools.")),
      [],
    );
  });
});

describe("Codex runtime approval transport", () => {
  it.effect(
    "answers native command, file, permission and MCP requests without pending approvals",
    () =>
      Effect.gen(function* () {
        const handlers = new Map<string, unknown>();
        yield* CodexAdapterV2.registerCodexRuntimeApprovalHandlers({
          handleServerRequest: (method, handler) =>
            Effect.sync(() => {
              handlers.set(method, handler);
            }),
        });
        const respond = (method: string, payload: unknown = {}) => {
          const handler = handlers.get(method) as (payload: unknown) => Effect.Effect<unknown>;
          assert.isFunction(handler);
          return handler(payload);
        };
        for (const method of [
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
        ]) {
          assert.deepEqual(yield* respond(method), { decision: "acceptForSession" });
        }
        for (const method of ["execCommandApproval", "applyPatchApproval"]) {
          assert.deepEqual(yield* respond(method), { decision: "approved_for_session" });
        }
        assert.deepEqual(yield* respond("item/permissions/requestApproval", { permissions: {} }), {
          permissions: {},
          scope: "session",
        });
        const result = yield* respond("mcpServer/elicitation/request", {
          serverName: "cogenly",
          mode: "form",
          message: "Allow preview_open?",
          requestedSchema: { type: "object", properties: {} },
        });
        assert.propertyVal(result, "action", "accept");
        assert.equal(handlers.size, 6);
      }),
  );
});
