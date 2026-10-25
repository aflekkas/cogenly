import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
  OrchestratorMcpFailure,
  ServerSettings,
  ServerSettingsPatch,
  UniversalClientPreferenceValues,
  UniversalClientPreferencePatch,
} from "@cogenly/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { EnvironmentId, MachineHealthReport, MachineSecurityStatus } from "@cogenly/contracts";
import * as DesktopAppControl from "../../../environment/DesktopAppControl.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as MachineHealth from "../../../health/MachineHealth.ts";
import * as MachineSecurity from "../../../security/MachineSecurity.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const PreferenceFields = {
  ...UniversalClientPreferenceValues.fields,
  sharedKeybindings: ServerSettings.fields.sharedKeybindings,
  defaultThreadEnvMode: ServerSettings.fields.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: ServerSettings.fields.newWorktreesStartFromOrigin,
  enableAgentTerminals: ServerSettings.fields.enableAgentTerminals,
  enableProviderUpdateChecks: ServerSettings.fields.enableProviderUpdateChecks,
  useProviderConnectors: ServerSettings.fields.useProviderConnectors,
  projectsRoot: ServerSettings.fields.projectsRoot,
  modelEffortDefaults: ServerSettings.fields.modelEffortDefaults,
  backgroundActivity: Schema.Struct({ profile: BackgroundActivityProfileSelection }),
  sourceControlWritingStyle: Schema.Struct({
    mode: Schema.String,
    followChangeRequestTemplates: Schema.Boolean,
    customInstructions: Schema.String,
    truncated: Schema.Boolean,
  }),
};
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};
const EnvironmentReadTool = Tool.make("environment_read", {
  ...shared,
  description:
    "Read this server's identity and selected preferences. The projects root, provider update checks and background activity belong to this machine; the rest are universal across paired machines. Provider/model availability is exposed by orchestrator_capabilities. Writing instructions are limited to 4,000 characters.",
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPreferencesTool = Tool.make("environment_preferences_update", {
  ...shared,
  description:
    "Update selected preferences through normal settings persistence and notifications. Requires a live full-access/default calling thread. defaultThreadEnvMode, setModelEffortDefault, newWorktreesStartFromOrigin, enableAgentTerminals, sourceControlWritingStyle and useProviderConnectors are universal: they reach every paired machine. The client-prefixed appearance, notifications, confirmation, composer, sidebar and diff preferences, and sharedKeybindings, are universal too. sharedKeybindings is the complete ordered list of { key, command, when? } rules; use mod for the platform modifier. enableProviderUpdateChecks, backgroundActivity and projectsRoot apply to this machine only. Omitted fields are preserved; empty customInstructions clears them. setModelEffortDefault sets the reasoning effort a model starts at ({ provider: instance id, model: slug, option: { id: the model's effort option id from orchestrator_capabilities, e.g. reasoningEffort or effort, value } }); option null restores the model's own default. projectsRoot sets where new project folders and their repositories go on this machine; empty restores the default, <Cogenly home>/projects. Existing project folders are not moved. useProviderConnectors (off by default) restores provider-native MCP servers, plugins and apps; it applies to new agent sessions.",
  parameters: Schema.Struct({
    ...UniversalClientPreferencePatch.fields,
    sharedKeybindings: ServerSettingsPatch.fields.sharedKeybindings,
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    setModelEffortDefault: ServerSettingsPatch.fields.setModelEffortDefault,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableAgentTerminals: ServerSettingsPatch.fields.enableAgentTerminals,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    useProviderConnectors: ServerSettingsPatch.fields.useProviderConnectors,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
    projectsRoot: ServerSettingsPatch.fields.projectsRoot,
  }),
  success: Schema.Struct(PreferenceFields),
}).annotate(Tool.Destructive, true);
const EnvironmentAddTool = Tool.make("environment_add", {
  ...shared,
  dependencies: [...shared.dependencies, DesktopAppControl.DesktopAppControl],
  description:
    "Add the user's server to their Cogenly desktop app over SSH, with no clicks. Use it when the user asks to add or connect a server. The desktop connects to an SSH host from the user's SSH config, uses the Cogenly already installed there (starting its service if stopped, installing it otherwise), pairs, and saves it; the user sees progress in the app. Only works from an environment on the same computer as the desktop app. Requires a live full-access/default calling thread. Can take a few minutes.",
  parameters: Schema.Struct({
    ssh: Schema.String.annotate({
      description: "SSH host alias from the user's SSH config (e.g. `myvps`), or user@host.",
    }),
    name: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Name to show, such as `Contabo VPS`. Omit to use the host's own name, `<Provider> VPS`, or `VPS`.",
      }),
    ),
  }),
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const MachineSecurityStatusTool = Tool.make("machine_security_status", {
  ...shared,
  dependencies: [
    ...shared.dependencies,
    MachineSecurity.MachineSecurity,
    ChildProcessSpawner.ChildProcessSpawner,
  ],
  description:
    "Read-only security posture of this machine: Cogenly's bind, non-loopback listeners, sshd password/root settings when readable, Tailscale Serve/Funnel, and host firewall when readable. Checks that cannot run without root report unknown, never pass.",
  success: MachineSecurityStatus,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const MachineHealthTool = Tool.make("machine_health", {
  ...shared,
  dependencies: [...shared.dependencies, MachineHealth.MachineHealth],
  description:
    "Health of a Cogenly machine: server, database, disk, provider sign-ins, links to paired machines, sync, integrations, scheduled tasks, stuck runs, boot service, Tailscale Serve and the canary. Each check has a status (ok, warn, fail, unknown when it could not run), a summary and the items worth attention, with a suggested fix where there is one. Omit environmentId for this machine; give a paired machine's (from machines_list) to read its report over the peer link. reachable false means that machine did not answer and the report describes what this one saw.",
  parameters: Schema.Struct({
    environmentId: Schema.optionalKey(
      EnvironmentId.annotate({
        description: "A paired machine's environment ID from machines_list. Omit for this machine.",
      }),
    ),
  }),
  success: MachineHealthReport,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const EnvironmentToolkit = Toolkit.make(
  EnvironmentReadTool,
  EnvironmentPreferencesTool,
  EnvironmentAddTool,
  MachineSecurityStatusTool,
  MachineHealthTool,
);
