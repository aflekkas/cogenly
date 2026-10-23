import {
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2HistoricalMessage,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";

/**
 * How much of the source chat a Work handoff carries. The most recent turns
 * travel in full; anything older is summarized into the handoff coverage, and
 * delivery re-selects both within the target turn's own handoff budget.
 */
export const HANDOFF_FULL_TAIL_MESSAGES = 20;
export const HANDOFF_FULL_TAIL_CHARS = 12_000;
/** One carried message never spends more than this in the prepared history. */
export const HANDOFF_MESSAGE_CHARS = 6_000;
/** Preparation bound; delivery enforces the live budget on top. */
export const HANDOFF_PREPARATION_BUDGET = DEFAULT_HANDOFF_TOKEN_CAP;
/** Labeled transcript lines offered to the brief generator. */
export const HANDOFF_BRIEF_MODEL_MESSAGES = 12;
export const HANDOFF_BRIEF_MODEL_CHARS = 1_200;
/** Older turns offered to the scope summarizer for the coverage summary. */
export const HANDOFF_OLDER_MODEL_TURNS = 24;
export const HANDOFF_OLDER_MODEL_CHARS = 500;
export const HANDOFF_OLDER_SUMMARY_LINES = 8;
export const HANDOFF_OLDER_SUMMARY_CHARS = 240;
export const HANDOFF_ARTIFACT_LINKS = 10;
export const HANDOFF_ARTIFACT_ATTACHMENTS = 10;
export const HANDOFF_ARTIFACT_TOOL_LINES = 12;
export const HANDOFF_ARTIFACT_LINE_CHARS = 240;
export const HANDOFF_BRIEF_GOAL_CHARS = 240;
export const HANDOFF_BRIEF_BULLETS = 5;
export const HANDOFF_BRIEF_BULLET_CHARS = 240;

const compactText = (text: string, maxLength: number): string => {
  const compacted = text.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) return compacted;
  return `${compacted.slice(0, Math.max(0, maxLength - 1))}…`;
};

/** Greetings and filler that carry no requirements on their own. */
const FILLER_PATTERN =
  /^(?:hi+|hello|hey+|yo|hiya|howdy|good\s?(?:morning|afternoon|evening|day)|thanks?|thank\s?you|thx|ok(?:ay)?|k|sure|yes|yeah|yep|no|nope|please|test(?:ing)?|ping|lol|haha+)(?:\s+(?:there|folks|everyone|everybody|team|all|mate|buddy|friend))?[\s.!?,;:'"\-–—()]*$/iu;
/** Tails left behind when a leading greeting is stripped ("hello there"). */
const GREETING_TAIL_PATTERN =
  /^(?:there|folks|everyone|everybody|team|all|again|mate|buddy|friend|sir|madam)$/iu;
const LEADING_GREETING_PATTERN =
  /^(?:hi+|hello|hey+|yo|hiya|howdy|thanks?|thank\s?you|thx|ok(?:ay)?|please)[\s,;:!?.-]+/iu;

/** A whole message that is only a greeting, an acknowledgement, or noise. */
export function isFillerMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (normalized.length === 0) return true;
  if (Array.from(normalized).length <= 2) return true;
  return FILLER_PATTERN.test(normalized);
}

const stripLeadingGreeting = (sentence: string): string =>
  sentence.replace(LEADING_GREETING_PATTERN, "").trim();

const isFillerSentence = (sentence: string): boolean => {
  if (isFillerMessage(sentence)) return true;
  const stripped = stripLeadingGreeting(sentence);
  return stripped.length === 0 || isFillerMessage(stripped) || GREETING_TAIL_PATTERN.test(stripped);
};

/** Settled user and assistant turns: what a handoff transcript is built from. */
export function isHandoffTranscriptMessage(message: OrchestrationV2ConversationMessage): boolean {
  return (
    (message.role === "user" || message.role === "assistant") &&
    !message.streaming &&
    message.text.trim().length > 0
  );
}

/**
 * The carried transcript split into the recent tail (travels in full) and
 * older turns (travel in summary form), both kept in chat order.
 */
