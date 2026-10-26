/**
 * Three-way reconciliation between a machine's settings.json and a shared
 * settings document. `base` is the value both last agreed on, so a difference
 * from it tells a local edit from a peer's: the side that moved wins, and a
 * local edit not yet published wins over a concurrent peer edit (it becomes
 * the newest clock once published). Field clocks in SharedState then settle
 * last-writer-wins between machines.
 *
 * @module settingsReconcile
 */
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings,
  type ProviderInstanceConfig,
  UNIVERSAL_SERVER_SETTING_KEYS,
} from "@cogenly/contracts";
import {
  applyProviderSettings,
  encodeProviderSettings,
  providerIdFromSettingsKey,
  providerSettingsKey,
} from "./providerSettingsDocument.ts";
import * as Option from "effect/Option";
import { providerSettingsCodec } from "./providerSettingsDocument.ts";
import type { ProviderAccountIdentity } from "./providerAccountIdentity.ts";
import type * as Schema from "effect/Schema";
import {
  decodeUniversalSetting,
  encodeUniversalSettings,
  UNIVERSAL_SETTINGS_DOCUMENT_ID,
} from "./settingsDocument.ts";

export type SettingsFieldOutcome =
  /** Nothing to do. */
  | { readonly _tag: "none" }
  /** Both sides agree; record the value as the new base. */
  | { readonly _tag: "settle"; readonly value: Schema.Json }
  /** A local edit: write it to the shared document, then record it. */
  | { readonly _tag: "publish"; readonly value: Schema.Json }
  /** A peer edit: write it to settings.json, then record it. */
  | { readonly _tag: "apply"; readonly value: Schema.Json };

