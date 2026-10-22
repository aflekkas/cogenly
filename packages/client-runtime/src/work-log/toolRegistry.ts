/**
 * The work-log registry: the one place that says how a row reads in the chat
 * work log (icon, label, link target, result, detail rows and grouping), for
 * every provider's tools and for system notices.
 *
 * To present a new tool, add one entry to `WORK_LOG_TOOLS`. Nothing else needs
 * to change: `workLogCallFromItem` maps each turn item type (shell commands,
 * file changes, searches, plans, subagents) to its key, and
 * `normalizeWorkLogToolKey` folds each provider's tool names to a key: Claude
 * `Read` or `mcp__cogenly__search`, Codex `cogenly.search`, Muse `read_file`,
 * legacy `t3-code` names. Cogenly orchestration tools without an entry derive
 * one from the shared T3 inventory; anything else gets the generic descriptor
 * named after the tool. System and lifecycle rows are `WORK_LOG_NOTICES`;
 * reasoning is `WORK_LOG_THOUGHT`.
 */
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import {
  resolveT3McpToolDefinition,
  resolveT3McpToolId,
  type T3McpToolDefinition,
  type T3McpToolSummaryAction,
} from "@t3tools/shared/t3McpToolPresentation";
import {
  claudeSkillInvocation,
  collectToolFilePaths,
  dynamicToolSurface,
  dynamicToolTitle,
  isJavaScriptReplTool,
} from "@t3tools/shared/toolActivity";

import { summarizeT3ToolCalls } from "../t3ToolSummary.ts";
import { commandDisplayText } from "./commandLabel.ts";

/** Icon names the clients map to glyphs. `message-circle` is the sidebar Chats icon. */
export type WorkLogToolIcon =
  | "bell"
  | "book-open"
  | "bot"
  | "brain"
  | "browser"
  | "circle-alert"
  | "clock"
  | "code"
  | "computer"
  | "device"
  | "eye"
  | "file-plus"
  | "folder"
  | "git-branch"
  | "git-fork"
  | "globe"
  | "image"
  | "info"
  | "key"
  | "list-todo"
  | "message-circle"
  | "paperclip"
  | "pull-request"
  | "rotate-ccw"
  | "search"
  | "settings"
  | "shrink"
  | "square-pen"
  | "square-stop"
  | "terminal"
  | "trash"
  | "wrench"
  | "zap";

export type WorkLogToolStatus = "inProgress" | "completed" | "failed" | "declined" | "stopped";

export interface WorkLogToolCall {
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: Readonly<Record<string, unknown>>;
  readonly status: WorkLogToolStatus;
  readonly toolName: string | null;
}

/** Something the call acted on that the row can link to. */
export interface WorkLogToolTarget {
  readonly kind: "thread" | "file" | "url";
  /** Thread id, file path as the tool wrote it, or URL. */
  readonly id: string;
  /** Null when only the id is known; clients may resolve a live title. */
  readonly title: string | null;
  /** Thread titles read as quoted names; file names and hosts do not. */
  readonly quoted: boolean;
}

export interface WorkLogToolDetailRow {
  readonly label: string;
  readonly value: string;
}

type Verb = readonly [running: string, completed: string, infinitive: string];

