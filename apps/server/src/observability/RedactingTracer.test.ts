import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";

import { REDACTED_ATTRIBUTE_VALUE, redactSensitiveSpanAttributes } from "./RedactingTracer.ts";

describe("redactSensitiveSpanAttributes", () => {
  it.effect("never records a tool call's parameters, and keeps every other attribute", () => {
    const spans: Array<Tracer.NativeSpan> = [];
    const recording = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    return Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({
        tool: "vault_save",
        parameters: { name: "GitHub", secretFields: { password: "hunter2-secret" } },
      }).pipe(
        Effect.withSpan("McpServer.tools/call", { attributes: { "rpc.method": "tools/call" } }),
        Effect.withTracer(redactSensitiveSpanAttributes(recording)),
      );
      const span = spans.find((candidate) => candidate.name === "McpServer.tools/call");
      expect(span?.attributes.get("tool")).toBe("vault_save");
      expect(span?.attributes.get("rpc.method")).toBe("tools/call");
      expect(span?.attributes.get("parameters")).toBe(REDACTED_ATTRIBUTE_VALUE);
      expect(JSON.stringify([...(span?.attributes.values() ?? [])])).not.toContain("hunter2");
    });
  });
});
