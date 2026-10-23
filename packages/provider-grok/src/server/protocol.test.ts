import { describe, expect, it } from "vite-plus/test";

import {
  applyGrokToolPatch,
  grokApprovalOptions,
  grokPermissionOutcome,
  grokToolPresentation,
  isGrokUsageLimitError,
  parseGrokAccount,
  parseGrokModelState,
  parseGrokPermissionRequest,
  parseGrokPromptUsage,
  parseGrokSessionResult,
  parseGrokSessionUpdate,
  parseGrokStopReason,
  type GrokToolCall,
} from "./protocol.ts";

describe("parseGrokSessionUpdate", () => {
  it("reads message and thought chunks", () => {
    expect(
      parseGrokSessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello" },
      }),
    ).toEqual({ type: "agent_message_chunk", text: "Hello" });
    expect(
      parseGrokSessionUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Thinking" },
      }),
    ).toEqual({ type: "agent_thought_chunk", text: "Thinking" });
  });

  it("reads a tool call with its diff and a later update", () => {
    const started = parseGrokSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "Edit src/a.ts",
      kind: "edit",
      status: "pending",
      content: [{ type: "diff", path: "/repo/src/a.ts", oldText: "a", newText: "b" }],
      locations: [{ path: "/repo/src/a.ts" }],
    });
    expect(started?.type).toBe("tool_call");
    const tool = (started as { toolCall: GrokToolCall }).toolCall;
    expect(tool).toMatchObject({
      toolCallId: "call_1",
      kind: "edit",
      status: "pending",
      diffs: [{ path: "/repo/src/a.ts", oldText: "a", newText: "b" }],
      locations: ["/repo/src/a.ts"],
    });
    const update = parseGrokSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
    });
    expect(update?.type).toBe("tool_call_update");
    const merged = applyGrokToolPatch(tool, (update as { patch: Partial<GrokToolCall> }).patch);
    expect(merged.status).toBe("completed");
    expect(merged.diffs).toHaveLength(1);
  });

  it("reads a plan and context usage, and ignores unknown updates", () => {
    expect(
      parseGrokSessionUpdate({
        sessionUpdate: "plan",
        entries: [
          { content: "Read the code", priority: "high", status: "completed" },
          { content: "  ", status: "pending" },
          { content: "Fix it", status: "in_progress" },
        ],
      }),
    ).toEqual({
      type: "plan",
      entries: [
        { content: "Read the code", status: "completed" },
        { content: "Fix it", status: "in_progress" },
      ],
    });
    expect(
      parseGrokSessionUpdate({ sessionUpdate: "usage_update", used: 1200, size: 256000 }),
    ).toEqual({ type: "usage_update", used: 1200, size: 256000 });
    expect(parseGrokSessionUpdate({ sessionUpdate: "available_commands_update" })).toBeUndefined();
    expect(parseGrokSessionUpdate(null)).toBeUndefined();
  });
});

describe("grokToolPresentation", () => {
  const tool = (patch: Partial<GrokToolCall>): GrokToolCall => ({
    toolCallId: "t",
    title: "Tool",
    kind: undefined,
    status: "completed",
    rawInput: undefined,
    rawOutput: undefined,
    text: [],
    diffs: [],
    locations: [],
    ...patch,
  });

  it("shows shell commands as command rows", () => {
    expect(
      grokToolPresentation(
        tool({ kind: "execute", rawInput: { command: "ls -la" }, text: ["a\nb"] }),
      ),
    ).toMatchObject({
      type: "command_execution",
      input: "ls -la",
      output: "a\nb",
      status: "completed",
    });
  });

  it("shows edits with a diff as file changes", () => {
    expect(
      grokToolPresentation(
        tool({ kind: "edit", diffs: [{ path: "/a.ts", oldText: null, newText: "x" }] }),
      ),
    ).toMatchObject({ type: "file_change", fileName: "/a.ts", newStr: "x" });
  });

  it("keeps a running tool running and other kinds as generic tools", () => {
    expect(grokToolPresentation(tool({ kind: "read", status: "in_progress" }))).toMatchObject({
      type: "dynamic_tool",
      status: "running",
    });
    expect(grokToolPresentation(tool({ status: "failed" })).status).toBe("failed");
  });
});

describe("permissions", () => {
  const request = parseGrokPermissionRequest({
    sessionId: "s1",
    toolCall: {
      toolCallId: "call_2",
      title: "Run ls",
      kind: "execute",
      rawInput: { command: "ls" },
    },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
      { optionId: "odd", name: "Odd", kind: "something_else" },
    ],
  })!;

  it("keeps only the option kinds ACP defines", () => {
    expect(request.options.map((option) => option.optionId)).toEqual(["allow", "always", "reject"]);
    expect(request.kind).toBe("execute");
  });

  it("maps Cogenly decisions onto native options", () => {
    expect(grokPermissionOutcome(request, "accept")).toEqual({
      outcome: "selected",
      optionId: "allow",
    });
    expect(grokPermissionOutcome(request, "acceptAlways")).toEqual({
      outcome: "selected",
      optionId: "always",
    });
    expect(grokPermissionOutcome(request, "decline")).toEqual({
      outcome: "selected",
      optionId: "reject",
    });
    expect(grokPermissionOutcome(request, "cancel")).toEqual({ outcome: "cancelled" });
    expect(grokApprovalOptions(request).map((option) => option.decision)).toEqual([
      "accept",
      "acceptAlways",
      "decline",
    ]);
  });

  it("has no answer for a decision Grok did not offer", () => {
    expect(grokPermissionOutcome({ options: [] }, "accept")).toBeUndefined();
  });
});

