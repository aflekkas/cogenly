import {
  OrchestratorMcpFailure,
  VaultError,
  VaultItemId,
  type PreviewAutomationStatus,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as AgentStore from "../../../agents/AgentStore.ts";
import * as Vault from "../../../vault/Vault.ts";
import * as VaultSync from "../../../vault/VaultSync.ts";
import { normalizeHost } from "../../../vault/VaultPolicy.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { VaultToolkit } from "./tools.ts";

const isVaultError = Schema.is(VaultError);
const failure = (message: string, code: OrchestratorMcpFailure["code"] = "invalid_request") =>
  new OrchestratorMcpFailure({ code, message });
const toFailure = (cause: unknown) =>
  isVaultError(cause)
    ? failure(
        cause.message,
        cause.reason === "not_found" ? "invalid_request" : "orchestration_error",
      )
    : failure("Vault operation failed.", "orchestration_error");

export const layer = McpToolAccess.toLayer(VaultToolkit, {
  vault_sharing_status: McpToolAccess.reads(() =>
    VaultSync.VaultSync.pipe(
      Effect.flatMap((sync) => sync.sharingStatus),
      Effect.mapError(toFailure),
    ),
  ),
  vault_sharing_update: McpToolAccess.writesEnvironment((input) =>
    VaultSync.VaultSync.pipe(
      Effect.flatMap((sync) => sync.setPeerSharing(input)),
      Effect.mapError(toFailure),
    ),
  ),
  vault_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const scope = yield* McpInvocationContext.McpInvocationContext;
      return yield* vault
        .list(input ?? {}, scope.thread?.threadId)
        .pipe(Effect.mapError(toFailure));
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
          ...(input.iconUrl ? { iconUrl: input.iconUrl } : {}),
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
      if (!domain || !status.tabId)
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
          ...(rest.label ? { label: rest.label } : {}),
          ...(rest.username ? { username: rest.username } : {}),
          field: rest.field,
          caller: agent
            ? { kind: "agent", agentId: agent.id }
            : { kind: "thread", threadId: scope.thread.threadId },
          threadId: scope.thread.threadId,
          domain,
          action: "fill",
          enforceAllowedDomains: true,
        })
        .pipe(Effect.mapError(toFailure));
      if (result.status === "ambiguous")
        return {
          status: "choose_login" as const,
          field: result.field,
          domain,
          candidates: result.candidates,
          message: `Several vault logins match ${domain}: ${result.candidates
            .map((candidate) => `${candidate.label} (itemId ${candidate.id})`)
            .join(
              ", ",
            )}. Nothing was filled. Choose the login this task needs and call vault_fill again with its itemId; ask the user if you cannot tell.`,
        };
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
          message:
            result.reason === "policy"
              ? "The owner blocked agents from using this vault item. Don't retry; ask the user if you need it."
              : "This vault item may not be used on that domain.",
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
            expectedOrigin: new URL(status.url!).origin,
            ...(rest.locator ? { locator: rest.locator } : {}),
            ...(rest.selector ? { selector: rest.selector } : {}),
            clear: true,
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
  vault_link_integration: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const found = yield* vault
        .findLogin({ itemId: VaultItemId.make(input.itemId), threadId: scope.thread?.threadId })
        .pipe(Effect.mapError(toFailure));
      if (found.status !== "found" || found.item.type !== "login")
        return yield* failure(`No vault login with id ${input.itemId}. Use an id from vault_list.`);
      const current = found.item.integrationIds ?? [];
      const integrationIds = input.unlink
        ? current.filter((id) => id !== input.integrationId)
        : [...new Set([...current, input.integrationId])];
      return yield* vault.update({ id: found.item.id, integrationIds }).pipe(
        Effect.map(({ item }) => ({ item })),
        Effect.mapError(toFailure),
      );
    }),
  ),
  vault_delete: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const scope = yield* McpInvocationContext.McpInvocationContext;
      return yield* vault.delete(input, scope.thread?.threadId).pipe(Effect.mapError(toFailure));
    }),
  ),
});
