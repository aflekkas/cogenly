import { createContext, useContext, useSyncExternalStore, useCallback, useRef } from "react";
import type { EnvironmentId, ProviderApprovalDecision, ThreadId } from "@t3tools/contracts";
import type {
  AgentContact,
  AgentDraft,
  AgentMemory,
  AgentModelOption,
  AgentTrigger,
} from "./agents.types";
import { agentContactKey, mergeLatestMessage, sortAgentContacts } from "./agents.logic";

export class AgentCreatedWithoutTriggerError extends Error {
  constructor(
    readonly agent: AgentContact,
    cause: unknown,
  ) {
    super(
      `Agent created, but the first trigger was not saved. ${cause instanceof Error ? cause.message : "Try saving the trigger again."}`,
    );
  }
}

export interface AgentsSnapshot {
  agents: ReadonlyArray<AgentContact>;
  models: ReadonlyArray<AgentModelOption>;
  loading: boolean;
  error: string | null;
}
export interface AgentsClient {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => AgentsSnapshot;
  save: (
    environmentId: EnvironmentId,
    draft: AgentDraft,
    firstTrigger?: Omit<AgentTrigger, "id">,
  ) => Promise<AgentContact>;
  remove: (agent: AgentContact) => Promise<void>;
  markRead: (agent: AgentContact, messageId: string) => Promise<void>;
  send: (agent: AgentContact, text: string) => Promise<void>;
  respond: (
    agent: AgentContact,
    requestId: string,
    response: ProviderApprovalDecision | Record<string, unknown>,
  ) => Promise<void>;
  saveMemory: (
    agent: AgentContact,
    note: Pick<AgentMemory, "text"> & { id?: string },
  ) => Promise<void>;
  deleteMemory: (agent: AgentContact, id: string) => Promise<void>;
  saveTrigger: (
    agent: AgentContact,
    trigger: Omit<AgentTrigger, "id"> & { id?: string },
  ) => Promise<void>;
  runTrigger: (agent: AgentContact, id: string) => Promise<void>;
  deleteTrigger: (agent: AgentContact, id: string) => Promise<void>;
  loadEarlier?: (agent: AgentContact) => Promise<void>;
  canWrite?: (environmentId: EnvironmentId) => boolean;
  openWork: (agent: AgentContact, threadId: ThreadId) => void;
}
const ClientContext = createContext<AgentsClient | null>(null);
export const AgentsClientProvider = ClientContext.Provider;
export function useAgentsClient() {
  const client = useContext(ClientContext);
  if (!client) throw new Error("AgentsClientProvider is required");
  return client;
}
export function useAgents() {
  const client = useAgentsClient();
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const agents = useMemo(() => sortAgentContacts(snapshot.agents), [snapshot.agents]);
  return { ...snapshot, agents };
}
export function useAgent(key: string | null) {
  return useAgents().agents.find((agent) => agentContactKey(agent) === key) ?? null;
}
export function useAgentMemory(key: string) {
  return useAgent(key)?.memory ?? [];
}
export function useAgentActivity(key: string) {
  return useAgent(key)?.activity ?? [];
}

export function useAgentUnread(agent: AgentContact) {
  return agent.unreadCount;
}

// All environment, thread, and RPC access for the feature stays at this boundary.
import { useAtomValue } from "@effect/atom-react";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  MessageId,
  ScheduledTaskId,
  RuntimeRequestId,
  AuthOrchestrationOperateScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { agentsRpc } from "~/rpc/agents";
import { usePrimaryEnvironmentId, useConnectedEnvironmentIds } from "~/state/environments";
import { useProjects, useServerConfigs, useThreadShells } from "~/state/entities";
import { useEnvironmentThread, threadEnvironment } from "~/state/threads";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { readEnvironmentScope } from "~/state/session";
import { useEnvironmentQuery } from "~/state/query";
import { randomUUID, newMessageId } from "~/lib/utils";
import { useAgentScheduledTasks } from "~/components/sidebar/modes/useAgentScheduledTasks";
import type { AgentRequest } from "./agents.types";