export interface WorkLogToolDescriptor {
  readonly icon: WorkLogToolIcon | ((call: WorkLogToolCall) => WorkLogToolIcon);
  /**
   * Present participle, past tense and infinitive: `Searching`, `Searched`, `search`.
   * Null labels the row with the object alone, as the generic fallback does.
   */
  readonly verb: Verb | null;
  /** What the call acted on, without the verb: `chats for “AI funding”`. Empty with a target. */
  readonly object: (call: WorkLogToolCall, target: WorkLogToolTarget | null) => string;
  /** Linked object, rendered after the verb phrase. */
  readonly target?: (call: WorkLogToolCall) => WorkLogToolTarget | null;
  /** Short outcome such as `3 results`. */
  readonly result?: (call: WorkLogToolCall) => string | null;
  /** Human-readable expanded detail. Raw ids belong in the raw inspector, not here. */
  readonly detail?: (call: WorkLogToolCall) => ReadonlyArray<WorkLogToolDetailRow>;
  /**
   * `collapsed` tucks the raw call inspector behind a disclosure (it holds ids);
   * `inline` shows it as the detail (command output, diffs).
   */
  readonly raw?: "inline" | "collapsed";
  /** Calls with the same group key collapse together. Defaults to the key. */
  readonly groupKey?: string;
  /**
   * Grouped label. `count` reads `Ran 3 commands`; `times` reads `Searched the web ×3`.
   * `count` may dedupe calls, as edits to one file count once.
   */
  readonly group: {
    readonly style: "count" | "times";
    readonly noun: readonly [singular: string, plural: string];
    readonly count?: (calls: ReadonlyArray<WorkLogToolCall>) => number;
  };
  /** Custom grouped label, for summaries that read results. */
  readonly summarize?: (calls: ReadonlyArray<WorkLogToolCall>) => string | null;
  /** Lower sorts first when a group summary has to pick its two headline actions. */
  readonly priority?: 0 | 1 | 2;
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
  readonly raw: "inline" | "collapsed";
  readonly groupKey: string;
  readonly priority: 0 | 1 | 2;
  /**
   * `registry` for an explicit entry, `t3` for one derived from the shared T3
   * inventory, `generic` for the fallback named after the tool.
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

function firstText(record: Readonly<Record<string, unknown>>, keys: ReadonlyArray<string>) {
  for (const key of keys) {
    const value = text(record[key]);
    if (value) return value;
  }
  return undefined;
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
  const args = typeof record.toolName === "string" ? asRecord(record.args) : undefined;
  return args ?? record;
}

function clip(value: string, max: number): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function quoted(value: string, max = 80): string {
  return `“${clip(value, max)}”`;
}

function count(value: number, noun: string, plural = `${noun}s`): string {
  return `${value} ${value === 1 ? noun : plural}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).findLast((part) => part.length > 0 && part !== ".") ?? path;
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return clip(`${parsed.host.replace(/^www\./, "")}${path}`, 60);
  } catch {
    return clip(url, 60);
  }
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function hitCount(call: WorkLogToolCall): number | null {
  const output = call.output;
  const hits = Array.isArray(output.results)
    ? output.results.length
    : Array.isArray(output.matches)
      ? output.matches.length
      : output.resultCount;
  return typeof hits === "number" ? hits : null;
}

function resultCount(call: WorkLogToolCall): string | null {
  const hits = hitCount(call);
  return hits !== null && call.status === "completed" ? count(hits, "result") : null;
}

// ---------------------------------------------------------------------------
// Native tools
// ---------------------------------------------------------------------------

/** File paths a call names, in the order the tool gave them. */
function callPaths(call: WorkLogToolCall): string[] {
  const listed = Array.isArray(call.input.paths)
    ? call.input.paths.flatMap((path) => (text(path) ? [text(path)!] : []))
    : [];
  return [...new Set(listed.length > 0 ? listed : collectToolFilePaths({ input: call.input }))];
}

function fileTarget(call: WorkLogToolCall): WorkLogToolTarget | null {
  const paths = callPaths(call);
  return paths.length === 1
    ? { kind: "file", id: paths[0]!, title: basename(paths[0]!), quoted: false }
    : null;
}

function filesObject(noun = "file") {
  return (call: WorkLogToolCall, target: WorkLogToolTarget | null) => {
    if (target) return "";
    const paths = callPaths(call);
    return paths.length > 1 ? count(paths.length, noun) : `a ${noun}`;
  };
}

function uniquePaths(calls: ReadonlyArray<WorkLogToolCall>): number {
  const paths = new Set<string>();
  let unnamed = 0;
  for (const call of calls) {
    const named = callPaths(call);
    if (named.length === 0) unnamed += 1;
    for (const path of named) paths.add(path);
  }
  return paths.size + unnamed;
}

function lineCounts(call: WorkLogToolCall): string | null {
  const added = call.input.additions;
  const removed = call.input.deletions;
  if (typeof added !== "number" && typeof removed !== "number") return null;
  return `+${typeof added === "number" ? added : 0} −${typeof removed === "number" ? removed : 0}`;
}

function commandText(call: WorkLogToolCall): string | undefined {
  const command = call.input.command ?? call.input.cmd;
  const joined = Array.isArray(command)
    ? command.filter((part) => typeof part === "string").join(" ")
    : command;
  const value = text(joined);
  return value ? commandDisplayText(value) : undefined;
}

const SEARCH_QUERY_KEYS = ["pattern", "query", "regex", "searchTerm", "q"];
const SEARCH_GLOB_KEYS = ["glob", "globPattern", "glob_pattern", "include", "filePattern"];
const SEARCH_DIR_KEYS = ["path", "target_directory", "directory", "dir", "cwd", "root"];

function searchIn(call: WorkLogToolCall): string {
  const dir = firstText(call.input, SEARCH_DIR_KEYS);
  const name = dir ? basename(dir) : undefined;
  return name ? ` in ${name}` : "";
}

function todoSteps(call: WorkLogToolCall): Array<{ done: boolean }> {
  const steps = Array.isArray(call.input.todos)
    ? call.input.todos
    : Array.isArray(call.input.steps)
      ? call.input.steps
      : Array.isArray(call.input.plan)
        ? call.input.plan
        : [];
  return steps.flatMap((step) => {
    const status = text(asRecord(step)?.status)?.toLowerCase();
    return status ? [{ done: status === "completed" || status === "done" }] : [];
  });
}

function webQueries(call: WorkLogToolCall): string[] {
  const queries = Array.isArray(call.input.queries)
    ? call.input.queries.flatMap((query) => (text(query) ? [text(query)!] : []))
    : [];
  const single = firstText(call.input, ["query", "q", "search_query"]);
  return queries.length > 0 ? queries : single ? [single] : [];
}

function fetchUrl(call: WorkLogToolCall): string | undefined {
  return firstText(call.input, ["url", "uri", "href"]);
}

const NATIVE_TOOLS: Readonly<Record<string, WorkLogToolDescriptor>> = {
  command: {
    icon: "terminal",
    verb: ["Running", "Ran", "run"],
    object: (call) => {
      const command = commandText(call);
      return command ? quoted(command, 72) : "a command";
    },
    raw: "inline",
    group: { style: "count", noun: ["command", "commands"] },
    priority: 0,
  },
  edit: {
    icon: "square-pen",
    verb: ["Editing", "Edited", "edit"],
    object: filesObject(),
    target: fileTarget,
    result: lineCounts,
    raw: "inline",
    group: { style: "count", noun: ["file", "files"], count: uniquePaths },
    priority: 0,
  },
  write: {
    icon: "file-plus",
    verb: ["Writing", "Wrote", "write"],
    object: filesObject(),
    target: fileTarget,
    result: lineCounts,
    raw: "inline",
    groupKey: "edit",
    group: { style: "count", noun: ["file", "files"], count: uniquePaths },
    priority: 0,
  },
  delete: {
    icon: "trash",
    verb: ["Deleting", "Deleted", "delete"],
    object: filesObject(),
    target: fileTarget,
    raw: "inline",
    group: { style: "count", noun: ["file", "files"], count: uniquePaths },
    priority: 0,
  },
  read: {
    icon: "eye",
    verb: ["Reading", "Read", "read"],
    object: filesObject(),
    target: fileTarget,
    raw: "inline",
    group: { style: "count", noun: ["file", "files"], count: uniquePaths },
  },
  "view-image": {
    icon: "image",
    verb: ["Viewing", "Viewed", "view"],
    object: filesObject("image"),
    target: fileTarget,
    raw: "inline",
    group: { style: "count", noun: ["image", "images"], count: uniquePaths },
  },
  "code-search": {
    icon: "search",
    verb: ["Searching", "Searched", "search"],
    object: (call) => {
      const query = firstText(call.input, SEARCH_QUERY_KEYS);
      const glob = firstText(call.input, SEARCH_GLOB_KEYS);
      const scope = glob && query ? ` in ${glob}` : searchIn(call);
      return query
        ? `code for ${quoted(query)}${scope}`
        : glob
          ? `for files matching ${quoted(glob)}${searchIn(call)}`
          : `code${scope}`;
    },
    result: resultCount,
    raw: "inline",
    group: { style: "times", noun: ["code", "code"] },
  },
  list: {
    icon: "folder",
    verb: ["Listing", "Listed", "list"],
    object: (call) => {
      const dir = firstText(call.input, SEARCH_DIR_KEYS);
      return dir ? basename(dir) : "files";
    },
    raw: "inline",
    group: { style: "count", noun: ["folder", "folders"] },
  },
  "web-search": {
    icon: "globe",
    verb: ["Searching", "Searched", "search"],
    object: (call) => {
      const [first, ...rest] = webQueries(call);
      if (!first) return "the web";
      return `the web for ${quoted(first)}${rest.length > 0 ? ` and ${count(rest.length, "more query", "more queries")}` : ""}`;
    },
    result: resultCount,
    raw: "inline",
    group: { style: "times", noun: ["the web", "the web"] },
  },
  "web-fetch": {
    icon: "globe",
    verb: ["Fetching", "Fetched", "fetch"],
    object: (_call, target) => (target ? "" : "a page"),
    target: (call) => {
      const url = fetchUrl(call);
      return url && isUrl(url)
        ? { kind: "url", id: url, title: shortUrl(url), quoted: false }
        : null;
    },
    raw: "inline",
    group: { style: "count", noun: ["page", "pages"] },
  },
  todo: {
    icon: "list-todo",
    verb: ["Updating", "Updated", "update"],
    object: () => "the plan",
    result: (call) => {
      const steps = todoSteps(call);
      return steps.length > 0
        ? `${steps.filter((step) => step.done).length} of ${steps.length} done`
        : null;
    },
    raw: "inline",
    group: { style: "times", noun: ["the plan", "the plan"] },
  },
  subagent: {
    icon: "bot",
    verb: ["Running", "Ran", "run"],
    object: (call) => {
      const task = firstText(call.input, ["description", "prompt", "task", "objective"]);
      return task ? `a subagent: ${quoted(task, 60)}` : "a subagent";
    },
    raw: "inline",
    group: { style: "count", noun: ["subagent", "subagents"] },
    priority: 0,
  },
  skill: {
    icon: "zap",
    verb: ["Using", "Used", "use"],
    object: (call) => {
      const name = claudeSkillInvocation(call.toolName, call.input)?.name;
      return name ? `the ${name} skill` : "a skill";
    },
    raw: "inline",
    group: { style: "count", noun: ["skill", "skills"] },
  },
  javascript: {
    icon: (call) =>
      dynamicToolSurface(call.toolName, call.input) === "computer" ? "computer" : "code",
    verb: null,
    object: (call) => dynamicToolTitle(call.toolName, call.input) ?? "Run JavaScript",
    raw: "inline",
    group: { style: "times", noun: ["Ran JavaScript", "Ran JavaScript"] },
  },
  "tool-search": {
    icon: "search",
    verb: ["Searching", "Searched", "search"],
    object: (call) => {
      const query = firstText(call.input, ["query", "q"]);
      return query ? `tools for ${quoted(query)}` : "tools";
    },
    raw: "inline",
    group: { style: "times", noun: ["tools", "tools"] },
  },
};

/** Native tool names, lowercased with separators removed, to their registry key. */
const NATIVE_TOOL_NAMES: Readonly<Record<string, string>> = {
  bash: "command",
  shell: "command",
  exec: "command",
  execcommand: "command",
  localshell: "command",
  terminal: "command",
  runterminalcmd: "command",
  runcommand: "command",
  read: "read",
  readfile: "read",
  readfiles: "read",
  view: "read",
  openfile: "read",
  write: "write",
  writefile: "write",
  createfile: "write",
  edit: "edit",
  editfile: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  strreplace: "edit",
  strreplacebasededittool: "edit",
  applypatch: "edit",
  patch: "edit",
  deletefile: "delete",
  grep: "code-search",
  rg: "code-search",
  glob: "code-search",
  find: "code-search",
  findfiles: "code-search",
  filesearch: "code-search",
  codebasesearch: "code-search",
  searchfiles: "code-search",
  ls: "list",
  listdir: "list",
  listdirectory: "list",
  listfiles: "list",
  websearch: "web-search",
  webfetch: "web-fetch",
  fetch: "web-fetch",
  fetchurl: "web-fetch",
  openpage: "web-fetch",
  todowrite: "todo",
  todoread: "todo",
  updateplan: "todo",
  updatetodos: "todo",
  task: "subagent",
  agent: "subagent",
  spawnagent: "subagent",
  viewimage: "view-image",
  imageview: "view-image",
  skill: "skill",
  toolsearch: "tool-search",
};

// ---------------------------------------------------------------------------
// Cogenly tools
// ---------------------------------------------------------------------------

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
  return id ? { kind: "thread", id, title: text(thread?.title) ?? null, quoted: true } : null;
}

