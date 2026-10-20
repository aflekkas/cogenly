/**
 * The work-log tool registry: the one place that says how a tool call reads in
 * the chat work log (icon, label, link target, detail rows and grouping).
 *
 * To present a new tool, add one entry to `WORK_LOG_TOOLS`, keyed by the tool's
 * bare name. Nothing else needs to change: `normalizeWorkLogToolKey` folds every
 * provider's spelling (Claude `mcp__cogenly__search`, Codex `cogenly.search`,
 * Muse and legacy `t3-code` prefixes) to that key, the shared T3 MCP inventory
 * supplies a derived entry for orchestration tools without one, and anything
 * else gets the generic descriptor named after the tool. The thought row is
 * `WORK_LOG_THOUGHT`.
 */
import {
  resolveT3McpToolDefinition,
  resolveT3McpToolId,
  type T3McpToolDefinition,
} from "@t3tools/shared/t3McpToolPresentation";

/** Icon names the clients map to glyphs. `message-circle` is the sidebar Chats icon. */
export type WorkLogToolIcon =
  | "book-open"
  | "brain"
  | "browser"
  | "device"
  | "message-circle"
  | "pull-request"
  | "search"
  | "t3-code"
  | "wrench";

export type WorkLogToolStatus = "inProgress" | "completed" | "failed" | "declined" | "stopped";

export interface WorkLogToolCall {
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: Readonly<Record<string, unknown>>;
  readonly status: WorkLogToolStatus;
}

/** Something the call acted on that the row can link to. */
export interface WorkLogToolTarget {
  readonly kind: "thread" | "file" | "url";
  readonly id: string;
  /** Null when only the id is known; clients may resolve a live title. */
  readonly title: string | null;
}

export interface WorkLogToolDetailRow {
  readonly label: string;
  readonly value: string;
}

export interface WorkLogToolDescriptor {
  readonly icon: WorkLogToolIcon;
  /**
   * Present participle, past tense and infinitive: `Searching`, `Searched`, `search`.
   * Null labels the row with the object alone, as the generic fallback does.
   */
  readonly verb: readonly [running: string, completed: string, infinitive: string] | null;
  /** What the call acted on, without the verb: `chats for “AI funding”`. */
  readonly object: (call: WorkLogToolCall, target: WorkLogToolTarget | null) => string;
  /** Linked object, rendered after the object as `“Title”`. */
  readonly target?: (call: WorkLogToolCall) => WorkLogToolTarget | null;
  /** Short outcome such as `3 results`. */
  readonly result?: (call: WorkLogToolCall) => string | null;
  /** Human-readable expanded detail. Raw ids belong in the raw inspector, not here. */
  readonly detail?: (call: WorkLogToolCall) => ReadonlyArray<WorkLogToolDetailRow>;
  /** Consecutive calls sharing a group key collapse into one `×N` row. Defaults to the key. */
  readonly groupKey?: string;
  /** Plural object for grouped rows: `Searched chats ×3`. */
  readonly groupObject: string;
}

export interface WorkLogToolPresentation {
  readonly key: string;
  readonly icon: WorkLogToolIcon;
  /** Full plain-text label, including the target title and result. */
  readonly label: string;
  /** Label text before the target title (the whole label without a target). */
  readonly labelPrefix: string;
  readonly target: WorkLogToolTarget | null;
  readonly result: string | null;
  readonly detail: ReadonlyArray<WorkLogToolDetailRow>;
  readonly groupKey: string;
  /**
   * `registry` for an explicit entry, `t3` for one derived from the shared T3
   * inventory, `generic` for the fallback, which clients may replace with native labeling.
   */
  readonly source: "registry" | "t3" | "generic";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Reads the record inside an MCP result envelope: a plain object, JSON text,
 * `{ content: [{ text }] }` blocks or `structuredContent`, as the adapters retain them.
 */
export function readToolRecord(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 4) return {};
  if (typeof value === "string") {
    try {
      return readToolRecord(JSON.parse(value), depth + 1);
    } catch {
      return {};
    }
  }
  if (Array.isArray(value)) {
    for (const block of value) {
      const record = readToolRecord(asRecord(block)?.text, depth + 1);
      if (Object.keys(record).length > 0) return record;
    }
    return {};
  }
  const record = asRecord(value);
  if (!record) return {};
  const nested =
    record.structuredContent ?? (Array.isArray(record.content) ? record.content : null);
  if (nested != null) {
    const inner = readToolRecord(nested, depth + 1);
    if (Object.keys(inner).length > 0) return inner;
  }
  // Cursor-style envelopes keep arguments under `args`.
  return typeof record.toolName === "string" && asRecord(record.args)
    ? asRecord(record.args)!
    : record;
}

