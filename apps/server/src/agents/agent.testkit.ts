import { AgentId, ThreadId, ProjectId, ProviderInstanceId, type Agent } from "@t3tools/contracts";
export const agentFixture = (suffix = "one"): Agent => ({
  id: AgentId.make(`agent:${suffix}`),
  name: "Juniper",
  avatar: { seed: suffix, color: "bleu" },
  instructions: "Be brief and remember preferences.",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "approval-required",
  projectId: ProjectId.make("project:one"),
  enabled: true,
  dailyRunCap: 2,
  conversationThreadId: ThreadId.make(`conversation:${suffix}`),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  consecutiveFailures: 0,
  backoffUntil: null,
  pauseReason: null,
});
