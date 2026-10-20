import {
  isToolLifecycleItemType,
  type AssetResource,
  type RuntimeItemStatus,
  type ToolActivitySource,
  type ToolActivitySurface,
  type ToolActivityIcon,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveT3McpToolDefinition } from "@t3tools/shared/t3McpToolPresentation";
import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import { resolveMediaSource } from "@t3tools/client-runtime/media-source";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { toolOutputIndicatesFailure } from "@t3tools/shared/toolOutput";

import { t3ToolResultIndicatesFailure } from "@t3tools/client-runtime/t3ToolSummary";
import {
  resolveWorkLogTool,
  workLogCallFromItem,
  workLogToolGroupLabel,
  type WorkLogToolCallInput,
  type WorkLogToolIcon,
  type WorkLogToolPresentation,
  type WorkLogToolStatus,
} from "./toolRegistry.ts";

export type WorkLogToolLifecycleStatus = RuntimeItemStatus | "stopped" | "idle";

/** Inspection and copying omit raw outputs, including values from older caches. */
export function toolItemForDisplay(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "command_execution":
    case "dynamic_tool": {
      const { output: _output, ...displayItem } = item;
      return displayItem;
    }
    case "file_change": {
      const { diffStr, oldStr: _oldStr, newStr: _newStr, ...displayItem } = item;
      // A failed edit's diffStr holds the provider's error, not a diff.
      return item.status === "failed" && diffStr?.trim()
        ? { ...displayItem, diffStr }
        : displayItem;
    }
    default:
      return item;
  }
}

export function contextCompactionLabel(
  item: Pick<
    Extract<OrchestrationV2TurnItem, { type: "compaction" }>,
    "status" | "beforeTokenCount" | "afterTokenCount"
  >,
): string {
  if (item.status === "running") return "Compacting context";
  if (item.beforeTokenCount !== undefined && item.afterTokenCount !== undefined) {
    return `Context compacted ${formatTokens(item.beforeTokenCount)} → ${formatTokens(item.afterTokenCount)} tokens`;
  }
  return "Context compacted";
}

export interface WorkLogPresentationEntry {
  readonly questionAnswer?: import("@t3tools/contracts").UserInputAttachmentAnswerPayload;
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly tone: "thinking" | "tool" | "info" | "error";
  readonly command?: string;
  readonly rawCommand?: string;
  readonly detail?: string;
  readonly viewedImagePath?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly toolTitle?: string;
  readonly toolData?: unknown;
  readonly requestKind?: string;
  readonly itemType?: OrchestrationV2TurnItem["type"];
  readonly toolLifecycleStatus?: WorkLogToolLifecycleStatus;
  readonly structuredPayload?: OrchestrationV2TurnItem;
  readonly toolSource?: ToolActivitySource;
  readonly toolSurface?: ToolActivitySurface;
  readonly toolIcon?: ToolActivityIcon;
}

/** Structured identity is authoritative, including when it identifies a foreign server. */
function workEntryToolName(
  entry: Pick<WorkLogPresentationEntry, "label" | "toolTitle" | "toolData" | "structuredPayload">,
): string | undefined {
  const item = entry.structuredPayload;
  if (item?.type === "dynamic_tool" && item.toolName) return item.toolName;
  const data = asRecord(entry.toolData);
  if (typeof data?.server === "string" && typeof data.tool === "string") {
    return `${data.server}.${data.tool}`;
  }
  if (typeof data?.toolName === "string") return data.toolName;
  return resolveT3McpToolDefinition(entry.toolTitle) ? entry.toolTitle : undefined;
}

function workEntryToolOutput(
  entry: Pick<WorkLogPresentationEntry, "toolData" | "structuredPayload">,
): unknown {
  const item = entry.structuredPayload;
  const data = asRecord(entry.toolData);
  return item?.type === "dynamic_tool"
    ? item.output
    : (data?.output ?? data?.result ?? data?.rawOutput ?? data?.content);
}

