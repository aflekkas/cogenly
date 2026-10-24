import {
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
} from "@t3tools/contracts";
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
  Tool.make("integration_setup_guide", {
    ...shared,
    parameters: IntegrationSetupGuideInput,
    success: IntegrationSetupGuideResult,
    description:
      "Read agent setup instructions for Gmail/Google Workspace, Wispr Flow, Slack, GitHub, Linear, Notion, Fathom or any MCP server by URL or command. Call this before connecting a service. Perform setup yourself, collecting secrets with request_secret and handing consent links to the user.",
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
      "List Cogenly-managed integrations connected for this project: name, display name, account label, hint, status (connected, needs_sign_in, error with message) and tool count. An account that isn't usable carries nextStep (what to tell the user, in plain words) and settingsUrl (a link that opens that step in Settings). One service can be connected several times, e.g. two Slack workspaces; the account label tells them apart. Credentials are never shown.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("integration_tools", {
    ...shared,
    parameters: IntegrationByNameInput,
    success: IntegrationToolsResult,
    description:
      "List one integration's upstream tools with descriptions and input schemas. Call this before integration_call for a tool you have not used.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, true),
  Tool.make("integration_call", {
    ...shared,
    parameters: IntegrationCallInput,
    success: IntegrationCallResult,
    description:
      "Call one tool on a connected integration by integration name and upstream tool name. Arguments must match the tool's input schema from integration_tools.",
  })
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, true),
  Tool.make("integration_add", {
    ...shared,
    parameters: IntegrationAddToolInput,
    success: IntegrationAgentResult,
    description:
      'Connect an integration. For a default service pass catalogId: google-workspace (Gmail, Calendar, Drive, Docs; needs accountLabel), slack, github, linear, notion, wispr-flow or fathom, plus an accountLabel to tell accounts apart (e.g. "work"). When the result has signIn.authorizationUrl, give that link to the user to open in their browser; after that it keeps working, including for scheduled runs. When something has to happen first (a key, the user\'s own app, Google\'s OAuth client, or installing uv), the result has nextStep saying exactly what to tell the user and integration_setup_guide instructions; perform setup and ask only for user-only actions. Secrets are always vault references {{credential:<item>.<field>}} collected with request_secret and saveToVault, never values in chat. On a VPS: set callbackOrigin to its reachable HTTPS origin for any OAuth integration, or ask the user to sign in first through Settings on that address. For any other remote MCP server omit catalogId and pass name, displayName, transport "http", url, headers, scope and hint; set auth {type: "oauth"} for OAuth sign-in (servers without automatic client registration also need auth.clientId and auth.clientSecret). Persistent agents need owner approval first.',
  }).annotate(Tool.Destructive, false),
  Tool.make("integration_update", {
    ...shared,
    parameters: IntegrationUpdateByNameInput,
    success: IntegrationAgentResult,
    description:
      "Change a connected integration by name: display name, account label, transport, url, headers, auth, enabled, project scope, or hint. Omitted fields are preserved. When the integration needs a (new) sign-in, remote OAuth or a managed Google account, the result includes signIn.authorizationUrl for the user to open; call this with just the name to get a fresh link. When something else blocks it, the result has nextStep and settingsUrl, as for integration_add. Widening project scope needs owner approval. Persistent agents also need approval for URL, transport, header, or auth changes.",
  }).annotate(Tool.Destructive, false),
  Tool.make("integration_remove", {
    ...shared,
    parameters: IntegrationRemoveInput,
    success: IntegrationDeleteResult,
    description:
      "Disconnect an integration by name. Its definition is tombstoned and its name becomes reusable.",
  }).annotate(Tool.Destructive, true),
);
