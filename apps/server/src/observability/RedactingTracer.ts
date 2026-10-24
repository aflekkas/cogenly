import * as Tracer from "effect/Tracer";

/**
 * Span attributes that can carry secrets and must never reach the trace file
 * or an OTLP exporter. The MCP toolkit annotates every tool call's span with
 * its raw `parameters`, which include `vault_save` secret fields, integration
 * headers and anything else an agent passes in. The tool name stays.
 */
const REDACTED_SPAN_ATTRIBUTES: ReadonlySet<string> = new Set(["parameters"]);

export const REDACTED_ATTRIBUTE_VALUE = "[redacted]";

/** Wraps a tracer so redacted attributes are replaced before any span records them. */
export const redactSensitiveSpanAttributes = (tracer: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    ...tracer,
    span(options) {
      const span = tracer.span(options);
      const attribute = span.attribute.bind(span);
      span.attribute = (key, value) =>
        attribute(key, REDACTED_SPAN_ATTRIBUTES.has(key) ? REDACTED_ATTRIBUTE_VALUE : value);
      return span;
    },
  });
