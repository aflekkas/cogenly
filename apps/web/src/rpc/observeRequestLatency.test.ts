import { afterEach, beforeEach, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Tracer from "effect/Tracer";

import { setDelegate } from "../observability/clientTracer";
import { observeRpcRequest } from "./observeRequestLatency";
import { getSlowRpcAckRequests, resetRequestLatencyStateForTests } from "./requestLatencyState";

let spans: Tracer.Span[];
let elapsed = 0;
beforeEach(() => {
  vi.useFakeTimers();
  spans = [];
  elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  setDelegate(
    Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    }),
  );
});
afterEach(() => {
  resetRequestLatencyStateForTests();
  setDelegate(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.effect("records failed remote round trips after the existing slow-RPC threshold", () =>
  Effect.gen(function* () {
    const complete = yield* observeRpcRequest({
      environmentId: "remote",
      method: "orchestration.dispatchCommand",
      remote: true,
      input: { type: "message.dispatch", text: "private prompt" },
    });
    yield* Effect.promise(() => vi.advanceTimersByTimeAsync(16_000));
    expect(getSlowRpcAckRequests()).toHaveLength(1);
    elapsed = 16_000;
    yield* complete(Exit.fail("offline"));
    expect(getSlowRpcAckRequests()).toHaveLength(0);
    expect(spans.map((s) => s.attributes.get("action.name"))).toEqual([
      "message.ack",
      "rpc.remote",
    ]);
    expect(spans.every((s) => s.attributes.get("action.outcome") === "failure")).toBe(true);
    expect(JSON.stringify(spans.map((s) => [...s.attributes]))).not.toContain("private prompt");
  }),
);
