import { useContext, useSyncExternalStore, useCallback, useRef, type ComponentType } from "react";
import type {
  AgentApproval,
  AgentListItem,
  Commitment,
  CommitmentCreateInput,
  CommitmentStatusInput,
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProjectLabelId,
  ProviderApprovalDecision,
  ThreadId,
} from "@t3tools/contracts";
import type { ChatAttachment } from "~/types";
import type {
  AgentAttachmentSupport,
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
  agentAttachmentIdentity,
  agentAttachmentSupport,
  agentContactKey,
  wireAgentAttachments,
  mergeLatestMessage,
  sortAgentContacts,
  messageDelivery,
  reconcileAgentMessages,
  resolveAgentModelStatus,
  type AgentModelStatus,
} from "./agents.logic";
import { triggerErrorMessage } from "./agentWorkspace.logic";
import { AgentHydrationContext, AgentsClientContext } from "./agentsContext";

export class AgentCreatedWithoutTriggerError extends Error {
  constructor(
    readonly agent: AgentContact,
    cause: unknown,
  ) {
    super(
      `Agent created, but the first trigger was not saved. ${triggerErrorMessage(cause, "Try saving the trigger again.")}`,
    );
  }
}

export interface AgentsSnapshot {
  agents: ReadonlyArray<AgentContact>;
  models: ReadonlyArray<AgentModelOption>;
  loading: boolean;
  /** A machine's list is being re-fetched; `agents` still holds what it last sent. */
  reconnecting: boolean;
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
  /** Files the agent's conversation in a project folder; null takes it out of any. */
  setProject: (agent: AgentContact, projectFolderId: ProjectLabelId | null) => Promise<void>;
  /** Whether this connection can arrange the agent in the list; absent where it cannot. */
  canReorder?: (agent: AgentContact) => boolean;
  /** Saves the list's order keys (see `orderAgentsForList`) on the agents' conversations. */
  reorder?: (
    writes: ReadonlyArray<{ readonly agent: AgentContact; readonly orderKey: string }>,
  ) => Promise<void>;
  /**
   * `attachments` are finished uploads; images may carry a local preview for the
   * optimistic bubble. `onMessageId` learns the optimistic message's id before it
   * renders, for send motion.
   */
  send: (
    agent: AgentContact,
    text: string,
    attachments?: ReadonlyArray<ChatAttachment>,
    onMessageId?: (messageId: string) => void,
  ) => Promise<void>;
  /** What a text to this environment's agents may carry; null where it carries no files. */
  attachmentSupport?: (environmentId: EnvironmentId) => AgentAttachmentSupport | null;
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
  setTriggerEnabled: (agent: AgentContact, id: string, enabled: boolean) => Promise<void>;
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
  /** Removes an open item and its history for good; dismissing keeps both. */
  deleteCommitment: (agent: AgentContact, id: string) => Promise<void>;
  /** Whether a model can run on the agent's environment; absent where there is no catalog. */
  modelStatus?: (agent: AgentContact, model: AgentModelRef) => AgentModelStatus;
  /** Model and effort pickers from the live provider catalog; absent where there is none. */
  ModelControls?: ComponentType<AgentModelControlsProps>;
  /** The agent's facts in Details; absent where there is no facts service. */
  MemorySection?: ComponentType<{
    agent: AgentContact;
    labels: AgentWorkspaceView["labels"];
  }>;
}
export const AgentsClientProvider = AgentsClientContext.Provider;
export function useAgentsClient() {
  const client = useContext(AgentsClientContext);
  if (!client) throw new Error("AgentsClientProvider is required");
  return client;
}
const NO_AGENTS: AgentsSnapshot = {
  agents: [],
  models: [],
  loading: false,
  reconnecting: false,
  error: null,
};
const subscribeToNothing = () => () => {};
const readNoAgents = () => NO_AGENTS;
/**
 * The agents list, empty outside the provider: global surfaces (sidebar, palette,
 * thread route) also render where it is absent, such as the welcome wizard.
 */
