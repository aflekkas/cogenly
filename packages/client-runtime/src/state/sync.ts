import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentGuardedRpcQueryAtomFamily } from "./runtime.ts";

/**
 * What each directly paired machine has yet to receive from this one, by
 * document kind. `refreshTrigger` names an atom that changes when the
 * environment's paired machines do, so presence re-reads without polling.
 */
export function createSyncStatusAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: {
    readonly refreshTrigger?: (environmentId: EnvironmentId) => Atom.Atom<unknown> | undefined;
  } = {},
) {
  return {
    status: createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
      label: "sync.status",
      tag: WS_METHODS.syncStatus,
      ...(options.refreshTrigger
        ? {
            staleTimeMs: 5_000,
            refreshTrigger: (target: { readonly environmentId: EnvironmentId }) =>
              options.refreshTrigger?.(target.environmentId),
          }
        : {}),
    }),
  };
}
