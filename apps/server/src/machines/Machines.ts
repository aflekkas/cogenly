/**
 * Machines: this server, the hub it dials, and the spokes that dial it. The
 * one service every transport calls (WebSocket RPC, MCP, CLI). A server is
 * standalone, a hub with spokes, or a spoke of exactly one hub; never both.
 * Feature code sends peer requests with `call` and serves them by registering
 * a channel on `PeerChannels`. See docs/internals/machines.md.
 */
import {
  type EnvironmentId,
  MachineError,
  type MachineCreatePeerGrantInput,
  type MachineInfo,
  type MachineJoinCode,
  type MachineJoinHubInput,
  type MachineLinkState,
  type MachineListResult,
  type MachinePeerIdentity,
  type MachineUnpairInput,
  type MachineUnpairResult,
  type MachineUpdateInput,
  type PeerCallError,
  type PeerChannel,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as SharedState from "../sync/SharedState.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as HubLink from "./HubLink.ts";
import * as MachineIdentity from "./MachineIdentity.ts";
import { relateHubMachine, toMachineInfo } from "./machineInfo.ts";
import { hubPublicKey } from "./peerCrypto.ts";
import { normalizePeerRoute } from "./peerRoutes.ts";
import * as PeerHub from "./PeerHub.ts";

export class Machines extends Context.Service<
  Machines,
  {
    readonly list: Effect.Effect<MachineListResult, MachineError>;
    /** The current list, then a fresh one after every change. */
    readonly subscribe: Stream.Stream<MachineListResult, MachineError>;
    /** Rename this machine or override its kind; null resets to detection. */
    readonly update: (input: MachineUpdateInput) => Effect.Effect<MachineListResult, MachineError>;
    /** Spoke, step 1: the identity and key a hub binds its grant to. */
    readonly prepareJoin: Effect.Effect<MachinePeerIdentity, MachineError>;
    /** Hub, step 2: a one-time grant for one spoke, plus what it pins. */
    readonly createPeerGrant: (
      input: MachineCreatePeerGrantInput,
    ) => Effect.Effect<MachineJoinCode, MachineError>;
    /** Spoke, step 3: redeem the grant and start dialing the hub. */
    readonly joinHub: (
      input: MachineJoinHubInput,
    ) => Effect.Effect<MachineListResult, MachineError>;
    /** Unpair a spoke (on the hub) or the hub (on a spoke). */
    readonly unpair: (
      input: MachineUnpairInput,
    ) => Effect.Effect<MachineUnpairResult, MachineError>;
    /**
     * Send a channel request to a paired machine: the hub from a spoke, a
     * spoke from the hub. Refused, never queued, while it is offline.
     */
    readonly call: <C extends PeerChannel>(
      environmentId: EnvironmentId,
      channel: C,
      payload: C["payload"]["Type"],
    ) => Effect.Effect<C["success"]["Type"], PeerCallError>;
  }
>()("cogenly-server/machines/Machines") {}

const make = Effect.gen(function* () {
  const shared = yield* SharedState.SharedState;
  const identity = yield* MachineIdentity.MachineIdentity;
  const hub = yield* PeerHub.PeerHub;
  const hubLink = yield* HubLink.HubLink;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const endpoints = yield* DirectEndpoints.DirectEndpoints;
  const initialLink = yield* hubLink.view;
  yield* shared.setHub(Option.isSome(initialLink) ? initialLink.value.link.hubEnvironmentId : null);

  const list: Machines["Service"]["list"] = Effect.gen(function* () {
    const self = yield* identity.self;
    const thisMachine = toMachineInfo(self, {
      relation: "this",
      online: true,
      lastSeenAt: null,
      pairedAt: null,
      pairing: "self",
    });
    const joined = yield* hubLink.view;
    if (Option.isSome(joined)) {
      const view = joined.value;
      // Session expiry can happen while offline, without a socket event.
      const expired =
        DateTime.toEpochMillis(view.link.expiresAt) <= DateTime.toEpochMillis(yield* DateTime.now);
      const hubOnline = !expired && view.status === "online";
      const fromHub = view.machines.find((machine) => machine.relation === "this");
      const hubMachine: MachineInfo = {
        ...(fromHub === undefined
          ? relateHubMachine(
              toMachineInfo(view.link.hub, {
                relation: "this",
                online: false,
                lastSeenAt: null,
                pairedAt: null,
                pairing: "self",
              }),
            )
          : relateHubMachine(fromHub)),
        online: hubOnline,
        lastSeenAt: hubOnline ? null : view.link.lastSeenAt,
        pairedAt: view.link.pairedAt,
        pairing: expired || view.status === "revoked" ? "revoked" : "paired",
      };
      // Other spokes are known only through the hub; offline with it.
      const peers = view.machines
        .filter(
          (machine) => machine.relation === "spoke" && machine.environmentId !== self.environmentId,
        )
        .map((machine) => ({
          ...relateHubMachine(machine),
          online: hubOnline && machine.online,
        }));
      const link: MachineLinkState = {
        _tag: "spoke",
        hubEnvironmentId: view.link.hubEnvironmentId,
        status: expired ? "revoked" : view.status,
        route: view.route,
        lastError: view.lastError,
      };
      return { machines: [thisMachine, hubMachine, ...peers], link };
    }
    const spokes = yield* hub.spokes;
    const link: MachineLinkState =
      spokes.length === 0 ? { _tag: "standalone" } : { _tag: "hub", spokes: spokes.length };
    return { machines: [thisMachine, ...spokes], link };
  }).pipe(Effect.withSpan("Machines.list"));

  // The initial list runs alongside the change subscriptions, not before
  // them, so a change landing in between is not missed.
  const subscribe: Machines["Service"]["subscribe"] = Stream.mergeAll(
    [Stream.make(undefined), identity.changes, hub.changes, hubLink.changes],
    { concurrency: "unbounded" },
  ).pipe(Stream.mapEffect(() => list));

  const update: Machines["Service"]["update"] = (input) =>
    identity.update(input).pipe(Effect.andThen(list), Effect.withSpan("Machines.update"));

  const requireNotHub = (operation: MachineError["operation"]) =>
    hub.spokes.pipe(
      Effect.flatMap((spokes) =>
        spokes.length === 0
          ? Effect.void
          : Effect.fail(new MachineError({ operation, reason: "spoke-is-hub" })),
      ),
    );

  const requireNotSpoke = (
    operation: MachineError["operation"],
    reason: "already-paired" | "hub-is-spoke",
  ) =>
    hubLink.view.pipe(
      Effect.flatMap((view) =>
        Option.isNone(view) ? Effect.void : Effect.fail(new MachineError({ operation, reason })),
      ),
    );

  const prepareJoin: Machines["Service"]["prepareJoin"] = requireNotSpoke(
    "prepare-join",
    "already-paired",
  ).pipe(
    Effect.andThen(requireNotHub("prepare-join")),
    Effect.andThen(hubLink.peerIdentity),
    Effect.withSpan("Machines.prepareJoin"),
  );

  const createPeerGrant: Machines["Service"]["createPeerGrant"] = Effect.fn(
    "Machines.createPeerGrant",
  )(function* (input) {
    yield* requireNotSpoke("create-grant", "hub-is-spoke");
    if (!input.spokeKeyThumbprint?.trim()) {
      return yield* new MachineError({ operation: "create-grant", reason: "invalid-input" });
    }
    const storage = (cause: unknown) =>
      new MachineError({ operation: "create-grant", reason: "storage", cause });
    const grant = yield* auth
      .issuePeerGrant({
        label: input.spokeName ?? "Machine",
        proofKeyThumbprint: input.spokeKeyThumbprint,
      })
      .pipe(Effect.mapError(storage));
    const self = yield* identity.self;
    const publicKey = yield* hubPublicKey.pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
      Effect.mapError(storage),
    );
    // Tailnet first: it is encrypted and follows the machine between networks.
    const routes = (yield* endpoints.resolve())
      .toSorted((left, right) => Number(right.kind === "tailnet") - Number(left.kind === "tailnet"))
      .flatMap((endpoint) => {
        try {
          return [normalizePeerRoute(endpoint.httpBaseUrl)];
        } catch {
          return [];
        }
      });
    return {
      grant: grant.credential,
      hubEnvironmentId: self.environmentId,
      hubName: self.name,
      hubPublicKey: publicKey,
      routes,
      expiresAt: grant.expiresAt,
    } satisfies MachineJoinCode;
  });

  const joinHub: Machines["Service"]["joinHub"] = (input) =>
    requireNotHub("join").pipe(
      Effect.andThen(hubLink.join(input)),
      Effect.andThen(shared.setHub(input.code.hubEnvironmentId)),
      Effect.andThen(list),
      Effect.withSpan("Machines.joinHub"),
    );

  const unpair: Machines["Service"]["unpair"] = Effect.fn("Machines.unpair")(function* (input) {
    const view = yield* hubLink.view;
    if (Option.isSome(view) && view.value.link.hubEnvironmentId === input.environmentId) {
      const unpaired = yield* hubLink.leave;
      yield* shared.setHub(null);
      return { unpaired };
    }
    return { unpaired: yield* hub.unpair(input.environmentId) };
  });

  const call: Machines["Service"]["call"] = (environmentId, channel, payload) =>
    hubLink.view.pipe(
      Effect.orElseSucceed(() => Option.none<HubLink.HubLinkView>()),
      Effect.flatMap((view) =>
        Option.isSome(view) && view.value.link.hubEnvironmentId === environmentId
          ? hubLink.callHub(channel, payload)
          : hub.callSpoke(environmentId, channel, payload),
      ),
    );

  return Machines.of({
    list,
    subscribe,
    update,
    prepareJoin,
    createPeerGrant,
    joinHub,
    unpair,
    call,
  });
});

export const layer = Layer.effect(Machines, make).pipe(Layer.provide(SharedState.layer));
