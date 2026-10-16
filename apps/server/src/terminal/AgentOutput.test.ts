import { describe, expect, it } from "@effect/vitest";
import { AgentOutput } from "./AgentOutput.ts";

describe("agent output", () => {
  it("reads incremental output without duplicating overlapping head and tail", () => {
    const output = new AgentOutput();
    output.append("hello");
    expect(output.read()).toEqual({ output: "hello", nextOffset: 5, truncated: false });
    output.append(" world");
    expect(output.read(5).output).toBe(" world");
    expect(output.read(11).output).toBe("");
  });
  it("retains the head and tail, with absolute offsets and an explicit gap", () => {
    const output = new AgentOutput();
    output.append("H".repeat(8_000));
    output.append("X".repeat(100_000));
    output.append("T".repeat(24_000));
    const result = output.read();
    expect(result.output).toBe(
      "H".repeat(8_000) + "\n[... 100000 characters omitted ...]\n" + "T".repeat(24_000),
    );
    expect(result.nextOffset).toBe(132_000);
    expect(result.truncated).toBe(true);
    expect(output.read(131_998)).toEqual({ output: "TT", nextOffset: 132_000, truncated: false });
    expect(output.read(108_000).output).toBe("T".repeat(24_000));
  });
});
