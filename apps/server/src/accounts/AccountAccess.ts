import { cliAdapter } from "./CliAdapters.ts";
import * as Option from "effect/Option";
import {
  AccountError,
  AccountId,
  AgentApprovalAction,
  CredentialId,
  type Account,
  type Credential,
  type AccountUseInput,
  type AccountUseResult,
  type AgentId,
  type ProjectId,
  type ProjectLabelId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as AgentStore from "../agents/AgentStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectFiles from "../projectLabels/ProjectFiles.ts";
import * as Accounts from "./Accounts.ts";

/** Only authenticated transport context supplies these two ids. All other identity is loaded here. */
export interface AccountCallerInput {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}
export interface AccountCaller extends AccountCallerInput {
  readonly projectId: ProjectId;
  readonly scopeProjectId: ProjectLabelId | null;
  readonly projectKey: string;
  readonly agentId: AgentId | null;
  readonly parentThreadId: ThreadId | null;
}
export interface AuthorizedCredential {
  readonly account: Account;
  readonly credential: Credential & {
    readonly vaultItemId: NonNullable<Credential["vaultItemId"]>;
  };
  readonly revision: number;
}
const wrap = (cause: unknown) =>
  Schema.is(AccountError)(cause) ? cause : new AccountError({ reason: "storage", cause });
export class AccountAccess extends Context.Service<
  AccountAccess,
  {
    readonly caller: (input: AccountCallerInput) => Effect.Effect<AccountCaller, AccountError>;
    readonly setThreadBindingForThread: (
      threadId: ThreadId,
      input: AccountUseInput,
    ) => Effect.Effect<typeof AccountUseResult.Type, AccountError>;
    readonly setThreadBinding: (
      caller: AccountCallerInput,
      input: AccountUseInput,
    ) => Effect.Effect<typeof AccountUseResult.Type, AccountError>;
    readonly forLaunch: (
      caller: AccountCallerInput,
      terminalId?: string,
      method?: "environment" | "verification",
      credentialId?: CredentialId,
    ) => Effect.Effect<
      { caller: AccountCaller; credentials: ReadonlyArray<AuthorizedCredential> },
      AccountError
    >;
    readonly approve: (
      id: string,
      scope: "thread" | "agent_project",
    ) => Effect.Effect<void, AccountError>;
    readonly removeAccess: (input: {
      scopeProjectId: ProjectLabelId | null;
      id: AccountId;
      credentialId: CredentialId;
    }) => Effect.Effect<
      { removed: boolean; affectedThreadIds: ReadonlyArray<string>; message: string },
      AccountError
    >;
    readonly audit: (input: {
      caller: AccountCaller;
      credential: AuthorizedCredential;
      terminalId: string;
      outcome: string;
      method?: "environment" | "verification";
    }) => Effect.Effect<void, AccountError>;
  }
>()("cogenly-server/accounts/AccountAccess") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const accounts = yield* Accounts.Accounts;
  const threads = yield* Threads.ThreadManagementService;
  const agents = yield* AgentStore.AgentStore;
  const projects = yield* ProjectFiles.ProjectFiles;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const crypto = yield* Crypto.Crypto;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const caller: AccountAccess["Service"]["caller"] = Effect.fnUntraced(function* (input) {
    const thread = yield* threads.getThreadShell(input.threadId);
    if (
      !thread ||
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      thread.settledOverride === "settled" ||
      thread.activeRunId === null ||
      thread.providerInstanceId !== input.providerInstanceId
    )
      return yield* new AccountError({ reason: "denied" });
    const folder = yield* projects.folderForThread(input.threadId);
    const agent = yield* agents.forThread(input.threadId);
    const scopeProjectId = folder?.labelId ?? null;
    return {
      ...input,
      projectId: thread.projectId,
      scopeProjectId,
      projectKey: scopeProjectId ?? `repository:${thread.projectId}`,
      agentId: agent?.id ?? null,
      parentThreadId:
        thread.lineage.relationshipToParent === "subagent" ? thread.lineage.parentThreadId : null,
    };
  }, Effect.mapError(wrap));
  const load = Effect.fnUntraced(function* (
    context: AccountCaller,
    accountId: AccountId,
    credentialId: CredentialId,
  ) {
    const { account } = yield* accounts.get({
      id: accountId,
      scopeProjectId: context.scopeProjectId,
    });
    if (!cliAdapter(account.serviceId)) return yield* new AccountError({ reason: "invalid_input" });
    const credential = account.credentials.find((c) => c.id === credentialId);
    if (
      !credential?.vaultItemId ||
      credential.kind !== "token" ||
      !credential.deliveryBindings.includes("cli")
    )
      return yield* new AccountError({ reason: "not_found" });
    if (credential.policy.processExposure === "deny")
      return yield* new AccountError({ reason: "denied" });
    if (credential.expiresAt) {
      const expires = DateTime.make(credential.expiresAt);
      if (Option.isNone(expires)) return yield* new AccountError({ reason: "invalid_input" });
      if (DateTime.isLessThanOrEqualTo(expires.value, yield* DateTime.now))
        return yield* new AccountError({ reason: "expired" });
    }
    const rows = yield* sql<{
      credential_revision: number;
    }>`SELECT credential_revision FROM vault_items WHERE id = ${credential.vaultItemId} AND deleted_at IS NULL AND (scope_project_id IS NULL OR scope_project_id = ${context.scopeProjectId})`;
    if (!rows[0]) return yield* new AccountError({ reason: "not_found" });
    return {
      account,
      credential: { ...credential, vaultItemId: credential.vaultItemId },
      revision: rows[0].credential_revision,
    };
  });
  const hasGrant = Effect.fnUntraced(function* (
    context: AccountCaller,
    item: AuthorizedCredential,
  ) {
    const rows =
      yield* sql`SELECT 1 FROM account_process_grants WHERE credential_id = ${item.credential.id} AND credential_revision = ${item.revision} AND project_key = ${context.projectKey} AND ((subject_type = 'thread' AND subject_id = ${context.threadId}) OR (subject_type = 'agent' AND subject_id = ${context.agentId}))`;
    return rows.length > 0;
  });
  // Re-evaluate every ancestor at use time: revoking a parent also cuts off
  // existing child bindings. Neither a child approval nor a persistent grant can widen this ceiling.
  const withinParent = Effect.fnUntraced(function* (
    context: AccountCaller,
    item: AuthorizedCredential,
  ) {
    const visited = new Set<string>([context.threadId]);
    let current = context;
    while (current.parentThreadId) {
      if (visited.has(current.parentThreadId)) return false;
      visited.add(current.parentThreadId);
      const shell = yield* threads.getThreadShell(current.parentThreadId);
      if (!shell?.providerInstanceId) return false;
      // A parent may be waiting for its child with no active run; its stored grant
      // still bounds the child. Do not require the parent to be actively executing.
      const folder = yield* projects.folderForThread(shell.id);
      const agent = yield* agents.forThread(shell.id);
      const label = folder?.labelId ?? null;
      current = {
        threadId: shell.id,
        providerInstanceId: shell.providerInstanceId,
        projectId: shell.projectId,
        scopeProjectId: label,
        projectKey: label ?? `repository:${shell.projectId}`,
        agentId: agent?.id ?? null,
        parentThreadId:
          shell.lineage.relationshipToParent === "subagent" ? shell.lineage.parentThreadId : null,
      };
      if (
        shell.deletedAt !== null ||
        shell.archivedAt !== null ||
        current.projectKey !== context.projectKey
      )
        return false;
      const bindings =
        yield* sql`SELECT 1 FROM account_thread_bindings WHERE thread_id = ${current.threadId} AND credential_id = ${item.credential.id} AND project_key = ${current.projectKey}`;
      if (!bindings[0] || !(yield* hasGrant(current, item))) return false;
    }
    return true;
  });
  const request = Effect.fnUntraced(function* (context: AccountCaller, item: AuthorizedCredential) {
    const id = `approval:account:${yield* crypto.randomUUIDv4()}`;
    const action: AgentApprovalAction = {
      actionKind: "vault_use",
      payload: {
        vaultItemId: item.credential.vaultItemId,
        vaultItemName: `CLI token · ${item.account.displayLabel}. The agent and the commands it runs can read this token.`,
        field: "value",
        domain: null,
        threadId: context.threadId,
        processExposure: {
          accountId: item.account.id,
          credentialId: item.credential.id,
          credentialRevision: item.revision,
          threadId: context.threadId,
          projectKey: context.projectKey,
          message: "The agent and the commands it runs can read this token.",
        },
      },
    };
    const actionJson = yield* Schema.encodeEffect(Schema.fromJsonString(AgentApprovalAction))(
      action,
    );
    const existing = yield* sql<{
      id: string;
    }>`SELECT id FROM agent_approvals WHERE status = 'pending' AND action_json = ${actionJson} AND agent_id IS ${context.agentId}`;
    if (existing[0]) return existing[0].id;
    yield* sql`INSERT INTO agent_approvals(id, agent_id, action_json, status, requested_at) VALUES (${id}, ${context.agentId}, ${actionJson}, 'pending', ${yield* now})`;
    return id;
  });
  const audit: AccountAccess["Service"]["audit"] = Effect.fnUntraced(function* (input) {
    yield* sql`INSERT INTO vault_usage(id, item_id, thread_id, agent_id, action, domain, at, outcome, credential_id, credential_revision, environment_id, project_id, delivery_method, terminal_id, provider_instance_id) VALUES (${`usage:${yield* crypto.randomUUIDv4()}`}, ${input.credential.credential.vaultItemId}, ${input.caller.threadId}, ${input.caller.agentId}, 'credential_delivery', NULL, ${yield* now}, ${input.outcome}, ${input.credential.credential.id}, ${String(input.credential.revision)}, ${yield* identity.getEnvironmentId}, ${input.caller.projectKey}, ${input.method ?? "environment"}, ${input.terminalId}, ${input.caller.providerInstanceId})`;
  }, Effect.mapError(wrap));
  const service = AccountAccess.of({
    caller,
    audit,
    setThreadBindingForThread: Effect.fnUntraced(function* (threadId, input) {
      const shell = yield* threads.getThreadShell(threadId);
      if (!shell?.providerInstanceId) return yield* new AccountError({ reason: "denied" });
      return yield* service.setThreadBinding(
        { threadId, providerInstanceId: shell.providerInstanceId },
        input,
      );
    }, Effect.mapError(wrap)),
    setThreadBinding: Effect.fnUntraced(function* (auth, input) {
      const context = yield* caller(auth);
      if (!input.attached) {
        yield* sql`DELETE FROM account_thread_bindings WHERE thread_id = ${context.threadId} AND credential_id = ${input.credentialId} AND account_id = ${input.accountId}`;
        yield* sql`DELETE FROM account_process_grants WHERE credential_id = ${input.credentialId} AND subject_type = 'thread' AND subject_id = ${context.threadId}`;
        yield* sql`UPDATE agent_approvals SET status = 'rejected', decided_at = ${yield* now} WHERE status = 'pending' AND json_extract(action_json, '$.payload.processExposure') IS NOT NULL AND json_extract(action_json, '$.payload.threadId') = ${context.threadId} AND json_extract(action_json, '$.payload.processExposure.credentialId') = ${input.credentialId}`;
        return { status: "detached" as const };
      }
      const item = yield* load(context, input.accountId, input.credentialId);
      if (!(yield* withinParent(context, item))) return { status: "denied" as const };
      // One token per adapter in a thread. Fail rather than let iteration order choose an identity.
      const bindings = yield* sql<{
        account_id: string;
        credential_id: string;
      }>`SELECT account_id, credential_id FROM account_thread_bindings WHERE thread_id = ${context.threadId} AND credential_id <> ${input.credentialId}`;
      for (const binding of bindings) {
        const other = yield* accounts.get({
          id: AccountId.make(binding.account_id),
          scopeProjectId: context.scopeProjectId,
        });
        if (other.account.serviceId === item.account.serviceId)
          return yield* new AccountError({ reason: "conflict" });
      }
      yield* sql`INSERT INTO account_thread_bindings(thread_id, credential_id, account_id, project_key) VALUES (${context.threadId}, ${input.credentialId}, ${input.accountId}, ${context.projectKey}) ON CONFLICT(thread_id, credential_id) DO UPDATE SET project_key = excluded.project_key, account_id = excluded.account_id`;
      if (yield* hasGrant(context, item)) return { status: "attached" as const };
      return {
        status: "approval_required" as const,
        approvalId: yield* request(context, item),
        message: new AccountError({ reason: "approval_required" }).message,
      };
    }, Effect.mapError(wrap)),
    forLaunch: Effect.fnUntraced(function* (
      auth,
      terminalId = "authorization",
      method = "environment",
      credentialId,
    ) {
      const context = yield* caller(auth);
      const bindings = yield* sql<{
        account_id: string;
        credential_id: string;
        project_key: string;
      }>`SELECT account_id, credential_id, project_key FROM account_thread_bindings WHERE thread_id = ${context.threadId} AND (${credentialId ?? null} IS NULL OR credential_id = ${credentialId ?? null}) ORDER BY credential_id`;
      const credentials: Array<AuthorizedCredential> = [];
      for (const binding of bindings) {
        const resolved = yield* Effect.gen(function* () {
          if (binding.project_key !== context.projectKey)
            return yield* new AccountError({ reason: "denied" });
          const item = yield* load(
            context,
            AccountId.make(binding.account_id),
            CredentialId.make(binding.credential_id),
          );
          if (!(yield* withinParent(context, item)))
            return yield* new AccountError({ reason: "denied" });
          if (!(yield* hasGrant(context, item))) {
            const decisions = yield* sql<{
              status: string;
              decided_by: string | null;
            }>`SELECT status, decided_by FROM agent_approvals WHERE json_extract(action_json, '$.payload.processExposure.threadId') = ${context.threadId} AND json_extract(action_json, '$.payload.processExposure.credentialId') = ${item.credential.id} AND json_extract(action_json, '$.payload.processExposure.credentialRevision') = ${item.revision} AND json_extract(action_json, '$.payload.processExposure.projectKey') = ${context.projectKey} ORDER BY rowid DESC LIMIT 1`;
            if (decisions[0]?.status === "rejected" && decisions[0].decided_by === "user")
              return yield* new AccountError({ reason: "denied" });
            yield* request(context, item);
            return yield* new AccountError({ reason: "approval_required" });
          }
          return item;
        }).pipe(Effect.mapError(wrap), Effect.result);
        if (resolved._tag === "Failure") {
          yield* sql`INSERT INTO vault_usage(id, item_id, thread_id, agent_id, action, at, outcome, credential_id, credential_revision, environment_id, project_id, delivery_method, terminal_id, provider_instance_id)
            SELECT ${`usage:${yield* crypto.randomUUIDv4()}`}, c.vault_item_id, ${context.threadId}, ${context.agentId}, 'credential_delivery', ${yield* now}, ${resolved.failure.reason}, c.id, CAST(v.credential_revision AS TEXT), ${yield* identity.getEnvironmentId}, ${context.projectKey}, ${method}, ${terminalId}, ${context.providerInstanceId} FROM account_credentials c JOIN vault_items v ON v.id = c.vault_item_id WHERE c.id = ${binding.credential_id}`;
          return yield* resolved.failure;
        }
        credentials.push(resolved.success);
      }
      return { caller: context, credentials };
    }, Effect.mapError(wrap)),
    approve: Effect.fnUntraced(
      function* (id, scope) {
        const rows = yield* sql<{
          action_json: string;
          agent_id: string | null;
          requested_at: string;
        }>`SELECT action_json, agent_id, requested_at FROM agent_approvals WHERE id = ${id} AND status = 'pending'`;
        if (!rows[0]) return yield* new AccountError({ reason: "not_found" });
        const action = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(AgentApprovalAction),
        )(rows[0].action_json);
        if (action.actionKind !== "vault_use" || !action.payload.processExposure)
          return yield* new AccountError({ reason: "invalid_input" });
        if (
          rows[0].requested_at <
          DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 7 }))
        )
          return yield* new AccountError({ reason: "denied" });
        const exposure = action.payload.processExposure;
        const shell = yield* threads.getThreadShell(exposure.threadId);
        if (!shell?.providerInstanceId) return yield* new AccountError({ reason: "denied" });
        const context = yield* caller({
          threadId: shell.id,
          providerInstanceId: shell.providerInstanceId,
        });
        const item = yield* load(
          context,
          AccountId.make(exposure.accountId),
          CredentialId.make(exposure.credentialId),
        );
        const bindings =
          yield* sql`SELECT 1 FROM account_thread_bindings WHERE thread_id = ${context.threadId} AND credential_id = ${item.credential.id} AND project_key = ${context.projectKey}`;
        if (
          !bindings[0] ||
          context.projectKey !== exposure.projectKey ||
          context.agentId !== rows[0].agent_id ||
          item.revision !== exposure.credentialRevision ||
          !(yield* withinParent(context, item))
        )
          return yield* new AccountError({ reason: "denied" });
        if (scope === "agent_project" && !context.agentId)
          return yield* new AccountError({ reason: "invalid_input" });
        yield* sql`INSERT INTO account_process_grants(credential_id, credential_revision, project_key, subject_type, subject_id) VALUES (${item.credential.id}, ${item.revision}, ${context.projectKey}, ${scope === "agent_project" ? "agent" : "thread"}, ${scope === "agent_project" ? context.agentId : context.threadId}) ON CONFLICT(credential_id, project_key, subject_type, subject_id) DO UPDATE SET credential_revision = excluded.credential_revision`;
        yield* sql`UPDATE agent_approvals SET status = 'approved', decided_at = ${yield* now}, decided_by = 'user' WHERE id = ${id} AND status = 'pending'`;
      },
      (effect) => sql.withTransaction(effect),
      Effect.mapError(wrap),
    ),
    removeAccess: Effect.fnUntraced(function* (input) {
      const { account } = yield* accounts.get(input);
      if (!account.credentials.some((c) => c.id === input.credentialId))
        return yield* new AccountError({ reason: "not_found" });
      const rows = yield* sql<{
        thread_id: string;
      }>`SELECT thread_id FROM account_thread_bindings WHERE credential_id = ${input.credentialId}`;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM account_process_grants WHERE credential_id = ${input.credentialId}`;
          yield* sql`DELETE FROM account_thread_bindings WHERE credential_id = ${input.credentialId}`;
          yield* sql`UPDATE agent_approvals SET status = 'rejected', decided_at = ${yield* now} WHERE status = 'pending' AND json_extract(action_json, '$.payload.processExposure') IS NOT NULL AND json_extract(action_json, '$.payload.processExposure.credentialId') = ${input.credentialId}`;
        }),
      );
      return {
        removed: true,
        affectedThreadIds: rows.map((r) => r.thread_id),
        message:
          "Future delivery is blocked. Stop affected terminals to end their process access; revoke the token upstream to invalidate copies already captured.",
      };
    }, Effect.mapError(wrap)),
  });
  return service;
});
export const layer = Layer.effect(AccountAccess, make);
