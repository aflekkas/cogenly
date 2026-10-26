import type {
  SharedDocumentKind,
  SharedSyncPeerStatus,
  VaultPeerSharingState,
  VaultPortabilityReason,
} from "@cogenly/contracts";

/** How one paired machine stands for one kind of synced data, as its row shows it. */
export type PeerSyncIndicator =
  | { readonly kind: "synced" }
  | { readonly kind: "syncing"; readonly pending: number }
  | { readonly kind: "not_shared" }
  | { readonly kind: "offline" }
  | { readonly kind: "key_changed" };

/** Changes `peer` has yet to receive for `kind`; 0 when its status has not arrived. */
export function pendingFor(
  peer: SharedSyncPeerStatus | undefined,
  kind: SharedDocumentKind,
): number {
  return peer?.kinds.find((entry) => entry.kind === kind)?.pendingOutgoing ?? 0;
}

/**
 * The indicator for one paired machine. `sharing` is the vault's sharing state
 * with it; data that always syncs, such as memory, leaves it out. A choice the
 * owner has to make outranks presence, and presence outranks progress, because
 * an offline machine receives nothing however much is queued for it.
 */
export function peerSyncIndicator(input: {
  readonly machine: string;
  readonly online: boolean;
  readonly pending: number;
  readonly sharing?: VaultPeerSharingState;
}): PeerSyncIndicator {
  if (input.sharing === "key_changed") return { kind: "key_changed" };
  if (input.sharing === "not_shared") return { kind: "not_shared" };
  if (!input.online) return { kind: "offline" };
  if (input.sharing === "waiting_for_peer") return { kind: "not_shared" };
  if (input.pending > 0) return { kind: "syncing", pending: input.pending };
  return { kind: "synced" };
}

export function peerSyncLabel(indicator: PeerSyncIndicator): string {
  switch (indicator.kind) {
    case "synced":
      return "Synced";
    case "syncing":
      return indicator.pending === 1 ? "Syncing 1 change" : `Syncing ${indicator.pending} changes`;
    case "not_shared":
      return "Not shared";
    case "offline":
      return "Offline";
    case "key_changed":
      return "Key changed: unpair and pair again";
  }
}

export function peerSyncTone(
  indicator: PeerSyncIndicator,
): "success" | "info" | "warning" | "error" | "outline" {
  switch (indicator.kind) {
    case "synced":
      return "success";
    case "syncing":
      return "info";
    case "key_changed":
      return "error";
    case "not_shared":
    case "offline":
      return "outline";
  }
}

/** The vault's line about items no machine has made readable here yet; null when there are none. */
export function vaultItemsWaitingText(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 encrypted item from another machine is not available here yet."
    : `${count} encrypted items from other machines are not available here yet.`;
}

const PORTABILITY_REASONS: Readonly<Record<VaultPortabilityReason, string>> = {
  local_integration: "A local integration on this machine runs with it, so it stays here.",
  machine_credential: "An account on this machine uses it as a machine-only credential.",
};

/** Why an item stays on this machine: a rule, or the owner's own choice. */
export function vaultPortabilityExplanation(reason: VaultPortabilityReason | undefined): string {
  return reason === undefined
    ? "You chose to keep it on this machine."
    : PORTABILITY_REASONS[reason];
}
