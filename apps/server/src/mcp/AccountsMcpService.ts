import {
  AccountError,
  type AccountDisconnectTarget,
  OrchestratorMcpFailure,
  type AccountConnectInput,
  type AccountConnectResult,
  type AccountsListResult,
  type AccountUseInput,
  type AccountUseResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Accounts from "../accounts/Accounts.ts";
import * as Access from "../accounts/AccountAccess.ts";
import * as Connections from "../accounts/AccountConnections.ts";
import * as Invocation from "./McpInvocationContext.ts";
const failure = (cause: AccountError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: cause.message });
/** @effect-expect-leaking McpInvocationContext -- authenticated caller is resolved for each tool invocation. */
export class AccountsMcpService extends Context.Service<
  AccountsMcpService,
  {
    readonly list: (
      serviceId?: string,
    ) => Effect.Effect<
      typeof AccountsListResult.Type,
      OrchestratorMcpFailure,
      Invocation.McpInvocationContext
    >;
    readonly connect: (
      input: AccountConnectInput,
    ) => Effect.Effect<
      typeof AccountConnectResult.Type,
      OrchestratorMcpFailure,
      Invocation.McpInvocationContext
    >;
    readonly use: (
      input: AccountUseInput,
    ) => Effect.Effect<
      typeof AccountUseResult.Type,
      OrchestratorMcpFailure,
      Invocation.McpInvocationContext
    >;
    readonly disconnect: (
      input: AccountDisconnectTarget,
    ) => Effect.Effect<
      { disconnected: boolean },
      OrchestratorMcpFailure,
      Invocation.McpInvocationContext
    >;
  }
>()("cogenly-server/mcp/AccountsMcpService") {}
const make = Effect.gen(function* () {
  const accounts = yield* Accounts.Accounts;
  const access = yield* Access.AccountAccess;
  const connections = yield* Connections.AccountConnections;
  const auth = Effect.gen(function* () {
    const invocation = yield* Invocation.McpInvocationContext;
    if (!invocation.capabilities.has("orchestration"))
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "This credential cannot manage accounts.",
      });
    const scope = yield* Invocation.requireThreadScope(invocation, "Accounts tools");
    return scope.thread;
  });
  return AccountsMcpService.of({
    list: Effect.fnUntraced(
      function* (serviceId) {
        const caller = yield* access.caller(yield* auth);
        return yield* accounts.list({
          scopeProjectId: caller.scopeProjectId,
          ...(serviceId === undefined ? {} : { serviceId }),
        });
      },
      Effect.mapError((cause) => (cause._tag === "AccountError" ? failure(cause) : cause)),
    ),
    connect: Effect.fnUntraced(function* (input) {
      return yield* connections.connect(yield* auth, input).pipe(Effect.mapError(failure));
    }),
    use: Effect.fnUntraced(function* (input) {
      return yield* access.setThreadBinding(yield* auth, input).pipe(Effect.mapError(failure));
    }),
    disconnect: Effect.fnUntraced(function* (input) {
      const caller = yield* access.caller(yield* auth).pipe(Effect.mapError(failure));
      if ((input.accountId === undefined) === (input.connectionId === undefined))
        return yield* failure(new AccountError({ reason: "invalid_input" }));
      return yield* (
        input.connectionId !== undefined
          ? accounts.cancelConnection(caller, input.connectionId)
          : accounts.disconnect({ id: input.accountId!, scopeProjectId: caller.scopeProjectId })
      ).pipe(Effect.mapError(failure));
    }),
  });
});
export const layer = Layer.effect(AccountsMcpService, make);
