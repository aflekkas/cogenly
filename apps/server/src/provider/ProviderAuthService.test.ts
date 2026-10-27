import * as SecretRequests from "../secrets/SecretRequests.ts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthPeerDelegateScope,
  EnvironmentId,
  ProviderMachineAuth,
  ProviderInstanceId,
  ProjectId,
  SecretRef,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
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
  "spoke-to-spoke login routes through the hub, isolates its client and cancels on the target",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claude-personal");
      const started = yield* Deferred.make<void>();
      const authenticated = yield* Deferred.make<void>();
      const receivedCode = yield* Deferred.make<void>();
      const peers = new Map<string, PeerChannels.PeerChannels["Service"]>();
      const controller = yield* ProviderAuthFlow.make({
        instanceId,
        credentialBinding: { owner: "provider", key: "contabo:personal" },
        methods: Effect.succeed([{ id: "cli", name: "CLI", description: null, type: "agent" }]),
        authenticate: (_, flow) =>
          Effect.gen(function* () {
            yield* flow.setInteraction(
              {
                type: "credentials",
                id: "browser",
                url: "https://claude.ai/oauth/authorize",
                fields: [{ name: "code", label: "One-time code", secret: true }],
              },
              (response) =>
                response.type === "credentials" && response.values.code === "hidden-code"
                  ? Deferred.succeed(receivedCode, undefined).pipe(Effect.asVoid)
                  : Effect.die("Invalid test code"),
            );
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(authenticated);
          }),
        logout: Effect.void,
      });
      const make = Effect.fnUntraced(function* (
        name: string,
        hasProvider: boolean,
        role: "standalone" | "spoke" | "hub" = "standalone",
      ) {
        const channels = yield* PeerChannels.PeerChannels.pipe(Effect.provide(PeerChannels.layer));
        peers.set(name, channels);
        const instance = { instanceId, auth: controller } as ProviderInstance;
        const changes = yield* PubSub.unbounded<void>();
        return yield* ProviderAuthService.makeProviderAuthService.pipe(
          Effect.provideService(PeerChannels.PeerChannels, channels),
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(Machines.Machines)({
                list: Effect.sync(() => ({
                  machines: Array.from(peers.keys()).map((key) => ({
                    environmentId: EnvironmentId.make(key),
                    name: key,
                    kind: key === name ? ("this-computer" as const) : ("other-computer" as const),
                    hardware: "laptop" as const,
                    platform: "linux" as const,
                    providers: [],
                    relation:
                      key === name
                        ? ("this" as const)
                        : role === "hub"
                          ? ("spoke" as const)
                          : key === "hub"
                            ? ("hub" as const)
                            : ("peer" as const),
                    online: true,
                    lastSeenAt: null,
                    pairedAt: null,
                    pairing: key === name ? ("self" as const) : ("paired" as const),
                  })),
                  link:
                    role === "spoke"
                      ? {
                          _tag: "spoke" as const,
                          hubEnvironmentId: EnvironmentId.make("hub"),
                          status: "online" as const,
                          route: null,
                          lastError: null,
                        }
                      : role === "hub"
                        ? { _tag: "hub" as const, spokes: 2 }
                        : { _tag: "standalone" as const },
                })),
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
      const hub = yield* make("hub", false, "hub");
      const mac = yield* make("macbook", false, "spoke");
      const input = {
        instanceId,
        targetEnvironmentId: EnvironmentId.make("contabo"),
        methodId: "cli",
      };
      const flow = yield* mac.start(input, "client-one");
      yield* Deferred.await(started);
      const own = yield* mac.manageSignIn({ operation: "read", input }, "client-one");
      expect(own.interaction?.type).toBe("credentials");
      const stranger = yield* mac.manageSignIn({ operation: "read", input }, "client-two");
      expect(stranger.interaction).toBeNull();
      expect(stranger.flowId).toBeNull();
      expect(stranger.flowEpoch).toBe(flow.flowEpoch);
      const denied = yield* mac
        .cancel({ ...input, flowId: flow.flowId! }, "client-two")
        .pipe(Effect.exit);
      expect(Exit.isFailure(denied)).toBe(true);
      expect(
        (yield* mac.manageSignIn(
          {
            operation: "cancel",
            input: { ...input, flowId: null, flowEpoch: stranger.flowEpoch! },
          },
          "client-two",
        )).phase,
      ).toBe("cancelled");
      const retry = yield* mac.start(input, "client-one");
      const stale = yield* mac
        .cancel({ ...input, flowEpoch: stranger.flowEpoch! }, "client-two")
        .pipe(Effect.flip);
      expect(stale.detail).toContain("no longer active");
      yield* controller.subscribe("hub:macbook:client-one").pipe(
        Stream.filter((state) => state.flowId === retry.flowId && state.phase === "waiting"),
        Stream.runHead,
      );
      let adopted = false;
      yield* mac
        .manageSignIn(
          {
            operation: "respond",
            input: {
              ...input,
              flowId: retry.flowId!,
              interactionId: "browser",
              response: { type: "credentials", values: {} },
            },
          },
          "client-one",
          { ref: SecretRef.make("secret:code"), projectId: ProjectId.make("project") },
        )
        .pipe(
          Effect.provide(
            Layer.mock(SecretRequests.SecretRequests)({
              adopt: (_receipt, save) => {
                adopted = true;
                return save("hidden-code");
              },
            }),
          ),
        );
      yield* Deferred.await(receivedCode);
      yield* Deferred.succeed(authenticated, undefined);
      const completed = yield* controller.subscribe("hub:macbook:client-one").pipe(
        Stream.filter((state) => state.phase === "succeeded"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(adopted).toBe(true);
      expect(completed.interaction).toBeNull();
      expect(completed.message).toBe("Sign-in complete.");
      const legacy = yield* PeerChannels.PeerChannels.pipe(Effect.provide(PeerChannels.layer));
      yield* legacy.register(
        {
          ...ProviderMachineAuth,
          payload: Schema.Struct({
            owner: Schema.String,
            // Older peers require a respond-capable ID on every cancel.
            request: Schema.Struct({
              operation: Schema.Literal("cancel"),
              input: Schema.Struct({
                instanceId: ProviderInstanceId,
                targetEnvironmentId: Schema.optionalKey(EnvironmentId),
                flowId: Schema.String,
              }),
            }),
          }),
        },
        () => Effect.die("Legacy decoder should reject before running the handler"),
      );
      peers.set("contabo", legacy);
      for (const service of [hub, mac]) {
        const incompatible = yield* service
          .cancel({ ...input, flowId: null }, "client-two")
          .pipe(Effect.flip);
        expect(incompatible.detail).toBe(
          "Update Cogenly on the other machine to use this sign-in action.",
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(NodeServices.layer, Layer.mock(SecretRequests.SecretRequests)({})),
      ),
    ),
);
