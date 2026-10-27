import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as TraceDiagnostics from "./TraceDiagnostics.ts";

it.effect("reads rotated browser and server timings through the diagnostic service", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "action-latency-" });
    const traceFilePath = `${directory}/server.trace.ndjson`;
    const at = 1_800_000_000_000;
    const record = (durationMs: number, browser: boolean) =>
      JSON.stringify({
        name: browser ? "ui.action.message.send" : "ws.rpc.orchestration.dispatchCommand",
        traceId: "trace",
        spanId: String(durationMs),
        durationMs,
        startTimeUnixNano: String(BigInt(at - durationMs) * 1_000_000n),
        endTimeUnixNano: String(BigInt(at) * 1_000_000n),
        exit: { _tag: "Success" },
        attributes: browser
          ? { "action.name": "message.send", "action.phase": "visible" }
          : { "orchestration_v2.command_type": "message.dispatch" },
      });
    yield* fs.writeFileString(`${traceFilePath}.1`, `${record(200, false)}\n`);
    yield* fs.writeFileString(traceFilePath, `${record(350, true)}\n{"incomplete":`);
    const service = yield* TraceDiagnostics.TraceDiagnostics;
    const report = yield* service.read({
      traceFilePath,
      maxFiles: 1,
      readAt: DateTime.makeUnsafe(at),
    });
    expect(report.recordCount).toBe(2);
    expect(report.parseErrorCount).toBe(1);
    expect(report.actionLatency?.actions.find((a) => a.action === "message.send")).toMatchObject({
      p95Ms: 350,
      status: "breach",
    });
    expect(
      report.actionLatency?.actions.find((a) => a.action === "message.ack" && a.phase === "server"),
    ).toMatchObject({ p95Ms: 200, status: "breach" });
    const missing = yield* service.read({
      traceFilePath: `${directory}/missing`,
      maxFiles: 0,
      readAt: DateTime.makeUnsafe(at),
    });
    expect(missing.actionLatency?.actions.every((a) => a.status === "unmeasured")).toBe(true);
  }).pipe(Effect.provide(TraceDiagnostics.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);
