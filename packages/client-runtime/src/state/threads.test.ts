import { expect, it } from "@effect/vitest";
import { EnvironmentId, ORCHESTRATION_V2_WS_METHODS } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import type { RpcSession } from "../rpc/session.ts";
import { ThreadSnapshotLoader } from "./threadSnapshotHttp.ts";
import { createEnvironmentThreadStateAtoms } from "./threads.ts";
import { v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";

it.live(
  "reopens a cold 404 when the new thread arrives, without resending its message",
  () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("vps");
      const target = new PrimaryConnectionTarget({
        environmentId,
        label: "VPS",
        httpBaseUrl: "https://vps.test",
        wsBaseUrl: "wss://vps.test",
      });
      const prepared: PreparedConnection = {
        environmentId,
        target,
        label: "VPS",
        httpBaseUrl: "https://vps.test",
        socketUrl: "wss://vps.test/ws",
        httpAuthorization: null,
      };
      let subscriptions = 0;
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: () => {
          subscriptions++;
          return Stream.concat(Stream.make({ kind: "synchronized" as const }), Stream.never);
        },
      } as unknown as RpcSession["client"];
      const session: RpcSession = {
        client,
        initialConfig: Effect.succeed({ threadResumeCompletionMarker: true } as never),
        subscribeServerConfig: () => Stream.never,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      const supervisor = EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.some(prepared)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const exists = Atom.make(false);
      let loads = 0;
      const layer = Layer.mergeAll(
        Layer.succeed(EnvironmentRegistry, {
          followStream: (_id, stream) =>
            stream.pipe(Stream.provideService(EnvironmentSupervisor, supervisor)),
        } as EnvironmentRegistry["Service"]),
        Layer.succeed(EnvironmentCacheStore, {
          loadThread: () => Effect.succeedNone,
          saveThread: () => Effect.void,
          removeThread: () => Effect.void,
        } as unknown as EnvironmentCacheStore["Service"]),
        Layer.succeed(ThreadSnapshotLoader, {
          load: () =>
            Effect.sync(() =>
              ++loads === 1
                ? { _tag: "missing" as const }
                : {
                    _tag: "present" as const,
                    snapshot: { snapshotSequence: 10, projection: v2Projection },
                  },
            ),
        }),
      );
      const runtime = Atom.runtime(layer);
      const atoms = createEnvironmentThreadStateAtoms(runtime, () => exists);
      const state = atoms.stateAtom(environmentId, v2ThreadId);
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      registry.mount(state);
      const awaitState = (status: string) =>
        AtomRegistry.toStream(registry, state).pipe(
          Stream.filter((value) => AsyncResult.isSuccess(value) && value.value.status === status),
          Stream.take(1),
          Stream.runDrain,
        );
      yield* awaitState("deleted");
      expect(loads).toBe(1);
      expect(subscriptions).toBe(0);
      registry.set(exists, true);
      yield* awaitState("live");
      expect(loads).toBe(2);
      expect(subscriptions).toBe(1);
      const current = registry.get(state);
      expect(
        AsyncResult.isSuccess(current) && Option.getOrNull(current.value.data)?.thread.id,
      ).toBe(v2ThreadId);
    }).pipe(Effect.scoped),
  10000,
);
