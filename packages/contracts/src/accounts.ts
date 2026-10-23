import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectLabelId } from "./projectLabel.ts";
import { VaultItemId } from "./vault.ts";

export const AccountId = TrimmedNonEmptyString.pipe(Schema.brand("AccountId"));
export type AccountId = typeof AccountId.Type;
export const CredentialId = TrimmedNonEmptyString.pipe(Schema.brand("CredentialId"));
export type CredentialId = typeof CredentialId.Type;
export const CredentialPolicy = Schema.Struct({
  processExposure: Schema.Literals(["ask", "deny"]),
});
export const Credential = Schema.Struct({
  id: CredentialId,
  kind: Schema.Literals(["login", "token", "key_set", "oauth_session"]),
  vaultItemId: Schema.optional(VaultItemId),
  portability: Schema.Literals(["shared", "machine"]),
  deliveryBindings: Schema.Array(Schema.Literals(["cli", "browser", "integration", "provider"])),
  policy: CredentialPolicy,
  expiresAt: Schema.optional(IsoDateTime),
});
export type Credential = typeof Credential.Type;
export const Account = Schema.Struct({
  id: AccountId,
  serviceId: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  /** Explicitly public display text. Never derived from encrypted identity fields. */
  displayLabel: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  scopeProjectId: Schema.NullOr(ProjectLabelId),
  credentials: Schema.Array(Credential),
  integrationIds: Schema.Array(TrimmedNonEmptyString),
});
export type Account = typeof Account.Type;
export const AccountMachineStatus = Schema.Struct({
  accountId: AccountId,
  credentialId: CredentialId,
  environmentId: TrimmedNonEmptyString,
  credentialRevision: TrimmedNonEmptyString,
  state: Schema.Literals([
    "stored",
    "verified",
    "expired",
    "insufficient_scope",
    "network_failure",
    "cli_missing",
    "invalid",
    "waiting_for_key_access",
    "unknown",
  ]),
  checkedAt: IsoDateTime,
  reason: Schema.optional(Schema.Literals(["authentication_only", "verification_failed"])),
});
export type AccountMachineStatus = typeof AccountMachineStatus.Type;

/** Null means an unfiled caller, which sees only all-project accounts. */
export const AccountScope = { scopeProjectId: Schema.NullOr(ProjectLabelId) };
export const AccountsListInput = Schema.Struct({
  ...AccountScope,
  serviceId: Schema.optional(Account.fields.serviceId),
});
export type AccountsListInput = typeof AccountsListInput.Type;
export const AccountKeyInput = Schema.Struct({ ...AccountScope, id: AccountId });
export type AccountKeyInput = typeof AccountKeyInput.Type;
export const AccountCreateInput = Schema.Struct({
  ...AccountScope,
  serviceId: Account.fields.serviceId,
  displayLabel: Account.fields.displayLabel,
  credentials: Schema.Array(
    Schema.Struct({
      kind: Credential.fields.kind,
      vaultItemId: Credential.fields.vaultItemId,
      portability: Credential.fields.portability,
      deliveryBindings: Credential.fields.deliveryBindings,
      policy: Credential.fields.policy,
      expiresAt: Credential.fields.expiresAt,
    }),
  ),
});
export type AccountCreateInput = typeof AccountCreateInput.Type;
export const AccountUpdateInput = Schema.Struct({
  ...AccountScope,
  id: AccountId,
  displayLabel: Schema.optional(Account.fields.displayLabel),
  credentials: Schema.optional(Schema.Array(Credential)),
});
export type AccountUpdateInput = typeof AccountUpdateInput.Type;
export const AccountResult = Schema.Struct({ account: Account });
export const AccountsListResult = Schema.Struct({
  accounts: Schema.Array(Account),
  statuses: Schema.Array(AccountMachineStatus),
});
export const AccountDisconnectResult = Schema.Struct({ disconnected: Schema.Boolean });
export class AccountError extends Schema.TaggedError<AccountError>()("AccountError", {
  reason: Schema.Literals([
    "storage",
    "not_found",
    "invalid_input",
    "denied",
    "approval_required",
    "expired",
    "conflict",
    "unavailable",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return {
      storage: "Could not access the accounts store.",
      not_found: "That account or credential is not available in this project.",
      invalid_input: "That account request is not valid.",
      denied: "Process access to this credential is denied.",
      approval_required:
        "Waiting on you: the agent and commands it runs can read this token. Approve process exposure for this thread or this agent in this project.",
      expired: "This credential has expired. Replace it before running a command.",
      conflict: "This credential is already associated with an account or CLI binding.",
      unavailable: "This credential cannot be used on this machine.",
    }[this.reason];
  }
}
