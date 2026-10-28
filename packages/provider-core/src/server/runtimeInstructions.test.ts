import { describe, expect, it } from "vite-plus/test";
import {
  HOW_COGENLY_WORKS_INSTRUCTIONS,
  buildIntegrationsContextLine,
  buildProjectManifest,
  buildRuntimeInstructions,
  conversationModeInstructions,
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

  it("tells every harness about the vault", () => {
    for (const harness of ["Claude Code", "Codex", "Muse Code"]) {
      const instructions = buildRuntimeInstructions({ harness });
      expect(instructions).toContain("<vault>");
      expect(instructions).toContain("vault_save");
      expect(instructions).toContain("vault_fill");
      expect(instructions).toContain(
        "Never ask for usernames, passwords, codes or other secrets in chat",
      );
      expect(instructions).toContain("request_login");
      expect(instructions).toContain("saveToVault");
    }
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

describe("buildProjectManifest", () => {
  it("names the project, its directory, and up to thirty resources", () => {
    const resources = Array.from({ length: 35 }, (_, i) => `Resources/file-${i}.md`);
    const manifest = buildProjectManifest({
      name: "Spawn Partners",
      directory: "/home/user/projects/Spawn Partners",
      resources,
      total: 35,
    });
    expect(manifest).toContain("<project_manifest>");
    expect(manifest).toContain('"Spawn Partners" at /home/user/projects/Spawn Partners');
    expect(manifest).toContain("- Resources/file-0.md");
    expect(manifest).toContain("- Resources/file-29.md");
    expect(manifest).not.toContain("file-30.md");
    expect(manifest).toContain("+5 more");
    expect(manifest).toContain("project_recall");
    expect(manifest).toContain("project_file_read");
  });

  it("tells agents to add repositories with the project clone tool, not git clone", () => {
    const manifest = buildProjectManifest({
      name: "Spawn Partners",
      directory: "/projects/Spawn Partners",
      resources: [],
      total: 0,
    });
    expect(manifest).toContain("project_label_clone_repository");
    expect(manifest).toContain("do not git clone by hand");
  });

  it("says when the project has no files yet", () => {
    const manifest = buildProjectManifest({
      name: "Empty",
      directory: "/projects/Empty",
      resources: [],
      total: 0,
    });
    expect(manifest).toContain("(no project files yet)");
    expect(manifest).not.toContain("+");
  });
});

describe("integrations context line", () => {
  it("names only working accounts as connected and labels sign-in and error states", () => {
    const line = buildIntegrationsContextLine([
      { name: "working", displayName: "Linear", status: "connected" },
      { name: "sign-in", displayName: "Google", status: "needs_sign_in" },
      { name: "broken", displayName: "Notion", status: "error" },
      { name: "off", displayName: "Slack", status: "disabled" },
    ]);
    expect(line).toContain("Connected integrations: working (Linear).");
    expect(line).toContain("sign-in (Google): needs sign-in");
    expect(line).toContain("broken (Notion): error");
    expect(line).toContain("off (Slack): disabled");
  });

  it("says provider connectors are off only when there is a line to add it to", () => {
    const connected = [{ name: "linear", displayName: "Linear", status: "connected" as const }];
    expect(buildIntegrationsContextLine(connected, ["notion"], true)).toBe(
      "Connected integrations: linear (Linear). Use integration_tools / integration_call. Also available to connect: notion. When the user asks for one of these, do not just say it isn't connected: offer to connect it, read integration_setup_guide, then start the connect flow with integration_add (its catalogId) and let the inline card handle sign-in. Find the fastest path: reuse existing local and shared setup, do browser, CLI and API steps yourself, and ask only for sign-ins, approvals and owner-only choices. Never paste long manual instructions first. Complete setup across every paired environment. Use Cogenly integrations. The provider's own MCP servers, connectors, plugins and apps are off; only MCP servers checked into the repository still load.",
    );
    expect(buildIntegrationsContextLine(connected, ["notion"])).not.toContain("turned off");
    expect(buildIntegrationsContextLine([], [], true)).toBe("");
  });

  it("names connected integrations with hints and stays empty when none", () => {
    expect(buildIntegrationsContextLine([])).toBe("");
    expect(
      buildIntegrationsContextLine([
        {
          name: "gmail",
          displayName: "Gmail",
          status: "connected",
          hint: "Gmail, aflekkas@example.com",
        },
        { name: "linear", displayName: "Linear", status: "connected" },
      ]),
    ).toBe(
      "Connected integrations: gmail (Gmail, aflekkas@example.com), linear (Linear). Use integration_tools / integration_call.",
    );
  });

  it("names the account of each connection so agents can pick one", () => {
    expect(
      buildIntegrationsContextLine([
        {
          name: "linear-spawn",
          displayName: "Linear",
          status: "connected",
          accountLabel: "Spawn Partners",
        },
        {
          name: "linear-personal",
          status: "connected",
          displayName: "Linear",
          accountLabel: "personal",
          hint: "side projects",
        },
      ]),
    ).toBe(
      "Connected integrations: linear-spawn (Linear · Spawn Partners), linear-personal (Linear · personal, side projects). Use integration_tools / integration_call.",
    );
  });

  it("names what is still available to connect on the same line", () => {
    expect(
      buildIntegrationsContextLine([], ["google-workspace (Gmail, Calendar, Drive)", "slack"]),
    ).toBe(
      "Integrations available to connect: google-workspace (Gmail, Calendar, Drive), slack. When the user asks for one of these, do not just say it isn't connected: offer to connect it, read integration_setup_guide, then start the connect flow with integration_add (its catalogId) and let the inline card handle sign-in. Find the fastest path: reuse existing local and shared setup, do browser, CLI and API steps yourself, and ask only for sign-ins, approvals and owner-only choices. Never paste long manual instructions first. Complete setup across every paired environment.",
    );
    const line = buildIntegrationsContextLine(
      [{ name: "linear", displayName: "Linear", status: "connected" }],
      ["notion"],
    );
    expect(line).toBe(
      "Connected integrations: linear (Linear). Use integration_tools / integration_call. Also available to connect: notion. When the user asks for one of these, do not just say it isn't connected: offer to connect it, read integration_setup_guide, then start the connect flow with integration_add (its catalogId) and let the inline card handle sign-in. Find the fastest path: reuse existing local and shared setup, do browser, CLI and API steps yourself, and ask only for sign-ins, approvals and owner-only choices. Never paste long manual instructions first. Complete setup across every paired environment.",
    );
    expect(line).not.toContain("\n");
  });

  it("adds exactly one line to the project manifest", () => {
    const base = { name: "P", directory: "/projects/P", resources: [], total: 0 };
    const withIntegrations = buildProjectManifest({
      ...base,
      integrations: [{ name: "gmail", displayName: "Gmail", status: "connected", hint: "" }],
    });
    expect(withIntegrations).toContain("Connected integrations: gmail (Gmail).");
    expect(buildProjectManifest(base)).not.toContain("Connected integrations:");
  });
});

describe("conversationModeInstructions", () => {
  it("gives builders setup instructions without terminal or task handoffs", () => {
    const text = conversationModeInstructions({ terminal: true, builder: true });
    expect(text).toContain("<builder_mode>");
    expect(text).toContain("propose_agent");
    expect(text).not.toContain("terminal_run");
    expect(text).not.toContain("work_task");
  });

  const withTerminal = conversationModeInstructions({ terminal: true });
  const withoutTerminal = conversationModeInstructions({ terminal: false });

  it.each([withTerminal, withoutTerminal])(
    "biases visual answers toward inline pictures from real sources",
    (text) => {
      expect(text).toContain("asks for pictures");
      expect(text).toContain("1-4 relevant images near the relevant text");
      expect(text).toContain("![alt](url)");
      expect(text).toContain("image_search");
      expect(text).toContain("never invent URLs");
      expect(text.startsWith("<conversation_mode>")).toBe(true);
      expect(text.endsWith("</conversation_mode>")).toBe(true);
    },
  );

  it.each([withTerminal, withoutTerminal])(
    "hands changes to a task instead of the user",
    (text) => {
      expect(text).toContain("work_task");
      expect(text).toContain("do not tell the user to do it by hand");
      expect(text).toContain('mode "propose"');
      expect(text).toContain("A subagent is different");
      expect(text).toContain("settleWhenDone=true");
    },
  );

  it("runs lookups in the chat when the terminal tools are attached", () => {
    expect(withTerminal).toContain("Look things up yourself with the cogenly terminal_run tool");
    expect(withTerminal).toContain("never hand a question to a task just to run commands");
    expect(withTerminal).toContain("long-running work such as builds and test suites");
    expect(withTerminal).not.toContain("you cannot run commands");
    expect(withTerminal).toContain("sandbox blocks local file writes");
    expect(withTerminal).toContain("must not run commands that change remote state");
  });

  it("says commands are unavailable without the terminal tools", () => {
    expect(withoutTerminal).toContain("you cannot run commands");
    expect(withoutTerminal).toContain("commands are unavailable on this machine");
    expect(withoutTerminal).not.toContain("terminal_run");
  });

  it("adds the project's instructions and leaves them out when blank", () => {
    const base = { name: "P", directory: "/projects/P", resources: [], total: 0 };
    expect(buildProjectManifest({ ...base, instructions: "Ship small PRs." })).toContain(
      "<project_instructions>The user set these instructions for every thread in this project; follow them:\nShip small PRs.",
    );
    expect(buildProjectManifest({ ...base, instructions: "   " })).not.toContain(
      "<project_instructions>",
    );
    expect(buildProjectManifest(base)).not.toContain("<project_chat>");
    expect(buildProjectManifest({ ...base, projectChat: true })).toContain("<project_chat>");
  });
});
