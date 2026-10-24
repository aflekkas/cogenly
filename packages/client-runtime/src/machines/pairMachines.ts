import {
  WS_METHODS,
  type EnvironmentId,
  type MachineCreatePeerGrantInput,
  type MachineJoinCode,
  type MachineJoinHubInput,
  type MachineListResult,
  type MachinePeerIdentity,
  type MachineSetupStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Atom } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import { requestGuarded } from "../rpc/client.ts";
import { createEnvironmentGuardedCommand } from "../state/runtime.ts";

/** Why the client refused to start pairing, before any grant was redeemed. */
export class MachinePairingRefusedError extends Schema.TaggedError<MachinePairingRefusedError>()(
  "MachinePairingRefusedError",
  {
    reason: Schema.Literals(["same-machine", "hub-not-ready"]),
    hubName: Schema.String,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "same-machine":
        return "A machine can't pair with itself. Pick a different machine.";
      case "hub-not-ready":
        return `${this.hubName} isn't ready for pairing yet. Finish its steps first.`;
    }
  }
}

/** The always-on machine's side of pairing. */
export interface MachinePairingHub<E, R> {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly setupStatus: Effect.Effect<MachineSetupStatus, E, R>;
  readonly createPeerGrant: (
    input: MachineCreatePeerGrantInput,
  ) => Effect.Effect<MachineJoinCode, E, R>;
}

/** The joining machine's side of pairing. */
export interface MachinePairingSpoke<E, R> {
  readonly environmentId: EnvironmentId;
  readonly prepareJoin: Effect.Effect<MachinePeerIdentity, E, R>;
  readonly joinHub: (input: MachineJoinHubInput) => Effect.Effect<MachineListResult, E, R>;
}

/**
 * Pairs `spoke` with `hub`: the spoke prepares its key, the hub issues a grant
 * bound to it, and the spoke redeems the grant over the routes the hub
 * advertised. The join code is a one-time secret, so it only ever lives in
 * this effect's locals, never in state, logs, or URLs.
 */
export const pairMachines = <HubE, HubR, SpokeE, SpokeR>(
  hub: MachinePairingHub<HubE, HubR>,
  spoke: MachinePairingSpoke<SpokeE, SpokeR>,
): Effect.Effect<MachineListResult, HubE | SpokeE | MachinePairingRefusedError, HubR | SpokeR> =>
  Effect.gen(function* () {
    const refuse = (reason: MachinePairingRefusedError["reason"]) =>
      new MachinePairingRefusedError({ reason, hubName: hub.name });
    if (hub.environmentId === spoke.environmentId) return yield* refuse("same-machine");
    const status = yield* hub.setupStatus;
    if (!status.ready || status.joinUrl === null) return yield* refuse("hub-not-ready");
    const identity = yield* spoke.prepareJoin;
    if (identity.environmentId === hub.environmentId) return yield* refuse("same-machine");
    const code = yield* hub.createPeerGrant({
      spokeKeyThumbprint: identity.keyThumbprint,
      spokeName: identity.name,
    });
    // Two saved connections can reach one server under different names.
    if (code.hubEnvironmentId === identity.environmentId) return yield* refuse("same-machine");
    // Empty routes: join over the addresses the hub advertised in the code.
    return yield* spoke.joinHub({ hubUrls: [], code });
  });

export interface MachinePairingInput {
  readonly hubEnvironmentId: EnvironmentId;
  /** Names the hub in a refusal. */
  readonly hubName: string;
}

/**
 * `pairMachines` as one command targeting the spoke. It needs access:write on
 * both machines; each request is authorized against the machine it goes to.
 */
export function createMachinePairingCommand<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
) {
  return createEnvironmentGuardedCommand(runtime, {
    label: "machines:pair",
    tag: WS_METHODS.machinesJoinHub,
    concurrency: {
      mode: "singleFlight",
      key: (target: { readonly environmentId: EnvironmentId }) => target.environmentId,
    },
    execute: (input: MachinePairingInput, spokeEnvironmentId: EnvironmentId) =>
      Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const setupStatus = registry.run(
          input.hubEnvironmentId,
          requestGuarded(WS_METHODS.machinesSetupStatus, {}),
        );
        const createPeerGrant = (grant: MachineCreatePeerGrantInput) =>
          registry.run(
            input.hubEnvironmentId,
            requestGuarded(WS_METHODS.machinesCreatePeerGrant, grant),
          );
        const hub: MachinePairingHub<
          Effect.Error<typeof setupStatus> | Effect.Error<ReturnType<typeof createPeerGrant>>,
          never
        > = {
          environmentId: input.hubEnvironmentId,
          name: input.hubName,
          setupStatus,
          createPeerGrant,
        };
        return yield* pairMachines(hub, {
          environmentId: spokeEnvironmentId,
          prepareJoin: requestGuarded(WS_METHODS.machinesPrepareJoin, {}),
          joinHub: (join) => requestGuarded(WS_METHODS.machinesJoinHub, join),
        });
      }),
  });
}