const COGENLY_TOOLS: Readonly<Record<string, WorkLogToolDescriptor>> = {
  search: {
    icon: "search",
    verb: ["Searching", "Searched", "search"],
    object: (call) => withQuery(searchScope(call), call),
    result: resultCount,
    detail: (call) => [
      ...queryDetail(call),
      ...(Array.isArray(call.input.kinds) ? [{ label: "In", value: searchScope(call) }] : []),
    ],
    raw: "collapsed",
    group: { style: "times", noun: ["chats", "chats"] },
  },
  t3_thread_search: {
    icon: "search",
    verb: ["Searching", "Searched", "search"],
    object: (call) => withQuery("chats", call),
    result: resultCount,
    detail: queryDetail,
    raw: "collapsed",
    groupKey: "search",
    group: { style: "times", noun: ["chats", "chats"] },
  },
  t3_thread_read: {
    icon: "message-circle",
    verb: ["Reading", "Read", "read"],
    object: (_call, target) => (target?.title ? "chat" : "a chat"),
    target: threadTarget,
    raw: "collapsed",
    group: {
      style: "count",
      noun: ["chat", "chats"],
      count: (calls) => new Set(calls.map((call) => threadTarget(call)?.id ?? call)).size,
    },
  },
  t3_thread_list: {
    icon: "message-circle",
    verb: ["Listing", "Listed", "list"],
    object: () => "chats",
    raw: "collapsed",
    group: { style: "times", noun: ["chats", "chats"] },
  },
  memory_read: {
    icon: "book-open",
    verb: ["Reading", "Read", "read"],
    object: () => "agent memory",
    raw: "collapsed",
    group: { style: "times", noun: ["agent memory", "agent memory"] },
  },
  memory_remember: {
    icon: "book-open",
    verb: ["Saving", "Saved", "save"],
    object: () => "a memory note",
    raw: "collapsed",
    groupKey: "memory-write",
    group: { style: "count", noun: ["memory note", "memory notes"] },
    priority: 0,
  },
  memory_write: {
    icon: "book-open",
    verb: ["Saving", "Saved", "save"],
    object: () => "a memory note",
    raw: "collapsed",
    groupKey: "memory-write",
    group: { style: "count", noun: ["memory note", "memory notes"] },
    priority: 0,
  },
  memory_forget: {
    icon: "book-open",
    verb: ["Forgetting", "Forgot", "forget"],
    object: () => "a memory note",
    raw: "collapsed",
    group: { style: "count", noun: ["memory note", "memory notes"] },
    priority: 0,
  },
  fact_search: {
    icon: "search",
    verb: ["Searching", "Searched", "search"],
    object: (call) => withQuery("facts", call),
    detail: queryDetail,
    raw: "collapsed",
    group: { style: "times", noun: ["facts", "facts"] },
  },
};

