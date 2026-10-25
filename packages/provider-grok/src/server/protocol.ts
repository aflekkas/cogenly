/**
 * Agent Client Protocol shapes Grok sends, read leniently, and their mapping
 * onto Cogenly's timeline fields. Pure functions only, so recorded frames can
 * be tested without a live CLI.
 *
 * @module provider-grok/server/protocol
 */
import type {
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemStatus,
  ProviderApprovalDecision,
} from "@cogenly/contracts";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const asString = (value: unknown) => (typeof value === "string" ? value : undefined);
const asNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export type AcpToolStatus = "pending" | "in_progress" | "completed" | "failed";

/** One ACP tool call as its updates have built it so far. */
export interface GrokToolCall {
  readonly toolCallId: string;
  readonly title: string;
  readonly kind: string | undefined;
  readonly status: AcpToolStatus;
  readonly rawInput: unknown;
  readonly rawOutput: unknown;
  /** Text content blocks, in order. */
  readonly text: ReadonlyArray<string>;
  readonly diffs: ReadonlyArray<{
    readonly path: string;
    readonly oldText: string | null;
    readonly newText: string;
  }>;
  readonly locations: ReadonlyArray<string>;
}

export interface GrokPlanEntry {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
}

/** The `session/update` variants Cogenly shows; anything else is ignored. */
export type GrokSessionUpdate =
  | { readonly type: "agent_message_chunk"; readonly text: string }
  | { readonly type: "agent_thought_chunk"; readonly text: string }
  | { readonly type: "tool_call"; readonly toolCall: GrokToolCall }
  | {
      readonly type: "tool_call_update";
      readonly toolCallId: string;
      readonly patch: Partial<Omit<GrokToolCall, "toolCallId">>;
    }
  | { readonly type: "plan"; readonly entries: ReadonlyArray<GrokPlanEntry> }
  | { readonly type: "usage_update"; readonly used: number; readonly size: number | undefined };

const toolStatus = (value: unknown): AcpToolStatus | undefined =>
  value === "pending" || value === "in_progress" || value === "completed" || value === "failed"
    ? value
    : undefined;

/** Text and diffs from an ACP tool-call `content` array. */
function toolContent(value: unknown): Pick<GrokToolCall, "text" | "diffs"> | undefined {
  if (!Array.isArray(value)) return undefined;
  const text: Array<string> = [];
  const diffs: Array<GrokToolCall["diffs"][number]> = [];
  for (const entry of value) {
    const block = asRecord(entry);
    if (!block) continue;
    if (block.type === "content") {
      const inner = asRecord(block.content);
      const value = asString(inner?.text);
      if (inner?.type === "text" && value) text.push(value);
    } else if (block.type === "diff") {
      const path = asString(block.path);
      const newText = asString(block.newText);
      if (path && newText !== undefined)
        diffs.push({ path, oldText: asString(block.oldText) ?? null, newText });
    }
  }
  return { text, diffs };
}

function locations(value: unknown): ReadonlyArray<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => {
    const path = asString(asRecord(entry)?.path);
    return path ? [path] : [];
  });
}

/** Parses one `session/update` notification's `update` object. */
export function parseGrokSessionUpdate(value: unknown): GrokSessionUpdate | undefined {
  const update = asRecord(value);
  if (!update) return undefined;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const content = asRecord(update.content);
      const text = content?.type === "text" ? asString(content.text) : undefined;
      return text === undefined ? undefined : { type: update.sessionUpdate, text };
    }
    case "tool_call": {
      const toolCallId = asString(update.toolCallId);
      if (!toolCallId) return undefined;
      const content = toolContent(update.content) ?? { text: [], diffs: [] };
      return {
        type: "tool_call",
        toolCall: {
          toolCallId,
          title: asString(update.title)?.trim() || "Tool",
          kind: asString(update.kind),
          status: toolStatus(update.status) ?? "pending",
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
          ...content,
          locations: locations(update.locations) ?? [],
        },
      };
    }
    case "tool_call_update": {
      const toolCallId = asString(update.toolCallId);
      if (!toolCallId) return undefined;
      const status = toolStatus(update.status);
      const title = asString(update.title)?.trim();
      const kind = asString(update.kind);
      const content = toolContent(update.content);
      const paths = locations(update.locations);
      return {
        type: "tool_call_update",
        toolCallId,
        patch: {
          ...(status ? { status } : {}),
          ...(title ? { title } : {}),
          ...(kind ? { kind } : {}),
          ...("rawInput" in update ? { rawInput: update.rawInput } : {}),
          ...("rawOutput" in update ? { rawOutput: update.rawOutput } : {}),
          ...(content ?? {}),
          ...(paths ? { locations: paths } : {}),
        },
      };
    }
    case "plan": {
      if (!Array.isArray(update.entries)) return undefined;
      return {
        type: "plan",
        entries: update.entries.flatMap((entry): Array<GrokPlanEntry> => {
          const record = asRecord(entry);
          const content = asString(record?.content)?.trim();
          if (!content) return [];
          const status = record?.status;
          return [
            {
              content,
              status:
                status === "completed" || status === "in_progress" ? status : ("pending" as const),
            },
          ];
        }),
      };
    }
    case "usage_update": {
      const used = asNumber(update.used);
      return used === undefined
        ? undefined
        : { type: "usage_update", used, size: asNumber(update.size) };
    }
    default:
      return undefined;
  }
}

