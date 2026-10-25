import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { DesktopCliCommandLocation, DesktopCliCommandStateSchema } from "./cliCommand.ts";

export const DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION = 1 as const;

export const DesktopAppActivationPlatform = Schema.Literals(["darwin", "linux", "win32"]);
export type DesktopAppActivationPlatform = typeof DesktopAppActivationPlatform.Type;

/** `cogenly app`: open a project folder in a new thread. */
export const DesktopAppOpenWorkspaceRequest = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  type: Schema.Literal("open-workspace"),
  workspaceRoot: TrimmedNonEmptyString,
  platform: DesktopAppActivationPlatform,
});
export type DesktopAppOpenWorkspaceRequest = typeof DesktopAppOpenWorkspaceRequest.Type;

/**
 * `cogenly environment add`, `environment_add`, or a confirmed
 * `cogenly://environments/add` link: connect an SSH host and save it. The
 * desktop checks `ssh` and `name` with `parseAddEnvironmentRequest` from
 * `@cogenly/shared/environmentLinks`.
 */
export const DesktopAppAddEnvironmentRequest = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  type: Schema.Literal("add-environment"),
  ssh: TrimmedNonEmptyString,
  name: Schema.optionalKey(TrimmedNonEmptyString),
});
export type DesktopAppAddEnvironmentRequest = typeof DesktopAppAddEnvironmentRequest.Type;

/**
 * `machine_pair`: pair two machines the desktop app is connected to, the same
 * way Settings → Machines → Add a machine does. Servers hold no credential
 * for each other before pairing, so the app that is signed in to both runs
 * it, and the one-time join code stays inside the app. `hub` and `joining`
 * name a connection by environment id or by its name.
 */
export const DesktopAppPairMachinesRequest = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  type: Schema.Literal("pair-machines"),
  hub: TrimmedNonEmptyString,
  joining: TrimmedNonEmptyString,
});
export type DesktopAppPairMachinesRequest = typeof DesktopAppPairMachinesRequest.Type;

/**
 * `cli_command_status` and `cli_command_change`: read, install, or uninstall the
 * desktop app's `cogenly` command, as Settings does. The app's main process
 * answers; the window is not involved.
 */
export const DesktopAppCliCommandRequest = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  type: Schema.Literal("cli-command"),
  action: Schema.Literals(["status", "install", "uninstall"]),
  location: Schema.optionalKey(DesktopCliCommandLocation),
});
export type DesktopAppCliCommandRequest = typeof DesktopAppCliCommandRequest.Type;

/** The requests the desktop window handles. */
export const DesktopAppRendererRequest = Schema.Union([
  DesktopAppOpenWorkspaceRequest,
  DesktopAppAddEnvironmentRequest,
  DesktopAppPairMachinesRequest,
]);
export type DesktopAppRendererRequest = typeof DesktopAppRendererRequest.Type;

export const DesktopAppActivationRequest = Schema.Union([
  DesktopAppOpenWorkspaceRequest,
  DesktopAppAddEnvironmentRequest,
  DesktopAppPairMachinesRequest,
  DesktopAppCliCommandRequest,
]);
export type DesktopAppActivationRequest = typeof DesktopAppActivationRequest.Type;

export const DesktopAppActivationErrorCode = Schema.Literals([
  "invalid-request",
  "renderer-unavailable",
  "environment-unavailable",
  "platform-mismatch",
  "project-create-failed",
  "thread-open-failed",
  "environment-add-failed",
  "machines-pair-failed",
  "cli-command-failed",
  "request-timeout",
  "internal-error",
]);
export type DesktopAppActivationErrorCode = typeof DesktopAppActivationErrorCode.Type;

export const DesktopAppActivationSuccess = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(true),
  projectId: ProjectId,
  threadId: ThreadId,
});
export type DesktopAppActivationSuccess = typeof DesktopAppActivationSuccess.Type;

export const DesktopAppEnvironmentAdded = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(true),
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
});
export type DesktopAppEnvironmentAdded = typeof DesktopAppEnvironmentAdded.Type;

export const DesktopAppPairedMachine = Schema.Struct({
  environmentId: EnvironmentId,
  name: TrimmedNonEmptyString,
});
export type DesktopAppPairedMachine = typeof DesktopAppPairedMachine.Type;

/** `pair-machines` finished: `joining` now syncs with `hub`. */
export const DesktopAppMachinesPaired = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(true),
  hub: DesktopAppPairedMachine,
  joining: DesktopAppPairedMachine,
});
export type DesktopAppMachinesPaired = typeof DesktopAppMachinesPaired.Type;

/** `cli-command` finished: the command's state after the action. */
export const DesktopAppCliCommandResult = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(true),
  cliCommand: DesktopCliCommandStateSchema,
});
export type DesktopAppCliCommandResult = typeof DesktopAppCliCommandResult.Type;

export const DesktopAppActivationFailure = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(false),
  code: DesktopAppActivationErrorCode,
  message: TrimmedNonEmptyString,
});
export type DesktopAppActivationFailure = typeof DesktopAppActivationFailure.Type;

export const DesktopAppActivationResponse = Schema.Union([
  DesktopAppActivationSuccess,
  DesktopAppEnvironmentAdded,
  DesktopAppMachinesPaired,
  DesktopAppCliCommandResult,
  DesktopAppActivationFailure,
]);
export type DesktopAppActivationResponse = typeof DesktopAppActivationResponse.Type;
