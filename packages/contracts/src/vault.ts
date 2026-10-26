import * as Schema from "effect/Schema";

import { AgentId } from "./agent.ts";
import { AuthSyncReplicateScope } from "./auth.ts";
import { EnvironmentId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { makePeerChannel } from "./machine.ts";
import { ProjectLabelId } from "./projectLabel.ts";

/**
 * Vault items: encrypted secrets an owner stores once and agents use without
 * ever seeing. Metadata is plaintext; every secret field lives only in the
 * item's encrypted body. See docs/internals/vault.md.
 */

export const VaultItemId = TrimmedNonEmptyString.pipe(Schema.brand("VaultItemId"));
export type VaultItemId = typeof VaultItemId.Type;

export const VaultItemType = Schema.Literals(["login", "api_key", "card", "note"]);
export type VaultItemType = typeof VaultItemType.Type;

/**
 * A field an agent may ask the server to fill; `totp` is generated, never
 * stored as a code. `cardExpiry` is derived from the stored month/year and
 * filled as `MM/YY`.
 */
export const VaultField = Schema.Literals([
  "username",
  "password",
  "totp",
  "value",
  "cardNumber",
  "cardExpiry",
  "cardCvc",
  "cardholderName",
]);
export type VaultField = typeof VaultField.Type;

/** Secret fields of an item body. All of them are secret, username included. */
export const VaultSecretFields = Schema.Struct({
  username: Schema.optional(Schema.String.check(Schema.isMaxLength(8192))),
  password: Schema.optional(Schema.String.check(Schema.isMaxLength(8192))),
  totpSecret: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  value: Schema.optional(Schema.String.check(Schema.isMaxLength(65536))),
  /** Card fields (`type: "card"`); every one lives only in the encrypted body. */
  cardNumber: Schema.optional(Schema.String.check(Schema.isMaxLength(32))),
  cardExpiryMonth: Schema.optional(Schema.String.check(Schema.isMaxLength(2))),
  cardExpiryYear: Schema.optional(Schema.String.check(Schema.isMaxLength(4))),
  cardCvc: Schema.optional(Schema.String.check(Schema.isMaxLength(8))),
  cardholderName: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});
export type VaultSecretFields = typeof VaultSecretFields.Type;

/**
 * Who may use an item without asking. `allow` with empty lists (the default)
 * lets any thread or agent fill it on the item's allowed sites; a fill on any
 * other site still asks the owner. `ask` makes every agent use create an owner
 * approval, and approving records an `allow` for that thread or persistent
 * agent. `deny` (Block) refuses agents outright.
 */
export const VaultPolicy = Schema.Struct({
  mode: Schema.Literals(["ask", "allow", "deny"]),
  allowedAgentIds: Schema.Array(AgentId),
  allowedThreadIds: Schema.optional(Schema.Array(ThreadId)),
  allowedDomains: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(253))),
  /** Sites beyond the item's allowed sites where the owner approved a fill. */
  approvedDomains: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(253))),
  ),
  /** The owner picked this rule by hand; a change of default never touches it. */
  ownerSet: Schema.optional(Schema.Boolean),
});
export type VaultPolicy = typeof VaultPolicy.Type;

export const defaultVaultPolicy: VaultPolicy = {
  mode: "allow",
  allowedAgentIds: [],
  allowedDomains: [],
};

/** The default rule: any agent, on the item's allowed sites, without asking. */
export const isDefaultVaultPolicy = (policy: VaultPolicy) =>
  policy.mode === "allow" &&
  policy.allowedAgentIds.length === 0 &&
  (policy.allowedThreadIds ?? []).length === 0 &&
  policy.allowedDomains.length === 0;

/**
 * Whether an item may copy to machines this one shares its vault with.
 * `machine` keeps it here; machines that already have it keep their copy.
 */
export const VaultItemPortability = Schema.Literals(["shared", "machine"]);
export type VaultItemPortability = typeof VaultItemPortability.Type;

/**
 * Why an item the owner left `shared` stays on this machine anyway: a local
 * integration runs with it, or its account credential is machine-only.
 */
export const VaultPortabilityReason = Schema.Literals(["local_integration", "machine_credential"]);
export type VaultPortabilityReason = typeof VaultPortabilityReason.Type;