function commandValue<A>(
  result:
    | { _tag: "Success"; value: A }
    | { _tag: "Failure"; cause: import("effect/Cause").Cause<unknown> },
): A {
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    throw error instanceof Error ? error : new Error("The request failed.");
  }
  return result.value;
}

const subscribeToContext = () => () => {};

export function LiveAgentsProvider({ children }: { children: ReactNode }) {
  const environmentIds = useConnectedEnvironmentIds();
  const projects = useProjects();
  const configs = useServerConfigs();
  const threads = useThreadShells();
  const tasks = useAgentScheduledTasks(environmentIds);
  const navigate = useNavigate();
  const idsKey = environmentIds.join("\0");
  const queryAtom = useMemo(
    () =>
      Atom.make((get) =>
        idsKey
          .split("\0")
          .filter(Boolean)
          .map((id) => {
            const environmentId = id as EnvironmentId;
            return { environmentId, result: get(agentsRpc.list({ environmentId, input: {} })) };
          }),
      ),
    [idsKey],
  );
  const results = useAtomValue(queryAtom);
  const [hydrated, setHydrated] = useState<ReadonlyMap<string, AgentConversationData>>(new Map());
  const save = useOrchestrationCommand(agentsRpc.save, { reportFailure: false });
  const remove = useOrchestrationCommand(agentsRpc.remove, { reportFailure: false });
  const sendAgent = useOrchestrationCommand(agentsRpc.send, { reportFailure: false });
  const markRead = useOrchestrationCommand(agentsRpc.markRead, { reportFailure: false });
  const approval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const answer = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const saveMemory = useOrchestrationCommand(agentsRpc.saveMemory, { reportFailure: false });
  const deleteMemory = useOrchestrationCommand(agentsRpc.deleteMemory, { reportFailure: false });
  const upsertTask = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    reportFailure: false,
  });
  const runTask = useAtomCommand(serverEnvironment.runScheduledTaskNow, { reportFailure: false });
  const deleteTask = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    reportFailure: false,
  });
  const models = useMemo(
    () =>
      [...configs.entries()].flatMap(([environmentId, config]) =>
        config.providers
          .filter(
            (provider) =>
              provider.enabled &&
              (provider.driver === "claude-code" || provider.driver === "codex"),
          )
          .flatMap((provider) =>
            provider.models
              .filter((model) => !model.isLegacy)
              .map((model) => ({
                environmentId,
                label: `${provider.displayName ?? provider.driver} · ${model.name}`,
                selection: { instanceId: provider.instanceId, model: model.slug },
              })),
          ),
      ),
    [configs],
  );
  const agents = useMemo(
    () =>
      results.flatMap(({ environmentId, result }) => {
        const records = Option.getOrNull(AsyncResult.value(result))?.agents ?? [];
        return records.map((record): AgentContact => {
          const shell = threads.find(
            (thread) =>
              thread.environmentId === environmentId && thread.id === record.conversationThreadId,
          );
          const latest = record.latestMessage;
          const key = agentContactKey({ environmentId, id: record.id });
          const cached = hydrated.get(key);
          const triggers = tasks
            .filter(
              (entry) => entry.environmentId === environmentId && entry.task.agentId === record.id,
            )
            .map(({ task }) => ({
              id: task.id,
              title: task.title,
              prompt: task.prompt,
              schedule: task.schedule,
              enabled: task.enabled,
            }));
          const workThreads = threads.filter((thread) => {
            const ownership = thread.source.agent;
            return (
              thread.environmentId === environmentId &&
              ownership?.id === record.id &&
              ownership.role === "work"
            );
          });
          const state = !record.enabled
            ? "asleep"
            : shell?.hasPendingApprovals ||
                shell?.hasPendingUserInput ||
                cached?.requests.length ||
                workThreads.some(
                  (thread) => thread.hasPendingApprovals || thread.hasPendingUserInput,
                )
              ? "blocked"
              : shell?.runtime?.activeRunId ||
                  workThreads.some((thread) => thread.runtime?.activeRunId)
                ? "thinking"
                : "idle";
          return {
            ...record,
            environmentId,
            state,
            updatedAt: shell?.updatedAt ?? record.updatedAt,
            preview: latest?.text ?? "Say hello",
            messages: mergeLatestMessage(
              cached?.messages ?? [],
              latest && !cached?.messages.some((message) => message.id === latest.id)
                ? {
                    id: latest.id,
                    role: latest.role,
                    text: latest.text,
                    createdAt: latest.createdAt,
                    updatedAt: latest.updatedAt,
                  }
                : null,
            ),
            triggers,
            memory: cached?.memory ?? [],
            activity: cached?.activity ?? [],
            requests: cached?.requests ?? [],
          };
        });
      }),
    [results, tasks, threads, hydrated],
  );
  const snapshot = useMemo<AgentsSnapshot>(
    () => ({
      agents,
      models,
      loading: results.some(({ result }) => result._tag === "Initial"),
      error: agents.length
        ? null
        : results.some(({ result }) => result._tag === "Failure")
          ? "Could not load agents. Check your connection."
          : null,
    }),
    [agents, models, results],
  );

  const loadEarlier = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    reportFailure: false,
  });
  const pendingSends = useRef(
    new Map<
      string,
      { text: string; commandId: CommandId; messageId: import("@t3tools/contracts").MessageId }
    >(),
  );
  const persistTrigger = useCallback(
    async (agent: AgentContact, trigger: Omit<AgentTrigger, "id"> & { id?: string }) => {
      const projectId =
        agent.projectId ??
        projects.find((project) => project.environmentId === agent.environmentId)?.id;
      if (!projectId) throw new Error("Choose a project before adding a trigger.");
      if (!readEnvironmentScope(agent.environmentId, AuthOrchestrationOperateScope))
        throw new Error("This connection cannot change agents.");
      const { id: _triggerId, ...triggerFields } = trigger;
      const existingTask = tasks.find(
        (entry) => entry.environmentId === agent.environmentId && entry.task.id === trigger.id,
      )?.task;
      const input = {
        ...triggerFields,
        agentId: agent.id,
        ...(trigger.id ? { id: ScheduledTaskId.make(trigger.id), requireExisting: true } : {}),
        projectId,
        threadId: agent.conversationThreadId,
        modelSelection: agent.modelSelection,
        runtimeMode: agent.runtimeMode,
        interactionMode: existingTask?.interactionMode ?? ("default" as const),
        workspaceStrategy: existingTask?.workspaceStrategy ?? { type: "root" as const },
      };
      commandValue(await upsertTask({ environmentId: agent.environmentId, input }));
    },
    [projects, tasks, upsertTask],
  );
  const client = useMemo<AgentsClient>(
    () => ({
      subscribe: subscribeToContext,
      getSnapshot: () => snapshot,
      save: async (environmentId, draft, firstTrigger) => {
        const record = commandValue(await save({ environmentId, input: draft })).agent;
        const contact: AgentContact = {
          ...record,
          environmentId,
          unreadCount: 0,
          latestMessage: null,
          state: record.enabled ? "idle" : "asleep",
          preview: "Say hello",
          messages: [],
          triggers: [],
          memory: [],
          activity: [],
          requests: [],
        };
        if (firstTrigger) {
          // Creation and the optional trigger are separate writes. Keep the profile's
          // identity on failure so retrying cannot create a second agent.
          try {
            await persistTrigger(contact, firstTrigger);
          } catch (cause) {
            throw new AgentCreatedWithoutTriggerError(contact, cause);
          }
        }
        return contact;
      },
      remove: async (agent) => {
        commandValue(await remove({ environmentId: agent.environmentId, input: { id: agent.id } }));
      },
      markRead: async (agent, messageId) => {
        commandValue(
          await markRead({
            environmentId: agent.environmentId,
            input: { agentId: agent.id, lastReadMessageId: MessageId.make(messageId) },
          }),
        );
      },
      send: async (agent, text) => {
        const key = agentContactKey(agent);
        const existing = pendingSends.current.get(key);
        const identity =
          existing?.text === text
            ? existing
            : { text, commandId: CommandId.make(randomUUID()), messageId: newMessageId() };
        pendingSends.current.set(key, identity);
        commandValue(
          await sendAgent({
            environmentId: agent.environmentId,
            input: { id: agent.id, ...identity, mode: "auto" },
          }),
        );
        pendingSends.current.delete(key);
      },
      respond: async (agent, requestId, response) => {
        const request = agent.requests.find((item) => item.id === requestId);
        if (!request?.canRespond) throw new Error("This request can no longer be answered.");
        const target = {
          environmentId: agent.environmentId,
          input: {
            threadId: request.threadId ?? agent.conversationThreadId,
            requestId: RuntimeRequestId.make(requestId),
          },
        };
        if (typeof response === "string")
          commandValue(
            await approval({ ...target, input: { ...target.input, decision: response } }),
          );
        else
          commandValue(await answer({ ...target, input: { ...target.input, answers: response } }));
      },
      saveMemory: async (agent, note) => {
        commandValue(
          await saveMemory({
            environmentId: agent.environmentId,
            input: { agentId: agent.id, ...note },
          }),
        );
      },
      deleteMemory: async (agent, id) => {
        commandValue(
          await deleteMemory({
            environmentId: agent.environmentId,
            input: { agentId: agent.id, id },
          }),
        );
      },
      saveTrigger: persistTrigger,
      runTrigger: async (agent, id) => {
        commandValue(
          await runTask({
            environmentId: agent.environmentId,
            input: { id: ScheduledTaskId.make(id) },
          }),
        );
      },
      deleteTrigger: async (agent, id) => {
        if (!readEnvironmentScope(agent.environmentId, AuthOrchestrationOperateScope))
          throw new Error("This connection cannot change agents.");
        commandValue(
          await deleteTask({
            environmentId: agent.environmentId,
            input: { id: ScheduledTaskId.make(id) },
          }),
        );
      },
      loadEarlier: async (agent) => {
        commandValue(
          await loadEarlier({
            environmentId: agent.environmentId,
            input: { threadId: agent.conversationThreadId },
          }),
        );
      },
      canWrite: (environmentId) =>
        readEnvironmentScope(environmentId, AuthOrchestrationOperateScope),
      openWork: (agent, threadId) => {
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: agent.environmentId, threadId },
        });
      },
    }),
    [
      snapshot,
      save,
      remove,
      sendAgent,
      markRead,
      approval,
      answer,
      saveMemory,
      deleteMemory,
      persistTrigger,
      deleteTask,
      runTask,
      navigate,
      loadEarlier,
    ],
  );
  return (
    <AgentsClientProvider value={client}>
      <AgentHydrationContext.Provider value={setHydrated}>
        {children}
      </AgentHydrationContext.Provider>
    </AgentsClientProvider>
  );
}
type AgentConversationData = Pick<AgentContact, "messages" | "requests" | "memory" | "activity">;
const AgentHydrationContext = createContext<
  | ((
      update: (
        current: ReadonlyMap<string, AgentConversationData>,
      ) => ReadonlyMap<string, AgentConversationData>,
    ) => void)
  | null
