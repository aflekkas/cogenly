/**
 * DEV PREVIEW ONLY. Fictional agents, items and runs for the standalone agents preview
 * page (preview/main.tsx). Never imported by the app; nothing here reaches a server.
 */
import { randomUUID } from "~/lib/utils";
import { useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import {
  AgentId,
  ScheduledTaskId,
  EnvironmentId,
  ProjectId,
  ProjectLabelId,
  ProviderInstanceId,
  ThreadId,
  conservativeAgentPermissions,
  type AgentApproval,
  type Commitment,
} from "@t3tools/contracts";
import type { AgentsClient, AgentsSnapshot } from "../agentsClient";
import type { AgentContact, AgentMessage, AgentWorkspaceView } from "../agents.types";

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
    unreadCount: 1,
    latestMessage: null,
    hasMoreMessages: false,
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
    responsibility: "",
    scope: [],
    autonomy: "propose" as const,
    permissions: conservativeAgentPermissions,
    notifyPolicy: "meaningful_changes" as const,
    paused: false,
    memory: [],
    activity: [],
    requests: [],
    approvals: [] as AgentApproval[],
    triggers: [],
  };
  const label = {
    id: ProjectLabelId.make("preview-project"),
    name: "Preview project",
    color: "blue",
    createdAt: ago(5000),
    updatedAt: ago(5000),
    repositoryIds: [ProjectId.make("preview-repo")],
  };
  const repositories = [{ id: ProjectId.make("preview-repo"), title: "preview-repo" }];
  const scope = [
    {
      labelId: label.id,
      permissions: { ...conservativeAgentPermissions, read: true, draft: true },
    },
  ];
  let commitments: Commitment[] = [
    {
      id: "preview-item-1",
      title: "Review the auth test cleanup",
      description: "Juniper's three-file cleanup, before the next release.",
      owner: { kind: "user" },
      dueAt: ago(-1440),
      reminderAt: null,
      waitingOn: null,
      labelIds: [label.id],
      agentId: AgentId.make("juniper"),
      sourceRefs: [{ kind: "message", id: "m3" }],
      evidenceRefs: [],
      status: "open",
      createdAt: ago(43),
      updatedAt: ago(43),
    },
    {
      id: "preview-item-2",
      title: "Drop the old auth helper after release",
      description: "",
      owner: { kind: "agent", agentId: AgentId.make("juniper") },
      dueAt: null,
      reminderAt: null,
      waitingOn: null,
      labelIds: [label.id],
      agentId: AgentId.make("juniper"),
      sourceRefs: [{ kind: "run", id: "preview-run-1" }],
      evidenceRefs: [],
      status: "proposed",
      createdAt: ago(42),
      updatedAt: ago(42),
    },
  ];
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
    id: AgentId.make("juniper"),
    name: "Juniper",
    avatar: { seed: "juniper-forest", color: "#90b79c" },
    conversationThreadId: ThreadId.make("preview-juniper"),
    state: "blocked",
    responsibility: "Keep the test suite healthy and tell me what needs a decision.",
    scope,
    approvals: [
      {
        id: "preview-approval-1",
        agentId: AgentId.make("juniper"),
        actionKind: "start_work",
        action: {
          actionKind: "start_work",
          payload: {
            agentId: AgentId.make("juniper"),
            projectId: ProjectId.make("preview-repo"),
            title: "Replace the old auth helper in three tests",
            prompt: "Swap the helper, run only the auth suite, and summarize.",
          },
        },
        payload: {},
        status: "pending",
        requestedAt: ago(3),
        decidedAt: null,
        decidedBy: null,
        sourceRunId: null,
        resultThreadId: null,
      },
    ],
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
        agentId: AgentId.make("juniper"),
        text: "Keep changes small enough to review over coffee.",
        source: "conversation",
        createdAt: ago(2000),
        updatedAt: ago(4),
      },
      {
        id: "note-2",
        agentId: AgentId.make("juniper"),
        text: "Ask before adding a dependency. Prefer what’s already in the project.",
        source: "conversation",
        createdAt: ago(5),
        updatedAt: ago(5),
      },
    ],
    activity: [
      {
        id: "run1",
        agentId: AgentId.make("juniper"),
        triggerId: ScheduledTaskId.make("nightly"),
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
        id: AgentId.make("atlas"),
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
        id: AgentId.make("milo"),
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
        id: AgentId.make("echo"),
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
  const workspaceFor = (agent: AgentContact): Omit<AgentWorkspaceView, "refresh"> => ({
    commitments: commitments.filter(
      (item) =>
        item.agentId === agent.id ||
        item.labelIds.some((id) => agent.scope.some((entry) => entry.labelId === id)),
    ),
    activity: {
      runs:
        agent.id === "juniper"
          ? [
              {
                id: "preview-run-1",
                agentId: agent.id,
                threadId: ThreadId.make("preview-work"),
                triggerKind: "trigger",
                status: "completed",
                startedAt: ago(50),
                finishedAt: ago(46),
                modelSelection: agent.modelSelection,
                summary: "All checks passed. Found three tests using the old auth helper.",
              },
            ]
          : [],
      actions:
        agent.id === "juniper"
          ? [
              {
                id: "preview-action-1",
                agentId: agent.id,
                runId: "preview-run-1",
                kind: "commitment_proposed",
                targetId: "preview-item-2",
                at: ago(46),
              },
            ]
          : [],
    },
    labels: [label],
    repositories,
    loading: false,
    error: null,
  });
  const setCommitment = (id: string, edit: (item: Commitment) => Commitment) => {
    commitments = commitments.map((item) => (item.id === id ? edit(item) : item));
    snapshot = { ...snapshot };
    emit();
  };
  // Mirrors the server: omitted policy fields keep their current value.
  const policy = (
    draft: Parameters<AgentsClient["save"]>[1],
    current: Pick<
      AgentContact,
      "responsibility" | "scope" | "autonomy" | "permissions" | "notifyPolicy"
    >,
  ) => ({
    responsibility: draft.responsibility ?? current.responsibility,
    scope: draft.scope ?? current.scope,
    autonomy: draft.autonomy ?? current.autonomy,
    permissions: draft.permissions ?? current.permissions,
    notifyPolicy: draft.notifyPolicy ?? current.notifyPolicy,
    paused: draft.paused ?? !draft.enabled,
  });
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  const update = (id: string, edit: (agent: AgentContact) => AgentContact) => {
    snapshot = {
      ...snapshot,
      agents: snapshot.agents.map((agent) => (agent.id === id ? edit(agent) : agent)),
    };
    emit();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  function MockWorkspace({
    agent,
    children,
  }: {
    agent: AgentContact;
    children: (view: AgentWorkspaceView) => ReactNode;
  }) {
    useSyncExternalStore(subscribe, () => snapshot);
    return children({ ...workspaceFor(agent), refresh: () => {} });
  }
  // The preview has no audit log; it shows the one entry every item starts with.
  function MockCommitmentHistory({
    commitment,
    children,
  }: ComponentProps<AgentsClient["CommitmentHistory"]>) {
    useSyncExternalStore(subscribe, () => snapshot);
    const item = commitments.find((candidate) => candidate.id === commitment.id);
    return children({
      history: item
        ? [
            {
              id: `${item.id}:created`,
              commitmentId: item.id,
              fromStatus: null,
              toStatus: "proposed",
              who: item.agentId ? `agent:${item.agentId}` : "user",
              at: item.createdAt,
              why: "Found in the conversation.",
              evidenceRefs: item.sourceRefs,
            },
          ]
        : [],
      error: null,
    });
  }
  return {
    subscribe,
    getSnapshot: () => snapshot,
    save: async (envId, draft, firstTrigger) => {
      if (draft.id) {
        update(draft.id, (agent) => ({
          ...agent,
          ...draft,
          ...policy(draft, agent),
          id: agent.id,
          state: draft.enabled ? (agent.enabled ? agent.state : "idle") : "asleep",
          updatedAt: ago(0),
        }));
        return snapshot.agents.find((agent) => agent.id === draft.id)!;
      }
      const id = AgentId.make(randomUUID());
      const agent: AgentContact = {
        ...base,
        ...draft,
        ...policy(draft, base),
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
    markRead: async (agent) => {
      update(agent.id, (current) => ({ ...current, unreadCount: 0 }));
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
        memory: note.id
          ? current.memory.map((item) =>
              item.id === note.id ? { ...item, text: note.text, updatedAt: ago(0) } : item,
            )
          : [
              ...current.memory,
              {
                id: randomUUID(),
                agentId: agent.id,
                text: note.text,
                source: "owner",
                createdAt: ago(0),
                updatedAt: ago(0),
              },
            ],
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
    runTrigger: async (agent) => update(agent.id, (current) => ({ ...current, state: "thinking" })),
    setTriggerEnabled: async (agent, id, enabled) =>
      update(agent.id, (current) => ({
        ...current,
        triggers: current.triggers.map((item) => (item.id === id ? { ...item, enabled } : item)),
      })),
    deleteTrigger: async (agent, id) =>
      update(agent.id, (current) => ({
        ...current,
        triggers: current.triggers.filter((item) => item.id !== id),
      })),
    openWork: (_agent, threadId) => {
      window.dispatchEvent(new CustomEvent("agents-preview-work", { detail: threadId }));
    },
    openExternal: (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    Workspace: MockWorkspace,
    CommitmentHistory: MockCommitmentHistory,
    decideApproval: async (agent, id, decision) => {
      const approval = agent.approvals.find((item) => item.id === id)!;
      update(agent.id, (current) => ({
        ...current,
        approvals: current.approvals.filter((item) => item.id !== id),
      }));
      return {
        ...approval,
        status: decision === "approve" ? "approved" : "rejected",
        decidedAt: ago(0),
        decidedBy: "user",
      };
    },
    startWork: async () => ({ threadId: ThreadId.make("preview-work"), approval: null }),
    createCommitment: async (_agent, input) => {
      commitments = [
        ...commitments,
        { ...input, id: randomUUID(), status: "open", createdAt: ago(0), updatedAt: ago(0) },
      ];
      snapshot = { ...snapshot };
      emit();
    },
    setCommitmentStatus: async (_agent, input) =>
      setCommitment(input.id, (item) => ({
        ...item,
        status: input.status,
        evidenceRefs: [...item.evidenceRefs, ...input.evidenceRefs],
        updatedAt: ago(0),
      })),
    confirmCommitment: async (_agent, id) =>
      setCommitment(id, (item) => ({ ...item, status: "open", updatedAt: ago(0) })),
    dismissCommitment: async (_agent, id) =>
      setCommitment(id, (item) => ({ ...item, status: "dismissed", updatedAt: ago(0) })),
  };
}
