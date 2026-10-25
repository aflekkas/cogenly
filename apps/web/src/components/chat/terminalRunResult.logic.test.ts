import { describe, expect, it } from "vite-plus/test";

import { parseTerminalRunResult, terminalRunResultSummary } from "./terminalRunResult.logic";

const result = {
  terminalId: "agent-63d13e86",
  status: "exited",
  exitCode: 1,
  timedOut: false,
  output:
    "/private/tmp/scratch\r\nhello-from-sandbox\r\ntouch: ~/probe.txt: Operation not permitted\r\n",
  nextOffset: 181,
  truncated: false,
  sandbox: "read-only",
};

describe("parseTerminalRunResult", () => {
  it("shows the output as terminal lines, without the tool's bookkeeping", () => {
    const parsed = parseTerminalRunResult(result);
    expect(parsed).toEqual({
      output:
        "/private/tmp/scratch\nhello-from-sandbox\ntouch: ~/probe.txt: Operation not permitted",
      exitCode: 1,
      timedOut: false,
      truncated: false,
      sandboxed: true,
      notice: null,
    });
    expect(parsed && terminalRunResultSummary(parsed)).toBe("Exited with code 1");
  });

  it("reads the result from JSON text and MCP content blocks", () => {
    const text = JSON.stringify(result);
    expect(parseTerminalRunResult(text)?.exitCode).toBe(1);
    expect(parseTerminalRunResult([{ type: "text", text }])?.sandboxed).toBe(true);
    expect(parseTerminalRunResult({ content: [{ type: "text", text }] })?.exitCode).toBe(1);
  });

  it("leaves an unsandboxed command unmarked and a clean exit unsummarized", () => {
    const parsed = parseTerminalRunResult({ ...result, exitCode: 0, sandbox: undefined });
    expect(parsed?.sandboxed).toBe(false);
    expect(parsed && terminalRunResultSummary(parsed)).toBeNull();
  });

  it("is null for anything that is not a terminal result", () => {
    expect(parseTerminalRunResult("Agent terminals require enabled tools")).toBeNull();
    expect(parseTerminalRunResult(null)).toBeNull();
  });
});
