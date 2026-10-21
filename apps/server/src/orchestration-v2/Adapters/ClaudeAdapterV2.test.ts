import type { AskUserQuestionInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import {
  ClaudeSettings,
  RuntimeMode,
  EnvironmentId,
  type ModelSelection,
  ProviderInstanceId,
  type ProviderApprovalDecision,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import { PreviewControlsToolkit } from "../../mcp/toolkits/previewControls/tools.ts";
import { HtmlToolkit } from "../../mcp/toolkits/html/tools.ts";
import { ImageToolkit } from "../../mcp/toolkits/images/tools.ts";
import { ProjectFilesToolkit } from "../../mcp/toolkits/projectFiles/tools.ts";
import { EnvironmentToolkit } from "../../mcp/toolkits/environment/tools.ts";
import { ProjectToolkit } from "../../mcp/toolkits/project/tools.ts";
import { WorktreeToolkit } from "../../mcp/toolkits/worktree/tools.ts";
import { TerminalToolkit } from "../../mcp/toolkits/terminal/tools.ts";
import { ThreadToolkit } from "../../mcp/toolkits/thread/tools.ts";
import { OrchestratorToolkit } from "../../mcp/toolkits/orchestrator/tools.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";

const decodeRuntimeMode = Schema.decodeUnknownSync(RuntimeMode);

const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});

const AUTO_COMPACT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({
  autoCompactWindow: "300000",
});

const CLAUDE_TEST_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
  options: [{ id: "effort", value: "ultrathink" }],
} satisfies ModelSelection;

