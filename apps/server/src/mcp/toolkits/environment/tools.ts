import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
  OrchestratorMcpFailure,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as DesktopAppControl from "../../../environment/DesktopAppControl.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
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
const EnvironmentReadTool = Tool.make("t3_environment_read", {
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
const EnvironmentPreferencesTool = Tool.make("t3_environment_preferences_update", {
  ...shared,
  description:
    "Update selected environment-wide preferences through normal settings persistence and notifications. Requires a live full-access/default calling thread. Omitted fields are preserved; empty customInstructions clears them. setModelEffortDefault sets the reasoning effort a model starts at ({ provider: instance id, model: slug, option: { id: the model's effort option id from orchestrator_capabilities, e.g. reasoningEffort or effort, value } }); option null restores the model's own default.",
  parameters: Schema.Struct({
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    setModelEffortDefault: ServerSettingsPatch.fields.setModelEffortDefault,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableAgentTerminals: ServerSettingsPatch.fields.enableAgentTerminals,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
  }),
  success: Schema.Struct(PreferenceFields),
}).annotate(Tool.Destructive, true);
const EnvironmentAddTool = Tool.make("t3_environment_add", {
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
export const EnvironmentToolkit = Toolkit.make(
  EnvironmentReadTool,
  EnvironmentPreferencesTool,
  EnvironmentAddTool,
);
