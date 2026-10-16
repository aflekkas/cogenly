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
export interface ReadCursor {
  at: string;
  ids: ReadonlyArray<string>;
}
export function readCursor(messages: ReadonlyArray<AgentMessage>): ReadCursor | null {
  const agentMessages = messages.filter((message) => message.role === "assistant");
  const at = agentMessages.reduce(
    (latest, message) => (message.createdAt > latest ? message.createdAt : latest),
    "",
  );
  return at
    ? {
        at,
        ids: agentMessages
          .filter((message) => message.createdAt === at)
          .map((message) => message.id),
      }
    : null;
}
export function unreadCount(
  messages: ReadonlyArray<AgentMessage>,
  cursor: ReadCursor | null,
): number {
  return messages.filter(
    (message) =>
      message.role === "assistant" &&
      (!cursor ||
        message.createdAt > cursor.at ||
        (message.createdAt === cursor.at && !cursor.ids.includes(message.id))),
  ).length;
}
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

/** Accept ownership from newer contracts while this branch still builds on main. */
export function agentThreadRole(source: object): "conversation" | "work" | null {
  if (
    !("agent" in source) ||
    !source.agent ||
    typeof source.agent !== "object" ||
    !("role" in source.agent)
  )
    return null;
  return source.agent.role === "work" || source.agent.role === "conversation"
    ? source.agent.role
    : null;
}
