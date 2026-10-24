import { assert, describe, it } from "@effect/vitest";
import { ExecutionEnvironmentDescriptor, ServerProvider } from "@cogenly/contracts";
import * as HostProcess from "@cogenly/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MachineIdentity from "./MachineIdentity.ts";

const descriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor)({
  environmentId: "test-computer",
  label: "Home PC",
  platform: { os: "windows", arch: "x64" },
  serverVersion: "1.0.0",
  capabilities: {},
});
const provider = Schema.decodeUnknownSync(ServerProvider)({
  instanceId: "codex",
  driver: "codex",
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-23T00:00:00.000Z",
  models: [],
});

const testLayer = Layer.unwrap(
  Effect.gen(function* () {
    const snapshots = yield* SubscriptionRef.make([provider]);
    const registry = Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: SubscriptionRef.get(snapshots),
      streamChanges: SubscriptionRef.changes(snapshots),
    });
    return Layer.mergeAll(MachineIdentity.layer, Layer.succeed(ProviderSnapshots, snapshots)).pipe(
      Layer.provideMerge(ServerSettings.layerTest()),
      Layer.provide(registry),
      Layer.provide(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed(descriptor),
        }),
      ),
      Layer.provide(Layer.mock(ProcessRunner.ProcessRunner)({})),
      Layer.provide(FileSystem.layerNoop({})),
      Layer.provide(Layer.succeed(HostProcess.Hostname, "home-pc")),
    );
  }),
);

// Test-owned reference lets a provider change without replacing the machine service.
class ProviderSnapshots extends Context.Service<
  ProviderSnapshots,
  SubscriptionRef.SubscriptionRef<Array<ServerProvider>>
>()("cogenly-server/machines/MachineIdentity.test/ProviderSnapshots") {}

describe("MachineIdentity", () => {
  it.effect("applies name and kind overrides and resets to detected identity", () =>
    Effect.gen(function* () {
      const identity = yield* MachineIdentity.MachineIdentity;
      const detected = yield* identity.self;
      assert.strictEqual(detected.name, "Home PC");
      assert.strictEqual(detected.role, "computer");
      assert.strictEqual(detected.hardware, "desktop");
      yield* identity.update({ name: "Office", role: "cloud-server" });
      assert.strictEqual((yield* identity.self).name, "Office");
      assert.strictEqual((yield* identity.self).hardware, "server");
      yield* identity.update({ name: null, role: null });
      assert.deepStrictEqual(yield* identity.self, detected);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("publishes provider auth changes so peers can refresh their reports", () =>
    Effect.gen(function* () {
      const identity = yield* MachineIdentity.MachineIdentity;
      const snapshots = yield* ProviderSnapshots;
      const pull = yield* Stream.toPull(identity.changes);
      yield* pull;
      yield* SubscriptionRef.set(snapshots, [
        { ...provider, auth: { ...provider.auth, status: "unauthenticated" as const } },
      ]);
      yield* pull;
      assert.strictEqual((yield* identity.self).providers[0]?.auth, "unauthenticated");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
