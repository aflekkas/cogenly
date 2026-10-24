import { WS_METHODS } from "@cogenly/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentGuardedRpcQueryAtomFamily,
  createEnvironmentRpcCommand,
} from "./runtime.ts";

/** Vault item metadata, usage log, and writes. Values never come back after save. */
export function createVaultAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
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
  };
}
