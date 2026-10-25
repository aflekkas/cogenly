import * as Option from "effect/Option";
import {
  AccountConnection,
  AccountConnectInput,
  type AccountServiceSetup,
  type ProjectId,
  type ProviderInstanceId,
  type ProjectLabelId,
  type ThreadId,
} from "@cogenly/contracts";
import * as Vault from "../vault/Vault.ts";
import { cliAdapter, cliAdapters } from "./CliAdapters.ts";
import {
  Account,
  AccountError,
  AccountId,
  AccountMachineStatus,
  CredentialId,
  type AccountCreateInput,
  type AccountKeyInput,
  type AccountsListInput,
  type AccountUpdateInput,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Account));
const encode = Schema.encodeSync(Schema.fromJsonString(Account));
const decodeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(AccountMachineStatus));
const isError = Schema.is(AccountError);
const wrap = (cause: unknown) =>
  isError(cause) ? cause : new AccountError({ reason: "storage", cause });

/** Derived server-side by AccountAccess, never decoded from a tool's parameters. */
export interface ConnectionCaller {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly projectId: ProjectId;
  readonly scopeProjectId: ProjectLabelId | null;
}
interface ConnectionRow {
  id: string;
  thread_id: string;
  provider_instance_id: string;
  project_id: string;
  scope_project_id: string | null;
  service_id: "cloudflare" | "github";
  display_label: string;
  account_id: string | null;
  credential_id: string | null;
  created_at: string;
  cancelled_at: string | null;
}
const connectionOf = (row: ConnectionRow): AccountConnection => ({
  connectionId: row.id,
  serviceId: row.service_id,
  displayLabel: row.display_label,
  scopeProjectId: row.scope_project_id as ProjectLabelId | null,
  kind: "token",
  intendedUse: "cli",
  requestedGrant: "ask",
  accountId: row.account_id ? AccountId.make(row.account_id) : null,
  credentialId: row.credential_id ? CredentialId.make(row.credential_id) : null,
});

export class Accounts extends Context.Service<
  Accounts,
  {
    readonly connect: (
      caller: ConnectionCaller,
      input: AccountConnectInput,
    ) => Effect.Effect<AccountConnection, AccountError>;
    readonly bindSecretRequest: (
      caller: ConnectionCaller,
      requestId: string,
      connectionId?: string,
    ) => Effect.Effect<void, AccountError>;
    readonly getConnection: (
      caller: ConnectionCaller,
      connectionId: string,
    ) => Effect.Effect<AccountConnection, AccountError>;
    readonly storeConnection: (
      caller: ConnectionCaller,
      connectionId: string,
      value: string,
    ) => Effect.Effect<AccountConnection, AccountError>;
    readonly cancelConnection: (
      caller: ConnectionCaller,
      connectionId: string,
    ) => Effect.Effect<{ disconnected: boolean }, AccountError>;
    readonly list: (input: AccountsListInput) => Effect.Effect<
      {
        accounts: ReadonlyArray<Account>;
        statuses: ReadonlyArray<AccountMachineStatus>;
        services: ReadonlyArray<AccountServiceSetup>;
      },
      AccountError
    >;
    readonly get: (input: AccountKeyInput) => Effect.Effect<{ account: Account }, AccountError>;
    readonly create: (
      input: AccountCreateInput,
    ) => Effect.Effect<{ account: Account }, AccountError>;
    readonly update: (
      input: AccountUpdateInput,
    ) => Effect.Effect<{ account: Account }, AccountError>;
    readonly disconnect: (
      input: AccountKeyInput,
    ) => Effect.Effect<{ disconnected: boolean }, AccountError>;
  }
