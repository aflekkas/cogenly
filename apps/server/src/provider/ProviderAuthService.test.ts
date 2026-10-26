import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthPeerDelegateScope, EnvironmentId, ProviderInstanceId } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as ProviderAuthFlow from "@cogenly/provider-core/server/providerAuthFlow";
import type { ProviderInstance } from "@cogenly/provider-core/server/driver";
import * as Machines from "../machines/Machines.ts";
import * as PeerChannels from "../machines/PeerChannels.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as Registry from "./ProviderInstanceRegistry.ts";
import * as ProviderAuthService from "./ProviderAuthService.ts";

it.effect(
  "a paired machine owns its login and isolates the initiating client; cancel reaches the target",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claude-personal");
      const started = yield* Deferred.make<void>();
      const authenticated = yield* Deferred.make<void>();
      const peers = new Map<string, PeerChannels.PeerChannels["Service"]>();
      const controller = yield* ProviderAuthFlow.make({
        instanceId,
        credentialBinding: { owner: "provider", key: "contabo:personal" },
        methods: Effect.succeed([{ id: "cli", name: "CLI", description: null, type: "agent" }]),
        authenticate: (_, flow) =>
          Effect.gen(function* () {
            yield* flow.setInteraction({
              type: "browser",
              id: "browser",
              url: "https://claude.ai/oauth/authorize",
              requiresConsent: false,
            });
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(authenticated);
          }),
        logout: Effect.void,
      });
      const make = Effect.fnUntraced(function* (name: string, hasProvider: boolean) {
        const channels = yield* PeerChannels.PeerChannels.pipe(Effect.provide(PeerChannels.layer));
        peers.set(name, channels);
        const instance = { instanceId, auth: controller } as ProviderInstance;
        const changes = yield* PubSub.unbounded<void>();
        return yield* ProviderAuthService.makeProviderAuthService.pipe(
          Effect.provideService(PeerChannels.PeerChannels, channels),
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(Machines.Machines)({
                call: (target, channel, payload) =>
                  PeerChannels.encodePeerPayload(channel, payload).pipe(
                    Effect.flatMap((encoded) =>
                      peers.get(target)!.dispatch({
                        channel: channel.name,
                        payload: encoded,
                        caller: {
                          environmentId: EnvironmentId.make(name),
                          scopes: [AuthPeerDelegateScope],
                        },
                      }),
                    ),
                    Effect.flatMap((reply) => PeerChannels.decodePeerResult(channel, reply)),
                  ),
              }),
              Layer.mock(Registry.ProviderInstanceRegistry)({
                getInstance: () => Effect.succeed(hasProvider ? instance : undefined),
                listInstances: Effect.succeed(hasProvider ? [instance] : []),
                subscribeChanges: PubSub.subscribe(changes),
              }),
              Layer.mock(Projections.ProjectionStoreV2)({
                getRecoveryThreadIds: () => Effect.succeed([]),
              }),
              Layer.mock(Sessions.ProviderSessionManagerV2)({}),
            ),
          ),
        );
      });
      yield* make("contabo", true);
      const mac = yield* make("macbook", false);
      const input = {
        instanceId,
        targetEnvironmentId: EnvironmentId.make("contabo"),
        methodId: "cli",
      };
      const flow = yield* mac.start(input, "client-one");
      yield* Deferred.await(started);
      const own = yield* mac.manageSignIn({ operation: "read", input }, "client-one");
      expect(own.interaction?.type).toBe("browser");
      const stranger = yield* mac.manageSignIn({ operation: "read", input }, "client-two");
      expect(stranger.interaction).toBeNull();
      const denied = yield* mac
        .cancel({ ...input, flowId: flow.flowId! }, "client-two")
        .pipe(Effect.exit);
      expect(Exit.isFailure(denied)).toBe(true);
      expect((yield* mac.cancel({ ...input, flowId: flow.flowId! }, "client-one")).phase).toBe(
        "cancelled",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
