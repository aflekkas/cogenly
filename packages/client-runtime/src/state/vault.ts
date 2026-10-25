import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentGuardedRpcQueryAtomFamily,
  createEnvironmentRpcCommand,
} from "./runtime.ts";

/**
 * Vault item metadata, usage log, and writes. Values never come back after save.
 * `refreshTrigger` names an atom that changes when the environment's paired
 * machines do (one coming online, a pairing ending), so sharing status re-reads
 * without polling.
 */
export function createVaultAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: {
    readonly refreshTrigger?: (environmentId: EnvironmentId) => Atom.Atom<unknown> | undefined;
  } = {},
) {
  return {
    list: createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
      label: "vault.list",
      tag: WS_METHODS.vaultList,
    }),
    usage: createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
      label: "vault.usage",
      tag: WS_METHODS.vaultUsage,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "vault.create",
      tag: WS_METHODS.vaultCreate,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "vault.update",
      tag: WS_METHODS.vaultUpdate,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "vault.delete",
      tag: WS_METHODS.vaultDelete,
    }),
    /** Per directly paired machine, whether each side shares its vault with the other. */
    sharingStatus: createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
      label: "vault.sharingStatus",
      tag: WS_METHODS.vaultSharingStatus,
      ...(options.refreshTrigger
        ? {
            staleTimeMs: 5_000,
            refreshTrigger: (target: { readonly environmentId: EnvironmentId }) =>
              options.refreshTrigger?.(target.environmentId),
          }
        : {}),
    }),
    setPeerSharing: createEnvironmentRpcCommand(runtime, {
      label: "vault.setPeerSharing",
      tag: WS_METHODS.vaultSetPeerSharing,
    }),
  };
}