describe("ClaudeAdapterV2 runtime query policy", () => {
  it.each([false, true])("requests thinking summaries with resume=%s", (resume) => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      nativeThreadId: "thinking-thread",
      resume,
      cwd: "/workspace",
    });
    assert.deepEqual(options.thinking, { type: "adaptive", display: "summarized" });
    assert.equal(options.extraArgs?.["thinking-display"], "summarized");
    assert.include(options.settings, { showThinkingSummaries: true });
  });

  it("preserves an explicit omitted thinking display", () => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      nativeThreadId: "thinking-thread",
      resume: false,
      cwd: "/workspace",
      settings: { ...DEFAULT_CLAUDE_SETTINGS, launchArgs: "--thinking-display omitted" },
    });
    assert.isUndefined(options.thinking);
    assert.equal(options.extraArgs?.["thinking-display"], "omitted");
    assert.notInclude(options.settings ?? {}, { showThinkingSummaries: true });
  });

  it("does not enable thinking when the model option disables it", () => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: {
        ...CLAUDE_TEST_MODEL_SELECTION,
        model: "claude-haiku-4-5",
        options: [{ id: "thinking", value: false }],
      },
      nativeThreadId: "thinking-thread",
      resume: false,
      cwd: "/workspace",
    });
    assert.isUndefined(options.thinking);
    assert.isUndefined(options.extraArgs?.["thinking-display"]);
    assert.include(options.settings, { alwaysThinkingEnabled: false });
  });

  it.each([
    ["--permission-mode acceptEdits", "bypassPermissions"],
    ["--dangerously-skip-permissions", "bypassPermissions"],
    ["--dangerously-skip-permissions --permission-mode plan", "bypassPermissions"],
  ])("folds %s into the SDK permission mode", (launchArgs, expected) => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      nativeThreadId: "native-permission-override",
      resume: false,
      cwd: "/workspace",
      permissionMode: "default",
      settings: { ...AUTO_COMPACT_CLAUDE_SETTINGS, launchArgs },
    });
    assert.equal(options.permissionMode, expected);
    assert.isUndefined(options.extraArgs?.["permission-mode"]);
    assert.isUndefined(options.extraArgs?.["dangerously-skip-permissions"]);
  });

  it("passes automatic compaction and resume-dialog controls to the SDK", () => {
    const onUserDialog = async () => ({
      behavior: "completed" as const,
      result: "continue" as const,
    });
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      nativeThreadId: "native-thread-auto-compact",
      resume: true,
      cwd: "/workspace",
      settings: AUTO_COMPACT_CLAUDE_SETTINGS,
      onUserDialog,
      supportedDialogKinds: ["resume_return"],
    });

    assert.equal((options.settings as { autoCompactWindow?: number }).autoCompactWindow, 300_000);
    assert.equal(options.onUserDialog, onUserDialog);
    assert.deepEqual(options.supportedDialogKinds, ["resume_return"]);
  });

  it("projects AskUserQuestion input with question text as the answer key", () => {
    assert.deepEqual(
      ClaudeAdapterV2.claudeUserInputQuestions({
        questions: [
          {
            header: "Approach",
            question: "Which approach?",
            options: [{ label: "Simple", description: "Use fewer moving parts" }],
            multiSelect: true,
          },
        ],
      }),
      [
        {
          id: "Which approach?",
          header: "Approach",
          question: "Which approach?",
          options: [{ label: "Simple", description: "Use fewer moving parts" }],
          multiSelect: true,
        },
      ],
    );
    const sdkAnswers: NonNullable<AskUserQuestionInput["answers"]> =
      ClaudeAdapterV2.claudeSdkUserInputAnswers({
        "Which approach?": ["Simple", "Safe"],
        "Deploy now?": "Yes",
      });
    assert.deepEqual(sdkAnswers, {
      "Which approach?": "Simple, Safe",
      "Deploy now?": "Yes",
    });
    assert.isTrue(
      ClaudeAdapterV2.ClaudeProviderCapabilitiesV2.planning.supportsStructuredQuestions,
    );
  });

  it("normalizes Claude todo and proposed-plan tool input", () => {
    assert.deepEqual(
      ClaudeAdapterV2.claudeTodoSteps({
        todos: [
          { content: "Inspect", status: "completed" },
          { content: "Implement", status: "in_progress" },
        ],
      }),
      [
        { id: "todo-0", text: "Inspect", status: "completed" },
        { id: "todo-1", text: "Implement", status: "running" },
      ],
    );
    assert.equal(
      ClaudeAdapterV2.claudeProposedPlan({ plan: "  # Plan\nShip it  " }),
      "# Plan\nShip it",
    );
    assert.isTrue(ClaudeAdapterV2.ClaudeProviderCapabilitiesV2.planning.emitsTodoList);
    assert.isTrue(ClaudeAdapterV2.ClaudeProviderCapabilitiesV2.planning.emitsProposedPlan);
  });

  it.each(["approval-required", "auto-accept-edits", "auto", "full-access"] as const)(
    "bypasses permissions and disables approval callbacks for legacy mode %s",
    (runtimeMode) => {
      for (const interactionMode of ["default", "plan"] as const) {
        const policy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy({
          runtimeMode: decodeRuntimeMode(runtimeMode),
          interactionMode,
          cwd: "/workspace",
          approvalPolicy: "on-request",
          sandboxPolicy: { type: "readOnly" },
        });
        assert.deepEqual(policy, {
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          installPermissionCallback: false,
          conversationMode: false,
        });
      }
    },
  );

  it.each([
    [undefined, false],
    [false, false],
    [true, true],
  ] as const)("maps conversationMode %s to %s", (conversationMode, expected) => {
    const policy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
        ...(conversationMode === undefined ? {} : { conversationMode }),
      }),
    );
    assert.equal(policy.conversationMode, expected);
  });

  it("keys live-query reuse on conversation mode", () => {
    const forMode = (conversationMode?: boolean) =>
      ClaudeAdapterV2.claudeEffectiveQueryPolicyKey(
        ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
          ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
            ...(conversationMode === undefined ? {} : { conversationMode }),
          }),
        ),
        {},
      );
    assert.notEqual(forMode(true), forMode(undefined));
    assert.equal(forMode(false), forMode(undefined));
  });

  it.each([undefined, false])(
    "omits the conversation instructions for work mode %s",
    (conversationMode) => {
      const options = ClaudeAdapterV2.makeClaudeQueryOptions({
        modelSelection: CLAUDE_TEST_MODEL_SELECTION,
        nativeThreadId: "work-thread",
        resume: false,
        cwd: "/workspace",
        ...(conversationMode === undefined ? {} : { conversationMode }),
      });
      const append =
        typeof options.systemPrompt === "object" && "append" in options.systemPrompt
          ? String(options.systemPrompt.append ?? "")
          : "";
      assert.notInclude(append, "<conversation_mode>");
      assert.notInclude(append, "image_search");
      assert.include(append, "<how_cogenly_works>");
    },
  );

  it("appends conversation instructions and drops the terminal routing for chat mode", () => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      nativeThreadId: "chat-thread",
      resume: false,
      cwd: "/workspace",
      conversationMode: true,
      disallowedTools: [...ClaudeAdapterV2.CLAUDE_CONVERSATION_DISALLOWED_TOOLS],
    });
    const append =
      typeof options.systemPrompt === "object" && "append" in options.systemPrompt
        ? String(options.systemPrompt.append ?? "")
        : "";
    assert.include(append, "<conversation_mode>");
    assert.include(append, "Start Work");
    assert.include(append, "image_search");
    assert.include(append, "<how_cogenly_works>");
    assert.notInclude(append, "terminal_run");
  });
});

