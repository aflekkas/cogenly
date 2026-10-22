import type { T3ImportJob, T3ImportReport, T3ImportStatus } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { RpcClientError } from "effect/rpc/RpcClientError";
import * as Socket from "effect/socket/Socket";
import * as TestClock from "effect/testing/TestClock";

import { followJob, runT3ImportStep, type SetupOutput } from "./setup.ts";
import { type SetupBackend, SetupBackendError } from "./setupBackend.ts";

const report: T3ImportReport = {
  reportId: "report-1",
  generatedAt: "2026-10-22T21:58:27.000Z",
  scope: { sourceProjectIds: [] },
  projects: [],
  totals: {
    threads: 0,
    messages: 0,
    events: 0,
    newEvents: 0,
    attachments: 0,
    attachmentBytes: 0,
    skippedEvents: 0,
    normalizedEvents: 0,
  },
  skipped: [],
  providers: [],
  settings: [],
  warnings: [],
};

const status = (job: T3ImportJob): T3ImportStatus => ({
  source: { available: true, databasePath: "/t3/statev2.sqlite", running: false, projects: [] },
  job,
});
const copying = status({
  _tag: "Scanning",
  progress: {
    phase: "snapshot",
    processedEvents: 0,
    totalEvents: 0,
    copiedBytes: 6 * 1024 ** 3,
    totalBytes: 12 * 1024 ** 3,
  },
});
const scanned = status({ _tag: "Scanned", report });

/** What the CLI saw when the server stalled: a missed pong fails the stream. */
const dropped = new SetupBackendError({
  operation: "import-status",
  cause: new RpcClientError({
    reason: new Socket.SocketReadError({ cause: new Error("ping timeout") }),
  }),
});

/** A backend whose nth status subscription is `subscriptions[n]`; it records calls. */
const fakeBackend = (
  subscriptions: ReadonlyArray<Stream.Stream<T3ImportStatus, SetupBackendError>>,
) => {
  const calls: Array<string> = [];
  let subscribed = 0;
  const unused = Effect.die("not used by this test");
  const backend: SetupBackend = {
    target: { _tag: "live", origin: "http://127.0.0.1:4773", environmentLabel: "Mac" },
    providers: unused,
    settings: unused,
    updateSettings: () => unused,
    t3Import: {
      status: Stream.suspend(() => {
        calls.push("status");
        const next = subscriptions[subscribed] ?? Stream.never;
        subscribed += 1;
        return next;
      }),
      scan: () => Effect.sync(() => void calls.push("scan")),
      run: () => Effect.sync(() => void calls.push("run")),
      cancel: Effect.sync(() => void calls.push("cancel")),
    },
    sessions: Option.none(),
  };
  return { backend, calls };
};

const recordingOutput = () => {
  const lines: Array<string> = [];
  const output: SetupOutput = { log: (line) => Effect.sync(() => void lines.push(line)) };
  return { output, lines };
};

/** Moves the test clock a second at a time, so timers armed along the way fire too. */
const advance = (seconds: number) =>
  Effect.repeat(TestClock.adjust("1 second"), { times: seconds - 1 });

const settled = (job: T3ImportJob) => job._tag !== "Scanning" && job._tag !== "Importing";

describe("following an import job from the CLI", () => {
  it.effect("re-attaches after the connection drops and picks up the job where it is", () =>
    Effect.gen(function* () {
      const { backend, calls } = fakeBackend([
        Stream.make(copying).pipe(Stream.concat(Stream.fail(dropped))),
        Stream.make(scanned),
      ]);
      const { output, lines } = recordingOutput();
      const fiber = yield* followJob(backend, output, settled).pipe(Effect.forkScoped);
      yield* advance(5);
      const result = yield* Fiber.join(fiber);

      expect(result.job._tag).toBe("Scanned");
      expect(calls).toEqual(["status", "status"]);
      expect(lines).toEqual([
        "  Copying T3 Code's data… 50% of 12.0 GB",
        "  Lost the connection to Cogenly; reconnecting…",
      ]);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("treats a stream that misses its heartbeats as dead and subscribes again", () =>
    Effect.gen(function* () {
      const { backend, calls } = fakeBackend([
        Stream.make(copying).pipe(Stream.concat(Stream.never)),
        Stream.make(scanned),
      ]);
      const { output } = recordingOutput();
      const fiber = yield* followJob(backend, output, settled).pipe(Effect.forkScoped);
      yield* advance(40);
      expect((yield* Fiber.join(fiber)).job._tag).toBe("Scanned");
      expect(calls).toEqual(["status", "status"]);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("gives up after a few minutes of no server, saying the job keeps running", () =>
    Effect.gen(function* () {
      const { backend } = fakeBackend(Array.from({ length: 200 }, () => Stream.fail(dropped)));
      const { output } = recordingOutput();
      const fiber = yield* followJob(backend, output, settled).pipe(Effect.flip, Effect.forkScoped);
      yield* advance(10 * 60);
      const error = yield* Fiber.join(fiber);
      expect(error).toMatchObject({ _tag: "SetupStoppedError" });
      expect(error.message).toMatch(/keeps running there; run the same command again/);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("does not retry a refusal", () =>
    Effect.gen(function* () {
      const refused = new SetupBackendError({ operation: "import-status", cause: "forbidden" });
      const { backend, calls } = fakeBackend([Stream.fail(refused), Stream.make(scanned)]);
      const { output } = recordingOutput();
      const error = yield* followJob(backend, output, settled).pipe(Effect.flip);
      expect(error).toBe(refused);
      expect(calls).toEqual(["status"]);
    }),
  );

  it.effect("follows an import already running instead of starting a new check", () =>
    Effect.gen(function* () {
      const importing = status({
        _tag: "Importing",
        report,
        progress: { phase: "events", processedEvents: 5, totalEvents: 10 },
        backupPath: "/backups/pre.sqlite",
      });
      const completed = status({
        _tag: "Completed",
        result: {
          report,
          backupPath: "/backups/pre.sqlite",
          importedThreads: 1,
          writtenEvents: 10,
          skippedEvents: 0,
          copiedAttachments: 0,
          completedAt: "2026-10-22T22:00:00.000Z",
        },
      });
      const { backend, calls } = fakeBackend([
        Stream.make(importing),
        Stream.make(importing, completed),
      ]);
      const { output, lines } = recordingOutput();
      const outcome = yield* runT3ImportStep(backend, {
        interactive: false,
        projects: [],
        includeSettings: false,
        dryRun: true,
        output,
      });
      expect(outcome._tag).toBe("Imported");
      expect(calls).toEqual(["status", "status"]);
      expect(lines[0]).toBe("  An import is already running; following it.");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
