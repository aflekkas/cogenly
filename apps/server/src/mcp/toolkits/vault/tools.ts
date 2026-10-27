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
    "List metadata and site-grouped logins (IDs/labels/usernames, missingUsername for password-only); never secret values. Check before every sign-in/integration setup. Choose a matching itemId; request_login for absent/rejected/missing-username logins per vault rules.",
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
    "Save credentials you create. Login: site name, allowedDomains host, username/email and password in secretFields; label defaults to <Site> · <username>. Default policy allows agents on allowed sites. iconUrl overrides favicon. User-known secrets use request_login or request_secret with saveToVault.",
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
    "Privately fill username/password/totp/value or cardNumber/cardExpiry (MM/YY)/cardCvc/cardholderName at a preview locator. Select itemId/name/label/username, or site matches by default. choose_login requires selecting a candidate itemId. Exact/subdomain allowed-site fills proceed; other sites/ask-first return approval_required. Follow vault retry/wait rules; denied blocks agents, rejected credentials need request_login updateItemId.",
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
    "Associate a login with integration ID from integrations_list for Settings display; unlink:true removes it. Stores no secret.",
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
      "Read sharing with directly paired peers, without secrets. Portable items/web sign-ins share by default; machine credentials/use policies stay local.",
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
      "Toggle sharing with a direct peer. Disabling either side stops both directions; received copies remain. Enabling verifies online peer key. Requires full access, no owner approval.",
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
      "Capture a one-time page secret privately via locator into api_key/note. Reads input value/text or specified attribute (e.g. aria-label). Use before closing creation dialogs. Returns metadata only.",
    parameters: PreviewVaultCaptureInput,
    success: VaultItemResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [...dependencies, ServerBrowser.ServerBrowser],
  }).annotate(Tool.Destructive, false),
  VaultListTool,
  VaultSaveTool,
  VaultFillTool,
  VaultLinkIntegrationTool,
  VaultDeleteTool,
);
