import { expect, it } from "@effect/vitest";
import { EnvironmentId, type MachineListResult } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Machines from "../machines/Machines.ts";
import * as PeerChannels from "../machines/PeerChannels.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ThreadReplication from "./ThreadReplication.ts";
import * as ThreadSync from "./ThreadSync.ts";

it.effect("replays hourly and immediately on a changed peer version", () =>
  Effect.gen(function* () {
    let version = "0.3.2";
    let replays = 0;
    let tick = Effect.void;
    const register: Scheduler.Scheduler["Service"]["register"] = Effect.fnUntraced(function* <E, R>(
      _name: string,
      work: Effect.Effect<void, E, R>,
    ) {
      const context = yield* Effect.context<R>();
      tick = work.pipe(Effect.provideContext(context), Effect.orDie);
    });
    const topology = Effect.sync((): MachineListResult => ({
      link: { _tag: "standalone" },
      machines: [
        {
          environmentId: EnvironmentId.make("peer"),
          name: "Peer",
          kind: "other-computer",
          hardware: "laptop",
          platform: "darwin",
          relation: "peer",
          online: true,
          lastSeenAt: null,
          pairedAt: null,
          pairing: "paired",
          providers: [],
          serverVersion: version,
        },
      ],
    }));
    yield* Layer.build(
      ThreadSync.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Machines.Machines)({ list: topology, subscribe: Stream.never }),
            Layer.mock(ThreadReplication.ThreadReplication)({
              environmentId: EnvironmentId.make("local"),
              replayHeld: Effect.sync(() => {
                replays++;
              }),
              changes: Stream.never,
            }),
            Layer.succeed(Scheduler.Scheduler, { register }),
            PeerChannels.layer,
          ),
        ),
      ),
    );
    yield* tick;
    yield* tick;
    expect(replays).toBe(1);
    version = "0.3.3";
    yield* tick;
    expect(replays).toBe(2);
    yield* TestClock.adjust("1 hour");
    yield* tick;
    expect(replays).toBe(3);
  }).pipe(Effect.scoped),
);
