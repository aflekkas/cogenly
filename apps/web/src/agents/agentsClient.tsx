import {
  createContext,
  useContext,
  useSyncExternalStore,
  useCallback,
  useRef,
  type ComponentType,
} from "react";
import type {
  AgentApproval,
  Commitment,
  CommitmentCreateInput,
  CommitmentStatusInput,
  EnvironmentId,
  ProjectId,
  ProviderApprovalDecision,
  ThreadId,
} from "@t3tools/contracts";
import type {
  AgentContact,
  AgentMessage,
  AgentDraft,
  AgentMemory,
  AgentModelControlsProps,
  AgentModelOption,
  AgentModelRef,
  AgentTrigger,
  AgentWorkspaceView,
  CommitmentHistoryView,
} from "./agents.types";
import {
  agentContactKey,
  mergeLatestMessage,
  sortAgentContacts,
  messageDelivery,
  reconcileAgentMessages,
  resolveAgentModelStatus,
  type AgentModelStatus,
} from "./agents.logic";

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
  /** Settings → Projects, where projects are created and linked to repositories. */
  openProjectSettings?: () => void;
  /** Opens an http(s) link from an open item's evidence outside the app. */
  openExternal: (url: string) => void;
  /** Renders its children with the agent's open items, audited activity, and projects. */
  Workspace: ComponentType<{
    agent: AgentContact;
    children: (view: AgentWorkspaceView) => ReactNode;
  }>;
  /** Renders its children with one open item's history; mount it only when shown. */
  CommitmentHistory: ComponentType<{
    agent: AgentContact;
    commitment: Pick<Commitment, "id" | "updatedAt">;
    children: (view: CommitmentHistoryView) => ReactNode;
  }>;
  decideApproval: (
    agent: AgentContact,
    id: string,
    decision: "approve" | "reject",
  ) => Promise<AgentApproval>;
  /** Owner-started Work as this agent. The server may still return an approval instead. */
  startWork: (
    agent: AgentContact,
    input: { projectId: ProjectId; title: string; prompt: string; commandId: string },
  ) => Promise<{ threadId: ThreadId | null; approval: AgentApproval | null }>;
  createCommitment: (agent: AgentContact, input: CommitmentCreateInput) => Promise<void>;
  setCommitmentStatus: (agent: AgentContact, input: CommitmentStatusInput) => Promise<void>;
  confirmCommitment: (agent: AgentContact, id: string, why: string) => Promise<void>;
  dismissCommitment: (agent: AgentContact, id: string, why: string) => Promise<void>;
  /** Whether a model can run on the agent's environment; absent where there is no catalog. */
  modelStatus?: (agent: AgentContact, model: AgentModelRef) => AgentModelStatus;
  /** Model and effort pickers from the live provider catalog; absent where there is none. */
  ModelControls?: ComponentType<AgentModelControlsProps>;
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
const NO_AGENTS: AgentsSnapshot = { agents: [], models: [], loading: false, error: null };
const subscribeToNothing = () => () => {};
const readNoAgents = () => NO_AGENTS;
/** Agents for surfaces that also render outside the provider, such as the welcome wizard's palette. */
export function useAgentsIfProvided(): ReadonlyArray<AgentContact> {
  const client = useContext(ClientContext);
  const snapshot = useSyncExternalStore(
    client?.subscribe ?? subscribeToNothing,
    client?.getSnapshot ?? readNoAgents,
  );
  return useMemo(() => sortAgentContacts(snapshot.agents), [snapshot.agents]);
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
import { RegistryContext, useAtomValue } from "@effect/atom-react";
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
import { agentWorkspaceRpc, agentsRpc } from "~/rpc/agents";
import { readLocalApi } from "~/localApi";
import { useEnvironmentProjectLabels } from "~/projectLabels/useProjectLabels";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { usePrimaryEnvironmentId, useConnectedEnvironmentIds } from "~/state/environments";
import { useProjects, useServerConfigs, useThreadShells } from "~/state/entities";
import { useEnvironmentThread, threadEnvironment } from "~/state/threads";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerVisible,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { ComposerControlSeparator } from "~/components/chat/ComposerControl";
import { TraitsPicker } from "~/components/chat/TraitsPicker";
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
            return {
              environmentId,
              result: get(agentsRpc.list({ environmentId, input: {} })),
              approvals: get(
                agentWorkspaceRpc.agentsApprovalsList({
                  environmentId,
                  input: { status: "pending" },
                }),
              ),
            };
          }),
      ),
    [idsKey],
  );
  const results = useAtomValue(queryAtom);
  const [hydrated, setHydrated] = useState<ReadonlyMap<string, AgentConversationData>>(new Map());
  const [outbox, setOutbox] = useState<ReadonlyMap<string, ReadonlyArray<AgentMessage>>>(new Map());
  const hydrate = useCallback((key: string, content: AgentConversationData) => {
    setHydrated((current) =>
      current.get(key) === content ? current : new Map(current).set(key, content),
    );
    setOutbox((current) => {
      const pending = current.get(key);
      if (!pending) return current;
      const remaining = pending.filter(
        (message) => !content.messages.some((item) => item.id === message.id),
      );
      if (remaining.length === pending.length) return current;
      const next = new Map(current);
      if (remaining.length) next.set(key, remaining);
      else next.delete(key);
      return next;
    });
  }, []);
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
  const registry = useContext(RegistryContext);
  const approve = useOrchestrationCommand(agentWorkspaceRpc.agentsApprove, {
    reportFailure: false,
  });
  const reject = useOrchestrationCommand(agentWorkspaceRpc.agentsReject, { reportFailure: false });
  const startWork = useOrchestrationCommand(agentWorkspaceRpc.agentsStartWork, {
    reportFailure: false,
  });
  const createCommitment = useOrchestrationCommand(agentWorkspaceRpc.commitmentsCreate, {
    reportFailure: false,
  });
  const updateCommitment = useOrchestrationCommand(agentWorkspaceRpc.commitmentsUpdateStatus, {
    reportFailure: false,
  });
  const confirmCommitment = useOrchestrationCommand(agentWorkspaceRpc.commitmentsConfirm, {
    reportFailure: false,
  });
  const dismissCommitment = useOrchestrationCommand(agentWorkspaceRpc.commitmentsDismiss, {
    reportFailure: false,
  });
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
              provider.availability !== "unavailable" &&
              provider.status === "ready",
          )
          .flatMap((provider) =>
            provider.models
              .filter((model) => !model.isLegacy)
              .map((model) => ({
                environmentId,
                label: `${provider.displayName ?? provider.driver} · ${model.name}`,
                name: model.name,
                selection: { instanceId: provider.instanceId, model: model.slug },
              })),
          ),
      ),
    [configs],
  );
  const agents = useMemo(
    () =>
      results.flatMap(({ environmentId, result, approvals: approvalsResult }) => {
        const records = Option.getOrNull(AsyncResult.value(result))?.agents ?? [];
        const pendingApprovals =
          Option.getOrNull(AsyncResult.value(approvalsResult))?.approvals ?? [];
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
          const approvals = pendingApprovals.filter(
            (approval) => approval.agentId === record.id && approval.status === "pending",
          );
          const waitingInRun = Boolean(
            shell?.hasPendingApprovals ||
            shell?.hasPendingUserInput ||
            workThreads.some((thread) => thread.hasPendingApprovals || thread.hasPendingUserInput),
          );
          const state =
            approvals.length || waitingInRun || cached?.requests.length
              ? "blocked"
              : shell?.runtime?.activeRunId ||
                  workThreads.some((thread) => thread.runtime?.activeRunId)
                ? "thinking"
                : record.enabled
                  ? "idle"
                  : "asleep";
          return {
            ...record,
            environmentId,
            state,
            updatedAt: shell?.updatedAt ?? record.updatedAt,
            preview: latest?.text ?? "Say hello",
            messages: reconcileAgentMessages(
              mergeLatestMessage(
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
              outbox.get(key) ?? [],
            ),
            triggers,
            memory: cached?.memory ?? [],
            activity: cached?.activity ?? [],
            requests: cached?.requests ?? [],
            approvals,
            waitingInRun,
          };
        });
      }),
    [results, tasks, threads, hydrated, outbox],
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
      // Policy changes only through the owner; a trigger saved here is the owner's decision.
      const projectId =
        agent.projectId ??
        projects.find((project) => project.environmentId === agent.environmentId)?.id;
      if (!projectId) throw new Error("Choose a repository before adding a trigger.");
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
          approvals: [],
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
        const updatePending = (delivery: NonNullable<AgentMessage["delivery"]>) =>
          setOutbox((current) => {
            const messages = current.get(key) ?? [];
            const previous = messages.find((message) => message.id === identity.messageId);
            return new Map(current).set(key, [
              ...messages.filter((message) => message.id !== identity.messageId),
              {
                id: identity.messageId,
                role: "user",
                text,
                createdAt: previous?.createdAt ?? new Date().toISOString(),
                optimistic: true,
                delivery,
                model: agent.modelSelection,
              },
            ]);
          });
        updatePending("sending");
        try {
          const result = commandValue(
            await sendAgent({
              environmentId: agent.environmentId,
              input: { id: agent.id, ...identity, mode: "auto" },
            }),
          );
          updatePending(result.delivery === "queued" ? "queued" : "delivered");
          pendingSends.current.delete(key);
        } catch (cause) {
          updatePending("failed");
          throw cause;
        }
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
      openProjectSettings: () => {
        void navigate({ to: "/settings/project-tags" });
      },
      openExternal: (url) => {
        void readLocalApi()?.shell.openExternal(url);
      },
      Workspace: LiveAgentWorkspace,
      CommitmentHistory: LiveCommitmentHistory,
      decideApproval: async (agent, id, decision) => {
        const command = decision === "approve" ? approve : reject;
        const { approval } = commandValue(
          await command({ environmentId: agent.environmentId, input: { id } }),
        );
        refreshWorkspace(registry, agent);
        return approval;
      },
      startWork: async (agent, input) => {
        const result = commandValue(
          await startWork({
            environmentId: agent.environmentId,
            input: { ...input, agentId: agent.id, commandId: CommandId.make(input.commandId) },
          }),
        );
        refreshWorkspace(registry, agent);
        return result;
      },
      createCommitment: async (agent, input) => {
        commandValue(await createCommitment({ environmentId: agent.environmentId, input }));
        refreshWorkspace(registry, agent);
      },
      setCommitmentStatus: async (agent, input) => {
        commandValue(await updateCommitment({ environmentId: agent.environmentId, input }));
        refreshWorkspace(registry, agent);
      },
      confirmCommitment: async (agent, id, why) => {
        commandValue(
          await confirmCommitment({ environmentId: agent.environmentId, input: { id, why } }),
        );
        refreshWorkspace(registry, agent);
      },
      dismissCommitment: async (agent, id, why) => {
        commandValue(
          await dismissCommitment({ environmentId: agent.environmentId, input: { id, why } }),
        );
        refreshWorkspace(registry, agent);
      },
      modelStatus: (agent, model) =>
        resolveAgentModelStatus(configs.get(agent.environmentId)?.providers, model),
      ModelControls: LiveAgentModelControls,
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
      configs,
      registry,
      approve,
      reject,
      startWork,
      createCommitment,
      updateCommitment,
      confirmCommitment,
      dismissCommitment,
    ],
  );
  return (
    <AgentsClientProvider value={client}>
      <AgentHydrationContext.Provider value={hydrate}>{children}</AgentHydrationContext.Provider>
    </AgentsClientProvider>
  );
}
/** Re-read what an owner decision can change, without waiting for the agents stream. */
function refreshWorkspace(
  registry: import("effect/reactivity").AtomRegistry.AtomRegistry,
  agent: AgentContact,
) {
  const environmentId = agent.environmentId;
  registry.refresh(
    agentWorkspaceRpc.agentsApprovalsList({ environmentId, input: { status: "pending" } }),
  );
  registry.refresh(
    agentWorkspaceRpc.commitmentsList({ environmentId, input: { agentId: agent.id } }),
  );
  registry.refresh(
    agentWorkspaceRpc.agentsActivity({ environmentId, input: { agentId: agent.id } }),
  );
}