export function useAgents() {
  const client = useContext(AgentsClientContext);
  const snapshot = useSyncExternalStore(
    client?.subscribe ?? subscribeToNothing,
    client?.getSnapshot ?? readNoAgents,
  );
  const agents = useMemo(() => sortAgentContacts(snapshot.agents), [snapshot.agents]);
  return { ...snapshot, agents };
}
/** True once the list has loaded and holds no agents; false while loading. */
export function useAgentsEmpty() {
  const { agents, loading } = useAgents();
  return !loading && agents.length === 0;
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
import {
  useProjects,
  useServerConfigs,
  useThreadShells,
  waitForThreadShell,
} from "~/state/entities";
import { openWorkWhenArrived } from "~/components/work/work.logic";
import { useEnvironmentThread, threadEnvironment } from "~/state/threads";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerVisible,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { ComposerControlSeparator } from "~/components/chat/ComposerControl";
import { TraitsPicker } from "~/components/chat/TraitsPicker";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { readEnvironmentScope } from "~/state/session";
import { useEnvironmentQuery } from "~/state/query";
import { randomUUID, newMessageId } from "~/lib/utils";
import { useAgentScheduledTasks } from "~/components/sidebar/modes/useAgentScheduledTasks";
import { AgentFactsSection } from "~/memory/AgentFacts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
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
  const setProject = useOrchestrationCommand(agentsRpc.setProject, { reportFailure: false });
  const reorderActive = useOrchestrationCommand(threadEnvironment.reorderActive, {
    reportFailure: false,
  });
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
  const setTaskEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    reportFailure: false,
  });
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
  const deleteCommitment = useOrchestrationCommand(agentWorkspaceRpc.commitmentsDelete, {
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
  // A machine that drops and reconnects restarts its stream; its last list stays
  // on screen meanwhile instead of flashing to empty.
  const lastKnown = useRef(new Map<EnvironmentId, ReadonlyArray<AgentListItem>>());
  const agents = useMemo(
    () =>
      results.flatMap(({ environmentId, result, approvals: approvalsResult }) => {
        const received = Option.getOrNull(AsyncResult.value(result))?.agents;
        if (received) lastKnown.current.set(environmentId, received);
        const records = received ?? lastKnown.current.get(environmentId) ?? [];
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
                : "idle";
          return {
            ...record,
            environmentId,
            state,
            updatedAt: shell?.updatedAt ?? record.updatedAt,
            // A text that only carried files has no words to preview.
            preview: latest ? latest.text.trim() || "Attachment" : "Say hello",
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
            // The list's arranged order rides on the conversation thread, as Work's does.
            orderKey: shell?.activeOrderKey ?? null,
            orderable:
              shell !== undefined &&
              shell.pinnedAt == null &&
              shell.settledOverride !== "settled" &&
              shell.archivedAt == null,
          };
        });
      }),
    [results, tasks, threads, hydrated, outbox],
  );
  const snapshot = useMemo<AgentsSnapshot>(
    () => ({
      agents,
      models,
      loading: results.some(
        ({ environmentId, result }) =>
          result._tag === "Initial" && !lastKnown.current.has(environmentId),
      ),
      reconnecting: results.some(
        ({ environmentId, result }) =>
          Option.isNone(AsyncResult.value(result)) && lastKnown.current.has(environmentId),
      ),
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
      {
        text: string;
        attachmentIds: string;
        commandId: CommandId;
        messageId: import("@t3tools/contracts").MessageId;
      }
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
          state: "idle",
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
      setProject: async (agent, projectFolderId) => {
        commandValue(
          await setProject({
            environmentId: agent.environmentId,
            input: { id: agent.id, projectFolderId },
          }),
        );
      },
      canReorder: (agent) =>
        agent.orderable === true &&
        configs.get(agent.environmentId)?.environment.capabilities.threadActiveReorder === true &&
        readEnvironmentScope(agent.environmentId, AuthOrchestrationOperateScope),
      reorder: async (writes) => {
        const results = await Promise.all(
          writes.map(({ agent, orderKey }) =>
            reorderActive({
              environmentId: agent.environmentId,
              input: { threadId: agent.conversationThreadId, orderKey },
            }),
          ),
        );
        for (const result of results) commandValue(result);
      },
      send: async (agent, text, attachments = [], onMessageId) => {
        const key = agentContactKey(agent);
        const existing = pendingSends.current.get(key);
        const attachmentIds = agentAttachmentIdentity(attachments);
        // Retrying the same text and files reuses the ids, so the server applies it once.
        const identity =
          existing?.text === text && existing.attachmentIds === attachmentIds
            ? existing
            : {
                text,
                attachmentIds,
                commandId: CommandId.make(randomUUID()),
                messageId: newMessageId(),
              };
        pendingSends.current.set(key, identity);
        onMessageId?.(identity.messageId);
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
                ...(attachments.length > 0 ? { attachments } : {}),
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
              input: {
                id: agent.id,
                commandId: identity.commandId,
                messageId: identity.messageId,
                text,
                ...(attachments.length > 0
                  ? { attachments: wireAgentAttachments(attachments) }
                  : {}),
                mode: "auto",
              },
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
      setTriggerEnabled: async (agent, id, enabled) => {
        if (!readEnvironmentScope(agent.environmentId, AuthOrchestrationOperateScope))
          throw new Error("This connection cannot change agents.");
        commandValue(
          await setTaskEnabled({
            environmentId: agent.environmentId,
            input: { id: ScheduledTaskId.make(id), enabled },
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
        void openWorkWhenArrived({
          waitForThread: () => waitForThreadShell(scopeThreadRef(agent.environmentId, threadId)),
          open: () =>
            navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: agent.environmentId, threadId },
            }),
        });
      },
      openProjectSettings: () => {
        void navigate({ to: "/project" });
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
      deleteCommitment: async (agent, id) => {
        commandValue(await deleteCommitment({ environmentId: agent.environmentId, input: { id } }));
        refreshWorkspace(registry, agent);
      },
      modelStatus: (agent, model) =>
        resolveAgentModelStatus(configs.get(agent.environmentId)?.providers, model),
      attachmentSupport: (environmentId) =>
        agentAttachmentSupport(configs.get(environmentId)?.environment.capabilities),
      ModelControls: LiveAgentModelControls,
      MemorySection: AgentFactsSection,
    }),
    [
      snapshot,
      save,
      remove,
      sendAgent,
      markRead,
      setProject,
      reorderActive,
      approval,
      answer,
      saveMemory,
      deleteMemory,
      persistTrigger,
      deleteTask,
      runTask,
      setTaskEnabled,
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
      deleteCommitment,
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

export type AgentConversationData = Pick<
  AgentContact,
  "messages" | "requests" | "memory" | "activity" | "workingOn"
>;

/** The title of the newest tool call still running in a thread, for a typing hint. */
export function workingOnFromItems(
  items: ReadonlyArray<{ type: string; status: string; title: string | null }>,
): string | null {
  const live = items.findLast(
    (item) => item.type === "tool_call" && (item.status === "running" || item.status === "pending"),
  );
  return live?.title?.trim() || null;
}
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
      // The agent's own turns (its kickoff greeting) are not owner bubbles.
      .filter(
        (message) =>
          message.role !== "system" &&
          (message.role !== "user" || message.createdBy === "user") &&
          (message.text.trim() || message.attachments.length > 0),
      )
      .map((message) => {
        const run = projection.runs.find((candidate) => candidate.id === message.runId);
        return {
          id: message.id,
          role: message.role as "user" | "assistant",
          text: message.text,
          ...(message.attachments.length > 0 ? { attachments: message.attachments } : {}),
          createdAt: DateTime.formatIso(message.createdAt),
          updatedAt: DateTime.formatIso(message.updatedAt),
          streaming: message.streaming,
          delivery: messageDelivery(run),
          ...(message.role === "user" && run ? { model: run.modelSelection } : {}),
          ...(message.role === "assistant" && message.runId ? { runId: message.runId } : {}),
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
      workingOn: workingOnFromItems(projection.turnItems),
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
function LiveAgentModelControls({ agent, ...props }: AgentModelControlsProps) {
  return (
    <LiveModelControls environmentId={agent.environmentId} projectId={agent.projectId} {...props} />
  );
}

/** The same pickers for a conversation that has no agent yet, such as the builder. */
export function LiveModelControls({
  environmentId,
  projectId,
  selection,
  disabled,
  unavailable,
  pickerOpen,
  onPickerOpenChange,
  onChange,
}: Omit<AgentModelControlsProps, "agent"> & {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(
          deriveProviderInstanceEntries(providers),
          settings,
          projectId,
        ),
      ).filter(isProviderInstancePickerVisible),
    [providers, settings, projectId],
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
        environmentId={environmentId}
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

/**
 * The model a new chat in this workspace starts with: the project or environment
 * default, else the first ready provider's default. Agents start on it and then
 * follow whatever their chat composer picks.
 */
export function useDefaultAgentModel(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): ModelSelection | null {
  const configs = useServerConfigs();
  const config = environmentId ? configs.get(environmentId) : undefined;
  const projects = useProjects();
  if (!config) return null;
  const project = projects.find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
  );
  return resolveDefaultProviderModelSelection(
    config.providers,
    resolveProjectSettings(config.settings, projectId, project).settings.defaultModelSelection,
  );
}
