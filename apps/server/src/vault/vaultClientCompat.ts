import type { VaultItemMetadata, VaultListResult, VaultPolicy } from "@cogenly/contracts";

/**
 * Block (`deny`) arrived after 0.3.2, and a client that can't decode it fails
 * the whole vault list. Desktop apps lag the server, so a client that doesn't
 * advertise `supportsDenyPolicy` reads Block as Ask. Only the wire changes:
 * the stored rule stays `deny` and the server keeps refusing agents.
 */
export const vaultItemForClient = (
  item: VaultItemMetadata,
  supportsDenyPolicy: boolean | undefined,
): VaultItemMetadata =>
  supportsDenyPolicy === true || item.policy.mode !== "deny"
    ? item
    : { ...item, policy: { ...item.policy, mode: "ask" } };

export const vaultListForClient = (
  result: VaultListResult,
  supportsDenyPolicy: boolean | undefined,
): VaultListResult =>
  supportsDenyPolicy === true
    ? result
    : { ...result, items: result.items.map((item) => vaultItemForClient(item, false)) };

/**
 * The rule an update stores. A client without Block saw a blocked item as Ask,
 * so the Ask it sends back when saving other changes keeps the item blocked.
 */
export const updatedVaultPolicy = (
  stored: VaultPolicy,
  incoming: VaultPolicy | undefined,
  supportsDenyPolicy: boolean | undefined,
): VaultPolicy => {
  if (incoming === undefined) return stored;
  if (supportsDenyPolicy !== true && stored.mode === "deny" && incoming.mode === "ask")
    return { ...incoming, mode: "deny" };
  return incoming;
};