/** Every explicit entry, native and Cogenly. Adding a tool means adding one here. */
export const WORK_LOG_TOOLS: Readonly<Record<string, WorkLogToolDescriptor>> = {
  ...NATIVE_TOOLS,
  ...COGENLY_TOOLS,
};

/** Reasoning summaries use the same row; their label is the thought itself. */
export const WORK_LOG_THOUGHT = { icon: "brain", groupKey: "thought" } as const;

// ---------------------------------------------------------------------------
// Derived and generic entries
// ---------------------------------------------------------------------------

/** Icons for shared T3 tools, by summary action. The inventory's own mark is not an icon. */
function t3ActionIcon(definition: T3McpToolDefinition): WorkLogToolIcon {
  if (definition.icon !== "t3-code") return definition.icon;
  const action: T3McpToolSummaryAction = definition.summaryAction;
  if (action === "delegate" || action.startsWith("task-")) return "bot";
  if (action.startsWith("schedule-")) return "clock";
  if (action.startsWith("project-")) return "folder";
  if (action.startsWith("worktree-")) return "git-branch";
  if (action.startsWith("queue-")) return "list-todo";
  if (action.startsWith("question-")) return "message-circle";
  if (action.startsWith("attachment-")) return "paperclip";
  if (action.startsWith("environment-")) return "settings";
  if (action === "thread-fork") return "git-fork";
  if (action === "workflow-stop" || action === "thread-interrupt") return "square-stop";
  if (action === "secret-request") return "key";
  if (action === "html-preview" || action === "html-render") return "code";
  if (action === "capabilities") return "info";
  return "message-circle";
}

