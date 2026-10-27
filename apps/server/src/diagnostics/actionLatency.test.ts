import { describe, expect, it } from "@effect/vitest";
import { makeActionLatencyAggregator, ACTION_LATENCY_WINDOW_MS } from "./actionLatency.ts";

const now = 1_800_000_000_000;
const record = (ms: number, overrides: Record<string, unknown> = {}) => ({
  name: "ui.action.message.ack",
  traceId: "trace",
  spanId: String(ms),
  durationMs: ms,
  endTimeUnixNano: String(BigInt(now) * 1_000_000n),
  attributes: { "action.name": "message.ack", "action.phase": "ack" },
  ...overrides,
});

describe("recent action latency", () => {
  it("reports nearest-rank percentiles and breaches without treating missing samples as a pass", () => {
    const report = makeActionLatencyAggregator(now);
    for (const ms of [10, 20, 150, 200, 400]) report.addRecord(record(ms));
    report.addRecord(
      record(900, {
        endTimeUnixNano: String(BigInt(now - ACTION_LATENCY_WINDOW_MS - 1) * 1_000_000n),
      }),
    );
    report.addRecord(record(1, { endTimeUnixNano: String(BigInt(now + 1) * 1_000_000n) }));
    report.addRecord(record(-1));
    report.addRecord({ durationMs: "broken" });
    expect(report.finish().actions.find((a) => a.action === "message.ack")).toMatchObject({
      count: 5,
      p50Ms: 150,
      p95Ms: 400,
      budgetMs: 150,
      breachCount: 2,
      status: "breach",
    });
    expect(report.finish().actions.find((a) => a.action === "turn.stop")).toMatchObject({
      count: 0,
      p50Ms: null,
      p95Ms: null,
      status: "unmeasured",
    });
  });

  it("separates send acknowledgement, visit commands and subscription lifetime", () => {
    const report = makeActionLatencyAggregator(now);
    report.addRecord(
      record(180, {
        name: "ws.rpc.orchestration.dispatchCommand",
        attributes: { "orchestration_v2.command_type": "message.dispatch" },
      }),
    );
    report.addRecord(
      record(5_000, {
        name: "ws.rpc.orchestration.dispatchCommand",
        attributes: { "orchestration_v2.command_type": "thread.visit" },
      }),
    );
    report.addRecord(
      record(99_999, { name: "ws.rpc.orchestration.subscribeThread", attributes: {} }),
    );
    report.addRecord(record(40, { name: "ProjectionStore.read", attributes: {} }));
    expect(
      report.finish().actions.find((a) => a.action === "message.ack" && a.phase === "server"),
    ).toMatchObject({ count: 1, p95Ms: 180 });
    expect(report.finish().spans.map((s) => s.name)).not.toContain(
      "ws.rpc.orchestration.subscribeThread",
    );
    expect(report.finish().spans.find((s) => s.name === "ProjectionStore.read")).toMatchObject({
      traceId: "trace",
      spanId: "40",
      p50Ms: 40,
    });
  });

  it("bounds samples by recency across rotated files and counts unsuccessful outcomes", () => {
    const report = makeActionLatencyAggregator(now);
    for (let i = 0; i < 2_100; i++)
      report.addRecord(record(20, { endTimeUnixNano: String(BigInt(now - i) * 1_000_000n) }));
    report.addRecord(
      record(1_000, {
        attributes: {
          "action.name": "message.ack",
          "action.phase": "ack",
          "action.outcome": "failure",
        },
      }),
    );
    expect(report.finish().actions.find((a) => a.action === "message.ack")).toMatchObject({
      count: 2_048,
      p50Ms: 20,
      p95Ms: 20,
      maxMs: 1_000,
      truncated: true,
      failureCount: 1,
    });
  });
});
