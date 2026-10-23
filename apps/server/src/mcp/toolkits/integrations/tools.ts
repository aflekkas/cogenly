import {
  IntegrationByNameInput,
  IntegrationCallInput,
  IntegrationCallResult,
  IntegrationCreateInput,
  IntegrationDeleteResult,
  IntegrationListResult,
  IntegrationMutationResult,
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
  Tool.make("integrations_list", {
    ...shared,
    parameters: Tool.EmptyParams,
    success: IntegrationListResult,
    description:
      "List Cogenly-managed integrations connected for this project: name, display name, account label, hint, status (connected, needs_sign_in, error with message) and tool count. One service can be connected several times, e.g. two Slack workspaces; the account label tells them apart. Credentials are never shown.",
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
    parameters: IntegrationCreateInput,
    success: IntegrationMutationResult,
    description:
      'Connect a new remote MCP integration (http transport). Most hosted servers (Linear, Notion, Atlassian, GitHub, Slack, Intercom…) sign in with OAuth: set auth to {type: "oauth"} with no auth headers, and the result\'s signIn.authorizationUrl is a link the user must open in their browser to approve access; give it to them. After that it keeps working, including for scheduled runs. Servers without automatic client registration (e.g. Slack) also need auth.clientId and auth.clientSecret as a vault reference. To connect another account of the same service, use a new name and an accountLabel. Header values may reference vault credentials as {{credential:<item>.<field>}}; never put raw secrets in headers. Persistent agents need owner approval first.',
  }).annotate(Tool.Destructive, false),
  Tool.make("integration_update", {
    ...shared,
    parameters: IntegrationUpdateByNameInput,
    success: IntegrationMutationResult,
    description:
      "Change a connected integration by name: display name, account label, transport, url, headers, auth, enabled, project scope, or hint. Omitted fields are preserved. When the integration needs a (new) OAuth sign-in, the result includes signIn.authorizationUrl for the user to open; call this with just the name to get a fresh link. Widening project scope needs owner approval. Persistent agents also need approval for URL, transport, header, or auth changes.",
  }).annotate(Tool.Destructive, false),
  Tool.make("integration_remove", {
    ...shared,
    parameters: IntegrationRemoveInput,
    success: IntegrationDeleteResult,
    description:
      "Disconnect an integration by name. Its definition is tombstoned and its name becomes reusable.",
  }).annotate(Tool.Destructive, true),
);
