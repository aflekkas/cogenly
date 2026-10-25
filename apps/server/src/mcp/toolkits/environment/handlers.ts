import {
  type MachineHealthError,
  OrchestratorMcpFailure,
  UNIVERSAL_CLIENT_PREFERENCE_KEYS,
  type ServerSettings,
} from "@cogenly/contracts";
import * as Struct from "effect/Struct";
import * as Effect from "effect/Effect";
import * as DesktopAppControl from "../../../environment/DesktopAppControl.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as MachineHealth from "../../../health/MachineHealth.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Settings from "../../../serverSettings.ts";
import * as MachineSecurity from "../../../security/MachineSecurity.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

export function preferences(settings: ServerSettings) {
  const {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableAgentTerminals,
    enableProviderUpdateChecks,
    useProviderConnectors,
    projectsRoot,
    modelEffortDefaults,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    ...Struct.pick(settings, UNIVERSAL_CLIENT_PREFERENCE_KEYS),
    sharedKeybindings: settings.sharedKeybindings,
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableAgentTerminals,
    enableProviderUpdateChecks,
    useProviderConnectors,
    projectsRoot,
    modelEffortDefaults,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
/** How an agent hears why the desktop app did not add the environment. */
export const addEnvironmentFailure = (error: DesktopAppControl.DesktopAppControlError) =>
  new OrchestratorMcpFailure({
    code:
      error._tag === "DesktopAppControlInvalidInputError"
        ? "invalid_request"
        : error._tag === "DesktopAppControlUnreachableError"
          ? "capability_denied"
          : "orchestration_error",
    message: error.message,
  });

const healthFailure = (error: MachineHealthError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "not-paired" ? "invalid_request" : "orchestration_error",
    message:
      error.reason === "not-paired"
        ? `${error.message} machines_list shows the paired machines.`
        : error.message,
  });
/** How an agent hears why the desktop app did not read or change its `cogenly` command. */
export const cliCommandFailure = (error: DesktopAppControl.DesktopAppControlError) =>
  error._tag === "DesktopAppControlUnreachableError"
    ? new OrchestratorMcpFailure({
        code: "capability_denied",
        message:
          "The cogenly command is installed by the Cogenly desktop app on the computer this agent runs on, and none answered here. Ask the user to open the desktop app and try again, or to use Settings → General → About → cogenly command.",
      })
    : addEnvironmentFailure(error);

const cliCommand = (input: {
  readonly action: "status" | "install" | "uninstall";
  readonly location?: "user" | "system" | undefined;
}) =>
  DesktopAppControl.DesktopAppControl.pipe(
    Effect.flatMap((control) => control.cliCommand(input)),
    Effect.mapError(cliCommandFailure),
  );

export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  cli_command_status: McpToolAccess.reads(() => cliCommand({ action: "status" })),
  // Writes a launcher into the user's own PATH folder; a /usr/local/bin install also
  // needs the user to approve macOS's admin prompt. Full-access work callers only.
  cli_command_change: McpToolAccess.writesEnvironmentAsWork((input) => cliCommand(input)),
  machine_security_status: McpToolAccess.reads(() =>
    MachineSecurity.MachineSecurity.pipe(Effect.flatMap((security) => security.status)),
  ),
  machine_health_fix: McpToolAccess.writesEnvironmentAsWork(() =>
    MachineHealth.MachineHealth.pipe(Effect.flatMap((health) => health.setupSandbox)),
  ),
  machine_health: McpToolAccess.reads((input) =>
    MachineHealth.MachineHealth.pipe(
      Effect.flatMap((health) => health.reportFor(input)),
      Effect.mapError(healthFailure),
    ),
  ),
  environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
      };
    }),
  ),
  // Adds a machine the user's own SSH config already reaches, to the user's own desktop app,
  // which shows it happening. Full-access work callers only, like project changes.
  environment_add: McpToolAccess.writesEnvironmentAsWork((input) =>
    DesktopAppControl.DesktopAppControl.pipe(
      Effect.flatMap((control) => control.addEnvironment(input)),
      Effect.map(({ environmentId, label }) => ({ environmentId, label })),
      Effect.mapError(addEnvironmentFailure),
    ),
  ),
  environment_preferences_update: McpToolAccess.writesEnvironmentAsWork((patch, check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const update = Effect.gen(function* () {
        // The turn may have ended, or the thread's modes changed, while this waited for the lock.
        yield* check;
        const { settings } = yield* access;
        return preferences(
          yield* settings.updateSettings(patch).pipe(Effect.mapError(unavailable)),
        );
      });
      // A thread caller serializes with its own turn; a client has no thread to lock.
      return yield* scope.thread === undefined
        ? update
        : executor.withLock(scope.thread.threadId, update);
    }),
  ),
});
