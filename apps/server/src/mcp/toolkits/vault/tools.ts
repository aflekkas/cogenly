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
  VaultItemType,
  VaultPolicy,
  PreviewTabId,
  PreviewVaultCaptureInput,
} from "@cogenly/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ServerBrowser from "../../../preview/ServerBrowser.ts";
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
  status: Schema.Literals(["filled", "approval_required", "denied"]),
  item: Schema.optional(VaultItemMetadata),
  field: VaultField,
  domain: Schema.NullOr(Schema.String),
  message: Schema.String,
  approvalId: Schema.optional(Schema.NullOr(Schema.String)),
});

const VaultListTool = Tool.make("vault_list", {
  description:
    "List vault items (logins, API keys, cards, notes) as metadata only: name, type, allowed domains, policy and which secret fields exist. Never returns secret values or usernames. Check it before signing in anywhere; when no login is allowed on the site, call request_login.",
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
    "Store a secret you generated or obtained (e.g. a password created at signup) in the vault under a name, so it can be filled later with vault_fill without asking the user. The value comes from you; for a login only the user knows, use request_login; for other secrets only the user knows, use request_secret with saveToVault.",
  parameters: Schema.Struct({
    name: VaultItemResult.fields.item.fields.name,
    type: VaultItemType,
    label: Schema.optional(Schema.String),
    allowedDomains: Schema.optional(Schema.Array(Schema.String)),
    policy: Schema.optional(VaultPolicy),
    secretFields: VaultSecretFields,
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
    "Type one field of a vault item (username, password, totp or value; for a card: cardNumber, cardExpiry as MM/YY, cardCvc or cardholderName) into the active preview tab at locator, without the value ever reaching you. The tab's host must match the item's allowedDomains (exact host or subdomain). If the owner must approve this use, the result says approval_required and the user gets an approval card in this thread (an agent's appears in its open items); say you are waiting on the card. Its answer automatically notifies this thread, steering active work or starting a new turn. Do not ask the user to allow it or type continue. On approval, retry the fill with a fresh locator. If the site rejects the filled login, ask for the new one with request_login and updateItemId.",
  parameters: Schema.Struct({
    itemId: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
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

  Tool.make("vault_capture", {
    description:
      "Capture a credential shown once on a page straight into the vault without seeing its value. Pass a snapshot locator, name, kind api_key or note, and optionally attribute (e.g. aria-label). Default reads an input value or element text. Never read secrets with preview_evaluate, extract or snapshot; use this tool before closing an OAuth client-created dialog. Returns vault metadata only.",
    parameters: PreviewVaultCaptureInput,
    success: VaultItemResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [...dependencies, ServerBrowser.ServerBrowser],
  }).annotate(Tool.Destructive, false),
  VaultListTool,
  VaultSaveTool,
  VaultFillTool,
  VaultDeleteTool,
);
