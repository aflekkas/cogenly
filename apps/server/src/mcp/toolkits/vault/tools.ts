import {
  OrchestratorMcpFailure,
  PreviewAutomationError,
  VaultDeleteInput,
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
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as AgentStore from "../../../agents/AgentStore.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Vault from "../../../vault/Vault.ts";
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
    "List vault items (logins, API keys, cards, notes) as metadata only: name, type, allowed domains, policy and which secret fields exist. Never returns secret values or usernames.",
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
    "Store a secret you generated or obtained (e.g. a password created at signup) in the vault under a name, so it can be filled later with vault_fill without asking the user. The value comes from you; for secrets only the user knows, use request_secret with saveToVault instead.",
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
    "Type one field of a vault item (username, password, totp or value) into the active preview tab at locator, without the value ever reaching you. The tab's host must match the item's allowedDomains (exact host or subdomain). If the owner must approve this use, the result says approval_required and waits on them; ask again after approval.",
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
  VaultListTool,
  VaultSaveTool,
  VaultFillTool,
  VaultDeleteTool,
);