/** An agent-supplied site icon: an https URL or a small image data URL. */
export const VaultIconUrl = TrimmedNonEmptyString.check(Schema.isMaxLength(256 * 1024));

const vaultItemFields = {
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  type: VaultItemType,
  /** Null means environment-wide; otherwise the project (label) this item belongs to. */
  scopeProjectId: Schema.NullOr(ProjectLabelId),
  /** The only non-secret display text besides the name, e.g. "Work GitHub". */
  label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  allowedDomains: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(253))),
  policy: VaultPolicy,
};

/** Longest login username kept as display text; a longer one stays only encrypted. */
export const VAULT_LOGIN_USERNAME_MAX_LENGTH = 320;

/** Plaintext metadata; never carries a secret value. */
export const VaultItemMetadata = Schema.Struct({
  id: VaultItemId,
  ...vaultItemFields,
  /** Optional association; encrypted identities are never copied into it. */
  accountId: Schema.optional(TrimmedNonEmptyString),
  credentialId: Schema.optional(TrimmedNonEmptyString),
  /** Names of secret fields present, e.g. ["username", "password", "totp"]. */
  fields: Schema.Array(VaultField),
  /**
   * A login's username or email, as display text: it tells several logins for
   * one site apart, like an integration's account label. Only logins carry it;
   * the password, one-time code secret and note stay encrypted.
   */
  username: Schema.optional(
    Schema.String.check(Schema.isMaxLength(VAULT_LOGIN_USERNAME_MAX_LENGTH)),
  ),
  /** Integrations (by id) this login signs in to; local to this machine. */
  integrationIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  /**
   * Last 4 digits of a card number, for telling cards apart in lists. This is
   * the one secret-derived fragment kept in plaintext: like `label` it is
   * display text, it cannot be filled or used on its own, and the full number
   * stays encrypted. Absent on non-card and legacy card-shaped items.
   */
  cardLast4: Schema.optional(Schema.String.check(Schema.isMaxLength(4))),
  /** Effective portability; absent from servers that predate vault sync. */
  portability: Schema.optional(VaultItemPortability),
  /** Set when a rule, not the owner, keeps the item on this machine. */
  portabilityReason: Schema.optional(VaultPortabilityReason),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type VaultItemMetadata = typeof VaultItemMetadata.Type;

export const VaultCreateInput = Schema.Struct({
  ...vaultItemFields,
  scopeProjectId: Schema.optional(Schema.NullOr(ProjectLabelId)),
  policy: Schema.optional(VaultPolicy),
  allowedDomains: Schema.optional(vaultItemFields.allowedDomains),
  /** Defaults to `shared`. */
  portability: Schema.optional(VaultItemPortability),
  secretFields: VaultSecretFields,
  /**
   * A login's site icon (an https image URL or an image data URL), cached as
   * that site's icon instead of the favicon the server would fetch.
   */
  iconUrl: Schema.optional(VaultIconUrl),
});
export type VaultCreateInput = typeof VaultCreateInput.Type;

export const VaultUpdateInput = Schema.Struct({
  id: VaultItemId,
  name: Schema.optional(vaultItemFields.name),
  type: Schema.optional(VaultItemType),
  scopeProjectId: Schema.optional(Schema.NullOr(ProjectLabelId)),
  label: Schema.optional(Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(200)))),
  allowedDomains: Schema.optional(vaultItemFields.allowedDomains),
  policy: Schema.optional(VaultPolicy),
  portability: Schema.optional(VaultItemPortability),
  /** Merged into the stored fields; an empty string removes that field. */
  secretFields: Schema.optional(VaultSecretFields),
  /** Replaces the integrations this login signs in to; logins only. */
  integrationIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  /** See `VaultListInput.supportsDenyPolicy`; also keeps Block on an older client's save. */
  supportsDenyPolicy: Schema.optional(Schema.Boolean),
});
export type VaultUpdateInput = typeof VaultUpdateInput.Type;

export const VaultListInput = Schema.Struct({
  scopeProjectId: Schema.optional(ProjectLabelId),
  /**
   * The client decodes the `deny` (Block) policy mode. Clients from before it
   * (0.3.2 and older) leave it out and get Block items as `ask`, which they
   * can decode; the server still refuses agents for them.
   */
  supportsDenyPolicy: Schema.optional(Schema.Boolean),
});
export type VaultListInput = typeof VaultListInput.Type;