function registryStatus(status: string | undefined): WorkLogToolStatus {
  return status === "completed" ||
    status === "failed" ||
    status === "declined" ||
    status === "stopped"
    ? status
    : "inProgress";
}

type ToolEntry = Pick<
  WorkLogPresentationEntry,
  | "label"
  | "toolTitle"
  | "toolData"
  | "toolLifecycleStatus"
  | "structuredPayload"
  | "itemType"
  | "toolSurface"
>;

/**
 * The registry call for a work entry, or null when it is not a tool call.
 * Structured turn items map by type; older entries fall back to their tool name.
 */
export function workEntryToolCall(
  entry: ToolEntry,
  fallbackStatus?: "inProgress" | "completed",
): WorkLogToolCallInput | null {
  const status = registryStatus(entry.toolLifecycleStatus ?? fallbackStatus);
  const item = entry.structuredPayload;
  const call = item
    ? workLogCallFromItem(item, status)
    : (() => {
        const toolName = workEntryToolName(entry);
        if (!toolName) return null;
        const data = asRecord(entry.toolData);
        return {
          toolName,
          input: data?.arguments ?? data?.input ?? data?.rawInput,
          output: workEntryToolOutput(entry),
          status,
        };
      })();
  if (!call) return null;
  const surfaced = entry.toolSurface ? { ...call, surface: entry.toolSurface } : call;
  // MCP errors can come back as data from a call the provider completed.
  return resolveT3McpToolDefinition(call.toolName) && t3ToolResultIndicatesFailure(call.output)
    ? { ...surfaced, status: "failed" }
    : surfaced;
}

/** The registry row for a work entry's tool call, or null when the entry is not a tool call. */
export function resolveWorkEntryTool(
  entry: ToolEntry,
  fallbackStatus?: "inProgress" | "completed",
): WorkLogToolPresentation | null {
  if (entry.itemType === "reasoning") return null;
  const call = workEntryToolCall(entry, fallbackStatus);
  return call ? resolveWorkLogTool(call) : null;
}

