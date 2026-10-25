import { normalizeWorkLogToolKey } from "@cogenly/client-runtime/work-log/tool-registry";
import type { OrchestrationV2TurnItem } from "@cogenly/contracts";
import { normalizeTerminalOutput } from "@cogenly/shared/terminalOutput";

type DynamicToolItem = Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }>;

/**
 * `item` when it is a call to Cogenly's `terminal_run`, under any provider's
 * naming: Claude's `mcp__cogenly__terminal_run`, Codex's `cogenly.terminal_run`,
 * or a bare dynamic tool `terminal_run`. The timeline row's tag and the
 * expanded terminal block both recognize the call through this.
 */
export function terminalRunItem(
  item: OrchestrationV2TurnItem | null | undefined,
): DynamicToolItem | null {
  return item?.type === "dynamic_tool" && normalizeWorkLogToolKey(item.toolName) === "terminal_run"
    ? item
    : null;
}

/**
 * Whether a `terminal_run` result ran in a chat's read-only sandbox. Reads the
 * full result or the timeline's compact copy, which keeps only `sandbox`.
 */
export function terminalRunSandboxed(value: unknown): boolean {
  return resultRecord(value)?.sandbox === "read-only";
}

/** What a `terminal_run` call reported, ready to show as a terminal block. */
export interface TerminalRunResult {
  /** The output as a terminal shows it: line endings and cursor moves applied. */
  readonly output: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  /** Ran in a chat's read-only sandbox. */
  readonly sandboxed: boolean;
  readonly notice: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The result object, whether it arrived parsed, as JSON text, or in MCP content blocks. */
function resultRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") return resultRecord(parseJson(value));
  if (Array.isArray(value)) {
    const text = value
      .flatMap((block) => (isRecord(block) && typeof block.text === "string" ? [block.text] : []))
      .join("");
    return text ? resultRecord(parseJson(text)) : null;
  }
  if (!isRecord(value)) return null;
  if (typeof value.output === "string" || typeof value.sandbox === "string") return value;
  if (isRecord(value.structuredContent)) return resultRecord(value.structuredContent);
  return Array.isArray(value.content) ? resultRecord(value.content) : null;
}

/**
 * Reads a `terminal_run` result for the timeline, which shows the output as a
 * terminal would rather than the raw JSON (ids, offsets, escaped newlines).
 * Null when the value is not a terminal result, such as a refusal message.
 */
export function parseTerminalRunResult(value: unknown): TerminalRunResult | null {
  const record = resultRecord(value);
  if (record === null || typeof record.output !== "string") return null;
  return {
    output: normalizeTerminalOutput(record.output).text.replace(/\n+$/u, ""),
    exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
    timedOut: record.timedOut === true,
    truncated: record.truncated === true,
    sandboxed: terminalRunSandboxed(record),
    notice: typeof record.notice === "string" ? record.notice : null,
  };
}

/** The result line over the output: how the command ended, when that is news. */
export function terminalRunResultSummary(result: TerminalRunResult): string | null {
  if (result.timedOut) return "Timed out and was stopped";
  if (result.exitCode !== null && result.exitCode !== 0) {
    return `Exited with code ${result.exitCode}`;
  }
  return null;
}
