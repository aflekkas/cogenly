import {
  ACTION_LATENCY_BUDGETS,
  type ActionLatencyReport,
  type LatencyAction,
} from "@cogenly/contracts";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";

const Record = Schema.Struct({
  name: Schema.String,
  traceId: Schema.String,
  spanId: Schema.String,
  durationMs: Schema.Number,
  endTimeUnixNano: Schema.String,
  links: Schema.optionalKey(
    Schema.Array(Schema.Struct({ traceId: Schema.String, spanId: Schema.String })),
  ),
  attributes: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  exit: Schema.optionalKey(Schema.Struct({ _tag: Schema.String })),
});
const decode = Schema.decodeUnknownResult(Record);
const MAX_SAMPLES = 2_048;
const MAX_SPAN_NAMES = 256;
export const ACTION_LATENCY_WINDOW_MS = 30 * 60_000;

type Sample = { at: number; ms: number; failed: boolean; traceId: string; spanId: string };
type Group = { samples: Sample[]; truncated: boolean };
const percentile = (sorted: ReadonlyArray<number>, fraction: number) =>
  sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;

/** Keeps the latest bounded samples, even when rotated files finish out of order. */
export function makeActionLatencyAggregator(untilEpochMs: number) {
  const sinceEpochMs = untilEpochMs - ACTION_LATENCY_WINDOW_MS;
  const actions = new Map<string, Group>();
  const spans = new Map<string, Group>();
  const add = (groups: Map<string, Group>, key: string, sample: Sample) => {
    const group = groups.get(key) ?? { samples: [], truncated: false };
    const samples = group.samples;
    // A min-heap keeps the newest samples in O(log n), including delayed
    // browser batches, without sorting on every high-volume SQLite span.
    if (samples.length < MAX_SAMPLES) {
      samples.push(sample);
      let child = samples.length - 1;
      while (child > 0) {
        const parent = (child - 1) >>> 1;
        if (samples[parent]!.at <= samples[child]!.at) break;
        [samples[parent], samples[child]] = [samples[child]!, samples[parent]!];
        child = parent;
      }
    } else {
      group.truncated = true;
      if (sample.at < samples[0]!.at) return;
      samples[0] = sample;
      let parent = 0;
      while (parent * 2 + 1 < samples.length) {
        let child = parent * 2 + 1;
        if (child + 1 < samples.length && samples[child + 1]!.at < samples[child]!.at) child++;
        if (samples[parent]!.at <= samples[child]!.at) break;
        [samples[parent], samples[child]] = [samples[child]!, samples[parent]!];
        parent = child;
      }
    }
    groups.set(key, group);
  };
  const serverActions: Readonly<Record<string, LatencyAction>> = {
    "ws.rpc.server.getSettings": "settings.load",
    "ws.rpc.provider.auth.start": "provider.signIn",
    "environment.orchestration.threadBoundedSnapshot": "thread.open",
    "http.orchestration.loadShellSnapshot": "threads.load",
    "clientRuntime.state.fetchEnvironmentThreadSnapshot": "thread.open",
  };
  const addRecord = (input: unknown) => {
    const decoded = decode(input);
    if (Result.isFailure(decoded)) return;
    const r = decoded.success;
    const at = Number(r.endTimeUnixNano) / 1_000_000;
    if (
      !Number.isFinite(at) ||
      at < sinceEpochMs ||
      at > untilEpochMs ||
      !Number.isFinite(r.durationMs) ||
      r.durationMs < 0
    )
      return;
    const sample = {
      at,
      ms: r.durationMs,
      failed:
        (r.exit !== undefined && r.exit._tag !== "Success") ||
        (r.attributes?.["action.outcome"] !== undefined &&
          r.attributes["action.outcome"] !== "success"),
      traceId: r.links?.[0]?.traceId ?? r.traceId,
      spanId: r.links?.[0]?.spanId ?? r.spanId,
    };
    const action = r.attributes?.["action.name"];
    const phase = r.attributes?.["action.phase"];
    if (
      typeof action === "string" &&
      Object.hasOwn(ACTION_LATENCY_BUDGETS, action) &&
      (phase === "visible" || phase === "ack" || phase === "server")
    ) {
      add(actions, `${action}:${phase}`, sample);
    }
    const serverAction =
      r.name === "ws.rpc.orchestration.dispatchCommand"
        ? r.attributes?.["orchestration_v2.command_type"] === "message.dispatch"
          ? "message.ack"
          : r.attributes?.["orchestration_v2.command_type"] === "run.interrupt" ||
              r.attributes?.["orchestration_v2.command_type"] === "thread.interrupt"
            ? "turn.stop"
            : null
        : serverActions[r.name];
    if (serverAction)
      add(
        actions,
        `${serverAction}:${r.name.startsWith("clientRuntime.") ? "ack" : "server"}`,
        sample,
      );
    // Streams measure subscription lifetime; they are never action durations.
    if (
      !r.name.toLowerCase().includes("subscribe") &&
      !r.name.startsWith("ui.action.") &&
      !r.name.startsWith("EnvironmentRpc.") &&
      r.name !== "runCachePersistence" &&
      (spans.has(r.name) || spans.size < MAX_SPAN_NAMES)
    ) {
      add(spans, r.name, sample);
    }
  };
  const summarize = (group: Group | undefined) => {
    const samples = group?.samples ?? [];
    const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
    return {
      count: samples.length,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      maxMs: sorted.at(-1) ?? null,
      truncated: group?.truncated ?? false,
    };
  };
  const finish = (): ActionLatencyReport => ({
    windowMs: ACTION_LATENCY_WINDOW_MS,
    sinceEpochMs,
    untilEpochMs,
    actions: (Object.keys(ACTION_LATENCY_BUDGETS) as LatencyAction[]).flatMap((action) => {
      const defaultPhase = action === "message.ack" || action === "rpc.remote" ? "ack" : "visible";
      const phases = new Set([
        defaultPhase,
        ...["visible", "ack", "server"].filter((phase) => actions.has(`${action}:${phase}`)),
      ] as const);
      return [...phases].map((phase) => {
        const group = actions.get(`${action}:${phase}`);
        const stats = summarize(group);
        const budgetMs = ACTION_LATENCY_BUDGETS[action];
        const slowest = group?.samples.reduce((a, b) => (a.ms >= b.ms ? a : b));
        return {
          action,
          phase: phase as "visible" | "ack" | "server",
          ...stats,
          budgetMs,
          traceId: slowest?.traceId ?? null,
          spanId: slowest?.spanId ?? null,
          failureCount: group?.samples.filter((s) => s.failed).length ?? 0,
          breachCount: group?.samples.filter((s) => s.ms > budgetMs).length ?? 0,
          status:
            stats.p95Ms === null
              ? ("unmeasured" as const)
              : stats.p95Ms > budgetMs
                ? ("breach" as const)
                : ("ok" as const),
        };
      });
    }),
    spans: [...spans]
      .map(([name, group]) => {
        const stats = summarize(group);
        const slowest = group.samples.reduce((a, b) => (a.ms >= b.ms ? a : b));
        return {
          name,
          ...stats,
          p50Ms: stats.p50Ms!,
          p95Ms: stats.p95Ms!,
          maxMs: stats.maxMs!,
          traceId: slowest.traceId,
          spanId: slowest.spanId,
        };
      })
      .sort((a, b) => b.p95Ms - a.p95Ms)
      .slice(0, 30),
  });
  return { addRecord, finish };
}