/** Only active or completed calls can inherit the live group’s present tense. */
export function liveActivityToolStatus(status: string | undefined, presentTense: boolean) {
  if (status === "failed" || status === "declined" || status === "stopped" || status === "idle") {
    return status;
  }
  if (presentTense || status === "inProgress") return "inProgress";
  return "completed";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function commandResultContent(value: unknown): string | null {
  const direct = nonEmptyString(value);
  if (direct) return direct;

  const directContent = Array.isArray(value) ? value : null;
  const record = asRecord(value);
  const content = record?.content;
  const contentText = nonEmptyString(content);
  if (contentText) return contentText;
  const blocks = directContent ?? (Array.isArray(content) ? content : null);
  if (!blocks) return null;

  const chunks = blocks.flatMap((entry) => {
    const text = nonEmptyString(entry) ?? nonEmptyString(asRecord(entry)?.text);
    return text ? [text] : [];
  });
  return chunks.length > 0 ? chunks.join("\n") : null;
}

/** Returns provider command output before it is formatted for a work-log row. */
export function extractCommandOutputText(dataValue: unknown): string | null {
  const data = asRecord(dataValue);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const rawOutput = asRecord(data?.rawOutput);
  const outputStreams = [
    nonEmptyString(rawOutput?.stdout),
    nonEmptyString(rawOutput?.stderr),
  ].filter((value): value is string => value !== null);
  const acpContent = Array.isArray(data?.content)
    ? data.content
        .flatMap((entryValue) => {
          const entry = asRecord(entryValue);
          const content = asRecord(entry?.content);
          const text = entry?.type === "content" ? nonEmptyString(content?.text) : null;
          return text ? [text] : [];
        })
        .join("\n")
    : null;

  const candidates = [
    item?.aggregatedOutput,
    itemResult?.content,
    data?.rawOutput,
    rawOutput?.content,
    outputStreams.length > 0 ? outputStreams.join("\n") : null,
    rawOutput?.output,
    acpContent,
    data?.result,
  ];
  for (const candidate of candidates) {
    const text = commandResultContent(candidate);
    if (text) return text;
  }
  return null;
}

/**
 * Ingestion caps tool details at 180 chars and appends "...", so a long command
 * echo no longer equals the command it repeats. Treat a truncated prefix of the
 * command as the same echo.
 */
function textRepeatsCommand(text: string, commands: ReadonlyArray<string | null>): boolean {
  const truncated = text.endsWith("...")
    ? text.slice(0, -3)
    : text.endsWith("\u2026")
      ? text.slice(0, -1)
      : null;
  return commands.some((candidate) => {
    const command = candidate?.trim();
    if (!command) return false;
    if (command === text) return true;
    return (
      truncated !== null &&
      truncated.length > 0 &&
      command.length > truncated.length &&
      command.startsWith(truncated)
    );
  });
}

/**
 * Decides whether a command row's `detail` is a synthetic echo of the command
 * rather than real output. OpenCode stores completed output in `detail` with no
 * other output channel, so plain equality is only treated as synthetic when the
 * payload shape shows the detail came from the command: Codex item metadata,
 * an ACP tool call (`data.toolCallId`, `kind: "execute"`), a Claude tool-name
 * prefix, or no structured command at all.
 */
export function commandDetailRepeatsCommand(input: {
  readonly detail: string;
  readonly command: string | null;
  readonly rawCommand: string | null;
  readonly toolName: unknown;
  readonly data: unknown;
}): boolean {
  const toolName = nonEmptyString(input.toolName)?.trim();
  const detail = input.detail.trim();
  const commands = [input.command, input.rawCommand];
  if (toolName) {
    const prefix = `${toolName}:`;
    if (detail.toLowerCase().startsWith(prefix.toLowerCase())) {
      const unprefixed = detail.slice(prefix.length).trim();
      if (textRepeatsCommand(unprefixed, commands)) return true;
    }
  }

  if (!textRepeatsCommand(detail, commands)) return false;

  const data = asRecord(input.data);
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const hasStructuredCommand = [
    item?.command,
    itemInput?.command,
    itemResult?.command,
    data?.command,
  ].some((value) =>
    Array.isArray(value)
      ? value.some((part) => nonEmptyString(part) !== null)
      : nonEmptyString(value) !== null,
  );
  return (
    !hasStructuredCommand ||
    item !== null ||
    data?.toolCallId !== undefined ||
    nonEmptyString(data?.kind)?.toLowerCase() === "execute"
  );
}

function workLogEntryIsToolLike(entry: WorkLogPresentationEntry): boolean {
  if (entry.tone === "tool" || entry.tone === "thinking" || entry.tone === "error") return true;
  if (entry.command !== undefined && entry.command.trim().length > 0) return true;
  if (entry.requestKind !== undefined) return true;
  return entry.itemType !== undefined && isToolLifecycleItemType(entry.itemType);
}

function workEntryIndicatesToolFailureFromOutput(
  entry: WorkLogPresentationEntry,
  includeCommand: boolean,
): boolean {
  if (
    entry.tone === "error" ||
    entry.toolLifecycleStatus === "failed" ||
    entry.toolLifecycleStatus === "declined"
  ) {
    return true;
  }
  if (!workLogEntryIsToolLike(entry)) return false;
  if (
    resolveT3McpToolDefinition(workEntryToolName(entry)) &&
    t3ToolResultIndicatesFailure(workEntryToolOutput(entry))
  ) {
    return true;
  }
  const item = entry.structuredPayload;
  if (item?.type === "command_execution") {
    if (item.outputIndicatesFailure || (item.exitCode !== undefined && item.exitCode !== 0)) {
      return true;
    }
    // Older servers/caches can still carry output. Read only the previous
    // preview-sized prefix for status, without exposing it in the row detail.
    if (item.output && toolOutputIndicatesFailure(item.output.slice(0, 32_768))) {
      return true;
    }
  }
  const output = includeCommand
    ? [entry.detail, entry.command].filter(Boolean).join("\n")
    : (entry.detail ?? "");
  return output.length > 0 && toolOutputIndicatesFailure(output);
}

/** Includes legacy activities that stored error output in the command field. */
export function workEntryIndicatesToolFailure(entry: WorkLogPresentationEntry): boolean {
  return workEntryIndicatesToolFailureFromOutput(entry, true);
}

/** Checks rendered output without treating the user's command as an error. */
export function workEntryDisplayIndicatesToolFailure(entry: WorkLogPresentationEntry): boolean {
  return workEntryIndicatesToolFailureFromOutput(entry, false);
}

/** Decides whether the row can show a success marker. */
export function workEntryIndicatesToolSuccess(entry: WorkLogPresentationEntry): boolean {
  return (
    workLogEntryIsToolLike(entry) &&
    !workEntryIndicatesToolFailure(entry) &&
    entry.tone !== "thinking" &&
    entry.toolLifecycleStatus !== "idle" &&
    entry.toolLifecycleStatus !== "inProgress" &&
    entry.toolLifecycleStatus !== "stopped"
  );
}

export function workEntryViewedImagePath(entry: WorkLogPresentationEntry): string | null {
  const viewedImagePath = entry.viewedImagePath?.trim();
  if (
    viewedImagePath !== undefined &&
    !/[\r\n]/.test(viewedImagePath) &&
    isWorkspaceImagePreviewPath(viewedImagePath)
  ) {
    return viewedImagePath;
  }
  const detail = entry.detail?.trim();
  return resolveWorkEntryTool(entry)?.key === "read" &&
    detail !== undefined &&
    !/[\r\n]/.test(detail) &&
    isWorkspaceImagePreviewPath(detail)
    ? detail
    : null;
}

export interface ViewedImageAsset {
  readonly resource: Extract<AssetResource, { readonly _tag: "media-file" }>;
  readonly alt: string;
  readonly srcFragment: string;
}

export function resolveViewedImageAsset(
  source: string,
  input: {
    readonly threadId: ThreadId;
    readonly workspaceRoot?: string | null | undefined;
  },
): ViewedImageAsset | null {
  // A relative path with no known workspace still names a media-file relative
  // to the thread's workspace, so classify against "." and drop the prefix.
  const imageSource = classifyMarkdownImageSource(source, input.workspaceRoot ?? ".");
  if (imageSource._tag !== "WorkspaceFile") return null;
  const resolvedFilePath =
    input.workspaceRoot == null && imageSource.path.startsWith("./")
      ? imageSource.path.slice(2)
      : imageSource.path;

  const media = resolveMediaSource(source, {
    threadId: input.threadId,
    workspaceRoot: input.workspaceRoot,
    resolvedFilePath,
  });
  if (media === null || media.access !== "environment") return null;
  return { resource: media.resource, alt: media.name, srcFragment: media.srcFragment };
}

/** Summarizes at most two tool groups; every omitted call still counts in the remainder. */
export function summarizeToolGroup(entries: ReadonlyArray<WorkLogPresentationEntry>): {
  summary: string;
  hasFailure: boolean;
} {
  const toolEntries = entries.filter((entry) => entry.itemType !== "reasoning");
  if (entries.length > 0 && toolEntries.length === 0) {
    return {
      summary: entries.length === 1 ? "Thought" : `Thought (×${entries.length})`,
      hasFailure: false,
    };
  }
  const groups = new Map<
    string,
    { priority: number; calls: WorkLogToolCallInput[]; entries: WorkLogPresentationEntry[] }
  >();
  const sources = new Map<string, ToolActivitySource>();
  let sourcedCount = 0;
  let updateCount = 0;
  for (const entry of toolEntries) {
    const call = workEntryToolCall(entry, "completed");
    const tool = call ? resolveWorkLogTool(call) : null;
    if (!call || !tool) {
      updateCount += 1;
      continue;
    }
    // An integration's own tools read as the integration, not one row per tool.
    if (tool.source === "generic" && entry.toolSource) {
      sources.set(entry.toolSource.key, entry.toolSource);
      sourcedCount += 1;
      continue;
    }
    const group = groups.get(tool.groupKey);
    if (group) {
      group.calls.push(call);
      group.entries.push(entry);
    } else {
      groups.set(tool.groupKey, { priority: tool.priority, calls: [call], entries: [entry] });
    }
  }
  const summaries = [...groups.values()].map((group, index) => ({
    index,
    count: group.entries.length,
    priority: group.priority,
    label: workLogToolGroupLabel(group.calls) ?? `Used ${group.entries.length} tools`,
    failedCount: group.entries.filter(workEntryDisplayIndicatesToolFailure).length,
  }));
  const selected = [...summaries]
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index);
  const labels = selected.map(({ label }) => label);
  if (sources.size > 0) {
    const sourceValues = [...sources.values()];
    const sourceNames = [...new Set(sourceValues.map((source) => source.name))];
    const allIntegrations = sourceValues.every((source) => source.kind === "integration");
    labels.unshift(
      `Used ${listNames(sourceNames)}${allIntegrations ? ` ${sourceNames.length === 1 ? "integration" : "integrations"}` : ""}`,
    );
  }
  const remainingCount =
    toolEntries.length -
    sourcedCount -
    updateCount -
    selected.reduce((total, group) => total + group.count, 0);
  if (remainingCount > 0) {
    labels.push(`Performed ${remainingCount} other ${remainingCount === 1 ? "action" : "actions"}`);
  }
  if (updateCount > 0 && labels.length === 0) {
    labels.push(`Received ${updateCount} ${updateCount === 1 ? "update" : "updates"}`);
  }
  const sentenceLabels = labels.map((label, index) =>
    index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1),
  );
  return {
    summary: listNames(sentenceLabels),
    hasFailure: summaries.some((group) => group.failedCount > 0),
  };
}