const EMPTY_COMMITMENTS: AgentWorkspaceView["commitments"] = [];
function LiveAgentWorkspace({
  agent,
  children,
}: {
  agent: AgentContact;
  children: (view: AgentWorkspaceView) => ReactNode;
}) {
  return children(useLiveAgentWorkspace(agent));
}
function useLiveAgentWorkspace(agent: AgentContact): AgentWorkspaceView {
  const environmentId = agent.environmentId;
  const commitments = useEnvironmentQuery(
    agentWorkspaceRpc.commitmentsList({ environmentId, input: { agentId: agent.id } }),
  );
  const activity = useEnvironmentQuery(
    agentWorkspaceRpc.agentsActivity({ environmentId, input: { agentId: agent.id } }),
  );
  const { labels, error: labelsError } = useEnvironmentProjectLabels(environmentId);
  const projects = useProjects();
  const configs = useServerConfigs();
  const scratchRoot = configs.get(environmentId)?.scratchWorkspaceRoot;
  const repositories = useMemo(
    () =>
      projects
        .filter(
          (project) =>
            project.environmentId === environmentId &&
            !project.isScratch &&
            !isScratchProject(project, scratchRoot),
        )
        .map(({ id, title }) => ({ id, title })),
    [projects, environmentId, scratchRoot],
  );
  const refreshCommitments = commitments.refresh;
  const refreshActivity = activity.refresh;
  const refresh = useCallback(() => {
    refreshCommitments();
    refreshActivity();
  }, [refreshCommitments, refreshActivity]);
  return {
    commitments: commitments.data?.commitments ?? EMPTY_COMMITMENTS,
    activity: activity.data,
    labels,
    repositories,
    loading: commitments.data === null && commitments.error === null,
    error: commitments.error ?? activity.error ?? labelsError,
    refresh,
  };
}