/** Merges a `tool_call_update` into what earlier frames reported. */
export function applyGrokToolPatch(
  tool: GrokToolCall,
  patch: Partial<Omit<GrokToolCall, "toolCallId">>,
): GrokToolCall {
  return { ...tool, ...patch };
}

export function grokToolItemStatus(status: AcpToolStatus): OrchestrationV2TurnItemStatus {
  return status === "completed" ? "completed" : status === "failed" ? "failed" : "running";
}

type Fields<
  T extends OrchestrationV2TurnItem["type"],
  K extends keyof Extract<OrchestrationV2TurnItem, { type: T }>,
> = Pick<Extract<OrchestrationV2TurnItem, { type: T }>, K>;
export type GrokToolPresentation = {
  readonly status: OrchestrationV2TurnItemStatus;
  readonly title: string | null;
} & (
  | Fields<"command_execution", "type" | "input" | "output">
  | Fields<"file_change", "type" | "fileName" | "oldStr" | "newStr">
  | Fields<"web_search", "type" | "patterns" | "results">
  | Fields<"dynamic_tool", "type" | "toolName" | "input" | "output">
);

function stringArg(input: unknown, ...keys: ReadonlyArray<string>) {
  const record = asRecord(input);
  for (const key of keys) {
    const value = asString(record?.[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function outputText(tool: GrokToolCall): string {
  if (tool.text.length) return tool.text.join("\n");
  if (typeof tool.rawOutput === "string") return tool.rawOutput;
  const output = asRecord(tool.rawOutput);
  const text =
    asString(output?.output) ??
    asString(output?.stdout) ??
    asString(output?.content) ??
    asString(output?.result);
  if (text !== undefined) return text;
  return tool.rawOutput === undefined ? "" : JSON.stringify(tool.rawOutput);
}

/** Converts an ACP tool call into the shared timeline row every client renders. */
export function grokToolPresentation(tool: GrokToolCall): GrokToolPresentation {
  const status = grokToolItemStatus(tool.status);
  const shared = { status, title: tool.title };
  const output = outputText(tool);
  if (tool.kind === "execute") {
    return {
      ...shared,
      type: "command_execution",
      input: stringArg(tool.rawInput, "command", "cmd") ?? tool.title,
      output,
    };
  }
  const diff = tool.diffs[0];
  if ((tool.kind === "edit" || tool.kind === "delete" || tool.kind === "move") && diff) {
    return {
      ...shared,
      type: "file_change",
      fileName: diff.path,
      ...(diff.oldText === null ? {} : { oldStr: diff.oldText }),
      newStr: diff.newText,
    };
  }
  if (tool.kind === "fetch") {
    const query = stringArg(tool.rawInput, "query", "url")?.trim();
    const url = stringArg(tool.rawInput, "url")?.trim();
    return {
      ...shared,
      type: "web_search",
      ...(query ? { patterns: [query] } : {}),
      ...(output ? { results: [{ ...(url ? { url } : {}), snippet: output }] } : {}),
    };
  }
  return {
    ...shared,
    type: "dynamic_tool",
    toolName: tool.kind ? `${tool.kind}: ${tool.title}` : tool.title,
    input: asRecord(tool.rawInput) ?? (tool.locations.length ? { paths: tool.locations } : ""),
    output,
  };
}

/** One choice Grok offers in `session/request_permission`. */
export interface GrokPermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface GrokPermissionRequest {
  readonly sessionId: string;
  readonly toolCallId: string | undefined;
  readonly title: string;
  readonly kind: string | undefined;
  readonly rawInput: unknown;
  readonly options: ReadonlyArray<GrokPermissionOption>;
}

export function parseGrokPermissionRequest(value: unknown): GrokPermissionRequest | undefined {
  const params = asRecord(value);
  const sessionId = asString(params?.sessionId);
  if (!sessionId || !Array.isArray(params?.options)) return undefined;
  const toolCall = asRecord(params.toolCall);
  return {
    sessionId,
    toolCallId: asString(toolCall?.toolCallId),
    title: asString(toolCall?.title)?.trim() || "Grok requests permission",
    kind: asString(toolCall?.kind),
    rawInput: toolCall?.rawInput,
    options: params.options.flatMap((entry): Array<GrokPermissionOption> => {
      const option = asRecord(entry);
      const optionId = asString(option?.optionId);
      const kind = option?.kind;
      if (
        !optionId ||
        (kind !== "allow_once" &&
          kind !== "allow_always" &&
          kind !== "reject_once" &&
          kind !== "reject_always")
      )
        return [];
      return [{ optionId, name: asString(option?.name) || optionId, kind }];
    }),
  };
}

const DECISION_OPTION_KINDS: Record<
  Exclude<ProviderApprovalDecision, "cancel">,
  ReadonlyArray<GrokPermissionOption["kind"]>
> = {
  accept: ["allow_once", "allow_always"],
  acceptForSession: ["allow_always", "allow_once"],
  acceptAlways: ["allow_always"],
  decline: ["reject_once", "reject_always"],
};

/** The native option a Cogenly decision selects; `cancel` answers with ACP's cancelled outcome. */
export function grokPermissionOutcome(
  request: Pick<GrokPermissionRequest, "options">,
  decision: ProviderApprovalDecision,
):
  | { readonly outcome: "selected"; readonly optionId: string }
  | { readonly outcome: "cancelled" }
  | undefined {
  if (decision === "cancel") return { outcome: "cancelled" };
  for (const kind of DECISION_OPTION_KINDS[decision]) {
    const option = request.options.find((candidate) => candidate.kind === kind);
    if (option) return { outcome: "selected", optionId: option.optionId };
  }
  return undefined;
}

/** The approval buttons to show: one per decision Grok offers an option for. */
export function grokApprovalOptions(request: Pick<GrokPermissionRequest, "options">) {
  const decisions: ReadonlyArray<Exclude<ProviderApprovalDecision, "cancel">> = [
    "accept",
    "acceptAlways",
    "decline",
  ];
  const seen = new Set<string>();
  return decisions.flatMap((decision) => {
    const outcome = grokPermissionOutcome(request, decision);
    if (outcome?.outcome !== "selected" || seen.has(outcome.optionId)) return [];
    seen.add(outcome.optionId);
    const option = request.options.find((candidate) => candidate.optionId === outcome.optionId);
    return [{ decision, label: option?.name ?? decision }];
  });
}

/** Tool kinds that change the machine; chat-surface threads decline them. */
export const GROK_MUTATING_TOOL_KINDS: ReadonlySet<string> = new Set([
  "edit",
  "delete",
  "move",
  "execute",
]);

export function grokRequestKind(
  kind: string | undefined,
): "command" | "file-read" | "file-change" | "permission" {
  if (kind === "execute") return "command";
  if (kind === "read" || kind === "search") return "file-read";
  if (kind === "edit" || kind === "delete" || kind === "move") return "file-change";
  return "permission";
}

export interface GrokTurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens: number;
  readonly cacheCreationTokens: number | undefined;
}

/**
 * Token usage from a `session/prompt` result. ACP's `usage` is camelCase;
 * Grok's headless JSON uses snake_case, so both are read.
 */
export function parseGrokPromptUsage(result: unknown): GrokTurnUsage | undefined {
  const record = asRecord(result);
  const usage = asRecord(record?.usage) ?? asRecord(asRecord(record?._meta)?.usage);
  if (!usage) return undefined;
  const pick = (...keys: ReadonlyArray<string>) => {
    for (const key of keys) {
      const value = asNumber(usage[key]);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const inputTokens = pick("inputTokens", "input_tokens");
  const outputTokens = pick("outputTokens", "output_tokens");
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cachedInputTokens:
      pick("cachedReadTokens", "cacheReadInputTokens", "cache_read_input_tokens") ?? 0,
    reasoningTokens: pick("thoughtTokens", "reasoningTokens", "reasoning_tokens") ?? 0,
    cacheCreationTokens: pick(
      "cachedWriteTokens",
      "cacheCreationInputTokens",
      "cache_creation_input_tokens",
    ),
  };
}

export type GrokStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export function parseGrokStopReason(result: unknown): GrokStopReason | undefined {
  const reason = asRecord(result)?.stopReason;
  return reason === "end_turn" ||
    reason === "max_tokens" ||
    reason === "max_turn_requests" ||
    reason === "refusal" ||
    reason === "cancelled"
    ? reason
    : undefined;
}

/** One reasoning tier Grok offers for a model (`_meta.reasoningEfforts`). */
export interface GrokReasoningEffort {
  readonly value: string;
  readonly label: string;
  readonly description: string | undefined;
  readonly isDefault: boolean;
}

export interface GrokModel {
  readonly modelId: string;
  readonly name: string;
  readonly contextTokens: number | undefined;
  readonly efforts: ReadonlyArray<GrokReasoningEffort>;
}

export interface GrokModelState {
  readonly currentModelId: string | undefined;
  readonly models: ReadonlyArray<GrokModel>;
}

/**
 * A model list: `models` on `session/new`, or `_meta.modelState` on
 * `initialize`. Each model's `_meta` names its context and reasoning tiers.
 */
export function parseGrokModelState(value: unknown): GrokModelState {
  const state = asRecord(value);
  const available = Array.isArray(state?.availableModels) ? state.availableModels : [];
  return {
    currentModelId: asString(state?.currentModelId),
    models: available.flatMap((entry): Array<GrokModel> => {
      const model = asRecord(entry);
      const modelId = asString(model?.modelId)?.trim();
      if (!modelId) return [];
      const meta = asRecord(model?._meta);
      const efforts = Array.isArray(meta?.reasoningEfforts) ? meta.reasoningEfforts : [];
      const defaultEffort = asString(meta?.reasoningEffort);
      return [
        {
          modelId,
          name: asString(model?.name)?.trim() || modelId,
          contextTokens: asNumber(meta?.totalContextTokens),
          efforts: efforts.flatMap((option): Array<GrokReasoningEffort> => {
            const record = asRecord(option);
            const effort = asString(record?.value) ?? asString(record?.id);
            if (!effort) return [];
            return [
              {
                value: effort,
                label: asString(record?.label)?.trim() || effort,
                description: asString(record?.description)?.trim() || undefined,
                isDefault: record?.default === true || effort === defaultEffort,
              },
            ];
          }),
        },
      ];
    }),
  };
}

/** A `configOptions` entry's current value (`model`, `reasoning_effort`). */
function configValue(options: unknown, id: string): string | undefined {
  if (!Array.isArray(options)) return undefined;
  const option = options.map(asRecord).find((entry) => entry?.id === id);
  return asString(option?.currentValue);
}

/** The session id, model choices and current settings from `session/new` / `session/load`. */
export function parseGrokSessionResult(value: unknown): GrokModelState & {
  readonly sessionId: string | undefined;
  readonly reasoningEffort: string | undefined;
} {
  const result = asRecord(value);
  const state = parseGrokModelState(result?.models);
  return {
    sessionId: asString(result?.sessionId),
    currentModelId: configValue(result?.configOptions, "model") ?? state.currentModelId,
    models: state.models,
    reasoningEffort: configValue(result?.configOptions, "reasoning_effort"),
  };
}

/** Who `authenticate` signed in as: its `_meta` names the email and plan. */
export function parseGrokAccount(value: unknown): {
  readonly email: string | undefined;
  readonly subscriptionTier: string | undefined;
} {
  const meta = asRecord(asRecord(value)?._meta);
  const email = asString(meta?.email)?.trim();
  return {
    email: email?.includes("@") ? email : undefined,
    subscriptionTier: asString(meta?.subscription_tier)?.trim() || undefined,
  };
}

/** Grok's ACP config-option ids for the model and its reasoning tier. */
export const GROK_MODEL_CONFIG_ID = "model";
export const GROK_REASONING_CONFIG_ID = "reasoning_effort";

/** Typed limit errors Grok reports, mapped to a usage-limit failure. */
const USAGE_LIMIT_ERROR = /usage_pool_exhausted|usage_limit_reached|rate_limited/i;

export function isGrokUsageLimitError(message: string, data?: unknown): boolean {
  return USAGE_LIMIT_ERROR.test(message) || USAGE_LIMIT_ERROR.test(JSON.stringify(data ?? ""));
}