function quoted(value: string, max = 80): string {
  const single = value.replace(/\s+/g, " ");
  return `“${single.length > max ? `${single.slice(0, max - 1)}…` : single}”`;
}

function count(value: number, noun: string, plural = `${noun}s`): string {
  return `${value} ${value === 1 ? noun : plural}`;
}

function resultCount(call: WorkLogToolCall): string | null {
  const hits = Array.isArray(call.output.results)
    ? call.output.results.length
    : Array.isArray(call.output.matches)
      ? call.output.matches.length
      : call.output.resultCount;
  return typeof hits === "number" && call.status === "completed" ? count(hits, "result") : null;
}

const SEARCH_KIND_NOUNS: Readonly<Record<string, string>> = {
  chat: "chats",
  work: "work",
  agent: "agents",
  commitment: "commitments",
  project: "projects",
  pr: "pull requests",
  fact: "facts",
};

function listPhrase(words: ReadonlyArray<string>): string {
  if (words.length < 3) return words.join(" and ");
  return `${words.slice(0, -1).join(", ")}, and ${words.at(-1)}`;
}

function searchScope(call: WorkLogToolCall): string {
  const kinds = Array.isArray(call.input.kinds)
    ? call.input.kinds.flatMap((kind) =>
        typeof kind === "string" && SEARCH_KIND_NOUNS[kind] ? [SEARCH_KIND_NOUNS[kind]] : [],
      )
    : [];
  return kinds.length > 0 && kinds.length < Object.keys(SEARCH_KIND_NOUNS).length
    ? listPhrase(kinds)
    : "Cogenly";
}

function withQuery(scope: string, call: WorkLogToolCall): string {
  const query = text(call.input.query);
  return query ? `${scope} for ${quoted(query)}` : scope;
}

function queryDetail(call: WorkLogToolCall): ReadonlyArray<WorkLogToolDetailRow> {
  const query = text(call.input.query);
  return query ? [{ label: "Query", value: query }] : [];
}

function threadTarget(call: WorkLogToolCall): WorkLogToolTarget | null {
  const thread = asRecord(call.output.thread);
  const id = text(call.input.threadId) ?? text(thread?.threadId) ?? text(call.output.threadId);
  return id ? { kind: "thread", id, title: text(thread?.title) ?? null } : null;
}

export const WORK_LOG_TOOLS: Readonly<Record<string, WorkLogToolDescriptor>> = {
  search: {
    icon: "search",
    verb: ["Searching", "Searched", "search"],
    object: (call) => withQuery(searchScope(call), call),
    result: resultCount,
    detail: (call) => [
      ...queryDetail(call),
      ...(Array.isArray(call.input.kinds) ? [{ label: "In", value: searchScope(call) }] : []),
    ],
    groupObject: "chats",
  },
  t3_thread_search: {
    icon: "search",
    verb: ["Searching", "Searched", "search"],
    object: (call) => withQuery("chats", call),
    result: resultCount,
    detail: queryDetail,
    groupKey: "search",
    groupObject: "chats",
  },
  t3_thread_read: {
    icon: "message-circle",
    verb: ["Reading", "Read", "read"],
    object: (_call, target) => (target?.title ? "chat" : "a chat"),
    target: threadTarget,
    groupObject: "chats",
  },
  t3_thread_list: {
    icon: "message-circle",
    verb: ["Listing", "Listed", "list"],
    object: () => "chats",
    groupObject: "chats",
  },
  memory_read: {
    icon: "book-open",
    verb: ["Reading", "Read", "read"],
    object: () => "agent memory",
    groupObject: "agent memory",
  },
  memory_remember: {
    icon: "book-open",
    verb: ["Saving", "Saved", "save"],
    object: () => "a memory note",
    groupKey: "memory-write",
    groupObject: "memory notes",
  },
  memory_write: {
    icon: "book-open",
    verb: ["Saving", "Saved", "save"],
    object: () => "a memory note",
    groupKey: "memory-write",
    groupObject: "memory notes",
  },
  memory_forget: {
    icon: "book-open",
    verb: ["Forgetting", "Forgot", "forget"],
    object: () => "a memory note",
    groupObject: "memory notes",
  },
  fact_search: {
    icon: "search",
    verb: ["Searching", "Searched", "search"],
    object: (call) => withQuery("facts", call),
    detail: queryDetail,
    groupObject: "facts",
  },
};

/** Reasoning summaries use the same row; their label is the thought itself. */
export const WORK_LOG_THOUGHT = { icon: "brain", groupKey: "thought" } as const;

/** Registry entry for a shared T3 orchestration tool that has no explicit entry. */
function descriptorFromT3Definition(definition: T3McpToolDefinition): WorkLogToolDescriptor {
  const [action, running, completed, detail] = definition.labels;
  return {
    icon: definition.icon,
    verb: [running, completed, action.toLowerCase()],
    object: () => detail,
    groupKey: definition.summaryAction,
    groupObject: detail,
  };
}

