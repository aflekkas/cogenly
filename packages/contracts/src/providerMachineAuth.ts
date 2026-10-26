import * as Schema from "effect/Schema";
import { AuthPeerDelegateScope } from "./auth.ts";
import { makePeerChannel } from "./machine.ts";
import {
  ProviderAuthStartInput,
  ProviderAuthRespondInput,
  ProviderAuthCancelInput,
  ProviderAuthCompleteInput,
  ProviderSetupInput,
  ProviderAuthState,
  ProviderSetupError,
} from "./providerSetup.ts";

export const ProviderMachineAuthRequest = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("start"), input: ProviderAuthStartInput }),
  Schema.Struct({ operation: Schema.Literal("respond"), input: ProviderAuthRespondInput }),
  Schema.Struct({ operation: Schema.Literal("complete"), input: ProviderAuthCompleteInput }),
  Schema.Struct({ operation: Schema.Literal("cancel"), input: ProviderAuthCancelInput }),
  Schema.Struct({ operation: Schema.Literal("logout"), input: ProviderSetupInput }),
  Schema.Struct({ operation: Schema.Literal("read"), input: ProviderSetupInput }),
]);
export type ProviderMachineAuthRequest = typeof ProviderMachineAuthRequest.Type;
export const ProviderMachineAuth = makePeerChannel({
  name: "provider.auth.v1",
  scope: AuthPeerDelegateScope,
  payload: Schema.Struct({
    owner: Schema.String.check(Schema.isMaxLength(256)),
    request: ProviderMachineAuthRequest,
  }),
  success: ProviderAuthState,
  error: ProviderSetupError,
});
