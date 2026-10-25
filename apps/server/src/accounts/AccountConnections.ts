import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import {
  AccountError,
  type AccountConnectInput,
  type AccountConnectResult,
  type AccountConnection,
  type SecretRef,
  type ThreadId,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Accounts from "./Accounts.ts";
import * as Access from "./AccountAccess.ts";
import * as Cli from "./CliCredentials.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { cliAdapter } from "./CliAdapters.ts";
const wrap = (cause: unknown) =>
  Schema.is(AccountError)(cause) ? cause : new AccountError({ reason: "storage", cause });

export class AccountConnections extends Context.Service<
  AccountConnections,
  {
    readonly bindSecretRequest: (
      caller: Access.AccountCallerInput,
      requestId: string,
      connectionId?: string,
    ) => Effect.Effect<void, AccountError>;
    readonly connectForThread: (
      threadId: ThreadId,
      input: AccountConnectInput,
    ) => Effect.Effect<typeof AccountConnectResult.Type, AccountError>;
    readonly connect: (
      caller: Access.AccountCallerInput,
      input: AccountConnectInput,
    ) => Effect.Effect<typeof AccountConnectResult.Type, AccountError>;
    readonly describe: (
      caller: Access.AccountCallerInput,
      connectionId: string,
    ) => Effect.Effect<
      { connection: AccountConnection; label: string; reason: string },
      AccountError
    >;
    readonly capture: (
      caller: Access.AccountCallerInput,
      connectionId: string,
      ref: SecretRef,
    ) => Effect.Effect<AccountConnection, AccountError>;
  }
>()("cogenly-server/accounts/AccountConnections") {}
const make = Effect.gen(function* () {
  const accounts = yield* Accounts.Accounts;
  const access = yield* Access.AccountAccess;
  const cli = yield* Cli.CliCredentials;
  const requests = yield* SecretRequests.SecretRequests;
  const threads = yield* Threads.ThreadManagementService;
  const service = AccountConnections.of({
    bindSecretRequest: Effect.fnUntraced(function* (auth, requestId, connectionId) {
      return yield* accounts.bindSecretRequest(yield* access.caller(auth), requestId, connectionId);
    }, Effect.mapError(wrap)),
    connectForThread: Effect.fnUntraced(function* (threadId, input) {
      const thread = yield* threads.getThreadShell(threadId);
      if (!thread?.providerInstanceId) return yield* new AccountError({ reason: "denied" });
      return yield* service.connect(
        { threadId, providerInstanceId: thread.providerInstanceId },
        input,
      );
    }, Effect.mapError(wrap)),
    connect: Effect.fnUntraced(function* (auth, input) {
      const caller = yield* access.caller(auth);
      const connection = yield* accounts.connect(caller, input);
      const adapter = cliAdapter(connection.serviceId)!;
      const setup = {
        serviceId: connection.serviceId,
        method: "api_token" as const,
        setupUrl: adapter.setupUrl,
        instructions: adapter.instructions,
      };
      if (!connection.accountId || !connection.credentialId) return { connection, setup };
      const binding = yield* access.setThreadBinding(auth, {
        accountId: connection.accountId,
        credentialId: connection.credentialId,
        attached: true,
      });
      if (binding.status !== "attached") return { connection, setup, access: binding };
      const verification = yield* cli.verify(auth, connection.accountId, connection.credentialId);
      return { connection, setup, access: binding, verification };
    }, Effect.mapError(wrap)),
    describe: Effect.fnUntraced(function* (auth, connectionId) {
      const caller = yield* access.caller(auth);
      const connection = yield* accounts.getConnection(caller, connectionId);
      return {
        connection,
        label: `Connect ${connection.serviceId} · ${connection.displayLabel}`,
        reason: `Service: ${connection.serviceId}. Project: ${caller.scopeProjectId ?? caller.projectId}. Credential: API token. Intended use: CLI. Storage does not grant process access. Before exposure, choose this thread or this agent in this project. The agent and the commands it runs can read this token once approved.`,
      };
    }, Effect.mapError(wrap)),
    capture: Effect.fnUntraced(function* (auth, id, ref) {
      const caller = yield* access.caller(auth);
      const connection = yield* accounts.getConnection(caller, id);
      if (connection.accountId) return connection;
      return yield* requests.adopt({ ref, projectId: caller.projectId }, (value) =>
        accounts.storeConnection(caller, id, value),
      );
    }, Effect.mapError(wrap)),
  });
  return service;
});
export const layer = Layer.effect(AccountConnections, make);