function listNames(names: ReadonlyArray<string>): string {
  return names.length < 3
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/**
 * The header icon for a group: the thought icon for reasoning alone, otherwise
 * the icon most of its tool calls share, earliest first on a tie.
 */
export function toolGroupIcon(
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): WorkLogToolIcon | "brain" | null {
  const toolEntries = entries.filter((entry) => entry.itemType !== "reasoning");
  if (entries.length > 0 && toolEntries.length === 0) return "brain";
  const tally = new Map<WorkLogToolIcon, number>();
  for (const entry of toolEntries) {
    const icon = resolveWorkEntryTool(entry, "completed")?.icon;
    if (icon) tally.set(icon, (tally.get(icon) ?? 0) + 1);
  }
  let best: WorkLogToolIcon | null = null;
  for (const [icon, count] of tally) {
    if (best === null || count > tally.get(best)!) best = icon;
  }
  return best;
}

/**
 * Plain-text line for the latest thought in the live activity row. A
 * bold-only opening line (the Codex summary heading) wins; otherwise this is
 * the first sentence of the reasoning text. Web and mobile both render it.
 */
export function liveThoughtLine(markdown: string): string {
  const heading = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?(?:\n|$)/.exec(markdown)?.[1];
  const text = (heading ?? markdown)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/`+|\*\*|~~/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (heading !== undefined) return text;
  // Cut after the first . ? or ! (plus a closing quote or paren) that a space follows.
  const end = /[.?!]["'”’)]?(?=\s)/.exec(text);
  return end ? text.slice(0, end.index + end[0].length) : text;
}
