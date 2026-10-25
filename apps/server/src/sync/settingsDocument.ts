/**
 * Shared settings documents. The `settings` document `universal` holds the
 * keys in `UNIVERSAL_SERVER_SETTING_KEYS` as their JSON encoding.
 *
 * `project-settings` documents held per-project overrides before 0.3.2.
 * Settings are global now, so this build reads none of their fields: an
 * older machine's document is stored and relayed as it came, and never
 * applied.
 *
 * @module settingsDocument
 */
import {
  ServerSettings,
  UNIVERSAL_SERVER_SETTING_KEYS,
  type UniversalServerSettingKey,
} from "@cogenly/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const UNIVERSAL_SETTINGS_DOCUMENT_ID = "universal";

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
const encodeUniversal = Schema.encodeSync(UniversalSettingsJson);
const decodeUniversalPartial = Schema.decodeUnknownOption(UniversalPartialJson);
const encodeUniversalPartial = Schema.encodeUnknownOption(UniversalPartialJson);

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

/** A `project-settings` document: no field is known, so every one is kept and relayed unread. */
export const PROJECT_SETTINGS_CODECS: ReadonlyMap<string, SettingsFieldCodec> = new Map();

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
