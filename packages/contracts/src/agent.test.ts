import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { Agent, defaultAgentPermissions } from "./agent.ts";
import { AgentActivityResult } from "./agentWorkspace.ts";

const agent032 = {
  id: "agent-1",
  name: "Juniper",
  avatar: { seed: "juniper" },
  instructions: "",
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  fallbackChain: [],
  runtimeMode: "full-access",
  projectId: "project-1",
  dailyRunCap: 10,
  responsibility: "Watch CI",
  permissions: defaultAgentPermissions,
  notifyPolicy: "meaningful_changes",
  conversationThreadId: "agent-conversation:agent-1",
  projectFolderId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  consecutiveFailures: 0,
  backoffUntil: null,
};

describe("agents across versions", () => {
  it("reads a 0.3.2 agent without core memory as empty memory", () => {
    expect(Schema.decodeUnknownSync(Agent)(agent032).coreMemory).toBe("");
  });

  it("lets a 0.3.2 reader decode an agent that carries core memory", () => {
    const { coreMemory: _coreMemory, ...legacyFields } = Agent.fields;
    const wire = Schema.encodeSync(Agent)(
      Schema.decodeUnknownSync(Agent)({ ...agent032, coreMemory: "Prefers short replies." }),
    );
    expect(wire.coreMemory).toBe("Prefers short replies.");
    expect(Schema.decodeUnknownSync(Schema.Struct(legacyFields))(wire).name).toBe("Juniper");
  });

  it("reads activity from a 0.3.2 server, which sends no handoff briefs", () => {
    const activity = Schema.decodeUnknownSync(AgentActivityResult)({ runs: [], actions: [] });
    expect(activity.handoffBriefs).toBeUndefined();
  });
});