const PULL_REQUEST_ACTIONS = new Set<string>(["link-pr", "unlink-pr", "watch-pr", "unwatch-pr"]);

function pullRequestNumber(call: WorkLogToolCall): number | null {
  const url = typeof call.input.url === "string" ? parseChangeRequestUrl(call.input.url) : null;
  const number = url?.number ?? call.input.number;
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : null;
}

function descriptorFromT3Definition(definition: T3McpToolDefinition): WorkLogToolDescriptor {
  const [action, running, completed, detail] = definition.labels;
  const summaryAction = definition.summaryAction;
  return {
    icon: t3ActionIcon(definition),
    verb: [running, completed, action.toLowerCase()],
    object: (call) => {
      const number = PULL_REQUEST_ACTIONS.has(summaryAction) ? pullRequestNumber(call) : null;
      return number === null ? detail : `PR #${number}`;
    },
    raw: "collapsed",
    groupKey: summaryAction,
    group: { style: "times", noun: [detail, detail] },
    summarize: (calls) =>
      summarizeT3ToolCalls(
        summaryAction,
        calls.map((call) => ({
          input: call.input,
          output: call.output,
          outcome:
            call.status === "failed" || call.status === "declined"
              ? "failed"
              : call.status === "completed"
                ? "completed"
                : "unfinished",
        })),
      ).label,
    priority: /(?:list|read|status|configuration|transfers|capabilities)$/.test(summaryAction)
      ? 1
      : 0,
  };
}