/** JSON with object keys sorted, so equal values from different machines compare equal. */
export function canonicalJson(value: Schema.Json | undefined): string {
  return JSON.stringify(value, (_key, current: unknown) =>
    current !== null && typeof current === "object" && !Array.isArray(current)
      ? Object.fromEntries(
          Object.entries(current as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : current,
  );
}

const same = (a: Schema.Json | undefined, b: Schema.Json | undefined) =>
  canonicalJson(a) === canonicalJson(b);

/**
 * One key. `unset` marks a local value that is only the default (or no
 * override): before the first agreement it never publishes, so a machine that
 * never touched a setting adopts the value its peers chose. Before the first
 * agreement a shared value also wins over a customized local one.
 */
export function reconcileSettingsField(input: {
  readonly local: Schema.Json;
  readonly remote: Schema.Json | undefined;
  readonly base: Schema.Json | undefined;
  readonly unset: boolean;
}): SettingsFieldOutcome {
  const { local, remote, base, unset } = input;
  if (remote !== undefined && same(local, remote)) {
    return base !== undefined && same(base, local)
      ? { _tag: "none" }
      : { _tag: "settle", value: local };
  }
  if (base === undefined) {
    if (remote !== undefined) return { _tag: "apply", value: remote };
    return unset ? { _tag: "settle", value: local } : { _tag: "publish", value: local };
  }
  if (!same(local, base)) return { _tag: "publish", value: local };
  if (remote !== undefined && !same(remote, base)) return { _tag: "apply", value: remote };
  return { _tag: "none" };
}

/** Where a reconciled value is recorded: `scope` is '' (builds before 0.3.2 also kept a repository id). */
export interface SettingsBaseEntry {
  readonly documentId: string;
  readonly scope: string;
  readonly key: string;
  readonly value: Schema.Json;
}

export const settingsBaseKey = (documentId: string, scope: string, key: string) =>
  `${documentId}\u0000${scope}\u0000${key}`;

export interface SettingsReconcileInput {
  readonly settings: ServerSettings;
  readonly accounts?: ReadonlyMap<string, ProviderAccountIdentity>;
  /** Keyed by `settingsBaseKey`. */
  readonly base: ReadonlyMap<string, Schema.Json>;
  /** The shared documents' merged fields, by document id. */
  readonly documents: ReadonlyMap<string, Readonly<Record<string, Schema.Json>>>;
}

export interface SettingsReconcilePlan {
  /** Settings with peer edits applied; null when settings.json stays as it is. */
  readonly settings: ServerSettings | null;
  /** Local edits to write, by document id. */
  readonly publish: ReadonlyMap<string, Record<string, Schema.Json>>;
  /** Base values to record once the writes above have landed. */
  readonly base: ReadonlyArray<SettingsBaseEntry>;
}

const DEFAULT_UNIVERSAL = encodeUniversalSettings(DEFAULT_SERVER_SETTINGS);

const remoteField = (
  document: Readonly<Record<string, Schema.Json>> | undefined,
  key: string,
): Schema.Json | undefined =>
  document !== undefined && Object.hasOwn(document, key) ? document[key] : undefined;

/** Decide every universal key. */
export function planSettingsReconcile(input: SettingsReconcileInput): SettingsReconcilePlan {
  const applied: Partial<ServerSettings> = {};
  let changed = false;
  const publish = new Map<string, Record<string, Schema.Json>>();
  const base: SettingsBaseEntry[] = [];
  const addPublish = (documentId: string, key: string, value: Schema.Json) => {
    const fields = publish.get(documentId) ?? {};
    fields[key] = value;
    publish.set(documentId, fields);
  };

  const universal = input.documents.get(UNIVERSAL_SETTINGS_DOCUMENT_ID);
  const local = encodeUniversalSettings(input.settings);
  for (const key of UNIVERSAL_SERVER_SETTING_KEYS) {
    const outcome = reconcileSettingsField({
      local: local[key],
      remote: remoteField(universal, key),
      base: input.base.get(settingsBaseKey(UNIVERSAL_SETTINGS_DOCUMENT_ID, "", key)),
      unset: canonicalJson(local[key]) === canonicalJson(DEFAULT_UNIVERSAL[key]),
    });
    if (outcome._tag === "none") continue;
    if (outcome._tag === "apply") {
      const decoded = decodeUniversalSetting(key, outcome.value);
      // A value this build cannot read is left for a newer build to apply.
      if (decoded === undefined) continue;
      Object.assign(applied, { [key]: decoded });
      changed = true;
    }
    if (outcome._tag === "publish") addPublish(UNIVERSAL_SETTINGS_DOCUMENT_ID, key, outcome.value);
    base.push({ documentId: UNIVERSAL_SETTINGS_DOCUMENT_ID, scope: "", key, value: outcome.value });
  }
  const instances: Record<string, ProviderInstanceConfig> = { ...input.settings.providerInstances };
  // On first sync align homes by verified driver/account identity. In particular,
  // a peer's default ID may name a different account from this machine's default.
  const aligned = new Set<string>();
  for (const [key, value] of Object.entries(universal ?? {})) {
    const id = providerIdFromSettingsKey(key);
    if (!id || input.base.has(settingsBaseKey(UNIVERSAL_SETTINGS_DOCUMENT_ID, "", key))) continue;
    const decoded = providerSettingsCodec.decode(value);
    if (Option.isNone(decoded) || !decoded.value?.accountIdentity) continue;
    const remote = decoded.value;
    const matches = Array.from(input.accounts ?? []).filter(
      ([, account]) =>
        account.driver === remote.driver && account.identity === remote.accountIdentity,
    );
    const own = input.accounts?.get(id);
    if (matches.length === 1 && matches[0]![0] !== id) {
      const [oldId, account] = matches[0]!;
      const source =
        input.settings.providerInstances[oldId as keyof typeof input.settings.providerInstances];
      instances[id] = {
        driver: remote.driver,
        ...source,
        config: {
          ...(typeof source?.config === "object" && source.config !== null ? source.config : {}),
          homePath: account.homePath,
        },
      };
      aligned.add(id);
    } else if (own && own.identity !== remote.accountIdentity) {
      // Keep the existing login untouched. This canonical ID needs its own grant.
      const current = instances[id];
      instances[id] = {
        ...current,
        driver: remote.driver,
        config: {
          ...(typeof current?.config === "object" && current.config !== null ? current.config : {}),
          homePath: `~/.cogenly/provider-homes/${id}`,
          shadowHomePath: "",
        },
      };
      aligned.add(id);
    }
  }
  const ids = new Set([
    ...Object.keys(instances),
    ...Object.keys(universal ?? {}).flatMap((key) => {
      const id = providerIdFromSettingsKey(key);
      return id === undefined ? [] : [id];
    }),
    ...Array.from(input.base.keys()).flatMap((key) => {
      const id = providerIdFromSettingsKey(key.split("\u0000")[2] ?? "");
      return id === undefined ? [] : [id];
    }),
  ]);
  for (const id of ids) {
    const key = providerSettingsKey(id);
    const outcome = reconcileSettingsField({
      local: encodeProviderSettings(
        instances[id],
        aligned.has(id) ? undefined : input.accounts?.get(id)?.identity,
        Object.keys(instances).indexOf(id),
      ),
      remote: remoteField(universal, key),
      base: input.base.get(settingsBaseKey(UNIVERSAL_SETTINGS_DOCUMENT_ID, "", key)),
      unset: instances[id] === undefined,
    });
    if (outcome._tag === "none") continue;
    if (outcome._tag === "apply") {
      const instance = applyProviderSettings(outcome.value, instances[id], id);
      if (instance === undefined) continue;
      if (instance === null) delete instances[id];
      else instances[id] = instance;
      changed = true;
    }
    if (outcome._tag === "publish") addPublish(UNIVERSAL_SETTINGS_DOCUMENT_ID, key, outcome.value);
    base.push({ documentId: UNIVERSAL_SETTINGS_DOCUMENT_ID, scope: "", key, value: outcome.value });
  }
  const positions = new Map<string, number>();
  for (const [key, value] of Object.entries({
    ...universal,
    ...publish.get(UNIVERSAL_SETTINGS_DOCUMENT_ID),
  })) {
    const id = providerIdFromSettingsKey(key);
    const decoded = providerSettingsCodec.decode(value);
    if (id && Option.isSome(decoded) && decoded.value?.position !== undefined)
      positions.set(id, decoded.value.position);
  }
  const ordered = Object.fromEntries(
    Object.entries(instances).sort(
      ([a], [b]) =>
        (positions.get(a) ?? Number.MAX_SAFE_INTEGER) -
          (positions.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b),
    ),
  );
  if (
    canonicalJson(Object.keys(ordered)) !==
    canonicalJson(Object.keys(input.settings.providerInstances))
  )
    changed = true;
  if (changed) Object.assign(applied, { providerInstances: ordered });
  return { settings: changed ? { ...input.settings, ...applied } : null, publish, base };
}
