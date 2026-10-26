import {
  ClientSettingsSchema,
  type ClientSettingsPatch,
  type EnvironmentId,
  isUniversalServerSettingKey,
  ServerSettings,
  type ServerSettingsPatch,
} from "@cogenly/contracts";
import type { EnvironmentConnectionPhase } from "@cogenly/client-runtime/connection";
import { resolveWorktreeCleanup } from "@cogenly/shared/projectSettings";
import * as Equal from "effect/Equal";
import * as Cause from "effect/Cause";

import type { ResolvedSettingsScope } from "./settingsScope";

export type ScopedSettingsPatch = ServerSettingsPatch & ClientSettingsPatch;

interface ScopedSettingsEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: { readonly settings: ServerSettings } | null;
}

const SERVER_KEYS = new Set<string>(Object.keys(ServerSettings.fields));
const CLIENT_KEYS = new Set<string>(Object.keys(ClientSettingsSchema.fields));

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConnected<T extends ScopedSettingsEnvironment>(environment: T) {
  return environment.connection.phase === "connected" && environment.serverConfig !== null;
}

/**
 * The representative supplies display values, never the set of write targets.
 * It is the scope's machine when connected: universal settings read the same
 * everywhere, and machine-local ones belong to that machine.
 */
export function selectScopedSettingsEnvironments<T extends ScopedSettingsEnvironment>(
  scope: ResolvedSettingsScope,
  available: readonly T[],
  primaryEnvironmentId: EnvironmentId | null,
) {
  const selectedIds = new Set(scope.environmentIds);
  const environments = available.filter((environment) =>
    selectedIds.has(environment.environmentId),
  );
  const connectedEnvironments = environments.filter(isConnected);
  const environment =
    connectedEnvironments.find((candidate) => candidate.environmentId === scope.machineId) ??
    connectedEnvironments.find((candidate) => candidate.environmentId === primaryEnvironmentId) ??
    connectedEnvironments[0] ??
    null;
  return { environments, connectedEnvironments, environment };
}

/** One environment the scope reads, with its settings. */
export interface ScopedSettingsTarget {
  readonly environmentId: EnvironmentId;
  /** The environment's label. */
  readonly label: string;
  readonly settings: ServerSettings;
}

/** The scope's machine when connected, else the first connected environment. */
export function resolveScopedSettingsTargets(
  scope: ResolvedSettingsScope,
  connectedEnvironments: readonly ScopedSettingsEnvironment[],
): readonly ScopedSettingsTarget[] {
  const machine =
    connectedEnvironments.find((environment) => environment.environmentId === scope.machineId) ??
    connectedEnvironments[0];
  return machine?.serverConfig
    ? [
        {
          environmentId: machine.environmentId,
          label: machine.label,
          settings: machine.serverConfig.settings,
        },
      ]
    : [];
}

/** A machine-local editor must not fall back to another machine's values or write targets. */
export function selectMachineLocalSettingsTargets<
  T extends { readonly environmentId: EnvironmentId },
>(scope: ResolvedSettingsScope, targets: readonly T[]): readonly T[] {
  return targets.filter((target) => target.environmentId === scope.machineId);
}

interface ScopedServerWrite {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly patch: ServerSettingsPatch;
  /** The environment's settings before the write, to tell a dropped key from a saved one. */
  readonly previous: ServerSettings;
}

/**
 * A storage cleanup edit also updates a machine whose worktree cleanup is
 * stored in the newer `worktreeCleanup` shape, so the two never disagree.
 */
