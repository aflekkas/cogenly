import {
  IntegrationInstallRuntimeInput,
  IntegrationInstallRuntimeResult,
  IntegrationSetupGuideInput,
  IntegrationSetupGuideResult,
  IntegrationTestResult,
  IntegrationAgentListResult,
  IntegrationAgentResult,
  IntegrationByNameInput,
  IntegrationCallInput,
  IntegrationCallResult,
  IntegrationAddToolInput,
  IntegrationDeleteResult,
  IntegrationRemoveInput,
  IntegrationToolsResult,
  IntegrationUpdateByNameInput,
  OrchestratorMcpFailure,
} from "@cogenly/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as Integrations from "../../../integrations/Integrations.ts";
import * as AgentStore from "../../../agents/AgentStore.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Integrations.Integrations,
    AgentStore.AgentStore,
    Invocation.McpInvocationContext,
    Threads.ThreadManagementService,
  ],
};

export const IntegrationsToolkit = Toolkit.make(
  Tool.make("integration_install_runtime", {
    ...shared,
    parameters: IntegrationInstallRuntimeInput,
    success: IntegrationInstallRuntimeResult,
    description:
      "Install uv on the Cogenly server for managed Google Workspace setup, using the fixed server installer. Does not accept arbitrary commands.",
  }).annotate(Tool.Destructive, false),
  Tool.make("integration_setup_guide", {
    ...shared,
    parameters: IntegrationSetupGuideInput,
    success: IntegrationSetupGuideResult,
    description:
      "Read agent setup instructions for Gmail/Google Workspace, Wispr Flow, Slack, GitHub, Linear, Notion, Fathom or any MCP server by URL or command. Call this before connecting or repairing a service; it opens with the setup notes earlier agents left on that service's existing integrations, so reuse what they created. Do the setup yourself end to end in the collaborative browser, console work included, without asking first; the user only handles a password or 2FA you can't fill from the vault, and the final OAuth consent.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("integration_test", {
    ...shared,
    parameters: IntegrationByNameInput,
    success: IntegrationTestResult,
    description:
      "Test an integration by name now. Reports authentication, scope, credential, timeout or reachability failures without exposing credentials.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("integrations_list", {
    ...shared,
    parameters: Tool.EmptyParams,
    success: IntegrationAgentListResult,
    description:
      "List Cogenly-managed integrations connected for this project: name, display name, account label, hint, setupNotes (what was created where during setup; read them before repairing one), status (connected, needs_sign_in, error with message) and tool count. An account that isn't usable carries nextStep (what to do next, and the part only the user can do); approval, sign-in and field fixes happen on an inline card in the thread, never a Settings URL. One service can be connected several times, e.g. two Slack workspaces; the account label tells them apart. Credentials are never shown.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("integration_tools", {
    ...shared,
    parameters: IntegrationByNameInput,
    success: IntegrationToolsResult,
    description:
      "List one integration's current upstream tools with descriptions and input schemas. Integrations added or updated during this chat, here or on a paired machine, are available immediately after sync, without restarting the session. Use integrations_list to discover them, then call this before integration_call for a tool you have not used.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, true),
  Tool.make("integration_call", {
    ...shared,
    parameters: IntegrationCallInput,
    success: IntegrationCallResult,
    description:
      "Call one tool on a connected integration by integration name and upstream tool name. Arguments must match the tool's input schema from integration_tools. Resolves the current integration on every call, including changes made mid-chat; disabled or removed integrations stop working immediately.",
  })
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, true),
  Tool.make("integration_add", {
    ...shared,
    parameters: IntegrationAddToolInput,
    success: IntegrationAgentResult,
    description:
      'Connect an integration. For a default service pass catalogId: google-workspace (Gmail, Calendar, Drive, Docs; needs accountLabel), slack, github, linear, notion, wispr-flow or fathom, plus an accountLabel to tell accounts apart (e.g. "work"). When the result needs sign-in, an inline Sign in card appears in this thread and opens the user\'s browser; do not paste the link or a Settings URL. Cogenly tells this thread when it connects; after that it keeps working, including for scheduled runs. When something has to happen first (a key, the user\'s own app, Google\'s OAuth client, or installing uv), the result has nextStep and integration_setup_guide instructions: do that work yourself in the collaborative browser, naming what you create Cogenly and reusing an existing Cogenly project or client, then retry; ask only for user-only actions. A failed OAuth step reports the step, host, HTTP status and the server\'s error. Pass setupNotes recording what you created where (project ID, client ID, redirect URIs, owning account, date; never secrets). Secrets are always vault references {{credential:<item>.<field>}} collected with request_secret and saveToVault, never values in chat. On a VPS: set callbackOrigin to its reachable HTTPS origin for OAuth. For a command server omit catalogId, use transport "stdio", url "https://localhost", headers {}, and command {command, args, env} with vault references for secrets in env, never argv. For any other remote MCP server omit catalogId and pass name, displayName, transport "http", url, headers, scope and hint; set auth {type: "oauth"} for OAuth sign-in (servers without automatic client registration also need auth.clientId and auth.clientSecret). Catalog integrations always use their service logo. Custom HTTP integrations use their server favicon automatically; if it is missing, set icon (a catalog logo) or iconUrl (a public HTTPS image URL) on add or update. Always supply an icon for a command server. Persistent agents get an inline owner approval card first.',
  }).annotate(Tool.Destructive, false),
  Tool.make("integration_update", {
    ...shared,
    parameters: IntegrationUpdateByNameInput,
    success: IntegrationAgentResult,
    description:
      "Change a connected integration by name: display name, account label, transport, url, headers, auth, enabled, project scope, hint, icon, iconUrl, or setupNotes. If the automatic server favicon is unavailable, supply icon or iconUrl. Omitted fields are preserved. setupNotes replaces the notes (empty clears them); changing only the notes keeps the sign-in and running process as they are, so update them whenever you change the setup. When the integration needs a (new) sign-in, an inline Sign in card appears in this thread; call this with just the name to start a fresh one. A change that needs the owner's approval (URL, transport, headers or auth from a persistent agent, or widening access) shows an inline Approve card and this call waits for the answer, then proceeds. Never send a Settings URL. When something else blocks it, follow nextStep and integration_setup_guide.",
  }).annotate(Tool.Destructive, false),
  Tool.make("integration_remove", {
    ...shared,
    parameters: IntegrationRemoveInput,
    success: IntegrationDeleteResult,
    description:
      "Disconnect an integration by name. Its definition is tombstoned and its name becomes reusable.",
  }).annotate(Tool.Destructive, true),
);