>(null);
export function useAgentConversation(agent: AgentContact | null): AgentContact | null {
  const state = useEnvironmentThread(
    agent?.environmentId ?? null,
    agent?.conversationThreadId ?? null,
  );
  const setHydrated = useContext(AgentHydrationContext);
  const memory = useEnvironmentQuery(
    agent
      ? agentsRpc.memory({ environmentId: agent.environmentId, input: { agentId: agent.id } })
      : null,
  );
  const activity = useEnvironmentQuery(
    agent
      ? agentsRpc.activity({ environmentId: agent.environmentId, input: { id: agent.id } })
      : null,
  );
  const activeWork = activity.data?.runs.find(
    (run) => run.status === "running" || run.status === "starting",
  );
  const workState = useEnvironmentThread(
    agent?.environmentId ?? null,
    activeWork?.workThreadId ?? null,
  );
  const workProjection = Option.getOrNull(workState.data);
  const projection = Option.getOrNull(state.data);
  const triggerNames = JSON.stringify(agent?.triggers.map(({ id, title }) => [id, title]) ?? []);
  const content = useMemo<AgentConversationData | null>(() => {
    if (!projection) return null;
    const names = new Map<string, string>(JSON.parse(triggerNames));
    const projectRequests = (thread: typeof projection): AgentRequest[] => {
      const pending = derivePendingThreadRequests(thread);
      return [
        ...pending.approvals.map((request): AgentRequest => ({
          id: request.requestId,
          threadId: thread.thread.id,
          kind: "approval",
          text: request.detail || "May I go ahead?",
          createdAt: request.createdAt,
          canRespond: request.responseCapability === "live",
          ...(request.options ? { choices: request.options } : {}),
        })),
        ...pending.userInputs.map((request): AgentRequest => ({
          id: request.requestId,
          threadId: thread.thread.id,
          kind: "question",
          text: "A quick question before I continue.",
          createdAt: request.createdAt,
          canRespond: request.responseCapability !== "not_resumable",
          questions: request.questions.map((question) => ({
            id: question.id,
            text: question.question,
            options: question.options.map((option) => ({
              label: option.label,
              description: option.description,
              ...(option.value ? { value: option.value } : {}),
            })),
            required: question.required ?? true,
            ...(question.initialAnswer !== undefined
              ? { initialAnswer: question.initialAnswer }
              : {}),
            allowCustomAnswer: question.allowCustomAnswer ?? true,
            multiSelect: question.multiSelect,
          })),
        })),
      ];
    };
    const requests = [
      ...projectRequests(projection),
      ...(workProjection ? projectRequests(workProjection) : []),
    ];
    const messages = projection.messages
      .filter((message) => message.role !== "system" && message.text.trim())
      .map((message) => ({
        id: message.id,
        role: message.role as "user" | "assistant",
        text: message.text,
        createdAt: DateTime.formatIso(message.createdAt),
        updatedAt: DateTime.formatIso(message.updatedAt),
        streaming: message.streaming,
        delivery: projection.runs.some((run) => run.id === message.runId && run.status === "queued")
          ? ("queued" as const)
          : ("delivered" as const),
        ...(message.scheduledTaskId && message.senderThreadId
          ? {
              source: {
                name: names.get(message.scheduledTaskId) ?? "Background work",
                threadId: message.senderThreadId,
              },
            }
          : {}),
      }));
    return {
      messages,
      requests,
      memory: memory.data?.notes ?? [],
      activity: activity.data?.runs ?? [],
    };
  }, [projection, workProjection, triggerNames, memory.data, activity.data]);
  const key = agent ? agentContactKey(agent) : null;
  useEffect(() => {
    if (!key || !content || !setHydrated) return;
    setHydrated((current) => {
      const existing = current.get(key);
      if (existing === content) return current;
      return new Map(current).set(key, content);
    });
  }, [key, content, setHydrated]);
  return agent && content
    ? {
        ...agent,
        ...content,
        hasMoreMessages: state.history.hasMoreHistory,
        loadingEarlierMessages: state.history.loading,
        historyError: state.history.error,
        conversationError: Option.getOrNull(state.error),
        state: !agent.enabled
          ? "asleep"
          : content.requests.length
            ? "blocked"
            : content.activity.some((run) => run.status === "running" || run.status === "starting")
              ? "thinking"
              : agent.state,
      }
    : agent;
}

/** The default workspace stays on the environment where creation was invoked. */
export function useAgentCreationContext(target: EnvironmentId | null) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  return {
    primaryEnvironmentId,
    projectId: projects.find((project) => project.environmentId === target)?.id ?? null,
    workspaces: projects
      .filter((project) => project.environmentId === target)
      .map(({ id, title }) => ({ id, title })),
  };
}
