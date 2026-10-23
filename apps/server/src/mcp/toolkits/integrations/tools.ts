import {
  IntegrationByNameInput,
  IntegrationCallInput,
  IntegrationCallResult,
  IntegrationAddInput,
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
      "List Cogenly-managed integrations connected for this project: name, display name, hint, connected status and tool count. Credentials are never shown.",
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
    parameters: IntegrationAddInput,
    success: IntegrationMutationResult,
    description:
      "Connect a remote MCP integration, or a managed Google account with preset: google-workspace and accountLabel. For a VPS, set callbackOrigin to its reachable HTTPS origin. Store google-oauth-client in the vault first (username: client ID, password: client secret, allowed domain: accounts.google.com), using request_secret with saveToVault. See docs/user/integrations.md#connect-google. Return the signInUrl to the user. Header values may reference vault credentials as {{credential:<item>.<field>}}; never put raw secrets in headers. Persistent agents need owner approval first.",
  }).annotate(Tool.Destructive, false),
  Tool.make("integration_update", {
    ...shared,
    parameters: IntegrationUpdateByNameInput,
    success: IntegrationMutationResult,
    description:
      "Change a connected integration by name: display name, transport, url, headers, enabled, project scope, or hint. Omitted fields are preserved. Widening project scope needs owner approval. Persistent agents also need approval for URL, transport, or header changes.",
  }).annotate(Tool.Destructive, false),
  Tool.make("integration_remove", {
    ...shared,
    parameters: IntegrationRemoveInput,
    success: IntegrationDeleteResult,
    description:
      "Disconnect an integration by name. Its definition is tombstoned and its name becomes reusable.",
  }).annotate(Tool.Destructive, true),
);