/** An integration's tool reads by its own name, without the server prefix. */
function humanizeToolName(name: string): string {
  const bare = name.replace(/^mcp__.+?__/, "").replace(/^[\w-]+[./:]/, "");
  const words = (bare || name).replace(/[_\-.]+/g, " ").trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Tool";
}

function genericDescriptor(name: string): WorkLogToolDescriptor {
  const label = humanizeToolName(name);
  return {
    icon: "wrench",
    verb: null,
    object: () => label,
    raw: "inline",
    group: { style: "times", noun: [label, label] },
    priority: 2,
  };
}

const COGENLY_PREFIX =
  /^(?:mcp__(?:cogenly|t3-code|t3_code|t3code)__|(?:mcp[-_]{1,2})?(?:cogenly|t3[-_ ]?code)(?:__|[-_.:/]|\s*·\s*))(?<tool>.+)$/i;

function nativeToolKey(name: string): string | null {
  // Server-prefixed names (`github.read_file`, `mcp__db__find`) belong to integrations.
  if (/__|[./]/.test(name)) return null;
  if (isJavaScriptReplTool(name)) return "javascript";
  return NATIVE_TOOL_NAMES[name.replace(/[\s_-]/g, "").toLowerCase()] ?? null;
}

/**
 * Folds a provider's tool name to its registry key: the bare Cogenly tool name
 * for Cogenly MCP tools, a native key such as `read` or `command` for built-in
 * tools, or null for an integration's tool.
 */
export function normalizeWorkLogToolKey(toolName: string | null | undefined): string | null {
  const name = toolName?.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
  if (!name) return null;
  const tool = COGENLY_PREFIX.exec(name)?.groups?.tool;
  if (tool && Object.hasOwn(COGENLY_TOOLS, tool)) return tool;
  return resolveT3McpToolId(name) ?? (tool ? tool : nativeToolKey(name));
}

function resolveDescriptor(key: string): {
  readonly descriptor: WorkLogToolDescriptor;
  readonly source: WorkLogToolPresentation["source"];
} {
  const explicit = WORK_LOG_TOOLS[key];
  if (explicit) return { descriptor: explicit, source: "registry" };
  const t3 = resolveT3McpToolDefinition(key);
  if (t3) return { descriptor: descriptorFromT3Definition(t3), source: "t3" };
  return { descriptor: genericDescriptor(key), source: "generic" };
}

function verbFor(verb: Verb | null, status: WorkLogToolStatus): string | null {
  if (verb === null) return status === "failed" ? "Failed:" : null;
  const [running, completed, infinitive] = verb;
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
  if (verb === null) return object;
  return object ? `${verb} ${object}` : verb;
}

export interface WorkLogToolCallInput {
  /** Registry key when the caller already knows it; otherwise it comes from `toolName`. */
  readonly key?: string;
  readonly toolName: string | null | undefined;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly status: WorkLogToolStatus;
  /** A fresher title for the target, such as a thread's live title after a rename. */
  readonly targetTitle?: string | null | undefined;
  /** A surface the provider reported for the call, which picks the icon. */
  readonly surface?: "browser" | "computer" | undefined;
}

function toCall(call: WorkLogToolCallInput): WorkLogToolCall {
  return {
    input: readToolRecord(call.input),
    output: readToolRecord(call.output),
    status: call.status,
    toolName: call.toolName ?? null,
  };
}

function callKey(call: WorkLogToolCallInput): string | null {
  return call.key ?? normalizeWorkLogToolKey(call.toolName);
}

/**
 * Resolves a tool call to its row. Unknown tools with a name get the generic
 * descriptor; a call with no name at all is not a tool, so it resolves to null.
 */
