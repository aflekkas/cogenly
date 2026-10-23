import {
  AccountConnectInput,
  AccountConnectResult,
  AccountDisconnectResult,
  AccountDisconnectTarget,
  AccountsListResult,
  AccountUseInput,
  AccountUseResult,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as AccountsMcp from "../../AccountsMcpService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
const dependencies = [
  AccountsMcp.AccountsMcpService,
  Invocation.McpInvocationContext,
  Threads.ThreadManagementService,
];
const list = Tool.make("accounts_list", {
  description:
    "List account metadata and machine status available to this thread's project, plus supported token setup instructions. Never returns secret values or encrypted identity fields. Needs a Cogenly thread.",
  parameters: Schema.Struct({ service: Schema.optional(TrimmedNonEmptyString) }),
  success: AccountsListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List accounts")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);
const connect = Tool.make("account_connect", {
  description:
    "Start or resume a server-owned Cloudflare/GitHub token connection in this thread's project. Collect the token with request_secret(saveToAccount: { connectionId }); never ask for it in chat. Resume after saving to request process-exposure approval and verify using an isolated CLI. Successful authentication does not prove deployment permissions.",
  parameters: AccountConnectInput,
  success: AccountConnectResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Connect account")
  .annotate(Tool.Destructive, false);
const use = Tool.make("account_use", {
  description:
    "Attach or detach a credential for CLI use in this thread. First process exposure asks the owner for this thread or this agent in this project: the agent and its commands can read the token. No values are returned. A detached token stays in already-running processes; stop them or revoke upstream to end that access.",
  parameters: Schema.Struct({ ...AccountUseInput.fields, use: Schema.Literal("cli") }),
  success: AccountUseResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Use account credential")
  .annotate(Tool.Destructive, false);
const disconnect = Tool.make("account_disconnect", {
  description:
    "Cancel a pending connection or disconnect a local account available to this project. Removes future process access and local bindings; it does not revoke the upstream token or remove copies already captured by processes.",
  parameters: AccountDisconnectTarget,
  success: AccountDisconnectResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Disconnect account")
  .annotate(Tool.Destructive, true);
export const AccountsToolkit = Toolkit.make(list, connect, use, disconnect);
