import { randomUUID } from "~/lib/utils";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { AgentsClient, AgentsSnapshot } from "../agentsClient";
import type { AgentContact, AgentMessage } from "../agents.types";

const environmentId = EnvironmentId.make("agents-preview");
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const message = (
  id: string,
  role: AgentMessage["role"],
  text: string,
  minutes: number,
): AgentMessage => ({ id, role, text, createdAt: ago(minutes) });
export function createMockAgentsClient(): AgentsClient {
  const models = [
    {
      label: "Claude · Sonnet",
      selection: { instanceId: ProviderInstanceId.make("claude-code"), model: "claude-sonnet-4-6" },
    },
    {
      label: "Codex · GPT-5.4",
      selection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    },
  ];
  const base = {
    environmentId,
    instructions:
      "Keep an eye on my projects. Be thoughtful, concise, and direct. Send me the highlights, and ask before making big changes.",
    modelSelection: models[0]!.selection,
    runtimeMode: "approval-required" as const,
    projectId: null,
    enabled: true,
    dailyRunCap: 24,
    createdAt: ago(2800),
    updatedAt: ago(2),
    consecutiveFailures: 0,
    backoffUntil: null,
    pauseReason: null,
    memory: [],
    activity: [],
    requests: [],
    triggers: [],
  };
  const messages: AgentMessage[] = [
    {
      ...message(
        "m1",
        "assistant",
        "Morning. I had a look around while you were away — the nightly audit came back clean. One small thing caught my eye, though.",
        46,
      ),
      source: { name: "Nightly audit", threadId: ThreadId.make("preview-work") },
    },
    message("m2", "user", "morning! what did you find?", 44),
    message(
      "m3",
      "assistant",
      "A few tests still use the old auth helper. Nothing’s broken, but it’ll be easier to change them now than after the next release.",
      43,
    ),
    message("m4", "assistant", "I can put together a small cleanup for you.", 43),
    message("m5", "user", "yes please. keep it small, i want to review it over coffee", 6),
    { ...message("m6", "user", "and remember: no new dependencies", 5), delivery: "read" },
    message(
      "m7",
      "assistant",
      "Coffee-sized. Got it ☕\n\nHere’s the plan:\n- Replace the old helper in three tests\n- Run just the auth suite\n- Leave you a short summary\n\nAnd I’ll remember the dependency rule.",
      4,
    ),
  ];
  const juniper: AgentContact = {
    ...base,
    id: "juniper",
    name: "Juniper",
    avatar: { seed: "juniper-forest", color: "#90b79c" },
    conversationThreadId: ThreadId.make("preview-juniper"),
    state: "blocked",
    preview: "Coffee-sized. Got it ☕",
    messages,
    triggers: [
      {
        id: "nightly",
        title: "Nightly audit",
        prompt: "Check tests and dependencies. Send a short summary here.",
        enabled: true,
        schedule: { type: "fixed_time", timeOfDay: "07:00" },
      },
    ],
    memory: [
      {
        id: "note-1",
        agentId: "juniper",
        text: "Keep changes small enough to review over coffee.",
        source: "conversation",
        createdAt: ago(2000),
        updatedAt: ago(4),
      },
      {
        id: "note-2",
        agentId: "juniper",
        text: "Ask before adding a dependency. Prefer what’s already in the project.",
        source: "conversation",
        createdAt: ago(5),
        updatedAt: ago(5),
      },
    ],
    activity: [
      {
        id: "run1",
        agentId: "juniper",
        triggerId: "nightly",
        workThreadId: ThreadId.make("preview-work"),
        status: "completed",
        createdAt: ago(50),
        completedAt: ago(46),
        summary: "All checks passed. Found three tests using the old auth helper.",
        posted: true,
      },
    ],
    requests: [
      {
        id: "approve-1",
        kind: "approval",
        text: "The cleanup is ready. May I update the three test files?",
        createdAt: ago(2),
        canRespond: true,
      },
    ],
  };
  let snapshot: AgentsSnapshot = {
    agents: [
      juniper,
      {
        ...base,
        id: "atlas",
        name: "Atlas",
        avatar: { seed: "atlas", color: "#c4a4df" },
        conversationThreadId: ThreadId.make("preview-atlas"),
        state: "thinking",
        updatedAt: ago(70),
        preview: "Your weekly notes are ready whenever you are.",
        messages: [
          message("atlas-1", "assistant", "Your weekly notes are ready whenever you are.", 70),
        ],
      },
      {
        ...base,
        id: "milo",
        name: "Milo",
        avatar: { seed: "milo", color: "#e3b484" },
        conversationThreadId: ThreadId.make("preview-milo"),
        state: "blocked",
        updatedAt: ago(120),
        preview: "Which project should I focus on this week?",
        messages: [
          message("milo-1", "assistant", "Which project should I focus on this week?", 120),
        ],
        requests: [
          {
            id: "question-1",
            kind: "question",
            text: "A little direction?",
            createdAt: ago(120),
            canRespond: true,
            questions: [
              {
                id: "project",
                text: "Which project should I focus on?",
                allowCustomAnswer: true,
                options: [{ label: "Cogenly" }, { label: "Website" }],
              },
            ],
          },
        ],
      },
      {
        ...base,
        id: "echo",
        name: "Echo",
        avatar: { seed: "echo", color: "#7da9c9" },
        enabled: false,
        state: "asleep",
        updatedAt: ago(1500),
        conversationThreadId: ThreadId.make("preview-echo"),
        preview: "Taking a break. Just say the word.",
        messages: [message("echo-1", "assistant", "Taking a break. Just say the word.", 1500)],
      },
    ],
    models,
    loading: false,
    error: null,
  };
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  const update = (id: string, edit: (agent: AgentContact) => AgentContact) => {
    snapshot = {
      ...snapshot,
      agents: snapshot.agents.map((agent) => (agent.id === id ? edit(agent) : agent)),
    };
    emit();
  };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    save: async (envId, draft, firstTrigger) => {
      if (draft.id) {
        update(draft.id, (agent) => ({
          ...agent,
          ...draft,
          state: draft.enabled ? (agent.enabled ? agent.state : "idle") : "asleep",
          updatedAt: ago(0),
        }));
        return snapshot.agents.find((agent) => agent.id === draft.id)!;
      }
      const id = randomUUID();
      const agent: AgentContact = {
        ...base,
        ...draft,
        id,
        environmentId: envId,
        avatar: draft.avatar,
        conversationThreadId: ThreadId.make(`preview-${id}`),
        state: "idle",
        preview: "Say hello",
        messages: [],
        triggers: firstTrigger ? [{ ...firstTrigger, id: randomUUID() }] : [],
      };
      snapshot = { ...snapshot, agents: [...snapshot.agents, agent] };
      emit();
      return agent;
    },
    remove: async (agent) => {
      snapshot = { ...snapshot, agents: snapshot.agents.filter((item) => item.id !== agent.id) };
      emit();
    },
    send: async (agent, text) =>
      update(agent.id, (current) => ({
        ...current,
        state: current.enabled ? "thinking" : "asleep",
        updatedAt: ago(0),
        preview: text,
        messages: [
          ...current.messages,
          {
            id: randomUUID(),
            role: "user",
            text,
            createdAt: ago(0),
            delivery: current.state === "thinking" ? "queued" : "delivered",
          },
        ],
      })),
    respond: async (agent, id, response) =>
      update(agent.id, (current) => ({
        ...current,
        state: "idle",
        requests: current.requests.filter((request) => request.id !== id),
        updatedAt: ago(0),
        messages: [
          ...current.messages,
          message(
            randomUUID(),
            "assistant",
            response === "decline"
              ? "All good. I’ll leave the files as they are."
              : "Got it. I’ll take it from here and send you the highlights.",
            0,
          ),
        ],
      })),
    saveMemory: async (agent, note) =>
      update(agent.id, (current) => ({
        ...current,
        memory: current.memory.map((item) =>
          item.id === note.id ? { ...item, text: note.text, updatedAt: ago(0) } : item,
        ),
      })),
    deleteMemory: async (agent, id) =>
      update(agent.id, (current) => ({
        ...current,
        memory: current.memory.filter((item) => item.id !== id),
      })),
    saveTrigger: async (agent, trigger) =>
      update(agent.id, (current) => ({
        ...current,
        triggers: trigger.id
          ? current.triggers.map((item) =>
              item.id === trigger.id ? { ...trigger, id: trigger.id! } : item,
            )
          : [...current.triggers, { ...trigger, id: randomUUID() }],
      })),
    deleteTrigger: async (agent, id) =>
      update(agent.id, (current) => ({
        ...current,
        triggers: current.triggers.filter((item) => item.id !== id),
      })),
    openWork: (_agent, threadId) => {
      window.dispatchEvent(new CustomEvent("agents-preview-work", { detail: threadId }));
    },
  };
}
