import type {
  OrchestrationV2ThreadProjection,
  ThreadOutput,
  ThreadSource,
  ThreadSourcesResult,
} from "@cogenly/contracts";
import { ThreadId } from "@cogenly/contracts";
import { htmlRenderFromToolItem } from "@cogenly/shared/toolOutput";
import * as DateTime from "effect/DateTime";
import * as Predicate from "effect/Predicate";

/**
 * Derives what a thread used (sources) and made (outputs) from the compact rows
 * `ProjectionStore.getThreadSourceRecords` reads. Pure, so it is tested without
 * a database; the rows carry `unknown` JSON because they come straight from
 * `json_extract`.
 */

export interface ThreadSourceToolRow {
  readonly type: "dynamic_tool" | "file_change" | "web_search";
  readonly status: string;
  readonly at: string;
  readonly toolName: string | null;
  /** Tool input with bulky text fields removed; null when it was too large. */
  readonly input: unknown;
  /** Only read for the tools whose result names the thing (vault_fill, thread_read, html_render). */
  readonly output: unknown;
  readonly toolSource: unknown;
  readonly fileName: string | null;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly changes: unknown;
  readonly patterns: unknown;
  readonly results: unknown;
}

export interface ThreadSourceMessageRow {
  readonly role: string;
  readonly at: string;
  readonly attachments: unknown;
  /** Only the link-shaped context records: thread, integration, project-folder, mention. */
  readonly contextRecords: unknown;
}

export interface ThreadSourceCheckpointRow {
  readonly at: string;
  readonly status: string;
  readonly files: unknown;
}

export interface ThreadSourceRecords {
  readonly threadId: string;
  readonly tools: ReadonlyArray<ThreadSourceToolRow>;
  readonly messages: ReadonlyArray<ThreadSourceMessageRow>;
  readonly checkpoints: ReadonlyArray<ThreadSourceCheckpointRow>;
  readonly pullRequests: ReadonlyArray<unknown>;
}

/** The popover and `thread_read` show this many of each, most recent first. */
export const THREAD_SOURCES_LIMIT = 60;

const MAX_TEXT = 400;
const MAX_PATH = 2000;

function text(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.length > max ? undefined : trimmed;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== "");
  return parts.at(-1) ?? path;
}

/** The bare Cogenly tool name (`integration_call`) from Claude's or Codex's spelling. */
export function cogenlyToolName(toolName: string | null): string | null {
  if (toolName === null) return null;
  const match = /^(?:mcp__(?:cogenly|t3[-_]?code)__|(?:cogenly|t3-code)[.:/])(.+)$/i.exec(toolName);
  return match?.[1] ?? null;
}

/** Page URL and host for a URL or bare host (`example.com`), or null for anything else. */
export function pageOf(value: unknown): { host: string; url: string } | null {
  const raw = text(value, MAX_PATH);
  if (raw === undefined) return null;
  // A bare host gets the scheme the browser tools give it: http on loopback, https elsewhere.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `${/^(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(raw) ? "http" : "https"}://${raw}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.hostname === "") return null;
    // Credentials in a URL are never shown back.
    url.username = "";
    url.password = "";
    return { host: url.hostname.replace(/^www\./, ""), url: url.toString() };
  } catch {
    return null;
  }
}

