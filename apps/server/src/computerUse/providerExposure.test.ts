import { ProviderInstanceId } from "@cogenly/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";

// Both providers reach the same `computer_*` tools through the Cogenly MCP
// server; what differs per adapter is how the prompt learns they exist.

const claudePrompt = (input: { computerUsePlatform?: string; conversationMode?: boolean }) => {
  const options = ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
      model: "claude-sonnet-4-6",
    },
    nativeThreadId: "computer-use-thread",
    resume: false,
    cwd: "/workspace",
    mcpServers: { cogenly: { type: "http", url: "http://127.0.0.1:1/mcp" } },
    ...input,
  });
  const prompt = options.systemPrompt;
  return typeof prompt === "object" && prompt !== null && "append" in prompt
    ? String(prompt.append)
    : "";
};

const codexTools = (computerUsePlatform: string | undefined, conversationMode = false) =>
  CodexAdapterV2.buildCodexTurnStartParams({
    nativeThreadId: "computer-use-thread",
    codexInput: [{ type: "text", text: "change a setting in Dia" }],
    runtimePolicy: {
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: null,
      ...(conversationMode ? { conversationMode } : {}),
    },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    hasT3Mcp: true,
    ...(computerUsePlatform === undefined ? {} : { computerUsePlatform }),
  }).pipe(
    Effect.map((params) =>
      Object.entries(params.additionalContext ?? {})
        .filter(([key]) => key.startsWith("cogenly_tools"))
        .map(([, entry]) => entry.value)
        .join(""),
    ),
  );

describe("computer use per provider", () => {
  it("tells Claude about the tools on a Mac, chats included", () => {
    assert.include(claudePrompt({ computerUsePlatform: "darwin" }), "computer_ui");
    assert.include(
      claudePrompt({ computerUsePlatform: "darwin", conversationMode: true }),
      "computer_press",
    );
    assert.notInclude(claudePrompt({}), "computer_");
  });

  it("tells Claude on a Linux server not to try", () => {
    const prompt = claudePrompt({ computerUsePlatform: "linux" });
    assert.include(prompt, "unavailable here");
    assert.notInclude(prompt, "computer_press");
  });

  it.effect("tells Codex about the tools on a Mac, chats included", () =>
    Effect.gen(function* () {
      assert.include(yield* codexTools("darwin"), "computer_ui");
      assert.include(yield* codexTools("darwin", true), "computer_press");
      assert.notInclude(yield* codexTools(undefined), "computer_");
      assert.include(yield* codexTools("linux"), "unavailable here");
    }),
  );
});
