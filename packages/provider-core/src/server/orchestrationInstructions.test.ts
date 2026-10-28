import { assert, describe, it } from "@effect/vitest";

import {
  COGENLY_ORCHESTRATION_INSTRUCTIONS,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("paces steps by resources without capping parallel agents", () => {
    assert.include(COGENLY_ORCHESTRATION_INSTRUCTIONS, "When work can run in parallel");
    assert.include(COGENLY_ORCHESTRATION_INSTRUCTIONS, "orchestrator_capabilities.machines");
    assert.include(
      COGENLY_ORCHESTRATION_INSTRUCTIONS,
      "stagger heavy steps such as builds, test suites and browser runs on a busy machine",
    );
    assert.include(COGENLY_ORCHESTRATION_INSTRUCTIONS, "There is no fixed agent cap");
    assert.notMatch(
      COGENLY_ORCHESTRATION_INSTRUCTIONS,
      /migrate-dev-db|Chromium|including the hub/,
    );
    assert.notMatch(
      COGENLY_ORCHESTRATION_INSTRUCTIONS,
      /at most \d|one heavy job|maximum .*agents/i,
    );
  });
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(COGENLY_ORCHESTRATION_INSTRUCTIONS, "use `delegate_task`");
    assert.include(
      COGENLY_ORCHESTRATION_INSTRUCTIONS,
      "create top-level conversations only when explicitly requested",
    );
    assert.include(
      COGENLY_ORCHESTRATION_INSTRUCTIONS,
      "never for subagents or parallel delegated work",
    );
    assert.include(COGENLY_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(COGENLY_ORCHESTRATION_INSTRUCTIONS, "Each review round needs `delegate_task`");
    assert.include(COGENLY_ORCHESTRATION_INSTRUCTIONS, "never thread_send to childThreadId");
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(COGENLY_ORCHESTRATION_INSTRUCTIONS, "structured schedule, never JSON text");
    assert.include(COGENLY_ORCHESTRATION_INSTRUCTIONS, "everyMs:3600000");
    assert.include(COGENLY_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = t3OrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasT3Mcp: true,
    });

    assert.include(injected, "<cogenly_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasT3Mcp: true }),
      prompt,
    );
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasT3Mcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the T3 MCP server is attached", () => {
    assert.equal(t3OrchestrationSystemPrompt(false), undefined);
    assert.equal(t3OrchestrationSystemPrompt(true), COGENLY_ORCHESTRATION_INSTRUCTIONS);
  });
});
