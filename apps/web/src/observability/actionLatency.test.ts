import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Tracer from "effect/Tracer";

import { setDelegate } from "./clientTracer";
import {
  beginAction,
  finishAction,
  finishActionAfterPaint,
  finishMessageActionsAfterPaint,
  finishStoppedThreadActionsAfterPaint,
} from "./actionLatency";
import { resetRequestLatencyStateForTests } from "../rpc/requestLatencyState";

let spans: Tracer.Span[];
let frames: FrameRequestCallback[];
let elapsed = 0;
const installTracer = () =>
  setDelegate(
    Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    }),
  );
const paint = async () => {
  for (const frame of frames.splice(0)) frame(elapsed);
  await vi.advanceTimersByTimeAsync(0);
};
beforeEach(() => {
  vi.useFakeTimers();
  elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  frames = [];
  spans = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  installTracer();
});
afterEach(() => {
  resetRequestLatencyStateForTests();
  setDelegate(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("visible action measurements", () => {
  it("includes preparation and only ends when the sent or queued message paints", async () => {
    beginAction("message.queue", "env:message");
    elapsed = 100;
    finishMessageActionsAfterPaint("env", [{ id: "older" }]);
    await paint();
    expect(spans).toHaveLength(0);
    elapsed = 250;
    finishMessageActionsAfterPaint("env", [{ id: "message" }]);
    expect(spans).toHaveLength(0);
    elapsed = 320;
    await paint();
    expect(spans[0]?.attributes.get("action.name")).toBe("message.queue");
    expect(spans[0]?.attributes.get("action.breach")).toBe(true);
    const status = spans[0]!.status;
    expect(status._tag).toBe("Ended");
    if (status._tag === "Ended")
      expect(Number(status.endTime - status.startTime) / 1e6).toBeCloseTo(320, 2);
  });

  it("does not mistake a Stop acknowledgement for a stopped thread", async () => {
    beginAction("turn.stop", "env:thread");
    const thread = {
      environmentId: "env",
      id: "thread",
      activeRunId: "run",
      status: "running",
      pendingRuntimeRequest: null,
      pendingBackgroundTasks: [],
    };
    finishStoppedThreadActionsAfterPaint([thread]);
    await paint();
    expect(spans).toHaveLength(0);
    finishStoppedThreadActionsAfterPaint([
      { ...thread, activeRunId: null, pendingBackgroundTasks: ["task"] },
    ]);
    await paint();
    expect(spans).toHaveLength(0);
    finishStoppedThreadActionsAfterPaint([{ ...thread, activeRunId: null, status: "waiting" }]);
    await paint();
    expect(spans).toHaveLength(0);
    elapsed = 400;
    finishStoppedThreadActionsAfterPaint([{ ...thread, activeRunId: null, status: "interrupted" }]);
    await paint();
    expect(spans[0]?.attributes.get("action.name")).toBe("turn.stop");
  });

  it("retains startup measurements until the existing exporter is configured", async () => {
    setDelegate(null);
    beginAction("app.startup", "", 0);
    elapsed = 800;
    finishActionAfterPaint("app.startup");
    await paint();
    expect(spans).toHaveLength(0);
    installTracer();
    expect(spans[0]?.name).toBe("ui.action.app.startup");
  });

  it("keeps superseded frame callbacks from ending a newer navigation", async () => {
    beginAction("thread.open", "env:thread");
    finishActionAfterPaint("thread.open", "env:thread");
    elapsed = 30;
    beginAction("thread.open", "env:thread");
    await paint();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes.get("action.outcome")).toBe("superseded");
    finishAction("thread.open", "env:thread");
  });
});
