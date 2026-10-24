import { createVaultAtoms } from "@cogenly/client-runtime/state/vault";
import { connectionAtomRuntime } from "../connection/runtime";

/** Vault items and their usage log. */
export const vaultRpc = createVaultAtoms(connectionAtomRuntime);