describe("ClaudeAdapterV2 MCP query overrides", () => {
  const T3_MCP_SERVERS = {
    cogenly: {
      type: "http",
      url: "http://127.0.0.1:43123/mcp",
      headers: {
        Authorization: "Bearer secret-claude-token",
      },
      timeout: ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_TIMEOUT_MS,
    },
  } as const;

  const mcpSessionFor = (
    threadId: ThreadId,
    authorizationHeader = "Bearer secret-claude-token",
  ): McpProviderSession.McpProviderSessionConfig => ({
    environmentId: EnvironmentId.make(`environment-${threadId}`),
    threadId,
    providerSessionId: `mcp-session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader,
    browserToolsAvailable: true,
  });

  it("leaves an absent allowlist absent when no MCP session exists", () => {
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession: undefined,
      readOnlySandbox: false,
    });

    assert.deepEqual(overrides, {});
  });

  it("preserves an explicit allowlist when no MCP session exists", () => {
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession: undefined,
      readOnlySandbox: false,
      allowedTools: ["Read"],
    });

    assert.deepEqual(overrides, { allowedTools: ["Read"] });
  });

  it("pre-approves all t3-code tools when attaching an MCP session without an allowlist", () => {
    const threadId = ThreadId.make("thread-claude-mcp-no-allowlist");
    const mcpSession = mcpSessionFor(threadId);
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession,
      readOnlySandbox: false,
    });

    assert.deepEqual(overrides, {
      allowedTools: [ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_WILDCARD],
      mcpServers: T3_MCP_SERVERS,
      disallowedTools: ["Bash", "BashOutput", "KillShell", "TaskOutput", "TaskStop"],
    });
  });

  it("extends an explicit allowlist with the t3-code wildcard", () => {
    const threadId = ThreadId.make("thread-claude-mcp-with-allowlist");
    const mcpSession = mcpSessionFor(threadId);
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession,
      readOnlySandbox: false,
      allowedTools: ["Read", "mcp__cogenly__*"],
    });

    assert.deepEqual(overrides, {
      allowedTools: ["Read", "mcp__cogenly__*"],
      mcpServers: T3_MCP_SERVERS,
      disallowedTools: ["Bash", "BashOutput", "KillShell", "TaskOutput", "TaskStop"],
    });
  });

  it("pre-approves only read-only t3-code tools in a read-only sandbox", () => {
    const threadId = ThreadId.make("thread-claude-mcp-read-only");
    const mcpSession = mcpSessionFor(threadId);
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession,
      readOnlySandbox: true,
      allowedTools: [...ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS],
    });

    assert.deepEqual(overrides, {
      allowedTools: [
        ...ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS,
        ...ClaudeAdapterV2.CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS,
      ],
      mcpServers: T3_MCP_SERVERS,
      disallowedTools: ["Bash", "BashOutput", "KillShell", "TaskOutput", "TaskStop"],
    });
    assert.isFalse(overrides.allowedTools?.includes(ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_WILDCARD));
  });

  it("pre-approves only read-only t3-code tools in a read-only sandbox without an allowlist", () => {
    const threadId = ThreadId.make("thread-claude-mcp-read-only-no-allowlist");
    const mcpSession = mcpSessionFor(threadId);
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession,
      readOnlySandbox: true,
    });

    assert.deepEqual(overrides.allowedTools, [
      ...ClaudeAdapterV2.CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS,
    ]);
  });

  it("adds the handoff draft, memory reads, and project organizers to conversation-mode tools", () => {
    const threadId = ThreadId.make("thread-claude-mcp-conversation");
    const mcpSession = mcpSessionFor(threadId);
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession,
      readOnlySandbox: true,
      conversationMode: true,
    });

    assert.deepEqual(overrides.allowedTools, [
      ...ClaudeAdapterV2.CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS,
      "mcp__cogenly__work_propose_handoff",
      "mcp__cogenly__memory_read",
      "mcp__cogenly__fact_search",
      "mcp__cogenly__t3_project_label_list",
      "mcp__cogenly__t3_project_label_read",
      "mcp__cogenly__t3_project_label_create",
      "mcp__cogenly__t3_project_label_update",
      "mcp__cogenly__t3_project_label_delete",
      "mcp__cogenly__t3_project_label_link_source",
      "mcp__cogenly__t3_project_label_unlink_source",
      "mcp__cogenly__t3_project_label_link_repository",
      "mcp__cogenly__t3_project_label_unlink_repository",
      "mcp__cogenly__t3_thread_move_project_folder",
      "mcp__cogenly__list_agents",
      "mcp__cogenly__start_agent_builder",
    ]);
    assert.isFalse(overrides.allowedTools?.includes(ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_WILDCARD));
    for (const mutating of [
      "mcp__cogenly__terminal_run",
      "mcp__cogenly__terminal_write",
      "mcp__cogenly__work_start",
      "mcp__cogenly__t3_thread_launch",
      "mcp__cogenly__t3_worktree_handoff",
      "mcp__cogenly__t3_project_clone",
      "mcp__cogenly__t3_project_label_clone_repository",
    ]) {
      assert.isFalse(overrides.allowedTools?.includes(mutating), mutating);
    }
  });

  it("disallows file writes and the shell for conversation turns", () => {
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]) {
      assert.include(ClaudeAdapterV2.CLAUDE_CONVERSATION_DISALLOWED_TOOLS, tool);
    }
  });

  it("keys live-query reuse on the MCP-derived pre-approvals", () => {
    const threadId = ThreadId.make("thread-claude-mcp-query-key");
    const mcpSession = mcpSessionFor(threadId);
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
        approvalPolicy: "on-request",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      }),
    );

    const readOnlyKey = ClaudeAdapterV2.claudeEffectiveQueryPolicyKey(
      queryPolicy,
      ClaudeAdapterV2.claudeMcpQueryOverrides({ mcpSession, readOnlySandbox: true }),
    );
    const fullAccessKey = ClaudeAdapterV2.claudeEffectiveQueryPolicyKey(
      queryPolicy,
      ClaudeAdapterV2.claudeMcpQueryOverrides({ mcpSession, readOnlySandbox: false }),
    );
    const detachedKey = ClaudeAdapterV2.claudeEffectiveQueryPolicyKey(queryPolicy, {});

    assert.notEqual(readOnlyKey, fullAccessKey);
    assert.notEqual(fullAccessKey, detachedKey);
  });

  it("invalidates live-query reuse when MCP credentials rotate", () => {
    const threadId = ThreadId.make("thread-claude-mcp-credential-rotation");
    const mcpSession = mcpSessionFor(threadId);
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
      }),
    );
    const initialKey = ClaudeAdapterV2.claudeEffectiveQueryPolicyKey(
      queryPolicy,
      ClaudeAdapterV2.claudeMcpQueryOverrides({ mcpSession, readOnlySandbox: false }),
    );

    const rotatedKey = ClaudeAdapterV2.claudeEffectiveQueryPolicyKey(
      queryPolicy,
      ClaudeAdapterV2.claudeMcpQueryOverrides({
        mcpSession: mcpSessionFor(threadId, "Bearer rotated-claude-token"),
        readOnlySandbox: false,
      }),
    );
    assert.notEqual(rotatedKey, initialKey);
  });

  it("restores native shell tools when agent terminals are disabled", () => {
    const mcpSession = {
      ...mcpSessionFor(ThreadId.make("disabled")),
      terminalToolsAvailable: false,
    };
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession,
      readOnlySandbox: false,
    });
    assert.isUndefined(overrides.disallowedTools);
  });

  it("matches the read-only allowlist to the orchestrator toolkit annotations", () => {
    const readOnlyToolNames = [
      ...Object.values(OrchestratorToolkit.tools),
      ...Object.values(TerminalToolkit.tools),
      ...Object.values(ThreadToolkit.tools),
      ...Object.values(WorktreeToolkit.tools),
      ...Object.values(ProjectToolkit.tools),
      ...Object.values(EnvironmentToolkit.tools),
      ...Object.values(PreviewControlsToolkit.tools),
      ...Object.values(HtmlToolkit.tools),
      ...Object.values(ImageToolkit.tools),
      ...Object.values(ProjectFilesToolkit.tools),
    ]
      .filter((tool) => Context.get(tool.annotations, Tool.Readonly))
      .map((tool) => `mcp__cogenly__${tool.name}`)
      .sort();

    assert.deepEqual(
      [...ClaudeAdapterV2.CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS].sort(),
      readOnlyToolNames,
    );
  });
});

describe("ClaudeAdapterV2 context usage", () => {
  it("projects assistant usage against the selected context window", () => {
    const usage = ClaudeAdapterV2.claudeProviderTurnTokenUsage(
      {
        input_tokens: 42_000,
        cache_creation_input_tokens: 2_000,
        cache_read_input_tokens: 5_000,
        output_tokens: 1_000,
      },
      CLAUDE_TEST_MODEL_SELECTION,
      "2026-08-29T00:00:00.000Z",
    );

    assert.deepEqual(usage, {
      usedTokens: 50_000,
      maxTokens: 200_000,
      inputTokens: 49_000,
      cachedInputTokens: 5_000,
      outputTokens: 1_000,
      reasoningOutputTokens: 0,
      updatedAt: "2026-08-29T00:00:00.000Z",
    });
  });

  it("reports the prompt cache TTL the response wrote", () => {
    const ttlFor = (cache_creation: {
      ephemeral_1h_input_tokens: number;
      ephemeral_5m_input_tokens: number;
    }) =>
      ClaudeAdapterV2.claudeProviderTurnTokenUsage(
        { input_tokens: 1, output_tokens: 1, cache_creation },
        CLAUDE_TEST_MODEL_SELECTION,
        "2026-08-29T00:00:00.000Z",
      ).promptCacheTtlMs;

    assert.strictEqual(
      ttlFor({ ephemeral_1h_input_tokens: 2_000, ephemeral_5m_input_tokens: 300 }),
      60 * 60_000,
    );
    assert.strictEqual(
      ttlFor({ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 300 }),
      5 * 60_000,
    );
    assert.strictEqual(
      ttlFor({ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }),
      undefined,
    );
  });
});

describe("ClaudeAdapterV2 session permissions", () => {
  it("keeps explicit user refusals classified as user_reject", () => {
    const result = ClaudeAdapterV2.permissionResultFromDecision({
      toolName: "Bash",
      decision: "decline",
      toolInput: { command: "make" },
      toolUseID: "denied-build",
    });
    assert.equal(result.behavior, "deny");
    if (result.behavior !== "deny") return;
    assert.equal(result.decisionClassification, "user_reject");
    assert.equal(result.message, "User declined tool execution.");
    assert.equal(result.interrupt, undefined);
  });

  it("forces suggested permission updates to session scope", () => {
    const result = ClaudeAdapterV2.permissionResultFromDecision({
      toolName: "Bash",
      decision: "acceptForSession",
      toolInput: { command: "git status" },
      toolUseID: "tool-1",
      suggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "git status" }],
          behavior: "allow",
          destination: "localSettings",
        },
      ],
    });

    assert.equal(result.behavior, "allow");
    if (result.behavior !== "allow") {
      return;
    }
    assert.deepEqual(result.updatedPermissions, [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "git status" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
  });

  it("adds a whole-tool session rule when Claude offers no suggestion", () => {
    const result = ClaudeAdapterV2.permissionResultFromDecision({
      toolName: "mcp__t3__custom_tool",
      decision: "acceptForSession",
      toolInput: {},
      toolUseID: "tool-2",
    });

    assert.equal(result.behavior, "allow");
    if (result.behavior !== "allow") {
      return;
    }
    assert.deepEqual(result.updatedPermissions, [
      {
        type: "addRules",
        rules: [{ toolName: "mcp__t3__custom_tool" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
  });
});

describe("ClaudeAdapterV2 approval cancellation", () => {
  it.effect("observes an approval signal that was already aborted", () =>
    Effect.gen(function* () {
      const decision = yield* Deferred.make<ProviderApprovalDecision>();
      const controller = new AbortController();
      controller.abort();

      const result = yield* ClaudeAdapterV2.awaitClaudeApprovalDecision(
        decision,
        controller.signal,
      );

      assert.equal(result, "cancel");
    }),
  );

  it.effect("removes the cancellation listener after approval resolves", () =>
    Effect.gen(function* () {
      const decision = yield* Deferred.make<ProviderApprovalDecision>();
      const controller = new AbortController();
      let removes = 0;
      const removeEventListener = controller.signal.removeEventListener.bind(controller.signal);
      controller.signal.removeEventListener = (...args) => {
        removes += 1;
        return removeEventListener(...args);
      };
      const fiber = yield* Effect.forkChild(
        ClaudeAdapterV2.awaitClaudeApprovalDecision(decision, controller.signal),
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(decision, "accept");
      const result = yield* Fiber.join(fiber);

      assert.equal(result, "accept");
      assert.equal(removes, 1);
    }),
  );
});
