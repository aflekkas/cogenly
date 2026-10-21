import { describe, expect, it } from "vite-plus/test";
import {
  CONVERSATION_MODE_INSTRUCTIONS,
  HOW_COGENLY_WORKS_INSTRUCTIONS,
  buildRuntimeInstructions,
} from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("requires explicit registration of every PR and stack layer", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When the cogenly MCP server exposes link_pull_request");
    expect(instructions).toContain("with the full PR URL immediately after creating a PR");
    expect(instructions).toContain("For a stack, call it for every layer");
    expect(instructions).toContain("call list_thread_pull_requests and link any PR");
  });

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it("names the model by display name and slug when they differ", () => {
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "gpt-5.4", modelName: "GPT-5.4" }),
    ).toContain("through the Codex harness, as GPT-5.4 (model slug: gpt-5.4).");
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "my-model", modelName: "my-model" }),
    ).toContain("through the Codex harness, as my-model.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });
});

describe("HOW_COGENLY_WORKS_INSTRUCTIONS", () => {
  it("explains chats, Work, agents, projects, and filing", () => {
    expect(HOW_COGENLY_WORKS_INSTRUCTIONS).toContain("<how_cogenly_works>");
    expect(HOW_COGENLY_WORKS_INSTRUCTIONS).toContain("Chats are conversations");
    expect(HOW_COGENLY_WORKS_INSTRUCTIONS).toContain("Work sessions change code");
    expect(HOW_COGENLY_WORKS_INSTRUCTIONS).toContain("persistent assistants");
    expect(HOW_COGENLY_WORKS_INSTRUCTIONS).toContain("<projectsRoot>/<Project>/");
    expect(HOW_COGENLY_WORKS_INSTRUCTIONS).toContain("moving a chat into a project forks it");
    expect(HOW_COGENLY_WORKS_INSTRUCTIONS).toContain("cogenly MCP tools");
    expect(HOW_COGENLY_WORKS_INSTRUCTIONS).toContain("Confirm first before bulk or destructive");
  });

  it("stays between 120 and 200 words", () => {
    const words = HOW_COGENLY_WORKS_INSTRUCTIONS.replaceAll(/<[^>]+>/g, "")
      .split(/\s+/)
      .filter(Boolean);
    expect(words.length).toBeGreaterThanOrEqual(120);
    expect(words.length).toBeLessThanOrEqual(200);
  });

  it("is included in the runtime instructions for every harness", () => {
    for (const harness of ["Claude Code", "Codex", "Muse Code"]) {
      expect(buildRuntimeInstructions({ harness })).toContain("<how_cogenly_works>");
    }
  });
});

describe("CONVERSATION_MODE_INSTRUCTIONS", () => {
  it("biases visual answers toward inline pictures from real sources", () => {
    expect(CONVERSATION_MODE_INSTRUCTIONS).toContain("asks for pictures");
    expect(CONVERSATION_MODE_INSTRUCTIONS).toContain("1-4 relevant images inline");
    expect(CONVERSATION_MODE_INSTRUCTIONS).toContain("![alt](url)");
    expect(CONVERSATION_MODE_INSTRUCTIONS).toContain("image_search");
    expect(CONVERSATION_MODE_INSTRUCTIONS).toContain("never invent URLs");
  });
});