>()("cogenly-server/accounts/Accounts") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const vault = yield* Vault.Vault;
  const crypto = yield* Crypto.Crypto;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  // Deleted vault items are never advertised as usable account credentials.
  const live = Effect.fnUntraced(function* (account: Account) {
    const credentials = [];
    for (const credential of account.credentials) {
      if (credential.vaultItemId) {
        const rows =
          yield* sql`SELECT id FROM vault_items WHERE id = ${credential.vaultItemId} AND deleted_at IS NULL AND (scope_project_id IS NULL OR scope_project_id = ${account.scopeProjectId})`;
        if (!rows[0]) continue;
      }
      credentials.push(credential);
    }
    return { ...account, credentials };
  });
  const get: Accounts["Service"]["get"] = Effect.fnUntraced(function* (input) {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM accounts WHERE id = ${input.id} AND deleted_at IS NULL AND (scope_project_id IS NULL OR scope_project_id = ${input.scopeProjectId})`;
    if (!rows[0]) return yield* new AccountError({ reason: "not_found" });
    return { account: yield* live(yield* decode(rows[0].payload_json)) };
  }, Effect.mapError(wrap));
  const persist = Effect.fnUntraced(function* (account: Account) {
    // No caller may widen a vault item's scope by associating it with an account.
    for (const credential of account.credentials) {
      if (credential.expiresAt !== undefined && Option.isNone(DateTime.make(credential.expiresAt)))
        return yield* new AccountError({ reason: "invalid_input" });
      if (!credential.vaultItemId) continue;
      const rows = yield* sql<{
        scope_project_id: string | null;
      }>`SELECT scope_project_id FROM vault_items WHERE id = ${credential.vaultItemId} AND deleted_at IS NULL AND (scope_project_id IS NULL OR scope_project_id = ${account.scopeProjectId})`;
      if (!rows[0]) return yield* new AccountError({ reason: "not_found" });
      const associations = yield* sql<{
        id: string;
        account_id: string;
      }>`SELECT id, account_id FROM account_credentials WHERE vault_item_id = ${credential.vaultItemId}`;
      if (associations.some((row) => row.id !== credential.id || row.account_id !== account.id))
        return yield* new AccountError({ reason: "conflict" });
    }
    if (new Set(account.credentials.map((c) => c.id)).size !== account.credentials.length)
      return yield* new AccountError({ reason: "invalid_input" });
    yield* sql`INSERT INTO accounts(id, scope_project_id, payload_json) VALUES (${account.id}, ${account.scopeProjectId}, ${encode(account)}) ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json`;
    const previous = yield* sql<{
      id: string;
      vault_item_id: string | null;
    }>`SELECT id, vault_item_id FROM account_credentials WHERE account_id = ${account.id}`;
    for (const old of previous) {
      const replacement = account.credentials.find((c) => c.id === old.id);
      if (!replacement || replacement.vaultItemId !== old.vault_item_id) {
        yield* sql`DELETE FROM account_process_grants WHERE credential_id = ${old.id}`;
        yield* sql`DELETE FROM account_thread_bindings WHERE credential_id = ${old.id}`;
        yield* sql`UPDATE agent_approvals SET status = 'rejected' WHERE status = 'pending' AND json_extract(action_json, '$.payload.processExposure') IS NOT NULL AND json_extract(action_json, '$.payload.processExposure.credentialId') = ${old.id}`;
      }
    }
    yield* sql`DELETE FROM account_credentials WHERE account_id = ${account.id}`;
    for (const credential of account.credentials) {
      yield* sql`INSERT INTO account_credentials(id, account_id, vault_item_id) VALUES (${credential.id}, ${account.id}, ${credential.vaultItemId ?? null})`;
    }
    return { account };
  });
  const ownedConnection = Effect.fnUntraced(function* (
    caller: ConnectionCaller,
    connectionId: string,
  ) {
    const rows =
      yield* sql<ConnectionRow>`SELECT * FROM account_connections WHERE id = ${connectionId} AND thread_id = ${caller.threadId} AND provider_instance_id = ${caller.providerInstanceId} AND project_id = ${caller.projectId} AND scope_project_id IS ${caller.scopeProjectId} AND cancelled_at IS NULL`;
    if (!rows[0]) return yield* new AccountError({ reason: "not_found" });
    if (rows[0].account_id) {
      const { account } = yield* get({
        id: AccountId.make(rows[0].account_id),
        scopeProjectId: caller.scopeProjectId,
      });
      if (
        account.serviceId !== rows[0].service_id ||
        !account.credentials.some((c) => c.id === rows[0]!.credential_id)
      )
        return yield* new AccountError({ reason: "not_found" });
    }
    return rows[0];
  });
  const service = Accounts.of({
    bindSecretRequest: Effect.fnUntraced(
      function* (caller, requestId, connectionId) {
        if (connectionId !== undefined) yield* ownedConnection(caller, connectionId);
        const rows = yield* sql<{
          thread_id: string;
          target_kind: string;
          connection_id: string | null;
        }>`SELECT thread_id, target_kind, connection_id FROM account_secret_request_targets WHERE request_id = ${requestId}`;
        if (rows[0]) {
          if (
            rows[0].thread_id !== caller.threadId ||
            rows[0].connection_id !== (connectionId ?? null)
          )
            return yield* new AccountError({ reason: "conflict" });
          return;
        }
        yield* sql`INSERT INTO account_secret_request_targets(request_id, thread_id, target_kind, connection_id) VALUES (${requestId}, ${caller.threadId}, ${connectionId === undefined ? "other" : "account"}, ${connectionId ?? null})`;
      },
      (effect) => sql.withTransaction(effect),
      Effect.mapError(wrap),
    ),
    connect: Effect.fnUntraced(
      function* (caller, input) {
        if (input.connectionId !== undefined)
          return connectionOf(yield* ownedConnection(caller, input.connectionId));
        if (caller.scopeProjectId === null)
          return yield* new AccountError({ reason: "project_required" });
        if (!input.serviceId || !input.displayLabel || !cliAdapter(input.serviceId))
          return yield* new AccountError({ reason: "invalid_input" });
        const pending =
          yield* sql<ConnectionRow>`SELECT * FROM account_connections WHERE thread_id = ${caller.threadId} AND provider_instance_id = ${caller.providerInstanceId} AND project_id = ${caller.projectId} AND scope_project_id IS ${caller.scopeProjectId} AND service_id = ${input.serviceId} AND display_label = ${input.displayLabel} AND account_id IS NULL AND cancelled_at IS NULL ORDER BY created_at LIMIT 1`;
        if (pending[0]) return connectionOf(pending[0]);
        const id = `connection:${yield* crypto.randomUUIDv4()}`;
        yield* sql`INSERT INTO account_connections(id, thread_id, provider_instance_id, project_id, scope_project_id, service_id, display_label, created_at) VALUES (${id}, ${caller.threadId}, ${caller.providerInstanceId}, ${caller.projectId}, ${caller.scopeProjectId}, ${input.serviceId}, ${input.displayLabel}, ${yield* now})`;
        return connectionOf(yield* ownedConnection(caller, id));
      },
      (effect) => sql.withTransaction(effect),
      Effect.mapError(wrap),
    ),
    getConnection: Effect.fnUntraced(function* (caller, id) {
      return connectionOf(yield* ownedConnection(caller, id));
    }, Effect.mapError(wrap)),
    storeConnection: Effect.fnUntraced(function* (caller, id, value) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const connection = yield* ownedConnection(caller, id);
          if (connection.account_id) return connectionOf(connection);
          if (value.length < 6 || value.length > 65536 || value.includes("\0"))
            return yield* new AccountError({ reason: "invalid_input" });
          const { item } = yield* vault.create({
            name: `account-token:${id}`,
            type: "api_key",
            scopeProjectId: caller.scopeProjectId,
            secretFields: { value },
          });
          const { account } = yield* service.create({
            serviceId: connection.service_id,
            displayLabel: connection.display_label,
            scopeProjectId: caller.scopeProjectId,
            credentials: [
              {
                kind: "token",
                vaultItemId: item.id,
                portability: "shared",
                deliveryBindings: ["cli"],
                policy: { processExposure: "ask" },
              },
            ],
          });
          yield* sql`UPDATE account_connections SET account_id = ${account.id}, credential_id = ${account.credentials[0]!.id} WHERE id = ${id}`;
          return connectionOf(yield* ownedConnection(caller, id));
        }),
      );
    }, Effect.mapError(wrap)),
    cancelConnection: Effect.fnUntraced(function* (caller, id) {
      const connection = yield* ownedConnection(caller, id);
      if (connection.account_id)
        return yield* service.disconnect({
          id: AccountId.make(connection.account_id),
          scopeProjectId: caller.scopeProjectId,
        });
      yield* sql`UPDATE account_connections SET cancelled_at = ${yield* now} WHERE id = ${id}`;
      return { disconnected: true };
    }, Effect.mapError(wrap)),
    get,
    list: Effect.fnUntraced(function* (input) {
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM accounts WHERE deleted_at IS NULL AND (scope_project_id IS NULL OR scope_project_id = ${input.scopeProjectId}) ORDER BY id`;
      const accounts = (yield* Effect.forEach(rows, (r) =>
        decode(r.payload_json).pipe(Effect.flatMap(live)),
      )).filter((a) => input.serviceId === undefined || a.serviceId === input.serviceId);
      const statuses: Array<AccountMachineStatus> = [];
      for (const account of accounts)
        for (const credential of account.credentials) {
          const rows = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM account_machine_status WHERE credential_id = ${credential.id}`;
          const revisions = credential.vaultItemId
            ? yield* sql<{
                credential_revision: number;
              }>`SELECT credential_revision FROM vault_items WHERE id = ${credential.vaultItemId}`
            : [];
          const decoded = yield* Effect.forEach(rows, (r) => decodeStatus(r.payload_json));
          statuses.push(
            ...decoded.map((status) =>
              revisions[0] && status.credentialRevision !== String(revisions[0].credential_revision)
                ? { ...status, state: "unknown" as const, reason: "credential_changed" as const }
                : status,
            ),
          );
        }
      return {
        accounts,
        statuses,
        services: Object.entries(cliAdapters)
          .filter(([id]) => input.serviceId === undefined || input.serviceId === id)
          .map(([serviceId, adapter]) => ({
            serviceId: serviceId as "cloudflare" | "github",
            method: "api_token" as const,
            setupUrl: adapter.setupUrl,
            instructions: adapter.instructions,
          })),
      };
    }, Effect.mapError(wrap)),
    create: Effect.fnUntraced(function* (input) {
      const account: Account = {
        id: AccountId.make(`account:${yield* crypto.randomUUIDv4()}`),
        serviceId: input.serviceId,
        displayLabel: input.displayLabel,
        scopeProjectId: input.scopeProjectId,
        credentials: yield* Effect.forEach(input.credentials, (c) =>
          crypto
            .randomUUIDv4()
            .pipe(Effect.map((id) => ({ ...c, id: CredentialId.make(`credential:${id}`) }))),
        ),
        integrationIds: [],
      };
      return yield* sql.withTransaction(persist(account));
    }, Effect.mapError(wrap)),
    update: Effect.fnUntraced(function* (input) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const { account } = yield* get(input);
          if (input.serviceId !== undefined && input.serviceId !== account.serviceId) {
            for (const credential of account.credentials) {
              yield* sql`DELETE FROM account_process_grants WHERE credential_id = ${credential.id}`;
              yield* sql`DELETE FROM account_thread_bindings WHERE credential_id = ${credential.id}`;
              yield* sql`DELETE FROM account_machine_status WHERE credential_id = ${credential.id}`;
              yield* sql`UPDATE agent_approvals SET status = 'rejected' WHERE status = 'pending' AND json_extract(action_json, '$.payload.processExposure.credentialId') = ${credential.id}`;
            }
          }
          return yield* persist({
            ...account,
            serviceId: input.serviceId ?? account.serviceId,
            displayLabel: input.displayLabel ?? account.displayLabel,
            credentials: input.credentials ?? account.credentials,
          });
        }),
      );
    }, Effect.mapError(wrap)),
    disconnect: Effect.fnUntraced(function* (input) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* get(input);
          yield* sql`UPDATE accounts SET deleted_at = ${yield* now} WHERE id = ${input.id}`;
          yield* sql`DELETE FROM account_machine_status WHERE credential_id IN (SELECT id FROM account_credentials WHERE account_id = ${input.id})`;
          yield* sql`DELETE FROM account_process_grants WHERE credential_id IN (SELECT id FROM account_credentials WHERE account_id = ${input.id})`;
          yield* sql`DELETE FROM account_thread_bindings WHERE account_id = ${input.id}`;
          yield* sql`UPDATE agent_approvals SET status = 'rejected' WHERE status = 'pending' AND json_extract(action_json, '$.payload.processExposure') IS NOT NULL AND json_extract(action_json, '$.payload.processExposure.accountId') = ${input.id}`;
          yield* sql`UPDATE account_connections SET cancelled_at = ${yield* now} WHERE account_id = ${input.id}`;
          yield* sql`DELETE FROM account_credentials WHERE account_id = ${input.id}`;
          return { disconnected: true };
        }),
      );
    }, Effect.mapError(wrap)),
  });
  return service;
});
export const layer = Layer.effect(Accounts, make);