function withWorktreeCleanupMirror(
  previous: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettingsPatch {
  if (
    previous.worktreeCleanup == null ||
    !patch.storageCleanup ||
    !Object.keys(patch.storageCleanup).some((key) => key.startsWith("worktree"))
  ) {
    return patch;
  }
  return {
    ...patch,
    worktreeCleanup: {
      mode: "custom",
      rules: {
        ...resolveWorktreeCleanup(previous),
        ...Object.fromEntries(
          Object.entries(patch.storageCleanup).filter(([key]) => key.startsWith("worktree")),
        ),
      },
    },
  };
}

/**
 * Universal keys go to every connected environment (paired machines sync them
 * too, which covers offline ones) and machine-local keys to the scope's
 * machine only. A write that cannot reach the machine it names is refused
 * whole. Client keys always persist locally.
 */
export function planScopedSettingsPatch(
  scope: ResolvedSettingsScope,
  environments: readonly ScopedSettingsEnvironment[],
  patch: ScopedSettingsPatch,
) {
  const clientPatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => CLIENT_KEYS.has(key) && !SERVER_KEYS.has(key)),
  ) as ClientSettingsPatch;
  const serverPatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => SERVER_KEYS.has(key)),
  ) as ServerSettingsPatch;
  const serverKeys = Object.keys(serverPatch);
  const machineId = scope.kind === "environment" ? scope.environmentId : scope.machineId;
  const machine = environments.find((environment) => environment.environmentId === machineId);
  const machineUnreachable =
    serverKeys.some((key) => !isUniversalServerSettingKey(key)) &&
    !(machine && isConnected(machine));
  const serverWrites: ScopedServerWrite[] =
    serverKeys.length === 0 || scope.kind === "unavailable" || machineUnreachable
      ? []
      : environments.filter(isConnected).flatMap((environment) => {
          const previous = environment.serverConfig?.settings;
          if (!previous) return [];
          const environmentPatch = Object.fromEntries(
            Object.entries(serverPatch).filter(
              ([key]) =>
                isUniversalServerSettingKey(key) || environment.environmentId === machineId,
            ),
          ) as ServerSettingsPatch;
          if (Object.keys(environmentPatch).length === 0) return [];
          return [
            {
              environmentId: environment.environmentId,
              label: environment.label,
              previous,
              patch: withWorktreeCleanupMirror(previous, environmentPatch),
            },
          ];
        });
  const hasClientWrite = Object.keys(clientPatch).length > 0;
  const hasWrite = hasClientWrite || serverWrites.length > 0;
  const unavailableReason =
    hasWrite || Object.keys(patch).length === 0
      ? null
      : scope.kind === "unavailable"
        ? scope.message
        : `Connect ${machineUnreachable ? (machine?.label ?? "the machine") : "a machine"} to save this setting.`;
  return { clientPatch, hasClientWrite, serverWrites, unavailableReason };
}

/**
 * Whether a server kept `before` where `value` asked for a change. Objects are
 * compared field by field, so a nested key an older server dropped is caught
 * even when a sibling field saved. A null clears the field; strings may come
 * back trimmed.
 */
function writeWasDropped(value: unknown, before: unknown, saved: unknown): boolean {
  if (value === null) return before != null && Equal.equals(saved, before);
  if (isPlainObject(value) && !Array.isArray(before) && !Array.isArray(saved)) {
    const field = (source: unknown, key: string) =>
      isPlainObject(source) ? source[key] : undefined;
    return Object.entries(value).some(([key, next]) =>
      writeWasDropped(next, field(before, key), field(saved, key)),
    );
  }
  const unchanged =
    typeof value === "string" && typeof before === "string"
      ? value.trim() === before
      : Equal.equals(value, before);
  return !unchanged && Equal.equals(saved, before);
}

/**
 * An older server drops keys it does not know, top-level or nested, and still
 * succeeds. Left unreported, the row would show a value that never saved.
 */
function droppedSettingKeys(write: ScopedServerWrite, saved: ServerSettings | undefined) {
  if (saved === undefined) return [];
  return Object.entries(write.patch).flatMap(([key, value]) =>
    writeWasDropped(
      value,
      write.previous[key as keyof ServerSettings],
      saved[key as keyof ServerSettings],
    )
      ? [key]
      : [],
  );
}

/** Wait for every target so a failed environment does not hide successful or later writes. */
export async function persistScopedSettingsPatch(
  plan: ReturnType<typeof planScopedSettingsPatch>,
  persistServer: (input: {
    environmentId: EnvironmentId;
    input: { patch: ServerSettingsPatch };
  }) => Promise<{
    readonly _tag: "Success" | "Failure";
    readonly cause?: Cause.Cause<unknown>;
    readonly value?: ServerSettings;
  }>,
  persistClient: (patch: ClientSettingsPatch) => void,
) {
  if (plan.hasClientWrite) persistClient(plan.clientPatch);
  const results = await Promise.allSettled(
    plan.serverWrites.map(({ environmentId, patch }) =>
      persistServer({ environmentId, input: { patch } }),
    ),
  );
  const saved = (index: number) => {
    const result = results[index];
    return (
      result?.status === "fulfilled" &&
      result.value._tag === "Success" &&
      droppedSettingKeys(plan.serverWrites[index]!, result.value.value).length === 0
    );
  };
  const failedEnvironments = plan.serverWrites.flatMap((environment, index) => {
    if (saved(index)) return [];
    const result = results[index];
    if (result?.status === "fulfilled" && result.value._tag === "Success") {
      return [
        {
          ...environment,
          message: "This machine does not support this setting. Update Cogenly on it.",
        },
      ];
    }
    const error: unknown =
      result?.status === "rejected"
        ? result.reason
        : result?.status === "fulfilled" && result.value.cause
          ? Cause.squash(result.value.cause)
          : undefined;
    return [
      {
        ...environment,
        message:
          error instanceof Error
            ? error.message
            : "The save failed. Try reconnecting and saving again.",
      },
    ];
  });
  const savedEnvironments = plan.serverWrites.filter((_, index) => saved(index));
  return {
    failedEnvironments,
    savedEnvironments,
    savedEnvironmentCount: savedEnvironments.length,
  };
}