export function splitTranscriptTail(carried: ReadonlyArray<OrchestrationV2ConversationMessage>): {
  readonly older: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly recent: ReadonlyArray<OrchestrationV2ConversationMessage>;
} {
  let chars = 0;
  let count = 0;
  let start = carried.length;
  for (let index = carried.length - 1; index >= 0; index--) {
    const text = carried[index]!.text.trim();
    if (count >= HANDOFF_FULL_TAIL_MESSAGES || chars + text.length > HANDOFF_FULL_TAIL_CHARS) break;
    chars += text.length;
    count++;
    start = index;
  }
  return { older: carried.slice(0, start), recent: carried.slice(start) };
}

const truncateMessageText = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.length <= HANDOFF_MESSAGE_CHARS) return trimmed;
  return `${trimmed.slice(0, HANDOFF_MESSAGE_CHARS)}…[truncated]`;
};

/**
 * One carried message as handoff history. Item ids are namespaced per source
 * message, so delivery receipts dedupe re-delivery without colliding with the
 * target thread's own items.
 */
export function toHandoffHistoricalMessage(
  message: OrchestrationV2ConversationMessage,
  sourceThreadId: ThreadId,
): OrchestrationV2HistoricalMessage {
  const role = message.role === "assistant" ? "assistant" : "user";
  return {
    role,
    text: truncateMessageText(message.text),
    threadId: sourceThreadId,
    runId: message.runId,
    itemId: TurnItemId.make(`handoff:${sourceThreadId}:${message.id}`),
    providerThreadId: null,
    status: "completed",
    kind: role === "user" ? "user_message" : "assistant_message",
  };
}

/**
 * Preparation-time history selection within a fixed budget. Delivery
 * re-selects with the live turn budget; this keeps the stored handoff small.
 */
export function selectHandoffHistory(
  recent: ReadonlyArray<OrchestrationV2ConversationMessage>,
  sourceThreadId: ThreadId,
  coverage: string,
  budget: number = HANDOFF_PREPARATION_BUDGET,
): {
  readonly messages: ReadonlyArray<OrchestrationV2HistoricalMessage>;
  readonly omittedItemIds: ReadonlyArray<OrchestrationV2HistoricalMessage["itemId"]>;
  readonly omittedItems: number;
} {
  const selected = selectHistory({
    messages: recent.map((message) => toHandoffHistoricalMessage(message, sourceThreadId)),
    coverage,
    budget,
  });
  return {
    messages: selected.messages,
    omittedItemIds: selected.omittedItemIds,
    omittedItems: selected.omittedItems,
  };
}

/** Labeled transcript lines ("User: …") for a generation prompt. */
export function handoffTranscriptLines(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  maxMessages: number,
  maxChars: number,
): ReadonlyArray<string> {
  return messages
    .filter((message) => !isFillerMessage(message.text))
    .slice(-maxMessages)
    .map(
      (message) =>
        `${message.role === "assistant" ? "Assistant" : "User"}: ${compactText(message.text, maxChars)}`,
    );
}

const stripSentencePrefix = (sentence: string): string =>
  sentence.replace(/^\s*(?:[-*•]\s*|\d+[.)]\s*)?(?:user:\s*|assistant:\s*)?/iu, "").trim();

/** Substantive user sentences in order, greetings and filler skipped. */
export function substantiveUserSentences(
  carried: ReadonlyArray<OrchestrationV2ConversationMessage>,
): ReadonlyArray<string> {
  return carried
    .filter((message) => message.role === "user")
    .flatMap((message) => message.text.trim().split(/\n+|(?<=[.!?])\s+/u))
    .map(stripSentencePrefix)
    .filter((sentence) => sentence.length > 0 && !isFillerSentence(sentence));
}

/**
 * Deterministic brief fallback: the first substantive user sentence is the
 * goal, the next few are bullets. Used when brief generation is unavailable.
 */
