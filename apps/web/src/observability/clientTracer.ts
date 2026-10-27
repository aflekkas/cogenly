import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

let delegate: Tracer.Tracer | null = null;
type CompletedSpan = {
  name: string;
  startTime: bigint;
  endTime: bigint;
  attributes: Record<string, unknown>;
  links: Array<Tracer.SpanLink>;
};
const earlySpans: CompletedSpan[] = [];

/** Also preserves startup measurements completed before the exporter is ready. */
export function recordCompletedSpan(record: CompletedSpan): void {
  if (delegate === null) {
    if (earlySpans.length < 128) earlySpans.push(record);
    return;
  }
  const span = delegate.span({
    name: record.name,
    startTime: record.startTime,
    parent: Option.none(),
    annotations: Context.empty(),
    links: record.links,
    kind: "client",
    root: true,
    sampled: true,
  });
  for (const [key, value] of Object.entries(record.attributes)) span.attribute(key, value);
  span.end(record.endTime, Exit.void);
}

/**
 * Points the installed tracer at the exporter `configureClientTracing` just built,
 * or at nothing while no exporter is configured.
 */
export function setDelegate(next: Tracer.Tracer | null): void {
  delegate = next;
  if (next !== null) {
    for (const record of earlySpans.splice(0)) recordCompletedSpan(record);
  }
}

export function hasDelegate(): boolean {
  return delegate !== null;
}

/**
 * Installed once when the client runtime is built, before any exporter exists, so
 * client spans keep flowing to whatever exporter is configured later on.
 */
export const layer = Layer.succeed(
  Tracer.Tracer,
  Tracer.make({
    span(options) {
      return delegate?.span(options) ?? new Tracer.NativeSpan(options);
    },
  }),
);
