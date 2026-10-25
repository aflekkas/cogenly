import {
  DEFAULT_CLIENT_SETTINGS,
  UNIVERSAL_CLIENT_PREFERENCE_KEYS,
  UNIVERSAL_CLIENT_SETTING_BINDINGS,
  type ClientSettings,
  type EnvironmentId,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@cogenly/contracts";
import type * as Schema from "effect/Schema";
import {
  DEFAULT_APPEARANCE_PREFERENCES,
  type AppearancePreferences,
} from "./appearancePreferences";
import { DEFAULT_APPEARANCE_MODE, type AppearanceMode } from "./theme";

type PreferenceKey = (typeof UNIVERSAL_CLIENT_PREFERENCE_KEYS)[number];
type PreferenceValues = Record<PreferenceKey, Schema.Json>;
export type ClientPreferenceSyncBase = ReadonlyMap<
  PreferenceKey,
  {
    readonly local: Schema.Json;
    readonly remote: Schema.Json | null;
    readonly pending?: Schema.Json;
    readonly pendingFrom?: Schema.Json;
    readonly pendingMigration?: boolean;
    readonly applyingFrom?: Schema.Json;
  }
>;

/** The portable fields, using the same independent keys as the shared document. */
export function clientPreferenceValues(
  client: ClientSettings,
  appearance: AppearancePreferences,
  mode: AppearanceMode,
): PreferenceValues {
  return {
    ...Object.fromEntries(
      Object.entries(UNIVERSAL_CLIENT_SETTING_BINDINGS).map(([key, shared]) => [
        shared,
        client[key as keyof typeof UNIVERSAL_CLIENT_SETTING_BINDINGS],
      ]),
    ),
    clientAppearanceMode: mode,
    clientAppearanceAccent: appearance.accent,
    clientAppearanceFontSize: appearance.fontSize,
    clientAppearanceMotion: appearance.motion,
    clientAppearanceUsageMeter: appearance.usageMeter,
  } as PreferenceValues;
}

const defaults = clientPreferenceValues(
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_APPEARANCE_PREFERENCES,
  DEFAULT_APPEARANCE_MODE,
);
const same = (a: Schema.Json | undefined, b: Schema.Json | undefined) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Legacy customizations seed only unset fields. Untouched defaults never publish,
 * so a new client cannot replace another machine's preferences before sync arrives.
 * Pending writes keep a stale server snapshot from briefly reverting a local edit.
 */
export function planClientPreferenceSync(
  local: PreferenceValues,
  shared: ServerSettings,
  previous: ClientPreferenceSyncBase,
  retryPending = false,
) {
  const apply: Partial<PreferenceValues> = {};
  const publish: Partial<PreferenceValues> = {};
  const migrate: Partial<PreferenceValues> = {};
  const next = new Map(previous);
  for (const key of UNIVERSAL_CLIENT_PREFERENCE_KEYS) {
    const value = local[key];
    const remote = shared[key] ?? null;
    const before = previous.get(key);
    if (before?.applyingFrom !== undefined && same(value, before.applyingFrom)) {
      next.set(key, before);
    } else if (before && !same(value, before.local)) {
      publish[key] = value;
      next.set(key, { local: value, remote, pending: value, pendingFrom: before.local });
    } else if (
      before?.pending !== undefined &&
      (retryPending || same(remote, before.remote)) &&
      (!before.pendingMigration || remote === null) &&
      !same(remote, before.pending)
    ) {
      if (retryPending) {
        if (before.pendingMigration) migrate[key] = before.pending;
        else publish[key] = before.pending;
      }
      next.set(key, retryPending ? { ...before, remote } : before);
    } else if (remote !== null) {
      if (!same(value, remote)) apply[key] = remote;
      next.set(key, {
        local: remote,
        remote,
        ...(same(value, remote) ? {} : { applyingFrom: value }),
      });
    } else if (!before && !same(value, defaults[key])) {
      migrate[key] = value;
      next.set(key, {
        local: value,
        remote,
        pending: value,
        pendingFrom: value,
        pendingMigration: true,
      });
    } else {
      next.set(key, { local: value, remote });
    }
  }
  const patch = {
    ...publish,
    ...(Object.keys(migrate).length ? { migrateClientPreferences: migrate } : {}),
  } as ServerSettingsPatch;
  return { apply, patch, next };
}

export interface ClientPreferenceConnectionState {
  readonly environmentId: EnvironmentId | null;
  readonly connected: boolean;
  readonly values: ClientPreferenceSyncBase;
}

/** Reconcile client caches with the currently connected destination. */
export function planClientPreferenceConnectionSync(
  local: PreferenceValues,
  shared: ServerSettings | undefined,
  environmentId: EnvironmentId | null,
  previous: ClientPreferenceConnectionState,
) {
  // A missing destination means a temporary disconnect, not a new account.
  // Keep both the last agreement and any unacknowledged local write.
  if (!shared || environmentId === null)
    return {
      apply: {} as Partial<PreferenceValues>,
      patch: {} as ServerSettingsPatch,
      next: { ...previous, connected: false },
    };
  const sameEnvironment = previous.environmentId === environmentId;
  const values = sameEnvironment ? previous.values : new Map();
  const plan = planClientPreferenceSync(
    local,
    shared,
    values,
    sameEnvironment && !previous.connected,
  );
  return { ...plan, next: { environmentId, connected: true, values: plan.next } };
}

/** Convert received shared fields back into the existing local cache's patch. */
export function clientSettingsPatchFromPreferences(values: Partial<PreferenceValues>) {
  return Object.fromEntries(
    Object.entries(UNIVERSAL_CLIENT_SETTING_BINDINGS).flatMap(([local, shared]) =>
      values[shared] === undefined ? [] : [[local, values[shared]]],
    ),
  ) as Partial<ClientSettings>;
}

/** Rejected or unsupported writes restore the confirmed value without retry loops. */
export function settleClientPreferenceWrite(
  previous: ClientPreferenceSyncBase,
  patch: ServerSettingsPatch,
  acknowledged: ServerSettings | null,
  attemptedBase: ClientPreferenceSyncBase = previous,
) {
  const next = new Map(previous);
  const apply: Partial<PreferenceValues> = {};
  let rejected = acknowledged === null;
  for (const key of UNIVERSAL_CLIENT_PREFERENCE_KEYS) {
    const explicit = patch[key];
    const attempted = explicit ?? patch.migrateClientPreferences?.[key];
    const before = previous.get(key);
    if (
      attempted === undefined ||
      !before ||
      attemptedBase.get(key) !== before ||
      !same(before.pending, attempted)
    )
      continue;
    const confirmed = acknowledged?.[key] ?? null;
    if (acknowledged !== null && same(confirmed, attempted)) continue;
    if (explicit !== undefined || confirmed === null) rejected = true;
    const rollback = confirmed ?? before.remote ?? before.pendingFrom ?? before.local;
    if (!same(before.local, rollback)) apply[key] = rollback;
    next.set(key, {
      local: rollback,
      remote: confirmed,
      ...(same(before.local, rollback) ? {} : { applyingFrom: before.local }),
    });
  }
  return { next, apply, rejected };
}
