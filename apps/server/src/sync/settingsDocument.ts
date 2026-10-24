/**
 * Shared `settings` documents. `universal` holds the keys in
 * `UNIVERSAL_SERVER_SETTING_KEYS` as their JSON encoding. `project:<label id>`
 * holds one project's overrides: each key is `null` (inherit) or
 * `{ value }`, so an override whose value is itself null stays expressible.
 *
 * @module settingsDocument
 */
import {
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  ProjectSettingsOverrides,
  ServerSettings,
  SharedStateError,
  UNIVERSAL_SERVER_SETTING_KEYS,
  type UniversalServerSettingKey,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const UNIVERSAL_SETTINGS_DOCUMENT_ID = "universal";
const PROJECT_DOCUMENT_PREFIX = "project:";

export const projectSettingsDocumentId = (labelId: string) =>
  `${PROJECT_DOCUMENT_PREFIX}${labelId}`;

/** Every key a project override entry can hold. */
export const PROJECT_SETTINGS_SYNC_KEYS = [
  ...PROJECT_SCOPED_SERVER_SETTING_KEYS,
  "providerInstances",
] as const satisfies ReadonlyArray<keyof ProjectSettingsOverrides>;
export type ProjectSettingsSyncKey = (typeof PROJECT_SETTINGS_SYNC_KEYS)[number];

type UniversalSettings = Pick<ServerSettings, UniversalServerSettingKey>;

const UniversalSettingsJson = Schema.toCodecJson(
  Schema.Struct(
    Object.fromEntries(
      UNIVERSAL_SERVER_SETTING_KEYS.map((key) => [key, ServerSettings.fields[key]]),
    ) as Pick<typeof ServerSettings.fields, UniversalServerSettingKey>,
  ),
);
const UniversalPartialJson = Schema.toCodecJson(
  Schema.Struct(
    Object.fromEntries(
      UNIVERSAL_SERVER_SETTING_KEYS.map((key) => [
        key,
        Schema.optionalKey(ServerSettings.fields[key]),
      ]),
    ),
  ),
);
const OverridesJson = Schema.toCodecJson(ProjectSettingsOverrides);
const encodeUniversal = Schema.encodeSync(UniversalSettingsJson);
const decodeUniversalPartial = Schema.decodeUnknownSync(UniversalPartialJson);
const encodeOverrides = Schema.encodeSync(OverridesJson);
const decodeOverrides = Schema.decodeUnknownSync(OverridesJson);
const validateUniversalPartial = Schema.decodeUnknownEffect(UniversalPartialJson);
const validateOverrides = Schema.decodeUnknownEffect(OverridesJson);

/** The universal keys' JSON values; an encoding that omits null reads as null. */
export function encodeUniversalSettings(
  settings: ServerSettings,
): Record<UniversalServerSettingKey, Schema.Json> {
  const picked = Object.fromEntries(
    UNIVERSAL_SERVER_SETTING_KEYS.map((key) => [key, settings[key]]),
  ) as UniversalSettings;
  const encoded = encodeUniversal(picked) as Record<string, Schema.Json>;
  return Object.fromEntries(
    UNIVERSAL_SERVER_SETTING_KEYS.map((key) => [key, encoded[key] ?? null]),
  ) as Record<UniversalServerSettingKey, Schema.Json>;
}

/** Decodes one universal key's JSON value; undefined when this build cannot read it. */
export function decodeUniversalSetting<K extends UniversalServerSettingKey>(
  key: K,
  value: Schema.Json,
): ServerSettings[K] | undefined {
  try {
    const decoded = decodeUniversalPartial({ [key]: value }) as Partial<UniversalSettings>;
    return Object.hasOwn(decoded, key) ? (decoded[key] as ServerSettings[K]) : undefined;
  } catch {
    return undefined;
  }
}

/** An override entry as `null | { value }` per key, the shape a project document stores. */
export function encodeProjectOverrides(
  entry: ProjectSettingsOverrides | undefined,
): Record<ProjectSettingsSyncKey, Schema.Json> {
  const encoded = encodeOverrides(entry ?? {}) as Record<string, Schema.Json | undefined>;
  return Object.fromEntries(
    PROJECT_SETTINGS_SYNC_KEYS.map((key) => {
      const value = encoded[key];
      return [key, value === undefined ? null : { value }];
    }),
  ) as Record<ProjectSettingsSyncKey, Schema.Json>;
}

/** The override entry a project document's fields describe; undecodable keys are left out. */
export function decodeProjectOverrides(
  fields: Readonly<Record<string, Schema.Json>>,
): ProjectSettingsOverrides {
  const entry: Record<string, Schema.Json> = {};
  for (const key of PROJECT_SETTINGS_SYNC_KEYS) {
    const field = fields[key];
    if (field === null || field === undefined || typeof field !== "object" || Array.isArray(field))
      continue;
    if (!Object.hasOwn(field, "value")) continue;
    const value = (field as { readonly value: Schema.Json }).value;
    try {
      Object.assign(entry, decodeOverrides({ [key]: value }));
    } catch {
      // A value this build cannot read stays in the document, unapplied.
    }
  }
  return entry as ProjectSettingsOverrides;
}

const PROJECT_KEYS: ReadonlySet<string> = new Set(PROJECT_SETTINGS_SYNC_KEYS);

/** Reject unknown ids, unknown keys and values the settings schemas refuse. */
export const validateSettingsFields = (id: string, fields: Readonly<Record<string, Schema.Json>>) =>
  Effect.gen(function* () {
    const invalid = (cause?: unknown) =>
      new SharedStateError({ reason: "invalid-document", cause });
    if (id === UNIVERSAL_SETTINGS_DOCUMENT_ID) {
      yield* validateUniversalPartial(fields, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(invalid));
      return;
    }
    if (!id.startsWith(PROJECT_DOCUMENT_PREFIX) || id.length === PROJECT_DOCUMENT_PREFIX.length)
      return yield* invalid();
    const entry: Record<string, Schema.Json> = {};
    for (const [key, field] of Object.entries(fields)) {
      if (!PROJECT_KEYS.has(key)) return yield* invalid();
      if (field === null) continue;
      if (
        typeof field !== "object" ||
        Array.isArray(field) ||
        Object.keys(field).length !== 1 ||
        !Object.hasOwn(field, "value")
      )
        return yield* invalid();
      entry[key] = (field as { readonly value: Schema.Json }).value;
    }
    yield* validateOverrides(entry, { onExcessProperty: "error" }).pipe(Effect.mapError(invalid));
  });
