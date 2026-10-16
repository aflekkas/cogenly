import type { OrchestrationV2Run } from "@t3tools/contracts";
import type { AgentContact, AgentMessage } from "./agents.types";

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

export function formatContactTime(at: string, now = new Date(), locale?: string): string {
  const date = validDate(at);
  if (!date) return "";
  return dayKey(date) === dayKey(now)
    ? date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

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

/** No-project contacts come first without a heading; each project keeps activity order. */
export function groupAgentContacts(
  agents: ReadonlyArray<AgentContact>,
  projectOf: (agent: AgentContact) => { key: string; label: string } | null,
) {
  const groups = new Map<string, { key: string; label: string | null; agents: AgentContact[] }>();
  for (const agent of sortAgentContacts(agents)) {
    const project = projectOf(agent);
    const key = project?.key ?? "no-project";
    let group = groups.get(key);
    if (!group) {
      group = { key, label: project?.label ?? null, agents: [] };
      groups.set(key, group);
    }
    group.agents.push(agent);
  }
  return [...groups.values()].toSorted(
    (a, b) =>
      Number(b.label === null) - Number(a.label === null) ||
      (a.label ?? "").localeCompare(b.label ?? "") ||
      a.key.localeCompare(b.key),
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
