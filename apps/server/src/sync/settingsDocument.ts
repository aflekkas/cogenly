/**
 * Shared settings documents. The `settings` document `universal` holds the
 * keys in `UNIVERSAL_SERVER_SETTING_KEYS` as their JSON encoding. A
 * `project-settings` document, id the project folder id, holds that
 * project's overrides: each key is `null` (inherit) or `{ value }`, so an
 * override whose value is itself null stays expressible.
 *
 * @module settingsDocument
 */
import {
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  isMachineLocalProjectSettingKey,
  ProjectSettingsOverrides,
  ServerSettings,
  UNIVERSAL_SERVER_SETTING_KEYS,
  type UniversalServerSettingKey,
} from "@cogenly/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const UNIVERSAL_SETTINGS_DOCUMENT_ID = "universal";
const PROJECT_KEY_PREFIX = "project:";

/** SettingsSync's own key for a project's document, in plans and the base table. */
export const projectSettingsDocumentId = (labelId: string) => `${PROJECT_KEY_PREFIX}${labelId}`;

/** The shared document behind one of SettingsSync's document keys. */
export const settingsDocumentAddress = (documentId: string) =>
  documentId.startsWith(PROJECT_KEY_PREFIX)
    ? ({ kind: "project-settings", id: documentId.slice(PROJECT_KEY_PREFIX.length) } as const)
    : ({ kind: "settings", id: documentId } as const);

/** Every key a project override entry can hold. */
export const PROJECT_SETTINGS_SYNC_KEYS = [
  ...PROJECT_SCOPED_SERVER_SETTING_KEYS.filter((key) => !isMachineLocalProjectSettingKey(key)),
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
const decodeUniversalPartial = Schema.decodeUnknownOption(UniversalPartialJson);
const encodeUniversalPartial = Schema.encodeUnknownOption(UniversalPartialJson);
const encodeOverrides = Schema.encodeSync(OverridesJson);
const decodeOverridesOption = Schema.decodeUnknownOption(OverridesJson);
const encodeOverridesOption = Schema.encodeUnknownOption(OverridesJson);

/** Reads and writes one document field's value, as documentSchemas' field codecs do. */
interface SettingsFieldCodec {
  readonly decode: (value: unknown) => Option.Option<unknown>;
  readonly encode: (value: unknown) => Option.Option<unknown>;
}

/** One key of a struct codec, read and written on its own. */
const keyOf = (run: (input: unknown) => Option.Option<unknown>, key: string) => (value: unknown) =>
  run({ [key]: value }).pipe(
    Option.filter((result) => typeof result === "object" && result !== null && key in result),
    Option.map((result) => (result as Record<string, unknown>)[key]),
  );

/** What this build reads of a `settings` document, per key. */
export const UNIVERSAL_SETTINGS_CODECS: ReadonlyMap<string, SettingsFieldCodec> = new Map(
  UNIVERSAL_SERVER_SETTING_KEYS.map((key) => [
    key,
    { decode: keyOf(decodeUniversalPartial, key), encode: keyOf(encodeUniversalPartial, key) },
  ]),
);

const isValueBox = (value: unknown): value is { readonly value: unknown } =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 1 &&
  Object.hasOwn(value, "value");

/** `null`, or `{ value }` with the key's override value run through `run`. */
const boxed =
  (run: (input: unknown) => Option.Option<unknown>, key: string) =>
  (field: unknown): Option.Option<unknown> => {
    if (field === null) return Option.some(null);
    if (!isValueBox(field)) return Option.none();
    return keyOf(run, key)(field.value).pipe(Option.map((value) => ({ value })));
  };

/** What this build reads of a `project-settings` document, per key. */
export const PROJECT_SETTINGS_CODECS: ReadonlyMap<string, SettingsFieldCodec> = new Map(
  PROJECT_SETTINGS_SYNC_KEYS.map((key) => [
    key,
    { decode: boxed(decodeOverridesOption, key), encode: boxed(encodeOverridesOption, key) },
  ]),
);

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
  return Option.getOrUndefined(keyOf(decodeUniversalPartial, key)(value)) as
    | ServerSettings[K]
    | undefined;
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
  const entry: Record<string, unknown> = {};
  for (const key of PROJECT_SETTINGS_SYNC_KEYS) {
    const field = fields[key];
    if (!isValueBox(field)) continue;
    // A value this build cannot read stays in the document, unapplied.
    const decoded = keyOf(decodeOverridesOption, key)(field.value);
    if (Option.isSome(decoded)) entry[key] = decoded.value;
  }
  return entry as ProjectSettingsOverrides;
}
