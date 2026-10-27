import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@cogenly/contracts";
import type { ProviderInstance } from "@cogenly/provider-core/server/driver";
import * as ProviderAdapter from "@cogenly/provider-core/server/ProviderAdapter";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@cogenly/provider-core/server/maintenanceResolver";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Config from "../config.ts";
import * as Instances from "./ProviderInstanceRegistry.ts";
import * as Manifest from "./ModelManifest.ts";
import * as Registry from "./ProviderRegistry.ts";

const instanceId = ProviderInstanceId.make("claude");
const driverKind = ProviderDriverKind.make("claude");
const snapshot: ServerProvider = {
  instanceId,
  driver: driverKind,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
};
const unused = () => Effect.die("unused provider operation");

it.effect(
  "concurrent workspace callers await one scan even when its first caller disconnects",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const staleStarted = yield* Deferred.make<void>();
      const staleRelease = yield* Deferred.make<void>();
      const freshStarted = yield* Deferred.make<void>();
      const freshRelease = yield* Deferred.make<void>();
      const waiterJoined = yield* Deferred.make<void>();
      const changes = yield* PubSub.unbounded<void>();
      let scans = 0;
      let lookups = 0;
      const adapter = yield* ProviderAdapter.ProviderAdapterV2;
      const instance: ProviderInstance = {
        instanceId,
        driverKind,
        continuationIdentity: { driverKind, continuationKey: "test" },
        displayName: "Claude",
        enabled: true,
        orchestrationAdapter: adapter,
        textGeneration: {
          generateCommitMessage: unused,
          generatePrContent: unused,
          generateBranchName: unused,
          generateThreadTitle: unused,
          generateReviewGuide: unused,
        },
        snapshot: {
          getSnapshot: Effect.succeed(snapshot),
          refresh: Effect.succeed(snapshot),
          streamChanges: Stream.empty,
          resolveMaintenance: () =>
            Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({
                provider: driverKind,
                packageName: null,
              }),
            ),
          applyUsageLimits: () => Effect.void,
        },
        snapshotForCwd: () =>
          Effect.gen(function* () {
            const scan = ++scans;
            yield* Deferred.succeed(
              scan === 1 ? started : scan === 2 ? staleStarted : freshStarted,
              undefined,
            );
            yield* Deferred.await(scan === 1 ? release : scan === 2 ? staleRelease : freshRelease);
            return {
              ...snapshot,
              skills: [
                {
                  name: scan === 1 ? "workspace" : scan === 2 ? "stale" : "fresh",
                  path: "/repo/SKILL.md",
                  description: "Scoped skill",
                  enabled: true,
                },
              ],
            };
          }),
      };
      const instances = Layer.succeed(
        Instances.ProviderInstanceRegistry,
        Instances.ProviderInstanceRegistry.of({
          getInstance: () =>
            Effect.gen(function* () {
              lookups++;
              if (lookups === 2) yield* Deferred.succeed(waiterJoined, undefined);
              return instance;
            }),
          listInstances: Effect.succeed([instance]),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.empty,
          subscribeChanges: PubSub.subscribe(changes),
        }),
      );
      const registryContext = yield* Layer.build(
        Registry.layer.pipe(
          Layer.provide(instances),
          Layer.provide(Manifest.layerTest),
          Layer.provide(Config.layerTest(process.cwd(), { prefix: "cogenly-workspace-refresh-" })),
          Layer.provide(NodeServices.layer),
        ),
      );
      const registry = Context.get(registryContext, Registry.ProviderRegistry);
      const input = { instanceId, cwd: "/repo" };
      const owner = yield* registry
        .refreshWorkspaceSnapshot(input)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(started);
      const waiter = yield* registry
        .refreshWorkspaceSnapshot(input)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(waiterJoined);
      yield* Fiber.interrupt(owner);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(waiter);
      expect(scans).toBe(1);
      expect(result[0]?.workspaceSnapshots?.[0]?.skills[0]?.name).toBe("workspace");
      yield* registry.refreshWorkspaceSnapshot(input);
      expect(scans).toBe(1);
      const stale = yield* registry
        .refreshWorkspaceSnapshot({ ...input, fresh: true })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(staleStarted);
      const fresh = yield* registry
        .refreshWorkspaceSnapshot({ ...input, fresh: true })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(freshStarted);
      yield* Deferred.succeed(staleRelease, undefined);
      yield* Fiber.join(stale);
      yield* Deferred.succeed(freshRelease, undefined);
      expect((yield* Fiber.join(fresh))[0]?.workspaceSnapshots?.[0]?.skills[0]?.name).toBe("fresh");
      expect(scans).toBe(3);
    }).pipe(
      Effect.provide(
        Layer.mock(ProviderAdapter.ProviderAdapterV2)({ instanceId, driver: driverKind }),
      ),
      Effect.scoped,
    ),
);
