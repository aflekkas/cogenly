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
} from "@cogenly/contracts";
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
    "List project account metadata, machine status and token setup instructions. No secret/encrypted identity values. Requires a Cogenly thread.",
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
    "Start/resume a project Cloudflare/GitHub token connection. Collect with request_secret saveToAccount:{connectionId}, then resume for process-exposure approval and isolated CLI verification. Authentication does not prove deployment access.",
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
    "Attach/detach a CLI credential. First exposure asks the owner for this thread or agent/project; commands can read it, tools return no values. Detach affects future processes only; stop existing ones or revoke upstream.",
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
    "Cancel/disconnect a local project account and future process bindings. Does not revoke upstream tokens or copies in existing processes.",
  parameters: AccountDisconnectTarget,
  success: AccountDisconnectResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Disconnect account")
  .annotate(Tool.Destructive, true);
export const AccountsToolkit = Toolkit.make(list, connect, use, disconnect);