function humanizeToolName(name: string): string {
  const words = name.replace(/[_\-.]+/g, " ").trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Tool";
}

function genericDescriptor(key: string): WorkLogToolDescriptor {
  const name = humanizeToolName(key);
  return { icon: "wrench", verb: null, object: () => name, groupObject: name };
}

const COGENLY_PREFIX =
  /^(?:mcp__(?:cogenly|t3-code|t3_code|t3code)__|(?:mcp[-_]{1,2})?(?:cogenly|t3[-_ ]?code)(?:__|[-_.:/]|\s*·\s*))(?<tool>.+)$/i;

/**
 * Folds a provider's tool name to its registry key: the bare Cogenly tool name
 * for Cogenly MCP tools, or null for every other tool.
 */
export function normalizeWorkLogToolKey(toolName: string | null | undefined): string | null {
  const name = toolName?.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
  if (!name) return null;
  const tool = COGENLY_PREFIX.exec(name)?.groups?.tool;
  if (tool && Object.hasOwn(WORK_LOG_TOOLS, tool)) return tool;
  return resolveT3McpToolId(name) ?? (tool ? tool : null);
}

function verbFor(descriptor: WorkLogToolDescriptor, status: WorkLogToolStatus): string | null {
  if (descriptor.verb === null) return status === "failed" ? "Failed:" : null;
  const [running, completed, infinitive] = descriptor.verb;
  switch (status) {
    case "inProgress":
      return running;
    case "completed":
      return completed;
    case "failed":
      return `Failed to ${infinitive}`;
    case "declined":
      return `Declined to ${infinitive}`;
    case "stopped":
      return `Stopped ${running.toLowerCase()}`;
  }
}

function phrase(verb: string | null, object: string): string {
  return verb === null ? object : `${verb} ${object}`;
}

export interface WorkLogToolCallInput {
  readonly toolName: string | null | undefined;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly status: WorkLogToolStatus;
  /** A fresher title for the target, such as a thread's live title after a rename. */
  readonly targetTitle?: string | null | undefined;
}

/** Resolves a Cogenly tool call to its row, or null for tools outside the Cogenly server. */
export function resolveWorkLogTool(call: WorkLogToolCallInput): WorkLogToolPresentation | null {
  const key = normalizeWorkLogToolKey(call.toolName);
  if (key === null) return null;
  const explicit = WORK_LOG_TOOLS[key];
  const t3 = explicit ? null : resolveT3McpToolDefinition(key);
  const descriptor = explicit ?? (t3 ? descriptorFromT3Definition(t3) : genericDescriptor(key));
  const resolved: WorkLogToolCall = {
    input: readToolRecord(call.input),
    output: readToolRecord(call.output),
    status: call.status,
  };
  const resolvedTarget = descriptor.target?.(resolved) ?? null;
  const target =
    resolvedTarget && call.targetTitle
      ? { ...resolvedTarget, title: call.targetTitle }
      : resolvedTarget;
  const labelPrefix = phrase(verbFor(descriptor, call.status), descriptor.object(resolved, target));
  const result = descriptor.result?.(resolved) ?? null;
  const titled = target?.title ? `${labelPrefix} ${quoted(target.title, 200)}` : labelPrefix;
  return {
    key,
    icon: descriptor.icon,
    label: result ? `${titled} · ${result}` : titled,
    labelPrefix,
    target,
    result,
    detail: descriptor.detail?.(resolved) ?? [],
    groupKey: descriptor.groupKey ?? key,
    source: explicit ? "registry" : t3 ? "t3" : "generic",
  };
}

/** Label for a run of calls collapsed under one group key: `Searched chats ×3`. */
export function workLogToolGroupLabel(
  key: string,
  calls: ReadonlyArray<WorkLogToolCallInput>,
): string | null {
  if (calls.length === 0) return null;
  const toolKey = normalizeWorkLogToolKey(calls[0]!.toolName) ?? key;
  const explicit = WORK_LOG_TOOLS[toolKey];
  const t3 = explicit ? null : resolveT3McpToolDefinition(toolKey);
  const descriptor = explicit ?? (t3 ? descriptorFromT3Definition(t3) : genericDescriptor(toolKey));
  const statuses = calls.map((call) => call.status);
  const status: WorkLogToolStatus = statuses.includes("inProgress")
    ? "inProgress"
    : statuses.every((value) => value === "failed")
      ? "failed"
      : "completed";
  if (calls.length === 1) return resolveWorkLogTool(calls[0]!)?.label ?? null;
  return `${phrase(verbFor(descriptor, status), descriptor.groupObject)} ×${calls.length}`;
}
