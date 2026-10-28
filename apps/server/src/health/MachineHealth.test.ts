import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as MachineResources from "../resourceTelemetry/MachineResources.ts";

import {
  awaitLinkState,
  pair,
  startMachine,
  startProxy,
  type Machine,
} from "../machines/testkit.ts";
import { buildReport, serverCheck } from "./healthChecks.ts";
import { makePeerReports } from "./MachineHealth.ts";

/** A stand-in for the machine's own checks: the peer path is what is under test. */
const ownReport = (machine: Machine, name: string) =>
  DateTime.now.pipe(
    Effect.map((now) =>
      buildReport({
        environmentId: machine.environmentId,
        machineName: name,
        observedAt: now,
        serverVersion: "0.0.0-test",
        uptimeSeconds: 1,
        checks: [serverCheck({ version: "0.0.0-test", schedulerHeartbeatAgeMs: null })],
      }),
    ),
  );

describe("MachineHealth.reportFor", () => {
  it.live(
    "reads a paired machine's report over the link, then describes it once unreachable",
    () =>
      Effect.gen(function* () {
        const hub = yield* startMachine("hub", "cloud-server");
        const spoke = yield* startMachine("laptop", "computer");
        const proxy = yield* startProxy(hub);
        yield* pair(hub, spoke, proxy.url);
        let samples = 0;
        const resources = MachineResources.MachineResources.of({
          read: Effect.sync(() => {
            samples++;
            return {
              sampledAt: samples,
              cpuCores: 4,
              loadAverage1m: 0,
              loadAverage5m: 0,
              availableMemoryBytes: 1000,
              totalMemoryBytes: 2000,
            };
          }),
        });
        yield* hub.run(
          makePeerReports(ownReport(hub, "hub")).pipe(
            Effect.provideService(MachineResources.MachineResources, resources),
          ),
        );
        const { reportFor } = yield* spoke.run(makePeerReports(ownReport(spoke, "laptop")));

        const own = yield* reportFor({});
        assert.strictEqual(own.machineName, "laptop");

        const online = yield* reportFor({ environmentId: hub.environmentId });
        assert.isTrue(online.reachable);
        assert.strictEqual(online.environmentId, hub.environmentId);
        assert.strictEqual(online.machineName, "hub");
        assert.isUndefined(online.resources);
        assert.strictEqual(samples, 0);
        const sampled = yield* reportFor({ environmentId: hub.environmentId }, true);
        assert.strictEqual(sampled.resources?.cpuCores, 4);
        assert.strictEqual(samples, 1);
        assert.isUndefined((yield* reportFor({ environmentId: hub.environmentId })).resources);
        assert.strictEqual(samples, 1);

        // Stop the relay accepting, then cut its socket, so the spoke can't redial.
        yield* Effect.sync(() => proxy.server.close());
        yield* proxy.dropAll;
        yield* awaitLinkState(spoke, (state) => state.status !== "online");

        const offline = yield* reportFor({ environmentId: hub.environmentId });
        assert.isFalse(offline.reachable);
        // Just dropped, so still within the connect grace.
        assert.strictEqual(offline.status, "unknown");
        assert.deepStrictEqual(
          offline.checks.map((check) => [check.id, check.items.map((item) => item.key)]),
          [["machine-links", [`machine-links:reachable:${hub.environmentId}`]]],
        );
        assert.strictEqual(offline.checks[0]?.items[0]?.title, "Connecting to hub…");

        const unknown = yield* reportFor({
          environmentId: EnvironmentId.make("env-unpaired"),
        }).pipe(Effect.flip);
        assert.strictEqual(unknown.reason, "not-paired");
      }).pipe(Effect.scoped),
    30_000,
  );
});