function LiveCommitmentHistory({
  agent,
  commitment,
  children,
}: {
  agent: AgentContact;
  commitment: Pick<Commitment, "id" | "updatedAt">;
  children: (view: CommitmentHistoryView) => ReactNode;
}) {
  const query = useEnvironmentQuery(
    agentWorkspaceRpc.commitmentsHistory({
      environmentId: agent.environmentId,
      input: { id: commitment.id },
    }),
  );
  // Any status change, by you or the agent, moves updatedAt; read the new entry.
  const { refresh } = query;
  const seenUpdatedAt = useRef(commitment.updatedAt);
  useEffect(() => {
    if (seenUpdatedAt.current === commitment.updatedAt) return;
    seenUpdatedAt.current = commitment.updatedAt;
    refresh();
  }, [commitment.updatedAt, refresh]);
  return children({ history: query.data?.history ?? null, error: query.error });
}

type AgentConversationData = Pick<AgentContact, "messages" | "requests" | "memory" | "activity">;
const AgentHydrationContext = createContext<
  ((key: string, content: AgentConversationData) => void) | null
>(null);
export function useAgentConversation(agent: AgentContact | null): AgentContact | null {
  const state = useEnvironmentThread(
    agent?.environmentId ?? null,
    agent?.conversationThreadId ?? null,
  );
  const hydrate = useContext(AgentHydrationContext);
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
      .map((message) => {
        const run = projection.runs.find((candidate) => candidate.id === message.runId);
        return {
          id: message.id,
          role: message.role as "user" | "assistant",
          text: message.text,
          createdAt: DateTime.formatIso(message.createdAt),
          updatedAt: DateTime.formatIso(message.updatedAt),
          streaming: message.streaming,
          delivery: messageDelivery(run),
          ...(message.role === "user" && run ? { model: run.modelSelection } : {}),
          ...(message.scheduledTaskId && message.senderThreadId
            ? {
                source: {
                  name: names.get(message.scheduledTaskId) ?? "Background work",
                  threadId: message.senderThreadId,
                },
              }
            : {}),
        };
      });
    return {
      messages,
      requests,
      memory: memory.data?.notes ?? [],
      activity: activity.data?.runs ?? [],
    };
  }, [projection, workProjection, triggerNames, memory.data, activity.data]);
  const key = agent ? agentContactKey(agent) : null;
  useEffect(() => {
    if (key && content && hydrate) hydrate(key, content);
  }, [key, content, hydrate]);
  return agent && content
    ? {
        ...agent,
        ...content,
        messages: reconcileAgentMessages(
          content.messages,
          agent.messages.filter((message) => message.optimistic),
        ),
        hasMoreMessages: state.history.hasMoreHistory,
        loadingEarlierMessages: state.history.loading,
        historyError: state.history.error,
        conversationError: Option.getOrNull(state.error),
        state: content.requests.length
          ? "blocked"
          : projection?.runs.some((run) =>
                ["preparing", "starting", "running"].includes(run.status),
              ) ||
              content.activity.some((run) => run.status === "running" || run.status === "starting")
            ? "thinking"
            : agent.state,
      }
    : agent;
}