export function fallbackHandoffBrief(carried: ReadonlyArray<OrchestrationV2ConversationMessage>): {
  readonly goal: string;
  readonly bullets: ReadonlyArray<string>;
} {
  const sentences = substantiveUserSentences(carried);
  const goal = sentences[0] ?? "Continue the work discussed in the source conversation.";
  return {
    goal: compactText(goal, HANDOFF_BRIEF_GOAL_CHARS),
    bullets: sentences
      .slice(1, 1 + HANDOFF_BRIEF_BULLETS)
      .map((sentence) => compactText(sentence, HANDOFF_BRIEF_BULLET_CHARS)),
  };
}

export function formatHandoffBrief(goal: string, bullets: ReadonlyArray<string>): string {
  const lines = [goal.trim(), ...bullets.map((bullet) => `- ${bullet.trim()}`)].filter(
    (line) => line.length > 0 && line !== "-",
  );
  return lines.join("\n");
}

/** Deterministic older-turn summary: one compact line per turn, oldest first. */
export function compactOlderTurns(
  older: ReadonlyArray<OrchestrationV2ConversationMessage>,
): ReadonlyArray<string> {
  const lines = older.map(
    (message) =>
      `- ${message.role === "assistant" ? "Assistant" : "User"}: ${compactText(message.text, HANDOFF_OLDER_SUMMARY_CHARS)}`,
  );
  if (lines.length <= HANDOFF_OLDER_SUMMARY_LINES + 4) return lines;
  return [
    ...lines.slice(0, HANDOFF_OLDER_SUMMARY_LINES),
    `- …plus ${lines.length - HANDOFF_OLDER_SUMMARY_LINES} earlier messages (see the source chat).`,
  ];
}

const LINK_PATTERN = /(?:https?:\/\/|cogenly-thread:\/\/)[^\s<>\]"')]+/gu;
const TRAILING_LINK_PUNCTUATION = /[.,;:!?)\]}>]+$/u;

/** Unique links referenced by the carried transcript, in first-seen order. */
export function extractHandoffLinks(
  carried: ReadonlyArray<OrchestrationV2ConversationMessage>,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const message of carried) {
    for (const match of message.text.match(LINK_PATTERN) ?? []) {
      const link = match.replace(TRAILING_LINK_PUNCTUATION, "");
      if (link.length === 0 || seen.has(link)) continue;
      seen.add(link);
      links.push(link);
      if (links.length >= HANDOFF_ARTIFACT_LINKS) return links;
    }
  }
  return links;
}

/** Unique attachment names carried by the transcript, in first-seen order. */
export function summarizeHandoffAttachments(
  carried: ReadonlyArray<OrchestrationV2ConversationMessage>,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const message of carried) {
    for (const attachment of message.attachments) {
      const line = `- file: ${attachment.name} (${attachment.type})`;
      if (seen.has(line)) continue;
      seen.add(line);
      files.push(line);
      if (files.length >= HANDOFF_ARTIFACT_ATTACHMENTS) return files;
    }
  }
  return files;
}

const summarizeToolItem = (item: OrchestrationV2TurnItem): string | null => {
  switch (item.type) {
    case "command_execution":
      return `- command \`${compactText(item.input, 120)}\` (exit ${item.exitCode ?? "?"}): ${compactText(item.output ?? "", 120)}`;
    case "file_search":
      return `- file search \`${compactText(item.pattern ?? "?", 120)}\`: ${item.results?.length ?? 0} matches`;
    case "web_search":
      return `- web search \`${compactText((item.patterns ?? []).join(", ") || "?", 120)}\`: ${item.results?.length ?? 0} results`;
    case "subagent": {
      const result =
        item.result === null
          ? ""
          : ` → ${compactText(item.result, HANDOFF_ARTIFACT_LINE_CHARS - 60)}`;
      return `- subagent (${item.driver}, ${item.status}): ${compactText(item.prompt, 120)}${result}`;
    }
    case "dynamic_tool": {
      const output =
        item.output === undefined ? "" : `: ${compactText(JSON.stringify(item.output) ?? "", 120)}`;
      return `- tool ${item.toolName ?? "unknown"} (${item.status})${output}`;
    }
    case "file_change":
      return `- file change: ${item.fileName}`;
    case "proposed_plan":
      return `- plan: ${compactText(item.markdown, HANDOFF_ARTIFACT_LINE_CHARS)}`;
    default:
      return null;
  }
};

