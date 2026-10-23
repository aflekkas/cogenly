import { createVaultAtoms } from "@t3tools/client-runtime/state/vault";
import { connectionAtomRuntime } from "../connection/runtime";

/** Vault items and their usage log. */
export const vaultRpc = createVaultAtoms(connectionAtomRuntime);