describe("prompt results", () => {
  it("reads camelCase and snake_case usage", () => {
    expect(
      parseGrokPromptUsage({ usage: { inputTokens: 10, outputTokens: 5, thoughtTokens: 2 } }),
    ).toMatchObject({ inputTokens: 10, outputTokens: 5, reasoningTokens: 2, cachedInputTokens: 0 });
    expect(
      parseGrokPromptUsage({
        _meta: {
          usage: {
            input_tokens: 13625,
            cache_read_input_tokens: 1536,
            output_tokens: 54,
            reasoning_tokens: 36,
          },
        },
      }),
    ).toMatchObject({
      inputTokens: 13625,
      cachedInputTokens: 1536,
      outputTokens: 54,
      reasoningTokens: 36,
    });
    expect(parseGrokPromptUsage({ stopReason: "end_turn" })).toBeUndefined();
  });

  it("reads stop reasons and session model lists", () => {
    expect(parseGrokStopReason({ stopReason: "cancelled" })).toBe("cancelled");
    expect(parseGrokStopReason({ stopReason: "weird" })).toBeUndefined();
    expect(
      parseGrokSessionResult({
        sessionId: "s1",
        models: {
          currentModelId: "grok-4.7",
          availableModels: [{ modelId: "grok-4.7", name: "Grok 4.7" }, { modelId: "" }],
        },
      }),
    ).toEqual({
      sessionId: "s1",
      currentModelId: "grok-4.7",
      models: [{ modelId: "grok-4.7", name: "Grok 4.7", contextTokens: undefined, efforts: [] }],
      reasoningEffort: undefined,
    });
  });

  it("prefers configOptions for the session's model and reasoning tier (1.0.67)", () => {
    const result = parseGrokSessionResult({
      sessionId: "s2",
      models: { currentModelId: "grok-4.7", availableModels: [] },
      configOptions: [
        { id: "model", type: "select", currentValue: "grok-4.7-fast", options: [] },
        {
          id: "reasoning_effort",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [{ value: "xhigh" }, { value: "high" }, { value: "medium" }, { value: "low" }],
        },
      ],
    });
    expect(result).toMatchObject({
      sessionId: "s2",
      currentModelId: "grok-4.7-fast",
      reasoningEffort: "high",
    });
  });

  it("recognises Grok's typed limit errors", () => {
    expect(isGrokUsageLimitError("usage_pool_exhausted")).toBe(true);
    expect(isGrokUsageLimitError("failed", { code: "rate_limited" })).toBe(true);
    expect(isGrokUsageLimitError("network down")).toBe(false);
  });
});

describe("initialize and authenticate", () => {
  it("reads the model state from initialize's _meta (1.0.67)", () => {
    expect(
      parseGrokModelState({
        currentModelId: "grok-4.7",
        availableModels: [
          {
            modelId: "grok-4.7",
            name: "Grok 4.7",
            description: "xAI's flagship",
            _meta: {
              totalContextTokens: 256000,
              supportsReasoningEffort: true,
              reasoningEffort: "high",
              reasoningEfforts: [
                {
                  id: "xhigh",
                  value: "xhigh",
                  label: "Extra High",
                  description: "Most",
                  default: false,
                },
                { id: "high", value: "high", label: "High", default: true },
              ],
              contextWindows: [256000, 500000],
            },
          },
        ],
      }),
    ).toEqual({
      currentModelId: "grok-4.7",
      models: [
        {
          modelId: "grok-4.7",
          name: "Grok 4.7",
          contextTokens: 256000,
          efforts: [
            { value: "xhigh", label: "Extra High", description: "Most", isDefault: false },
            { value: "high", label: "High", description: undefined, isDefault: true },
          ],
        },
      ],
    });
  });

  it("reads the signed-in account from authenticate's _meta", () => {
    expect(
      parseGrokAccount({
        _meta: { email: "dev@example.com", auth_mode: "oauth", subscription_tier: "Free" },
      }),
    ).toEqual({ email: "dev@example.com", subscriptionTier: "Free" });
    expect(parseGrokAccount({})).toEqual({ email: undefined, subscriptionTier: undefined });
  });

  it("recognises Grok's typed limit errors", () => {
    expect(isGrokUsageLimitError("usage_pool_exhausted")).toBe(true);
    expect(isGrokUsageLimitError("failed", { code: "rate_limited" })).toBe(true);
    expect(isGrokUsageLimitError("network down")).toBe(false);
  });
});