/** One saved login as lists and disambiguation show it: never a secret. */
export const VaultLoginSummary = Schema.Struct({
  id: VaultItemId,
  label: Schema.String,
  username: Schema.NullOr(Schema.String),
  /** A password-only login: the owner should add the username or email. */
  missingUsername: Schema.Boolean,
});
export type VaultLoginSummary = typeof VaultLoginSummary.Type;

/** The logins saved for one site, by its primary host. */
export const VaultLoginSite = Schema.Struct({
  host: Schema.NullOr(Schema.String),
  siteName: Schema.String,
  logins: Schema.Array(VaultLoginSummary),
});
export type VaultLoginSite = typeof VaultLoginSite.Type;

export const VaultListResult = Schema.Struct({
  items: Schema.Array(VaultItemMetadata),
  /** Logins grouped by site; absent from servers that predate it. */
  sites: Schema.optional(Schema.Array(VaultLoginSite)),
});
export type VaultListResult = typeof VaultListResult.Type;

/** The host a login is for: its first allowed domain. */
export const vaultLoginHost = (item: Pick<VaultItemMetadata, "allowedDomains">): string | null =>
  item.allowedDomains[0]?.toLowerCase() ?? null;

/** The default label of a login: "<Site> · <username>", or the site alone. */
export const defaultVaultLoginLabel = (siteName: string, username: string | null | undefined) =>
  username ? `${siteName} · ${username}` : siteName;

/** A login's label as shown: the owner's, else the default. */
export const vaultLoginLabel = (item: Pick<VaultItemMetadata, "name" | "label" | "username">) =>
  item.label ?? defaultVaultLoginLabel(item.name, item.username);

/** A login that has a password but no username or email saved with it. */
export const vaultLoginMissingUsername = (item: Pick<VaultItemMetadata, "type" | "fields">) =>
  item.type === "login" && !item.fields.includes("username");

export const vaultLoginSummary = (item: VaultItemMetadata): VaultLoginSummary => ({
  id: item.id,
  label: vaultLoginLabel(item),
  username: item.username ?? null,
  missingUsername: vaultLoginMissingUsername(item),
});

/**
 * Logins grouped by site (primary host, else name), sites and logins in
 * alphabetical order. Other item types are left out.
 */
export const groupVaultLoginsBySite = (
  items: ReadonlyArray<VaultItemMetadata>,
): Array<VaultLoginSite> => {
  const sites = new Map<
    string,
    { host: string | null; siteName: string; items: Array<VaultItemMetadata> }
  >();
  for (const item of items) {
    if (item.type !== "login") continue;
    const host = vaultLoginHost(item);
    const key = host ?? `name:${item.name.toLowerCase()}`;
    const site = sites.get(key) ?? { host, siteName: item.name, items: [] };
    site.items.push(item);
    sites.set(key, site);
  }
  const byText = (left: string, right: string) =>
    left.localeCompare(right, undefined, { sensitivity: "base" });
  return [...sites.values()]
    .sort((left, right) => byText(left.siteName, right.siteName))
    .map((site) => ({
      host: site.host,
      siteName: site.siteName,
      logins: site.items
        .map(vaultLoginSummary)
        .sort((left, right) => byText(left.label, right.label) || byText(left.id, right.id)),
    }));
};

export const VaultItemResult = Schema.Struct({ item: VaultItemMetadata });
export type VaultItemResult = typeof VaultItemResult.Type;

export const VaultDeleteInput = Schema.Struct({ id: VaultItemId });
export type VaultDeleteInput = typeof VaultDeleteInput.Type;

export const VaultDeleteResult = Schema.Struct({ id: VaultItemId, deleted: Schema.Boolean });
export type VaultDeleteResult = typeof VaultDeleteResult.Type;

export const VaultUsageEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  itemId: VaultItemId,
  threadId: Schema.NullOr(ThreadId),
  agentId: Schema.NullOr(AgentId),
  action: TrimmedNonEmptyString,
  credentialId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  credentialRevision: Schema.optional(Schema.NullOr(Schema.String)),
  environmentId: Schema.optional(Schema.NullOr(Schema.String)),
  projectId: Schema.optional(Schema.NullOr(Schema.String)),
  deliveryMethod: Schema.optional(Schema.NullOr(Schema.String)),
  terminalId: Schema.optional(Schema.NullOr(Schema.String)),
  providerInstanceId: Schema.optional(Schema.NullOr(Schema.String)),
  domain: Schema.NullOr(Schema.String),
  at: IsoDateTime,
  outcome: TrimmedNonEmptyString,
});
export type VaultUsageEntry = typeof VaultUsageEntry.Type;

