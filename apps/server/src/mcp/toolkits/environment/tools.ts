import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  DesktopCliCommandLocation,
  DesktopCliCommandStateSchema,
  ExecutionEnvironmentDescriptor,
  OrchestratorMcpFailure,
  ServerSettings,
  ServerSettingsPatch,
} from "@cogenly/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { MachineSecurityStatus } from "@cogenly/contracts";
import * as DesktopAppControl from "../../../environment/DesktopAppControl.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as MachineSecurity from "../../../security/MachineSecurity.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const PreferenceFields = {
  defaultThreadEnvMode: ServerSettings.fields.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: ServerSettings.fields.newWorktreesStartFromOrigin,
  enableAgentTerminals: ServerSettings.fields.enableAgentTerminals,
  enableProviderUpdateChecks: ServerSettings.fields.enableProviderUpdateChecks,
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
    "Read this server's identity and selected environment preferences, including the projects root. Provider/model availability is exposed by orchestrator_capabilities. Writing instructions are limited to 4,000 characters.",
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
    "Update selected environment-wide preferences through normal settings persistence and notifications. Requires a live full-access/default calling thread. Omitted fields are preserved; empty customInstructions clears them. setModelEffortDefault sets the reasoning effort a model starts at ({ provider: instance id, model: slug, option: { id: the model's effort option id from orchestrator_capabilities, e.g. reasoningEffort or effort, value } }); option null restores the model's own default. projectsRoot sets where new project folders and their repositories go; empty restores the default, <Cogenly home>/projects. Existing project folders are not moved.",
  parameters: Schema.Struct({
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    setModelEffortDefault: ServerSettingsPatch.fields.setModelEffortDefault,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableAgentTerminals: ServerSettingsPatch.fields.enableAgentTerminals,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
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
const desktopCliCommandShared = {
  ...shared,
  dependencies: [...shared.dependencies, DesktopAppControl.DesktopAppControl],
  success: DesktopCliCommandStateSchema,
};
const CliCommandStatusTool = Tool.make("cli_command_status", {
  ...desktopCliCommandShared,
  description:
    "Read whether the Cogenly desktop app's `cogenly` command line tool is on PATH on this computer: installed (where, and which app it runs), stale (its app moved or was removed), foreign (a `cogenly` Cogenly did not write is in the way), or not installed, plus whether ~/.local/bin is on the login shell's PATH. Only works from an environment on the same computer as the desktop app.",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const CliCommandChangeTool = Tool.make("cli_command_change", {
  ...desktopCliCommandShared,
  description:
    "Install or uninstall the Cogenly desktop app's `cogenly` command line tool, as Settings does. Install writes a small launcher to ~/.local/bin (location `user`), or on macOS to /usr/local/bin (location `system`), which shows the user macOS's administrator prompt; omit location to use the state's recommendedLocation. Install updates a stale launcher. Never overwrites or removes a `cogenly` Cogenly did not write. Uninstall removes every launcher Cogenly wrote. Requires a live full-access/default calling thread; tell the user before a `system` change, since it asks for their password.",
  parameters: Schema.Struct({
    action: Schema.Literals(["install", "uninstall"]),
    location: Schema.optionalKey(DesktopCliCommandLocation),
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
export const EnvironmentToolkit = Toolkit.make(
  EnvironmentReadTool,
  EnvironmentPreferencesTool,
  EnvironmentAddTool,
  CliCommandStatusTool,
  CliCommandChangeTool,
  MachineSecurityStatusTool,
);
