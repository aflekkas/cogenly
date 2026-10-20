import type { ContextItem, MessageId, ThreadId } from "@t3tools/contracts";

import { resolveFactRefs } from "../memory/facts.logic";

/** A retrieved item; older runs are backfilled with the display fields when read. */
export type ContextUsedItem = ContextItem;

/** Dialog section order and headings. */
export const CONTEXT_USED_GROUPS = [
  { kind: "message", label: "Messages" },
  { kind: "work", label: "Work outcomes" },
  { kind: "fact", label: "Facts" },
  { kind: "commitment", label: "Open items" },
] as const satisfies ReadonlyArray<{ kind: ContextItem["kind"]; label: string }>;

const KIND_SINGULAR: Record<ContextItem["kind"], string> = {
  message: "Message",
  work: "Work outcome",
  fact: "Fact",
  commitment: "Open item",
};

export interface ContextUsedEntry {
  readonly key: string;
  readonly kind: ContextItem["kind"];
  readonly title: string;
  readonly snippet: string;
  readonly role: "user" | "assistant" | null;
  readonly reason: string;
  readonly at: string;
  readonly sourceThreadId: ThreadId | null;
  readonly sourceMessageId: MessageId | null;
  readonly external: ReadonlyArray<{ readonly label: string; readonly href: string }>;
}

/** The thread an item came from: the explicit field, else its thread ref. */
export function contextSourceThreadId(item: ContextUsedItem): ThreadId | null {
  if (item.sourceThreadId) return item.sourceThreadId;
  const ref = item.refs.find((candidate) => candidate.kind === "thread");
  return ref ? (ref.id as ThreadId) : null;
}

/** Message snippets lead with "user: " or "assistant: "; the role is shown on its own. */
function stripRolePrefix(snippet: string, role: ContextItem["role"]) {
  if (role === undefined) return snippet;
  const prefix = `${role}: `;
  return snippet.startsWith(prefix) ? snippet.slice(prefix.length) : snippet;
}

const SUMMARY_PREFIX = "Earlier conversation summary: ";

/**
 * One item as the "Context used" dialog shows it. `knownThreadTitle` is the client's
 * title for the source thread, used when the server sent none.
 */
export function describeContextItem(
  item: ContextUsedItem,
  knownThreadTitle: string | null,
): ContextUsedEntry {
  const sourceThreadId = contextSourceThreadId(item);
  const threadTitle = item.sourceThreadTitle?.trim() || knownThreadTitle?.trim() || null;
  const isSummary = item.kind === "message" && item.text.startsWith(SUMMARY_PREFIX);
  const text = isSummary ? item.text.slice(SUMMARY_PREFIX.length) : item.text;
  const fallbackReason = (() => {
    switch (item.kind) {
      case "message":
        if (isSummary) return threadTitle ? `Summary of ${threadTitle}` : "Conversation summary";
        return threadTitle ? `Recent message in ${threadTitle}` : "Recent message in this chat";
      case "work":
        return threadTitle ? `Work outcome from ${threadTitle}` : "Work outcome in this project";
      case "fact":
        return "Confirmed fact in this project";
      case "commitment":
        return "Open item in this project";
    }
  })();
  const external = resolveFactRefs(item.refs).flatMap((ref) =>
    ref.kind === "external" ? [{ label: ref.label, href: ref.href }] : [],
  );
  const messageRef = item.refs.find((ref) => ref.kind === "message");
  return {
    key: `${item.kind}:${item.id}`,
    kind: item.kind,
    title:
      item.title?.trim() ||
      threadTitle ||
      (isSummary ? "Earlier conversation" : KIND_SINGULAR[item.kind]),
    snippet: stripRolePrefix(item.snippet?.trim() || text.trim(), item.role),
    role: item.role ?? null,
    reason: item.reason?.trim() || fallbackReason,
    at: item.createdAt ?? item.updatedAt,
    sourceThreadId,
    sourceMessageId:
      item.sourceMessageId ?? (messageRef && !isSummary ? (messageRef.id as MessageId) : null),
    external,
  };
}

/** Items in dialog order, empty groups dropped. */
export function groupContextItems<T extends { readonly kind: ContextItem["kind"] }>(
  items: ReadonlyArray<T>,
) {
  return CONTEXT_USED_GROUPS.flatMap((group) => {
    const members = items.filter((item) => item.kind === group.kind);
    return members.length > 0 ? [{ ...group, items: members }] : [];
  });
}