/**
 * Tool and subagent calls in summary form, oldest first, newest kept when
 * over budget. Message text itself travels as history, not here.
 */
export function summarizeHandoffToolItems(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<string> {
  const lines = items.flatMap((item) => {
    const line = summarizeToolItem(item);
    return line === null ? [] : [line];
  });
  return lines.slice(-HANDOFF_ARTIFACT_TOOL_LINES);
}

/**
 * Turn items at or before the handoff cut-off, by thread ordinal. Without a
 * cut-off everything is carried; when the cut-off's own message items are
 * missing (they are never pruned, but be lenient) the artifacts stay too.
 */
export function filterHandoffItemsThroughCutoff(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  carriedMessageIds: ReadonlySet<string>,
  throughMessageId: string | undefined,
): ReadonlyArray<OrchestrationV2TurnItem> {
  if (throughMessageId === undefined) return items;
  let cutoffOrdinal = -1;
  for (const item of items) {
    if (
      (item.type === "user_message" || item.type === "assistant_message") &&
      carriedMessageIds.has(item.messageId) &&
      item.ordinal > cutoffOrdinal
    ) {
      cutoffOrdinal = item.ordinal;
    }
  }
  if (cutoffOrdinal === -1) return items;
  return items.filter((item) => item.ordinal <= cutoffOrdinal);
}

/** What the provider reads above the carried transcript: older summary, artifacts, provenance. */
export function buildHandoffCoverage(input: {
  readonly sourceThreadId: ThreadId;
  readonly sourceThreadTitle: string;
  readonly modelSelection: ModelSelection;
  readonly messagesCarried: number;
  readonly recentCount: number;
  readonly olderCount: number;
  readonly olderSummaryLines: ReadonlyArray<string>;
  readonly links: ReadonlyArray<string>;
  readonly attachments: ReadonlyArray<string>;
  readonly toolLines: ReadonlyArray<string>;
}): string {
  const title = compactText(input.sourceThreadTitle || "Chat", 200);
  const carried =
    input.messagesCarried === 0
      ? "Carried no chat messages; the brief below is the whole handoff."
      : input.olderCount === 0
        ? `Carried ${input.messagesCarried} chat messages in full, oldest first.`
        : `Carried ${input.messagesCarried} chat messages: the ${input.recentCount} most recent in full, the ${input.olderCount} older ones summarized here.`;
  const sections = [
    `Work handoff from chat "${title}" (thread ${input.sourceThreadId}).`,
    `Source chat model: ${input.modelSelection.model} (provider ${input.modelSelection.instanceId}).`,
    carried,
  ];
  if (input.olderSummaryLines.length > 0)
    sections.push(`Earlier discussion:\n${input.olderSummaryLines.join("\n")}`);
  const artifacts = [
    ...input.links.map((link) => `- link: ${link}`),
    ...input.attachments,
    ...input.toolLines,
  ];
  if (artifacts.length > 0) sections.push(`Key artifacts:\n${artifacts.join("\n")}`);
  sections.push(
    `Recover omitted history with thread_read({threadId:"${input.sourceThreadId}",view:"activity",limit:20,maxCharsPerItem:4000}); paginate with afterPosition=nextPosition. For long items use itemId and textOffset=nextTextOffset until null.`,
  );
  return sections.join("\n\n");
}

/** Generated scope-ish summaries, cleaned the same way drafts are. */
export function cleanHandoffSummaryLines(
  summary: string,
  maxLines: number = HANDOFF_OLDER_SUMMARY_LINES,
): ReadonlyArray<string> {
  return summary
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]\s*)?(?:user|assistant):\s*/iu, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("```"))
    .slice(0, maxLines)
    .map((line) => compactText(line, HANDOFF_OLDER_SUMMARY_CHARS));
}
