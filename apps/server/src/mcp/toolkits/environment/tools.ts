import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  DesktopCliCommandLocation,
  DesktopCliCommandStateSchema,
  ExecutionEnvironmentDescriptor,
  OrchestratorMcpFailure,
  ServerSettings,
  ServerSettingsPatch,
  StorageStatus,
  StorageCleanupReport,
  UniversalClientPreferenceValues,
  UniversalClientPreferencePatch,
} from "@cogenly/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import {
  EnvironmentId,
  MACHINE_HEALTH_FIX_MAX_ITEMS,
  MachineHealthFixResult,
  MachineHealthReport,
  MachineSecurityStatus,
  TrimmedNonEmptyString,
} from "@cogenly/contracts";
import * as DesktopAppControl from "../../../environment/DesktopAppControl.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as MachineHealth from "../../../health/MachineHealth.ts";
import * as MachineHealthFixes from "../../../health/MachineHealthFixes.ts";
import * as MachineSecurity from "../../../security/MachineSecurity.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as StorageCleanup from "../../../storageCleanup.ts";

const PreferenceFields = {
  ...UniversalClientPreferenceValues.fields,
  sharedKeybindings: ServerSettings.fields.sharedKeybindings,
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
    "Read server identity/preferences. projectsRoot, update checks and background activity are machine-local; others sync. Catalog: orchestrator_capabilities. Writing text caps at 4,000 chars.",
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
    "Update preferences; omitted fields stay. Requires full-access/default. Universal: thread defaults, model effort, worktree defaults, agent terminals, writing style, client preferences and keybindings. Machine-local: update checks, backgroundActivity, projectsRoot. Keybindings replace the ordered {key,command,when?} list; mod is the platform modifier. setModelEffortDefault uses {provider,model,option:{id,value}} from capabilities; option:null restores default. Empty customInstructions clears; empty projectsRoot restores <Cogenly home>/projects without moving existing folders.",
  parameters: Schema.Struct({
    ...UniversalClientPreferencePatch.fields,
    sharedKeybindings: ServerSettingsPatch.fields.sharedKeybindings,
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
    "Connect a server to the desktop over an SSH alias or user@host. Starts or installs Cogenly, pairs and saves it; may take minutes. Requires full-access/default and a desktop on this machine.",
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
    "Read local desktop launcher status: installed, stale, foreign or missing, its app/path, ~/.local/bin login-PATH availability and recommendedLocation. Requires a desktop on this machine.",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const CliCommandChangeTool = Tool.make("cli_command_change", {
  ...desktopCliCommandShared,
  description:
    "Install/update or uninstall Cogenly-owned launchers only. Install defaults to recommendedLocation: user (~/.local/bin) or macOS system (/usr/local/bin, administrator prompt). Tell the user before system changes. Uninstall removes all owned launchers. Requires full-access/default.",
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
    "Inspect bind/listeners, readable sshd/firewall settings and Tailscale Serve/Funnel. Checks needing root return unknown, never pass.",
  success: MachineSecurityStatus,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const MachineHealthTool = Tool.make("machine_health", {
  ...shared,
  dependencies: [...shared.dependencies, MachineHealth.MachineHealth],
  description:
    "Read machine health and suggested fixes. Omit environmentId for this machine; paired IDs come from machines_list. reachable:false means the peer did not answer. Apply supported fixes with machine_health_fix on their owning machine.",
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
const MachineHealthFixTool = Tool.make("machine_health_fix", {
  ...shared,
  dependencies: [
    ...shared.dependencies,
    MachineHealth.MachineHealth,
    MachineHealthFixes.MachineHealthFixes,
  ],
  description:
    "Apply machine_health fixes: stop-runs (legacy resume), run-now, retry-sync, setup-sandbox, or discard-quarantined. Omitted itemKeys fixes all actionable items except discard-quarantined, which needs its explicit key and preserves local data. Manual/sign-in items need investigation. Recheck machine_health afterward.",
  parameters: Schema.Struct({
    environmentId: Schema.optionalKey(
      EnvironmentId.annotate({
        description: "A paired machine's environment ID from machines_list. Omit for this machine.",
      }),
    ),
    itemKeys: Schema.optionalKey(
      Schema.Array(TrimmedNonEmptyString)
        .check(Schema.isMinLength(1), Schema.isMaxLength(MACHINE_HEALTH_FIX_MAX_ITEMS))
        .annotate({ description: "Item `key`s from machine_health for that machine." }),
    ),
  }),
  success: MachineHealthFixResult,
})
  .annotate(Tool.Readonly, false)
  // stop-runs interrupts turns and subagents.
  .annotate(Tool.Destructive, true);
const StorageStatusTool = Tool.make("storage_status", {
  ...shared,
  dependencies: [...shared.dependencies, StorageCleanup.StorageCleanup],
  description:
    "Read volume/database usage and worktree/dependency/artifact/log/backup counts. APFS/reflink category bytes are null to avoid double-counting shared blocks. Does not follow symlinks.",
  success: StorageStatus,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const StorageCleanupTool = Tool.make("storage_cleanup", {
  ...shared,
  dependencies: [...shared.dependencies, StorageCleanup.StorageCleanup],
  description:
    "Preview cleanup (dryRun:true default), or safely remove eligible worktrees/expired artifacts/logs. Keeps branches/checkpoints; reports blockers. Execution rechecks advisory preview safety.",
  parameters: Schema.Struct({ dryRun: Schema.optionalKey(Schema.Boolean) }),
  success: StorageCleanupReport,
}).annotate(Tool.Destructive, true);

export const EnvironmentToolkit = Toolkit.make(
  StorageStatusTool,
  StorageCleanupTool,
  EnvironmentReadTool,
  EnvironmentPreferencesTool,
  EnvironmentAddTool,
  CliCommandStatusTool,
  CliCommandChangeTool,
  MachineSecurityStatusTool,
  MachineHealthTool,
  MachineHealthFixTool,
);
