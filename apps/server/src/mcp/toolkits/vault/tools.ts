import {
  OrchestratorMcpFailure,
  PreviewAutomationError,
  VaultDeleteInput,
  VaultSetPeerSharingInput,
  VaultSharingStatus,
  VaultDeleteResult,
  VaultField,
  VaultItemMetadata,
  VaultItemResult,
  VaultListInput,
  VaultListResult,
  VaultSecretFields,
  VaultIconUrl,
  VaultItemType,
  VaultLoginSummary,
  VaultPolicy,
  PreviewTabId,
} from "@cogenly/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as AgentStore from "../../../agents/AgentStore.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Vault from "../../../vault/Vault.ts";
import * as VaultSync from "../../../vault/VaultSync.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  Vault.Vault,
  PreviewAutomationBroker.PreviewAutomationBroker,
  AgentStore.AgentStore,
];

const VaultFillResult = Schema.Struct({
  status: Schema.Literals(["filled", "approval_required", "denied", "choose_login"]),
  item: Schema.optional(VaultItemMetadata),
  field: VaultField,
  domain: Schema.NullOr(Schema.String),
  message: Schema.String,
  approvalId: Schema.optional(Schema.NullOr(Schema.String)),
  /** choose_login: the logins that match; call again with one's itemId. */
  candidates: Schema.optional(Schema.Array(VaultLoginSummary)),
});

const VaultListTool = Tool.make("vault_list", {
  description:
    "List vault items (logins, API keys, cards, notes) as metadata only: name, type, label, allowed domains, policy and which secret fields exist, plus `sites`: the saved logins grouped by site with each login's id, label and username or email (missingUsername marks a password-only login). Never returns passwords, codes or other secret values. Always check it before signing in anywhere or setting up an integration that signs in to a site: reuse a matching login with vault_fill. A site can have several logins; pick the one the task needs by itemId. When none fits, call request_login; for a login missing its username, call request_login with updateItemId and fields ['username'].",
  parameters: VaultListInput,
  success: VaultListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List vault items")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const VaultSaveTool = Tool.make("vault_save", {
  description:
    "Store a secret you generated or obtained (e.g. a password created at signup) in the vault, so it can be filled later with vault_fill without asking the user. For a login, name it after the site (e.g. 'GitHub'), set allowedDomains to the site's host and put both username (or email) and password in secretFields; several logins for one site share the name and get the label '<Site> · <username>' unless you pass one. Omit policy: by default any agent may fill it on its allowed sites without asking. Pass iconUrl when the page shows a better icon than its favicon. The value comes from you; for a login only the user knows, use request_login; for other secrets only the user knows, use request_secret with saveToVault.",
  parameters: Schema.Struct({
    name: VaultItemResult.fields.item.fields.name,
    type: VaultItemType,
    label: Schema.optional(Schema.String),
    allowedDomains: Schema.optional(Schema.Array(Schema.String)),
    policy: Schema.optional(VaultPolicy),
    secretFields: VaultSecretFields,
    iconUrl: Schema.optional(VaultIconUrl),
  }),
  success: VaultItemResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Save a vault item")
  .annotate(Tool.Destructive, false);

const VaultFillTool = Tool.make("vault_fill", {
  description:
    "Type one field of a vault item (username, password, totp or value; for a card: cardNumber, cardExpiry as MM/YY, cardCvc or cardholderName) into the active preview tab at locator, without the value ever reaching you. Name the item by itemId, name, label or username; with none, the logins for the tab's site are used. When several logins match, nothing is filled and the result is choose_login with the candidates: pick one and call again with its itemId; never guess. On one of the item's allowed sites (exact host or subdomain) the fill goes through at once. On any other site, or for an item the owner set to ask first, the result is approval_required and the user gets an approval card in this thread (an agent's appears in its open items); wait for their decision, then call again. denied means the owner blocked agents from it. If the site rejects the filled login, ask for the new one with request_login and updateItemId.",
  parameters: Schema.Struct({
    itemId: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
    label: Schema.optional(Schema.String),
    username: Schema.optional(Schema.String),
    field: VaultField,
    locator: Schema.optional(Schema.String),
    selector: Schema.optional(Schema.String),
    tabId: Schema.optional(PreviewTabId),
  }),
  success: VaultFillResult,
  failure: Schema.Union([OrchestratorMcpFailure, PreviewAutomationError]),
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Fill from the vault")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const VaultDeleteTool = Tool.make("vault_delete", {
  description:
    "Delete a vault item by id (from vault_list). This is a tombstone: the secret is removed.",
  parameters: VaultDeleteInput,
  success: VaultDeleteResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delete a vault item")
  .annotate(Tool.Destructive, true);

const VaultLinkIntegrationTool = Tool.make("vault_link_integration", {
  description:
    "Record that a vault login signs in to an integration (integration id from integrations_list), e.g. the Google account used for the Google Cloud console while setting up Google Workspace. The integration's Settings page then shows which login it signs in with. Pass unlink: true to remove the link. Stores no secret.",
  parameters: Schema.Struct({
    itemId: Schema.String,
    integrationId: Schema.String,
    unlink: Schema.optional(Schema.Boolean),
  }),
  success: VaultItemResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Link a login to an integration")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const VaultToolkit = Toolkit.make(
  Tool.make("vault_sharing_status", {
    description:
      "Inspect vault sharing with directly paired machines. Portable vault items and web integration sign-ins share by default; machine-only credentials and item-use policies stay local. Returns sharing state without secrets.",
    parameters: Tool.EmptyParams,
    success: VaultSharingStatus,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [VaultSync.VaultSync],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("vault_sharing_update", {
    description:
      "Enable or disable vault sharing with a directly paired machine by environmentId. Uses the same switch as Settings → Vault. Disabling on either machine stops future sharing in both directions; copies already received remain. Requires full access; no owner approval. Enabling needs the peer online to verify its key.",
    parameters: VaultSetPeerSharingInput,
    success: VaultSharingStatus,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      VaultSync.VaultSync,
      McpInvocationContext.McpInvocationContext,
      ThreadManagementService.ThreadManagementService,
    ],
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false),

  VaultListTool,
  VaultSaveTool,
  VaultFillTool,
  VaultLinkIntegrationTool,
  VaultDeleteTool,
);
