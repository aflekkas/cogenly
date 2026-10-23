import * as Effect from "effect/Effect";
import * as Accounts from "../../AccountsMcpService.ts";
import * as Access from "../../McpToolAccess.ts";
import { AccountsToolkit } from "./tools.ts";
export const layer = Access.toLayer(AccountsToolkit, {
  accounts_list: Access.readsAsCaller((input) =>
    Effect.flatMap(Accounts.AccountsMcpService, (service) => service.list(input.service)),
  ),
  account_connect: Access.actsAsCaller((input) =>
    Effect.flatMap(Accounts.AccountsMcpService, (service) => service.connect(input)),
  ),
  account_use: Access.actsAsCaller((input) =>
    Effect.flatMap(Accounts.AccountsMcpService, (service) => service.use(input)),
  ),
  account_disconnect: Access.actsAsCaller((input) =>
    Effect.flatMap(Accounts.AccountsMcpService, (service) => service.disconnect(input)),
  ),
});
