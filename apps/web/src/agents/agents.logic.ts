import type { ModelSelection, OrchestrationV2Run } from "@t3tools/contracts";
import type { AgentContact, AgentDraft, AgentMessage, AgentModelOption } from "./agents.types";

const GROUP_GAP_MS = 3 * 60_000;
const SEPARATOR_GAP_MS = 30 * 60_000;
const validDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

export function formatMessageTime(at: string, now = new Date(), locale?: string): string {
  const date = validDate(at);
  if (!date) return "";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const day =
    dayKey(date) === dayKey(now)
      ? "Today"
      : dayKey(date) === dayKey(yesterday)
        ? "Yesterday"
        : date.toLocaleDateString(locale, {
            month: "short",
            day: "numeric",
            ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
          });
  return `${day} ${date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}`;
}

/** Each message with its time separator and grouping. */
export function conversationRows(
  messages: ReadonlyArray<AgentMessage>,
  now = new Date(),
  locale?: string,
) {
  return messages.map((message, index) => {
    const previous = messages[index - 1];
    const date = validDate(message.createdAt);
    const previousDate = previous ? validDate(previous.createdAt) : null;
    const gap = date && previousDate ? date.getTime() - previousDate.getTime() : Infinity;
    const separator =
      !previous ||
      !date ||
      !previousDate ||
      dayKey(date) !== dayKey(previousDate) ||
      gap >= SEPARATOR_GAP_MS;
    return {
      message,
      separator: separator ? formatMessageTime(message.createdAt, now, locale) : null,
      grouped:
        !separator &&
        previous?.role === message.role &&
        gap >= 0 &&
        gap <= GROUP_GAP_MS &&
        !message.source &&
        !previous.source,
    };
  });
}

// Timestamp + id avoids dropping messages that share the same timestamp.
export function sortAgentContacts(agents: ReadonlyArray<AgentContact>) {
  return [...agents].sort(
    (a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}
export const agentContactKey = (agent: Pick<AgentContact, "environmentId" | "id">) =>
  `${agent.environmentId}:${agent.id}`;

export type AgentStatusLabel = "Needs approval" | "Needs you" | "Running" | "Idle";

/**
 * What an agent is doing, from its requests and runs. It claims activity only
 * while a run is live: an agent with nothing running is "Idle", never "online"
 * or "thinking".
 */
export function agentStatusLabel(
  agent: Pick<AgentContact, "state" | "requests"> & {
    approvals?: AgentContact["approvals"];
  },
): AgentStatusLabel {
  if (agent.approvals?.length || agent.requests.some((request) => request.kind === "approval"))
    return "Needs approval";
  if (agent.requests.length > 0 || agent.state === "blocked" || agent.state === "needsYou")
    return "Needs you";
  if (agent.state === "thinking" || agent.state === "working") return "Running";
  return "Idle";
}

/** Preserve viewed history while the shell receives a message in a closed conversation. */
export function mergeLatestMessage(
  messages: ReadonlyArray<AgentMessage>,
  latest: AgentMessage | null,
): ReadonlyArray<AgentMessage> {
  if (!latest) return messages;
  const existing = messages.find((message) => message.id === latest.id);
  if (existing)
    return existing.text === latest.text
      ? messages
      : messages.map((message) =>
          message.id === latest.id ? { ...message, text: latest.text } : message,
        );
  return [...messages, latest].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

/** Delivery follows the durable turn, not just acknowledgement of the send RPC. */
export function messageDelivery(
  run: Pick<OrchestrationV2Run, "status" | "startedAt"> | undefined,
): NonNullable<AgentMessage["delivery"]> {
  if (run?.status === "failed") return "failed";
  if (run?.status === "interrupted" || run?.status === "cancelled") return "interrupted";
  if (run?.status === "queued") return "queued";
  return run?.startedAt != null || run?.status === "completed" ? "read" : "delivered";
}

export function reconcileAgentMessages(
  persisted: ReadonlyArray<AgentMessage>,
  pending: ReadonlyArray<AgentMessage>,
): ReadonlyArray<AgentMessage> {
  const ids = new Set(persisted.map((message) => message.id));
  return [...persisted, ...pending.filter((message) => !ids.has(message.id))];
}

/** The editable profile, so a composer edit saves the same fields as the Details sheet. */
export function agentDraft(agent: AgentContact): AgentDraft {
  return {
    id: agent.id,
    name: agent.name,
    avatar: agent.avatar,
    instructions: agent.instructions,
    modelSelection: agent.modelSelection,
    runtimeMode: agent.runtimeMode,
    projectId: agent.projectId,
    dailyRunCap: agent.dailyRunCap,
  };
}

type ModelRef = Pick<ModelSelection, "instanceId" | "model">;
const sameModel = (a: ModelRef, b: ModelRef) =>
  a.instanceId === b.instanceId && a.model === b.model;

/**
 * Where the conversation changed models: before each owner text sent to a different model
 * than the previous one, plus a trailing switch the next text will use.
 */
export function modelSwitches(messages: ReadonlyArray<AgentMessage>, current: ModelRef) {
  const before = new Map<string, ModelRef>();
  let previous: ModelRef | undefined;
  for (const message of messages) {
    if (message.role !== "user" || !message.model) continue;
    if (previous && !sameModel(previous, message.model)) before.set(message.id, message.model);
    previous = message.model;
  }
  return { before, trailing: previous && !sameModel(previous, current) ? current : null };
}

export function modelDisplayName(models: ReadonlyArray<AgentModelOption>, model: ModelRef) {
  const option = models.find((candidate) => sameModel(candidate.selection, model));
  return option?.name ?? option?.label.split(" · ").at(-1) ?? model.model;
}

export interface AgentModelStatus {
  status: "available" | "unavailable" | "unknown";
  providerName: string;
}
/**
 * Whether a saved model can run: its provider instance must be enabled and list the model.
 * A provider still probing (no models yet) or a catalog not yet loaded stays "unknown".
 */
export function resolveAgentModelStatus(
  providers:
    | ReadonlyArray<{
        instanceId: string;
        enabled: boolean;
        displayName?: string | undefined;
        driver: string;
        models: ReadonlyArray<{ slug: string }>;
      }>
    | undefined,
  selection: ModelRef,
): AgentModelStatus {
  const provider = providers?.find((candidate) => candidate.instanceId === selection.instanceId);
  const providerName =
    provider?.displayName ??
    (provider?.driver === "claudeAgent"
      ? "Claude"
      : provider?.driver === "codex"
        ? "Codex"
        : null) ??
    selection.instanceId;
  if (!providers) return { status: "unknown", providerName };
  if (!provider?.enabled) return { status: "unavailable", providerName };
  if (provider.models.length === 0) return { status: "unknown", providerName };
  return {
    status: provider.models.some((model) => model.slug === selection.model)
      ? "available"
      : "unavailable",
    providerName,
  };
}
