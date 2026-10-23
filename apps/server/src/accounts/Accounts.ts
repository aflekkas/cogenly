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
} from "@t3tools/contracts";
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

export class Accounts extends Context.Service<
  Accounts,
  {
    readonly list: (
      input: AccountsListInput,
    ) => Effect.Effect<
      { accounts: ReadonlyArray<Account>; statuses: ReadonlyArray<AccountMachineStatus> },
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
        yield* sql`UPDATE agent_approvals SET status = 'rejected' WHERE status = 'pending' AND json_extract(action_json, '$.actionKind') = 'account_process' AND json_extract(action_json, '$.payload.credentialId') = ${old.id}`;
      }
    }
    yield* sql`DELETE FROM account_credentials WHERE account_id = ${account.id}`;
    for (const credential of account.credentials) {
      yield* sql`INSERT INTO account_credentials(id, account_id, vault_item_id) VALUES (${credential.id}, ${account.id}, ${credential.vaultItemId ?? null})`;
    }
    return { account };
  });
  return Accounts.of({
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
          statuses.push(...(yield* Effect.forEach(rows, (r) => decodeStatus(r.payload_json))));
        }
      return { accounts, statuses };
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
          return yield* persist({
            ...account,
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
          yield* sql`UPDATE agent_approvals SET status = 'rejected' WHERE status = 'pending' AND json_extract(action_json, '$.actionKind') = 'account_process' AND json_extract(action_json, '$.payload.accountId') = ${input.id}`;
          yield* sql`UPDATE account_connections SET cancelled_at = ${yield* now} WHERE account_id = ${input.id}`;
          yield* sql`DELETE FROM account_credentials WHERE account_id = ${input.id}`;
          return { disconnected: true };
        }),
      );
    }, Effect.mapError(wrap)),
  });
});
export const layer = Layer.effect(Accounts, make);