/** The chat composer's own pickers over the same live catalog, limited to Claude and Codex. */
function LiveAgentModelControls({
  agent,
  selection,
  disabled,
  unavailable,
  pickerOpen,
  onPickerOpenChange,
  onChange,
}: AgentModelControlsProps) {
  const settings = useEnvironmentSettings(agent.environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(agent.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(
          deriveProviderInstanceEntries(providers),
          settings,
          agent.projectId,
        ),
      ).filter(isProviderInstancePickerVisible),
    [providers, settings, agent.projectId],
  );
  const modelOptionsByInstance = useMemo(
    () =>
      getCustomModelOptionsByInstance(settings, providers, selection.instanceId, selection.model),
    [settings, providers, selection.instanceId, selection.model],
  );
  const entry = instanceEntries.find((candidate) => candidate.instanceId === selection.instanceId);
  return (
    <>
      <ProviderModelPicker
        environmentId={agent.environmentId}
        disabled={disabled}
        activeInstanceId={selection.instanceId}
        model={selection.model}
        lockedProvider={null}
        instanceEntries={instanceEntries}
        modelOptionsByInstance={modelOptionsByInstance}
        // Without this the picker would name the catalog's first model instead.
        {...(unavailable ? { triggerLabel: `${selection.model} · unavailable` } : {})}
        open={pickerOpen}
        onOpenChange={onPickerOpenChange}
        onInstanceModelChange={(instanceId, model) => {
          if (instanceId !== selection.instanceId || model !== selection.model)
            onChange({ instanceId, model });
        }}
      />
      {entry && !unavailable && (
        <>
          <ComposerControlSeparator />
          <TraitsPicker
            provider={entry.driverKind}
            instanceId={entry.instanceId}
            models={entry.models}
            model={selection.model}
            modelOptions={selection.options}
            prompt=""
            onPromptChange={() => {}}
            allowPromptInjectedEffort={false}
            planModeEnabled={false}
            disabled={disabled}
            onModelOptionsChange={(options) =>
              onChange({
                instanceId: selection.instanceId,
                model: selection.model,
                ...(options ? { options } : {}),
              })
            }
          />
        </>
      )}
    </>
  );
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
