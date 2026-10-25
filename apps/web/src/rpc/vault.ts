import { createVaultAtoms } from "@t3tools/client-runtime/state/vault";
import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "../state/server";

/** Vault items, their usage log, and sharing with paired machines. */
export const vaultRpc = createVaultAtoms(connectionAtomRuntime, {
  refreshTrigger: (environmentId) => serverEnvironment.machinesLive({ environmentId, input: {} }),
});
