import type {
  ChatAttachment as ContractChatAttachment,
  ModelSelection,
  OrchestrationV2Run,
} from "@t3tools/contracts";
import { isFileAttachment, isImageAttachment, type ChatAttachment } from "~/types";
import type {
  AgentAttachmentSupport,
  AgentContact,
  AgentDraft,
  AgentMessage,
  AgentModelOption,
} from "./agents.types";

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

/** Which uploads a text carries, so retrying the same text and files keeps its ids. */
export function agentAttachmentIdentity(
  attachments: ReadonlyArray<Pick<ChatAttachment, "id">>,
): string {
  return attachments.map((attachment) => attachment.id).join("\0");
}

/** The uploads as the server takes them; local previews stay on this client. */
export function wireAgentAttachments(
  attachments: ReadonlyArray<ChatAttachment>,
): ReadonlyArray<ContractChatAttachment> {
  return attachments.map((attachment) => {
    if (isImageAttachment(attachment)) {
      const { previewUrl: _previewUrl, ...wire } = attachment;
      return wire;
    }
    if (isFileAttachment(attachment)) {
      const { previewUrl: _previewUrl, downloadable: _downloadable, ...wire } = attachment;
      return wire;
    }
    return attachment;
  });
}

/**
 * Whether texts to this environment's agents can carry uploads. Servers from before
 * agent attachments silently drop them, so a missing capability hides the controls.
 */
export function agentAttachmentSupport(
  capabilities:
    | {
        readonly agentAttachments?: boolean;
        readonly attachmentUploads?: boolean;
        readonly fileAttachments?: { readonly maxUploadBytes: number };
      }
    | undefined,
): AgentAttachmentSupport | null {
  if (capabilities?.agentAttachments !== true || capabilities.attachmentUploads !== true) {
    return null;
  }
  return { maxFileBytes: capabilities.fileAttachments?.maxUploadBytes ?? null };
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

// Typing slot -----------------------------------------------------------------

/**
 * Where the agent's next bubble will be. While the agent works and no reply is
 * streaming yet, a typing bubble sits at the end of the transcript under a slot
 * key; the reply that then arrives takes that same key, so React keeps the
 * element and the typing bubble grows into the message instead of being replaced.
 */
export interface TypingSlotState {
  /** The next slot key's number. */
  slot: number;
  /** Message ids rendered under a slot key, so later renders keep the element. */
  claimed: ReadonlyMap<string, string>;
  /** The slot key the typing bubble showed under on the previous step, if any. */
  showing: string | null;
  /** Message ids seen on the previous step. */
  seen: ReadonlySet<string>;
}

export const INITIAL_TYPING_SLOT: TypingSlotState = {
  slot: 0,
  claimed: new Map(),
  showing: null,
  seen: new Set(),
};

/** Whether a typing bubble belongs at the end: the agent works and nothing of its reply is in yet. */
export function typingVisible(
  messages: ReadonlyArray<Pick<AgentMessage, "role" | "streaming">>,
  busy: boolean,
) {
  if (!busy) return false;
  const last = messages.at(-1);
  return !(last?.role === "assistant" && last.streaming);
}

/**
 * One step: a new assistant message that arrives while the typing bubble shows
 * claims its slot key; afterwards the bubble, if still needed, moves on to a new key.
 */
export function stepTypingSlot(
  state: TypingSlotState,
  messages: ReadonlyArray<Pick<AgentMessage, "id" | "role" | "streaming">>,
  busy: boolean,
): { state: TypingSlotState; typingKey: string | null } {
  let { slot, showing } = state;
  const claimed = new Map(state.claimed);
  const seen = new Set(messages.map((message) => message.id));
  const arrived = messages.filter(
    (message) => message.role === "assistant" && !state.seen.has(message.id),
  );
  const claimant = arrived.at(-1);
  if (showing !== null && claimant && state.seen.size > 0) {
    claimed.set(claimant.id, showing);
    slot += 1;
    showing = null;
  }
  const visible = typingVisible(messages, busy);
  const typingKey = visible ? (showing ?? `typing-${slot}`) : null;
  return {
    state: { slot, claimed, showing: typingKey, seen },
    typingKey,
  };
}