/** A tool result's data object: structured content, or the first JSON text block. */
function resultData(value: unknown, depth = 0): Record<PropertyKey, unknown> | undefined {
  if (depth > 3) return undefined;
  if (typeof value === "string") {
    if (value.length > 65_536) return undefined;
    try {
      return resultData(JSON.parse(value), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const block of value.slice(0, 8)) {
      const found = resultData(Predicate.isObject(block) ? block.text : undefined, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!Predicate.isObject(value)) return undefined;
  const content = value.structuredContent ?? value.content;
  return content === undefined ? value : resultData(content, depth + 1);
}

type SourceDraft = ThreadSource extends infer S
  ? S extends ThreadSource
    ? Omit<S, "usedAt" | "uses">
    : never
  : never;
type OutputDraft = ThreadOutput;

class Collector {
  private readonly sources = new Map<string, ThreadSource>();
  private readonly outputs = new Map<string, ThreadOutput>();

  source(draft: SourceDraft, at: string): void {
    const existing = this.sources.get(draft.key);
    if (existing === undefined) {
      this.sources.set(draft.key, { ...draft, usedAt: at, uses: 1 } as ThreadSource);
      return;
    }
    const later = at >= existing.usedAt;
    // The latest use wins its details (a page's URL), and earlier labels fill gaps.
    const merged = (later ? { ...existing, ...draft } : { ...draft, ...existing }) as ThreadSource;
    this.sources.set(draft.key, {
      ...merged,
      usedAt: later ? at : existing.usedAt,
      uses: existing.uses + 1,
    } as ThreadSource);
  }

  output(draft: OutputDraft): void {
    const existing = this.outputs.get(draft.key);
    if (existing === undefined || draft.at >= existing.at) this.outputs.set(draft.key, draft);
  }

  hasOutputKind(kind: ThreadOutput["kind"]): boolean {
    for (const output of this.outputs.values()) if (output.kind === kind) return true;
    return false;
  }

  dropOutputs(predicate: (output: ThreadOutput) => boolean): void {
    for (const [key, output] of this.outputs) if (predicate(output)) this.outputs.delete(key);
  }

  result(): ThreadSourcesResult {
    const sources = [...this.sources.values()].toSorted((a, b) => b.usedAt.localeCompare(a.usedAt));
    const outputs = [...this.outputs.values()].toSorted((a, b) => b.at.localeCompare(a.at));
    return {
      sources: sources.slice(0, THREAD_SOURCES_LIMIT),
      outputs: outputs.slice(0, THREAD_SOURCES_LIMIT),
      sourceTotal: sources.length,
      outputTotal: outputs.length,
    };
  }
}

function projectSource(projectLabelId: string | undefined, label?: string): SourceDraft {
  return {
    kind: "project",
    key: `project:${projectLabelId ?? "self"}`,
    ...(projectLabelId === undefined ? {} : { projectLabelId }),
    ...(label === undefined ? {} : { label }),
  };
}

function collectTool(collector: Collector, row: ThreadSourceToolRow, threadId: string): void {
  if (row.status === "failed" || row.status === "declined") return;
  const at = row.at;
  if (row.type === "file_change") {
    const paths = new Set<string>();
    if (Array.isArray(row.changes)) {
      for (const change of row.changes) {
        const path = Predicate.isObject(change) ? text(change.path, MAX_PATH) : undefined;
        if (path !== undefined) paths.add(path);
      }
    }
    const fileName = text(row.fileName, MAX_PATH);
    if (paths.size === 0 && fileName !== undefined) paths.add(fileName);
    for (const path of paths) {
      const single = paths.size === 1;
      collector.output({
        kind: "file",
        key: `workspace:${path}`,
        at,
        location: "workspace",
        name: basename(path).slice(0, MAX_TEXT),
        path,
        ...(single && row.additions !== null ? { additions: row.additions } : {}),
        ...(single && row.deletions !== null ? { deletions: row.deletions } : {}),
      });
    }
    return;
  }
  if (row.type === "web_search") {
    // A search lists hits it did not open; only a fetch (no patterns) read its page.
    if (Array.isArray(row.patterns) && row.patterns.length > 0) return;
    if (!Array.isArray(row.results)) return;
    for (const result of row.results.slice(0, 4)) {
      const page = Predicate.isObject(result) ? pageOf(result.url) : null;
      if (page !== null) collector.source({ kind: "page", key: `page:${page.host}`, ...page }, at);
    }
    return;
  }

  const input = Predicate.isObject(row.input) ? row.input : {};
  // A third-party MCP server the agent called directly.
  if (Predicate.isObject(row.toolSource) && row.toolSource.kind === "integration") {
    const key = text(row.toolSource.key);
    const name = text(row.toolSource.name);
    if (key !== undefined && name !== undefined) {
      const icon = row.toolSource.icon;
      collector.source(
        {
          kind: "integration",
          key: `integration:${key}`,
          name: key,
          label: name,
          ...(Predicate.isObject(icon) ? { icon: icon as never } : {}),
        },
        at,
      );
    }
    return;
  }

  // Claude's native Read.
  if (row.toolName === "Read") {
    const path = text(input.file_path ?? input.path, MAX_PATH);
    if (path !== undefined) {
      collector.source(
        {
          kind: "file",
          key: `workspace:${path}`,
          location: "workspace",
          name: basename(path).slice(0, MAX_TEXT),
          path,
        },
        at,
      );
    }
    return;
  }

  const tool = cogenlyToolName(row.toolName);
  const projectLabelId = text(input.projectFolderId);
  switch (tool) {
    case "integration_call":
    case "integration_tools": {
      const name = text(input.name);
      if (name !== undefined) {
        collector.source({ kind: "integration", key: `integration:${name}`, name }, at);
      }
      return;
    }
    case "project_file_read": {
      const path = text(input.path, MAX_PATH);
      if (path === undefined) return;
      collector.source(
        {
          kind: "file",
          key: `project:${projectLabelId ?? "self"}:${path}`,
          location: "project",
          name: basename(path).slice(0, MAX_TEXT),
          path,
          ...(projectLabelId === undefined ? {} : { projectLabelId }),
        },
        at,
      );
      collector.source(projectSource(projectLabelId), at);
      return;
    }
    case "project_files_list":
    case "project_recall":
    case "project_overview":
      collector.source(projectSource(projectLabelId), at);
      return;
    case "memory_read":
    case "fact_search":
      collector.source({ kind: "memory", key: "memory" }, at);
      return;
    case "vault_fill": {
      const data = resultData(row.output);
      if (data !== undefined && data.status !== "filled") return;
      const item = Predicate.isObject(data?.item) ? data.item : undefined;
      const itemId = text(item?.id);
      // The name or label only: a username names a person and stays out.
      const name = text(item?.name) ?? text(input.name) ?? text(input.label);
      if (name === undefined) return;
      const host = text(data?.domain);
      collector.source(
        {
          kind: "vault",
          key: `vault:${itemId ?? name}`,
          name,
          ...(itemId === undefined ? {} : { itemId }),
          ...(host === undefined ? {} : { host }),
        },
        at,
      );
      return;
    }
    case "preview_open":
    case "preview_navigate": {
      const page = pageOf(input.url);
      if (page !== null) collector.source({ kind: "page", key: `page:${page.host}`, ...page }, at);
      return;
    }
    case "thread_read": {
      const target = text(input.threadId);
      if (target === undefined || target === threadId) return;
      const data = resultData(row.output);
      const thread = Predicate.isObject(data?.thread) ? data.thread : undefined;
      const title = text(thread?.title);
      collector.source(
        {
          kind: "thread",
          key: `thread:${target}`,
          threadId: ThreadId.make(target),
          ...(title === undefined ? {} : { title }),
        },
        at,
      );
      return;
    }
    case "html_render": {
      const render = htmlRenderFromToolItem({ toolName: row.toolName, output: row.output });
      if (render === undefined) return;
      collector.output({
        kind: "page",
        key: `page:${render.attachmentId}`,
        at,
        attachmentId: render.attachmentId,
        title: (text(render.title) ?? "Page").slice(0, MAX_TEXT),
      });
      return;
    }
    case "project_file_write": {
      const title = text(input.title);
      if (title === undefined) return;
      collector.output({
        kind: "file",
        key: `project:${projectLabelId ?? "self"}:${title}`,
        at,
        location: "project",
        name: title,
      });
      collector.source(projectSource(projectLabelId), at);
      return;
    }
    default:
      return;
  }
}

function collectMessage(collector: Collector, row: ThreadSourceMessageRow, threadId: string): void {
  const at = row.at;
  const attachments = Array.isArray(row.attachments) ? row.attachments : [];
  for (const attachment of attachments) {
    if (!Predicate.isObject(attachment)) continue;
    if (attachment.type !== "image" && attachment.type !== "file") continue;
    // Folded clipboard text is the user's own message, not a file they shared.
    if (attachment.source !== undefined) continue;
    const attachmentId = text(attachment.id);
    const name = text(attachment.name);
    const mimeType = text(attachment.mimeType);
    if (attachmentId === undefined || name === undefined || mimeType === undefined) continue;
    const sizeBytes =
      typeof attachment.sizeBytes === "number" && Number.isInteger(attachment.sizeBytes)
        ? { sizeBytes: Math.max(0, attachment.sizeBytes) }
        : {};
    if (row.role === "assistant") {
      collector.output({
        kind: "attachment",
        key: `attachment:${attachmentId}`,
        at,
        attachmentId,
        name,
        mimeType,
        ...sizeBytes,
      });
    } else if (row.role === "user") {
      collector.source(
        {
          kind: "file",
          key: `attachment:${attachmentId}`,
          location: "attachment",
          name,
          attachmentId,
          mimeType,
          ...sizeBytes,
        },
        at,
      );
    }
  }
  if (row.role !== "user" || !Array.isArray(row.contextRecords)) return;
  for (const record of row.contextRecords) {
    if (!Predicate.isObject(record)) continue;
    switch (record.kind) {
      case "thread": {
        const target = text(record.threadId);
        if (target === undefined || target === threadId) break;
        const title = text(record.title);
        collector.source(
          {
            kind: "thread",
            key: `thread:${target}`,
            threadId: ThreadId.make(target),
            ...(title === undefined ? {} : { title }),
          },
          at,
        );
        break;
      }
      case "integration": {
        const name = text(record.name);
        if (name === undefined) break;
        const label = text(record.displayName) ?? text(record.serviceName);
        collector.source(
          {
            kind: "integration",
            key: `integration:${name}`,
            name,
            ...(label === undefined ? {} : { label }),
          },
          at,
        );
        break;
      }
      case "project-folder": {
        collector.source(projectSource(text(record.projectFolderId), text(record.name)), at);
        break;
      }
      case "mention": {
        const path = text(record.path, MAX_PATH);
        if (path === undefined) break;
        collector.source(
          {
            kind: "file",
            key: `workspace:${path}`,
            location: "workspace",
            name: basename(path).slice(0, MAX_TEXT),
            path,
          },
          at,
        );
        break;
      }
      default:
        break;
    }
  }
}

function collectCheckpoints(
  collector: Collector,
  rows: ReadonlyArray<ThreadSourceCheckpointRow>,
): void {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  let at: string | null = null;
  for (const row of rows) {
    if (row.status !== "ready" || !Array.isArray(row.files)) continue;
    for (const file of row.files) {
      if (!Predicate.isObject(file)) continue;
      const path = text(file.path, MAX_PATH);
      if (path === undefined) continue;
      files.add(path);
      additions += typeof file.additions === "number" ? file.additions : 0;
      deletions += typeof file.deletions === "number" ? file.deletions : 0;
      if (at === null || row.at > at) at = row.at;
    }
  }
  if (files.size === 0 || at === null) return;
  collector.output({
    kind: "changes",
    key: "changes",
    at,
    fileCount: files.size,
    additions,
    deletions,
  });
}

function collectPullRequests(collector: Collector, links: ReadonlyArray<unknown>): void {
  for (const link of links) {
    if (!Predicate.isObject(link) || link.source === "stack-dismissed") continue;
    const url = text(link.url, MAX_PATH);
    const repository = text(link.repository);
    const number = link.number;
    const at = text(link.linkedAt);
    if (url === undefined || repository === undefined || at === undefined) continue;
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1) continue;
    const title = Predicate.isObject(link.snapshot) ? text(link.snapshot.title) : undefined;
    collector.output({
      kind: "pull_request",
      key: `pr:${url}`,
      at,
      url,
      repository,
      number,
      ...(title === undefined ? {} : { title }),
    });
  }
}

/** The same rows from a decoded projection, for stores that keep projections in memory. */
export function threadSourceRecordsFromProjection(
  projection: OrchestrationV2ThreadProjection,
): ThreadSourceRecords {
  const tools: ThreadSourceToolRow[] = [];
  for (const item of projection.turnItems) {
    const base = { status: item.status, at: DateTime.formatIso(item.updatedAt) };
    if (item.type === "dynamic_tool") {
      tools.push({
        ...base,
        ...EMPTY_TOOL_FIELDS,
        type: "dynamic_tool",
        toolName: item.toolName,
        input: item.input,
        output: item.output,
        toolSource: item.toolSource ?? null,
      });
    } else if (item.type === "file_change") {
      tools.push({
        ...base,
        ...EMPTY_TOOL_FIELDS,
        type: "file_change",
        fileName: item.fileName,
        additions: item.additions ?? null,
        deletions: item.deletions ?? null,
        changes: item.changes ?? null,
      });
    } else if (item.type === "web_search") {
      tools.push({
        ...base,
        ...EMPTY_TOOL_FIELDS,
        type: "web_search",
        patterns: item.patterns ?? null,
        results: item.results ?? null,
      });
    }
  }
  return {
    threadId: projection.thread.id,
    tools,
    messages: projection.messages.map((message) => ({
      role: message.role,
      at: DateTime.formatIso(message.createdAt),
      attachments: message.attachments,
      contextRecords: message.context?.records ?? null,
    })),
    checkpoints: projection.checkpoints.map((checkpoint) => ({
      at: DateTime.formatIso(checkpoint.capturedAt),
      status: checkpoint.status,
      files: checkpoint.files,
    })),
    pullRequests: projection.thread.pullRequests ?? [],
  };
}

const EMPTY_TOOL_FIELDS = {
  toolName: null,
  input: null,
  output: null,
  toolSource: null,
  fileName: null,
  additions: null,
  deletions: null,
  changes: null,
  patterns: null,
  results: null,
} as const;

export function deriveThreadSources(records: ThreadSourceRecords): ThreadSourcesResult {
  const collector = new Collector();
  for (const row of records.tools) collectTool(collector, row, records.threadId);
  for (const row of records.messages) collectMessage(collector, row, records.threadId);
  collectCheckpoints(collector, records.checkpoints);
  // Checkpoints already sum every workspace edit into one diff; listing each
  // edited file beside it would repeat it.
  if (collector.hasOutputKind("changes")) {
    collector.dropOutputs((output) => output.kind === "file" && output.location === "workspace");
  }
  collectPullRequests(collector, records.pullRequests);
  return collector.result();
}