export function resolveWorkLogTool(call: WorkLogToolCallInput): WorkLogToolPresentation | null {
  const key = callKey(call) ?? (text(call.toolName) ? text(call.toolName)! : null);
  if (key === null) return null;
  const { descriptor, source } = resolveDescriptor(key);
  const resolved = toCall(call);
  const resolvedTarget = descriptor.target?.(resolved) ?? null;
  const target =
    resolvedTarget && call.targetTitle
      ? { ...resolvedTarget, title: call.targetTitle }
      : resolvedTarget;
  const labelPrefix = phrase(
    verbFor(descriptor.verb, call.status),
    descriptor.object(resolved, target),
  );
  const result = descriptor.result?.(resolved) ?? null;
  const title = target?.title ? (target.quoted ? quoted(target.title, 200) : target.title) : null;
  const titled = title ? `${labelPrefix} ${title}` : labelPrefix;
  const icon = typeof descriptor.icon === "function" ? descriptor.icon(resolved) : descriptor.icon;
  return {
    key,
    icon: call.surface ?? icon,
    label: result ? `${titled} · ${result}` : titled,
    labelPrefix,
    target,
    result,
    detail: descriptor.detail?.(resolved) ?? [],
    raw: descriptor.raw ?? "inline",
    groupKey: descriptor.groupKey ?? key,
    priority: descriptor.priority ?? 1,
    source,
  };
}

/**
 * Label for calls collapsed under one group key: `Ran 3 commands`, `Searched chats ×3`.
 * A single call reads as its own row.
 */
export function workLogToolGroupLabel(calls: ReadonlyArray<WorkLogToolCallInput>): string | null {
  const [first] = calls;
  if (!first) return null;
  if (calls.length === 1) return resolveWorkLogTool(first)?.label ?? null;
  const key = callKey(first) ?? text(first.toolName);
  if (!key) return null;
  const { descriptor } = resolveDescriptor(key);
  const resolved = calls.map(toCall);
  const custom = descriptor.summarize?.(resolved);
  if (custom) return custom;
  const statuses = calls.map((call) => call.status);
  const status: WorkLogToolStatus = statuses.includes("inProgress")
    ? "inProgress"
    : statuses.every((value) => value === "failed")
      ? "failed"
      : "completed";
  const verb = verbFor(descriptor.verb, status);
  const { style, noun, count: countCalls } = descriptor.group;
  if (style === "times") return `${phrase(verb, noun[1])} ×${calls.length}`;
  const total = countCalls?.(resolved) ?? calls.length;
  return phrase(verb, count(total, noun[0], noun[1]));
}

// ---------------------------------------------------------------------------
// Turn items
// ---------------------------------------------------------------------------

function itemStatus(item: OrchestrationV2TurnItem): WorkLogToolStatus {
  switch (item.status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
    default:
      return "inProgress";
  }
}

const FILE_OPERATION_KEYS: Readonly<Record<string, string>> = {
  add: "write",
  create: "write",
  created: "write",
  delete: "delete",
  deleted: "delete",
  remove: "delete",
};

/**
 * The registry call for a turn item, or null when the item is not a tool call.
 * This is where each provider's item shapes meet the registry's inputs.
 */
