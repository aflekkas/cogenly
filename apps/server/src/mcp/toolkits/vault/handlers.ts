import {
  OrchestratorMcpFailure,
  VaultError,
  VaultItemId,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as AgentStore from "../../../agents/AgentStore.ts";
import * as ProjectFiles from "../../../projectLabels/ProjectFiles.ts";
import * as Vault from "../../../vault/Vault.ts";
import { normalizeHost } from "../../../vault/VaultPolicy.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import type { VaultFillBinding } from "../../../preview/ServerBrowserPage.ts";
import { VaultToolkit } from "./tools.ts";

const isVaultError = Schema.is(VaultError);
const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};
const failure = (message: string, code: OrchestratorMcpFailure["code"] = "invalid_request") =>
  new OrchestratorMcpFailure({ code, message });
const toFailure = (cause: unknown) =>
  isVaultError(cause)
    ? failure(
        cause.message,
        cause.reason === "not_found" ? "invalid_request" : "orchestration_error",
      )
    : failure("Vault operation failed.", "orchestration_error");

/**
 * The calling thread's project, which limits the items it can list, fill or
 * delete. A thread whose project cannot be read reaches only all-project items.
 */
const callerAccess = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const files = yield* Effect.serviceOption(ProjectFiles.ProjectFiles);
  if (scope.thread === undefined || Option.isNone(files)) return { projectId: null };
  const folder = yield* files.value
    .folderForThread(scope.thread.threadId)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  return { projectId: folder?.labelId ?? null } satisfies Vault.VaultAccess;
});

export const layer = McpToolAccess.toLayer(VaultToolkit, {
  // The listing scope is the caller's own project, whatever the input names.
  vault_list: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      return yield* vault.list({}, yield* callerAccess).pipe(Effect.mapError(toFailure));
    }),
  ),
  vault_save: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      return yield* vault
        .create({
          name: input.name,
          type: input.type,
          ...(input.label ? { label: input.label as never } : {}),
          allowedDomains: (input.allowedDomains ?? []) as never,
          ...(input.policy ? { policy: input.policy } : {}),
          secretFields: input.secretFields,
        })
        .pipe(Effect.mapError(toFailure));
    }),
  ),
  vault_fill: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const vault = yield* Vault.Vault;
      const agents = yield* AgentStore.AgentStore;
      const { tabId, ...rest } = input;
      const status = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          operation: "status",
          input: {},
          ...(tabId ? { tabId } : {}),
        })
        .pipe(Effect.mapError((cause) => failure(cause.message, "orchestration_error")));
      const domain = status.url ? normalizeHost(status.url) || null : null;
      const checkedOrigin = status.url ? originOf(status.url) : null;
      if (!domain || !checkedOrigin || !status.tabId)
        return yield* failure("vault_fill needs an active preview tab with a page URL.");
      const agent = yield* agents
        .forThread(scope.thread.threadId)
        .pipe(
          Effect.mapError(() =>
            failure("Could not resolve the calling agent.", "orchestration_error"),
          ),
        );
      const result = yield* vault
        .use({
          ...(rest.itemId ? { itemId: VaultItemId.make(rest.itemId) } : {}),
          ...(rest.name ? { name: rest.name } : {}),
          field: rest.field,
          caller: agent ? { kind: "agent", agentId: agent.id } : { kind: "human" },
          access: yield* callerAccess,
          threadId: scope.thread.threadId,
          domain,
          action: "fill",
          enforceAllowedDomains: true,
        })
        .pipe(Effect.mapError(toFailure));
      if (result.status === "approval_required")
        return {
          status: "approval_required" as const,
          item: result.item,
          field: result.field,
          domain,
          message: result.message,
          approvalId: result.approvalId,
        };
      if (result.status === "denied")
        return {
          status: "denied" as const,
          item: result.item,
          field: result.field,
          domain,
          message: "This vault item may not be used on that domain.",
        };
      // Type server-side through the same machinery as preview_type; the
      // value never leaves this handler.
      yield* broker
        .invoke({
          scope,
          operation: "type",
          containsVaultSecret: true,
          input: {
            text: result.value,
            ...(rest.locator ? { locator: rest.locator } : {}),
            ...(rest.selector ? { selector: rest.selector } : {}),
            clear: true,
            // The browser types only into the page checked above, and only into
            // a field whose own host the item allows.
            vaultFill: {
              origin: checkedOrigin,
              allowedHosts: result.item.allowedDomains.map(normalizeHost).filter(Boolean),
            } satisfies VaultFillBinding,
          },
          tabId: status.tabId,
        })
        .pipe(Effect.mapError((cause) => failure(cause.message, "orchestration_error")));
      return {
        status: "filled" as const,
        item: result.item,
        field: result.field,
        domain,
        message: `Filled ${result.field} from vault item ${result.item.name}.`,
      };
    }),
  ),
  vault_delete: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      return yield* vault.delete(input, yield* callerAccess).pipe(Effect.mapError(toFailure));
    }),
  ),
});