export const VaultUsageListInput = Schema.Struct({
  itemId: Schema.optional(VaultItemId),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
});
export type VaultUsageListInput = typeof VaultUsageListInput.Type;

export const VaultUsageListResult = Schema.Struct({ usage: Schema.Array(VaultUsageEntry) });
export type VaultUsageListResult = typeof VaultUsageListResult.Type;

/**
 * Vault sharing with one directly paired machine (docs/internals/vault-sync.md).
 * `waiting_for_peer` is retained for older servers; new servers report not_shared
 * when either machine opts out. Both sides otherwise default on.
 * `key_changed`: the other machine now presents a different vault key than the
 * one pinned here. Re-pairing clears the pin; the UI tells the owner to do that.
 */
export const VaultPeerSharingState = Schema.Literals([
  "not_shared",
  "waiting_for_peer",
  "shared",
  "key_changed",
]);
export type VaultPeerSharingState = typeof VaultPeerSharingState.Type;

export const VaultPeerSharing = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  online: Schema.Boolean,
  state: VaultPeerSharingState,
  /** Local opt-out switch; absent on older servers. */
  sharingEnabled: Schema.optionalKey(Schema.Boolean),
  /** Whether the other machine shares with this one; null when it could not be asked. */
  peerSharing: Schema.NullOr(Schema.Boolean),
  /** Synced items whose current revision this machine has passed to that peer. */
  itemsShared: Schema.Int,
});
export type VaultPeerSharing = typeof VaultPeerSharing.Type;

export const VaultSharingStatus = Schema.Struct({
  peers: Schema.Array(VaultPeerSharing),
  /** Synced items this machine can read. */
  itemsShared: Schema.Int,
  /** Synced items here that no trusted machine has made readable for this one yet. */
  itemsWaiting: Schema.Int,
});
export type VaultSharingStatus = typeof VaultSharingStatus.Type;

export const VaultSetPeerSharingInput = Schema.Struct({
  environmentId: EnvironmentId,
  enabled: Schema.Boolean,
});
export type VaultSetPeerSharingInput = typeof VaultSetPeerSharingInput.Type;

/**
 * A directly paired machine's vault public key, asked of that machine itself
 * over the authenticated link and never relayed. `sharing` says whether the
 * responder shares its vault with the caller.
 */
export const VaultPeerKey = makePeerChannel({
  name: "vault.peerKey.v1",
  scope: AuthSyncReplicateScope,
  payload: Schema.Struct({}),
  success: Schema.Struct({ publicKey: Schema.String, sharing: Schema.Boolean }),
});

const VAULT_FAILURE_MESSAGES = {
  storage: "Could not access the vault store.",
  crypto: "Could not decrypt this vault item on this machine.",
  not_found: "That vault item does not exist.",
  ambiguous_name: "More than one vault item has that name; use its id.",
  name_conflict: "A vault item with that name already exists in this scope.",
  label_conflict: "Another login for this site already has that label.",
  invalid_input: "That vault item is not valid.",
  field_missing: "That vault item has no such field.",
  domain_not_allowed: "This vault item may not be used on that domain.",
  approval_required: "Waiting on you: this vault use needs owner approval.",
  peer_unavailable: "Vault sharing needs that machine paired directly with this one and online.",
  peer_key_invalid: "That machine did not present a valid vault key.",
  peer_key_changed:
    "That machine's vault key changed. Unpair it and pair again, then turn sharing back on.",
} as const;

export const VaultFailureReason = Schema.Literals(
  Object.keys(VAULT_FAILURE_MESSAGES) as Array<keyof typeof VAULT_FAILURE_MESSAGES>,
);
export type VaultFailureReason = typeof VaultFailureReason.Type;

export class VaultError extends Schema.TaggedError<VaultError>()("VaultError", {
  reason: VaultFailureReason,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return VAULT_FAILURE_MESSAGES[this.reason];
  }
}
