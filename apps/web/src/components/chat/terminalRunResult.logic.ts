import { normalizeTerminalOutput } from "@cogenly/shared/terminalOutput";

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
  if (typeof value.output === "string") return value;
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
    sandboxed: record.sandbox === "read-only",
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
