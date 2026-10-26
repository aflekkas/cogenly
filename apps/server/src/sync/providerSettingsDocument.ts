import {
  CustomModelSetting,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  ProviderInstanceEnvironmentVariableName,
} from "@cogenly/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const secretEnvironmentName = (name: string) =>
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)(?:$|_)/i.test(
    name,
  ) || /KEY|AUTH|BEARER|SESSION|COOKIE|PRIVATE|CREDENTIAL|PASS/i.test(name);

// Never replicate the opaque driver config: it can hold passwords, machine
// paths and arbitrary command arguments. Only these portable settings travel.
const PortableProvider = Schema.NullOr(
  Schema.Struct({
    driver: ProviderDriverKind,
    displayName: Schema.optionalKey(Schema.String),
    accentColor: Schema.optionalKey(Schema.String),
    enabled: Schema.optionalKey(Schema.Boolean),
    position: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    accountIdentity: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
    environment: Schema.Array(
      Schema.Struct({
        name: ProviderInstanceEnvironmentVariableName.check(
          Schema.makeFilter((name) => !secretEnvironmentName(name)),
        ),
        value: Schema.String,
        sensitive: Schema.Literal(false),
      }),
    ),
    customModels: Schema.Array(CustomModelSetting),
  }),
);
export const providerSettingsCodec = {
  decode: Schema.decodeUnknownOption(PortableProvider),
  encode: Schema.encodeUnknownOption(PortableProvider),
};
const encode = Schema.encodeSync(Schema.toCodecJson(PortableProvider));
const decodeModels = Schema.decodeUnknownOption(
  Schema.Struct({
    customModels: Schema.optionalKey(Schema.Array(CustomModelSetting)),
    syncAccountIdentity: Schema.optionalKey(Schema.String),
  }),
);
const isInstanceId = Schema.is(ProviderInstanceId);
export const providerSettingsKey = (id: string) => `provider:${id}`;
export const providerIdFromSettingsKey = (key: string) => {
  const id = key.startsWith("provider:") ? key.slice(9) : "";
  return isInstanceId(id) ? id : undefined;
};

export function encodeProviderSettings(
  instance: ProviderInstanceConfig | undefined,
  accountIdentity?: string,
  position?: number,
): Schema.Json {
  if (!instance) return null;
  const models = decodeModels(instance.config);
  const identity =
    accountIdentity ?? (Option.isSome(models) ? models.value.syncAccountIdentity : undefined);
  return encode({
    driver: instance.driver,
    ...(position === undefined ? {} : { position }),
    ...(identity ? { accountIdentity: identity } : {}),
    ...(instance.displayName === undefined ? {} : { displayName: instance.displayName }),
    ...(instance.accentColor === undefined ? {} : { accentColor: instance.accentColor }),
    ...(instance.enabled === undefined ? {} : { enabled: instance.enabled }),
    environment: (instance.environment ?? []).flatMap((entry) =>
      entry.sensitive || entry.valueRedacted || secretEnvironmentName(entry.name)
        ? []
        : [{ name: entry.name, value: entry.value, sensitive: false as const }],
    ),
    customModels: Option.isSome(models) ? (models.value.customModels ?? []) : [],
  });
}

/** Apply portable metadata while retaining this machine's paths and vault-backed secrets. */
export function applyProviderSettings(
  value: Schema.Json,
  current: ProviderInstanceConfig | undefined,
  id: string,
): ProviderInstanceConfig | null | undefined {
  const decoded = providerSettingsCodec.decode(value);
  if (Option.isNone(decoded)) return undefined;
  const remote = decoded.value;
  if (remote === null) return null;
  // An ID collision across drivers cannot silently switch the account runtime.
  if (current && current.driver !== remote.driver) return undefined;
  const config = current?.config;
  const localConfig = typeof config === "object" && config !== null ? config : {};
  // Additional accounts must never inherit the default CLI home's login.
  const newHome =
    !current &&
    id !== remote.driver &&
    (remote.driver === "claudeAgent" || remote.driver === "codex")
      ? { homePath: `~/.cogenly/provider-homes/${id}` }
      : {};
  return {
    driver: remote.driver,
    ...(remote.displayName === undefined ? {} : { displayName: remote.displayName }),
    ...(remote.accentColor === undefined ? {} : { accentColor: remote.accentColor }),
    ...(remote.enabled === undefined ? {} : { enabled: remote.enabled }),
    environment: [
      ...remote.environment,
      ...(current?.environment ?? []).filter(
        (entry) => entry.sensitive || secretEnvironmentName(entry.name),
      ),
    ],
    config: {
      ...localConfig,
      ...newHome,
      customModels: remote.customModels,
      ...(remote.accountIdentity ? { syncAccountIdentity: remote.accountIdentity } : {}),
    },
  };
}
