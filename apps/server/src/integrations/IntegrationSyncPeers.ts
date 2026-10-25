/**
 * What Integrations knows about paired machines when sign-ins travel through
 * the shared vault: which machine refreshes a new sign-in, what that machine
 * is called, and whether the vault is shared at all. Machines and VaultSync
 * are built after Integrations, so IntegrationSyncBinding attaches them once
 * they exist. Until then, and on a machine that is not paired, every sign-in
 * is this machine's own to refresh. See docs/internals/vault-sync.md.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as Machines from "../machines/Machines.ts";
import type * as VaultSync from "../vault/VaultSync.ts";
import type * as VaultSyncCapture from "../vault/VaultSyncCapture.ts";

export interface SignInPeers {
  /** The machine a sign-in made here should name as its only refresher. */
  readonly defaultRefreshOwner: Effect.Effect<string>;
  /** A machine's name for messages; another machine's id is never shown. */
  readonly label: (environmentId: string) => Effect.Effect<string>;
  /** Whether this vault is shared with at least one machine. */
  readonly sharing: Effect.Effect<boolean>;
}

export class IntegrationSyncPeers extends Context.Service<
  IntegrationSyncPeers,
  SignInPeers & {
    /** This machine's environment id. */
    readonly self: string;
    /** Attaches the paired-machine view for the caller's scope. */
    readonly bind: (peers: SignInPeers) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("cogenly-server/integrations/IntegrationSyncPeers") {}

/** A port for `self` with nothing paired until `bind`. */
export const make = (self: string) =>
  Effect.gen(function* () {
    const standalone: SignInPeers = {
      defaultRefreshOwner: Effect.succeed(self),
      label: () => Effect.succeed("another machine"),
      sharing: Effect.succeed(false),
    };
    const bound = yield* Ref.make(standalone);
    const current = Ref.get(bound);
    return IntegrationSyncPeers.of({
      self,
      defaultRefreshOwner: Effect.flatMap(current, (peers) => peers.defaultRefreshOwner),
      label: (environmentId) => Effect.flatMap(current, (peers) => peers.label(environmentId)),
      sharing: Effect.flatMap(current, (peers) => peers.sharing),
      bind: (peers) =>
        Effect.acquireRelease(Ref.set(bound, peers), () => Ref.set(bound, standalone)),
    });
  });

export const layer = Layer.effect(
  IntegrationSyncPeers,
  Effect.gen(function* () {
    const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
    return yield* make(yield* identity.getEnvironmentId);
  }),
);

/** Tests: a fixed id, standalone until bound. */
export const layerFor = (self: string) => Layer.effect(IntegrationSyncPeers, make(self));

/**
 * The paired-machine view from Machines and VaultSync. A spoke names its hub,
 * which is always on, when the hub reads this vault (both sides share);
 * anything else refreshes its own sign-ins.
 */
export const signInPeers = (input: {
  readonly self: string;
  readonly machines: Machines.Machines["Service"];
  readonly vaultSync: VaultSync.VaultSync["Service"];
  readonly capture: VaultSyncCapture.VaultSyncCapture["Service"];
}): SignInPeers => ({
  defaultRefreshOwner: Effect.gen(function* () {
    const view = yield* input.machines.list;
    if (view.link._tag !== "spoke") return input.self;
    const hub = view.link.hubEnvironmentId;
    const status = yield* input.vaultSync.sharingStatus;
    return status.peers.some((peer) => peer.environmentId === hub && peer.state === "shared")
      ? (hub as string)
      : input.self;
  }).pipe(Effect.orElseSucceed(() => input.self)),
  label: (environmentId) =>
    input.machines.list.pipe(
      Effect.map(
        (view) =>
          view.machines.find((machine) => machine.environmentId === environmentId)?.name ??
          "another machine",
      ),
      Effect.orElseSucceed(() => "another machine"),
    ),
  sharing: input.capture.shares.pipe(
    Effect.map((shares) => shares.length > 0),
    Effect.orElseSucceed(() => false),
  ),
});
