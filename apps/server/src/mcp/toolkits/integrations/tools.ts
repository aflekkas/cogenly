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
import * as Schema from "effect/Schema";

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
      "Read service-specific connection/repair instructions and existing setup notes first. Reuse prior setup; complete browser/console work yourself. The user handles unfillable credentials, 2FA and final OAuth consent. Supports catalog services and arbitrary MCP URLs/commands.",
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
    parameters: Schema.Struct({ detail: Schema.optional(Schema.Boolean) }),
    success: IntegrationAgentListResult,
    description:
      "List project integrations, account labels, status, nextStep and tool counts without credentials. detail:true adds setupNotes for repairs. Multiple accounts per service are supported. Fix via inline cards; for missing services read integration_setup_guide then integration_add.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("integration_tools", {
    ...shared,
    parameters: IntegrationByNameInput,
    success: IntegrationToolsResult,
    description:
      "Read an integration's current upstream descriptions/schemas before calling unfamiliar tools. Added/updated integrations work after sync without session restart; discover via integrations_list.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, true),
  Tool.make("integration_call", {
    ...shared,
    parameters: IntegrationCallInput,
    success: IntegrationCallResult,
    description:
      "Call an integration tool using its integration_tools schema. Resolves current config each call; disabled/removed integrations stop immediately.",
  })
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, true),
  Tool.make("integration_add", {
    ...shared,
    parameters: IntegrationAddToolInput,
    success: IntegrationAgentResult,
    description:
      "Connect a catalogId (google-workspace, slack, github, linear, notion, wispr-flow, fathom) with accountLabel, or a custom MCP server. Read integration_setup_guide first for configuration/repair recipes. Follow nextStep, reuse Cogenly projects/clients, record nonsecret setupNotes. Sign-in appears on an inline card and completion notifies this thread; never send Settings/sign-in URLs. Secrets use vault references {{credential:<item>.<field>}}, never argv/chat. VPS OAuth needs reachable HTTPS callbackOrigin. Catalog logos/server favicons are automatic; custom stdio needs icon/iconUrl. Persistent agents need owner approval.",
  }).annotate(Tool.Destructive, false),
  Tool.make("integration_update", {
    ...shared,
    parameters: IntegrationUpdateByNameInput,
    success: IntegrationAgentResult,
    description:
      "Patch an integration by name; omissions stay. setupNotes replaces notes (empty clears) without disturbing sign-in/process. Call with just name to restart sign-in via an inline card. Sensitive agent changes or wider access wait on approval cards. Follow nextStep/setup guide for blockers; never send Settings URLs.",
  }).annotate(Tool.Destructive, false),
  Tool.make("integration_remove", {
    ...shared,
    parameters: IntegrationRemoveInput,
    success: IntegrationDeleteResult,
    description:
      "Disconnect an integration by name. Its definition is tombstoned and its name becomes reusable.",
  }).annotate(Tool.Destructive, true),
);