export function workLogCallFromItem(
  item: OrchestrationV2TurnItem,
  status: WorkLogToolStatus = itemStatus(item),
): WorkLogToolCallInput | null {
  switch (item.type) {
    case "command_execution":
      return {
        key: "command",
        toolName: "command",
        input: { command: item.input },
        ...(item.exitCode === undefined ? {} : { output: { exitCode: item.exitCode } }),
        status,
      };
    case "file_change": {
      const paths = item.changes?.map((change) => change.path) ?? [item.fileName];
      const operations = new Set(
        item.changes?.map((change) => FILE_OPERATION_KEYS[change.operation.toLowerCase()]) ?? [
          item.oldStr === undefined && item.diffStr === undefined && item.newStr !== undefined
            ? "write"
            : undefined,
        ],
      );
      const [only] = operations;
      return {
        key: operations.size === 1 && only ? only : "edit",
        toolName: "file_change",
        input: {
          paths,
          ...(item.additions === undefined ? {} : { additions: item.additions }),
          ...(item.deletions === undefined ? {} : { deletions: item.deletions }),
        },
        status,
      };
    }
    case "file_search":
      return {
        key: "code-search",
        toolName: "file_search",
        input: item.pattern ? { pattern: item.pattern } : {},
        ...(item.results ? { output: { resultCount: item.results.length } } : {}),
        status,
      };
    case "web_search": {
      const patterns = item.patterns ?? [];
      const url = patterns.find(isUrl);
      return url && patterns.every((pattern) => isUrl(pattern) || pattern === url)
        ? { key: "web-fetch", toolName: "web_fetch", input: { url }, status }
        : {
            key: "web-search",
            toolName: "web_search",
            input: { queries: patterns.filter((pattern) => !isUrl(pattern)) },
            ...(item.results ? { output: { resultCount: item.results.length } } : {}),
            status,
          };
    }
    case "todo_list":
      return {
        key: "todo",
        toolName: "todo_list",
        input: { steps: item.steps.map((step) => ({ status: step.status })) },
        status,
      };
    case "subagent":
      return { key: "subagent", toolName: "subagent", input: { prompt: item.prompt }, status };
    case "dynamic_tool": {
      const viewsImage = item.viewedImagePath !== undefined;
      const surface = dynamicToolSurface(item.toolName, item.input);
      return {
        ...(viewsImage ? { key: "view-image" } : {}),
        toolName: item.toolName ?? item.title ?? "Tool",
        input: viewsImage ? { paths: [item.viewedImagePath] } : item.input,
        output: item.output,
        status,
        ...(surface === "computer" ? { surface } : {}),
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// System notices
// ---------------------------------------------------------------------------

export interface WorkLogNotice {
  readonly icon: WorkLogToolIcon;
  readonly label: string;
  /** Quiet notes are muted single lines; alerts keep the warning or error color. */
  readonly tone: "quiet" | "warning" | "danger";
}

type NoticeItem = Extract<
  OrchestrationV2TurnItem,
  {
    readonly type:
      | "notification"
      | "system_notice"
      | "compaction"
      | "run_interrupt_request"
      | "run_interrupt_result"
      | "handoff"
      | "fork"
      | "checkpoint"
      | "thread_created";
  }
>;

/** System and lifecycle rows, by item type. Add a notice by adding its type here. */
export const WORK_LOG_NOTICES: {
  readonly [Type in NoticeItem["type"]]: (
    item: Extract<NoticeItem, { readonly type: Type }>,
  ) => WorkLogNotice;
} = {
  notification: (item) => {
    const label = item.summary;
    if (item.outcome === "failed") return { icon: "circle-alert", label, tone: "warning" };
    switch (item.source.kind) {
      case "system":
        return {
          icon: /restart|resum/i.test(label) ? "rotate-ccw" : "info",
          label,
          tone: "quiet",
        };
      case "subagent":
      case "delegated_task":
        return { icon: "bot", label, tone: "quiet" };
      case "command":
        return { icon: "terminal", label, tone: "quiet" };
      case "monitor":
        return { icon: "eye", label, tone: "quiet" };
      case "work_task":
        return { icon: "wrench", label, tone: "quiet" };
      default:
        return {
          icon: item.outcome === "cancelled" ? "square-stop" : "bell",
          label,
          tone: "quiet",
        };
    }
  },
  system_notice: (item) => ({ icon: "info", label: item.message, tone: "quiet" }),
  compaction: (item) => ({
    icon: "shrink",
    label: item.status === "running" ? "Compacting context" : "Context compacted",
    tone: item.status === "failed" ? "danger" : "quiet",
  }),
  run_interrupt_request: () => ({ icon: "square-stop", label: "Stop requested", tone: "quiet" }),
  run_interrupt_result: () => ({ icon: "square-stop", label: "Stopped", tone: "quiet" }),
  handoff: (item) => ({
    icon: "zap",
    label: "Context handed off",
    tone: item.status === "failed" ? "danger" : "quiet",
  }),
  fork: () => ({ icon: "git-fork", label: "Forked the conversation", tone: "quiet" }),
  checkpoint: () => ({ icon: "git-branch", label: "Checkpoint saved", tone: "quiet" }),
  thread_created: (item) => ({
    icon: "message-circle",
    label: item.title ? `Created chat ${quoted(item.title)}` : "Created a chat",
    tone: "quiet",
  }),
};

/** The notice row for a system or lifecycle item, or null for any other item. */
export function resolveWorkLogNotice(item: OrchestrationV2TurnItem): WorkLogNotice | null {
  if (item.type === "error") {
    return {
      icon: "circle-alert",
      label: item.failure.message,
      tone: item.failure.class === "usage_limit" ? "warning" : "danger",
    };
  }
  if (!Object.hasOwn(WORK_LOG_NOTICES, item.type)) return null;
  const present = WORK_LOG_NOTICES[item.type as NoticeItem["type"]] as (
    item: NoticeItem,
  ) => WorkLogNotice;
  return present(item as NoticeItem);
}
