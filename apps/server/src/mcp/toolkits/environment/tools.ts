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
  MachineHealthFixAction,
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
    "Update selected preferences through normal settings persistence and notifications. Requires a live full-access/default calling thread. defaultThreadEnvMode, setModelEffortDefault, newWorktreesStartFromOrigin, enableAgentTerminals and sourceControlWritingStyle are universal: they reach every paired machine. The client-prefixed appearance, notifications, confirmation, composer, sidebar and diff preferences, and sharedKeybindings, are universal too. sharedKeybindings is the complete ordered list of { key, command, when? } rules; use mod for the platform modifier. enableProviderUpdateChecks, backgroundActivity and projectsRoot apply to this machine only. Omitted fields are preserved; empty customInstructions clears them. setModelEffortDefault sets the reasoning effort a model starts at ({ provider: instance id, model: slug, option: { id: the model's effort option id from orchestrator_capabilities, e.g. reasoningEffort or effort, value } }); option null restores the model's own default. projectsRoot sets where new project folders and their repositories go on this machine; empty restores the default, <Cogenly home>/projects. Existing project folders are not moved.",
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
const MachineHealthTool = Tool.make("machine_health", {
  ...shared,
  dependencies: [...shared.dependencies, MachineHealth.MachineHealth],
  description:
    "Health of a Cogenly machine: server, database, disk, provider sign-ins, links to paired machines, sync, integrations, scheduled tasks, stuck runs, boot service, Tailscale Serve and the canary. Each check has a status (ok, warn, fail, unknown when it could not run), a summary and the items worth attention, with a suggested fix where there is one. Items with a fix (stop-runs, run-now, retry-sync, setup-sandbox) are fixed with machine_health_fix, which runs on the machine that has them. With the machine's \"Fix problems automatically\" setting on (the default), it already applies update-machine, retry-sync and stop-runs (sparing runs with a live session) on its own and only alerts when that fails. Omit environmentId for this machine; give a paired machine's (from machines_list) to read its report over the peer link. reachable false means that machine did not answer and the report describes what this one saw.",
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
    "Run the direct fix for machine_health items, on the machine they are on (a paired machine runs it over the peer link). Fixes by item `fix`: stop-runs (and legacy resume) stops the thread's stale turn and subagents and marks dead ones interrupted, even with no live provider session; run-now runs the scheduled task; discard-quarantined discards only held incoming changes for the named thread, preserving local data; retry-sync retries transient sync failures with the target machine; setup-sandbox installs bubblewrap with root or passwordless sudo, or returns the command to run. Items whose fix is sign-in or null come back `manual` (a sign-in provider the owner doesn't want on that machine can be turned off with action turn-off-provider): investigate those yourself with machine_health and the thread, integration or provider tools. Omit itemKeys to fix every item that has a direct fix except discard-quarantined, which requires the named item key. Run machine_health afterwards to see current health.",
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
    action: Schema.optionalKey(
      MachineHealthFixAction.annotate({
        description:
          "fix (default) runs each item's fix. turn-off-provider turns off the provider of each named sign-in item on that machine only, when the owner would rather not sign it in there; it stays on for their other machines. Requires itemKeys.",
      }),
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
    "Read actual volume usage and available space, database file size, and file counts for agent and user worktrees, dependencies, dev data, browser artifacts, logs and backups. On APFS or reflink filesystems, per-category bytes are null because directory sizes overcount shared blocks. Does not follow symlinks.",
  success: StorageStatus,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const StorageCleanupTool = Tool.make("storage_cleanup", {
  ...shared,
  dependencies: [...shared.dependencies, StorageCleanup.StorageCleanup],
  description:
    "Preview or run this environment's configured storage cleanup. dryRun defaults to true and changes nothing; pass false to remove only eligible, safely preserved worktrees and expired artifacts/logs. Branches and checkpoints are kept. Kept entries explain blockers such as unsaved changes or running processes. Preview is advisory: execution rechecks safety.",
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
