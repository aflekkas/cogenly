import { t3ToolResultIndicatesFailure } from "@cogenly/client-runtime/t3ToolSummary";
import type {
  ComputerUsePermission,
  ComputerUsePermissionStatus,
  ComputerUseStatus,
  OrchestrationV2TurnItem,
  TurnItemId,
} from "@cogenly/contracts";
import { resolveT3McpToolId } from "@cogenly/shared/t3McpToolPresentation";

/**
 * The grant each `computer_*` tool needs before it runs. Status, the app list
 * and opening an app need none, so their failures never ask for one. Mirrors
 * the server's `COMPUTER_TOOL_PERMISSION`.
 */
const TOOL_PERMISSION: Readonly<Record<string, ComputerUsePermission>> = {
  computer_screenshot: "screen-recording",
  computer_ui: "accessibility",
  computer_press: "accessibility",
  computer_click: "accessibility",
  computer_type: "accessibility",
  computer_key: "accessibility",
  computer_scroll: "accessibility",
  computer_drag: "accessibility",
};

const PERMISSION_BY_TITLE: Readonly<Record<string, ComputerUsePermission>> = {
  Accessibility: "accessibility",
  "Screen Recording": "screen-recording",
};

export interface ComputerUsePermissionPrompt {
  /** The failed tool call the prompt follows in the thread. */
  readonly itemId: TurnItemId;
  readonly permission: ComputerUsePermission;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The text of a tool result, from a string, MCP content blocks, or `{ content }`. */
function outputText(value: unknown, depth = 0): string | null {
  if (depth > 3) return null;
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (Array.isArray(value)) {
    const parts = value.flatMap(
      (block) => outputText(asRecord(block)?.text ?? block, depth + 1) ?? [],
    );
    return parts.length > 0 ? parts.join("\n") : null;
  }
  const record = asRecord(value);
  if (!record) return null;
  return outputText(record.content ?? record.text, depth + 1);
}

/**
 * What a failed call's text says: the grant macOS refused, or `other` for any
 * other failure (computer use turned off, an unknown key). Reads the encoded
 * `ComputerUseUnavailableError` and the agent-facing message alike, since
 * MCP sends a failure's message as its text.
 */
export function refusedComputerUsePermission(text: string): ComputerUsePermission | "other" {
  try {
    const parsed = asRecord(JSON.parse(text));
    if (parsed?._tag === "ComputerUseUnavailableError") {
      const missing = Array.isArray(parsed.missing) ? parsed.missing[0] : undefined;
      return parsed.code === "permission-missing" &&
        (missing === "accessibility" || missing === "screen-recording")
        ? missing
        : "other";
    }
  } catch {
    // Plain text: the error's message.
  }
  const title = /has not granted .+? (Accessibility|Screen Recording) yet/u.exec(text)?.[1];
  return (title && PERMISSION_BY_TITLE[title]) || "other";
}

/**
 * The one macOS permission prompt a thread shows, if any: after its latest
 * `computer_*` call that failed for want of a grant no later call of the same
 * kind succeeded with. The timeline keeps only a compact output for tool calls,
 * so a failure without its text is taken to be the grant the tool needs; the
 * prompt confirms it against the machine's live status before showing anything.
 */
export function computerUsePermissionPrompt(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): ComputerUsePermissionPrompt | null {
  const unresolved = new Map<ComputerUsePermission, { itemId: TurnItemId; order: number }>();
  for (const [order, item] of items.entries()) {
    if (item.type !== "dynamic_tool") continue;
    const tool = resolveT3McpToolId(item.toolName);
    const needed = tool === null ? undefined : TOOL_PERMISSION[tool];
    if (needed === undefined) continue;
    const failed = item.status === "failed" || t3ToolResultIndicatesFailure(item.output);
    if (!failed) {
      if (item.status === "completed") unresolved.delete(needed);
      continue;
    }
    const text = outputText(item.output);
    const refused = text === null ? needed : refusedComputerUsePermission(text);
    if (refused !== "other") unresolved.set(refused, { itemId: item.id, order });
  }
  let latest: ComputerUsePermissionPrompt | null = null;
  let latestOrder = -1;
  for (const [permission, failure] of unresolved) {
    if (failure.order > latestOrder) {
      latest = { itemId: failure.itemId, permission };
      latestOrder = failure.order;
    }
  }
  return latest;
}

/** Whether the machine can use computer use at all: on, and on a Mac with a desktop. */
export function computerUseAvailable(status: ComputerUseStatus): boolean {
  return status.state === "ready" || status.state === "needs-permission";
}

export function computerUsePermissionStatus(
  status: ComputerUseStatus,
  permission: ComputerUsePermission,
): ComputerUsePermissionStatus | undefined {
  return status.permissions.find((entry) => entry.permission === permission);
}

/** Missing or unreadable grants both still need the user; only `granted` is done. */
export function computerUseGrantMissing(
  status: ComputerUseStatus,
  permission?: ComputerUsePermission,
): boolean {
  if (!computerUseAvailable(status)) return false;
  return status.permissions.some(
    (entry) =>
      (permission === undefined || entry.permission === permission) && entry.grant !== "granted",
  );
}

/**
 * Which app's switch to turn on, when it is not Cogenly's own: a server started
 * from a terminal is granted through that terminal.
 */
export function computerUseHostAppNote(status: ComputerUseStatus): string | null {
  if (status.platform !== "darwin" || status.hostApp === "Cogenly") return null;
  return status.hostApp === null
    ? "Cogenly's server was started by another app; turn on the switch for that app."
    : `Cogenly's server runs inside ${status.hostApp}, so turn on the switch for ${status.hostApp}.`;
}

/** One plain line for a machine that cannot do computer use; null when it can or is off. */
export function computerUseUnsupportedLine(status: ComputerUseStatus): string | null {
  if (status.state !== "unsupported") return null;
  switch (status.platform) {
    case "darwin":
      return "Not available until someone is logged in to this Mac's desktop.";
    case "linux":
      return "Not available on Linux servers. Computer use controls a Mac's apps.";
    case "win32":
      return "Not available on Windows. Computer use controls a Mac's apps.";
    default:
      return "Not available on this machine. Computer use controls a Mac's apps.";
  }
}
