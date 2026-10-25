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
  type ProjectId,
  type ProjectSettingsOverrides,
  type ServerSettings,
  UNIVERSAL_SERVER_SETTING_KEYS,
} from "@cogenly/contracts";
import { withProjectSettingsOverrides } from "@cogenly/shared/projectSettings";
import type * as Schema from "effect/Schema";
import {
  decodeProjectOverrides,
  decodeUniversalSetting,
  encodeProjectOverrides,
  encodeUniversalSettings,
  PROJECT_SETTINGS_SYNC_KEYS,
  projectSettingsDocumentId,
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

/**
 * One project key across the machine's repositories in that project, which
 * all carry the project's override. The first repository with a local edit
 * publishes it (in the order given), and every other repository follows it.
 */
export function reconcileProjectSettingsField(input: {
  readonly repositories: ReadonlyArray<{
    readonly local: Schema.Json;
    readonly base: Schema.Json | undefined;
  }>;
  readonly remote: Schema.Json | undefined;
}): {
  readonly publish: Schema.Json | undefined;
  readonly repositories: ReadonlyArray<SettingsFieldOutcome>;
} {
  const outcomes = input.repositories.map((repository) =>
    reconcileSettingsField({
      local: repository.local,
      base: repository.base,
      remote: input.remote,
      unset: repository.local === null,
    }),
  );
  const edit = outcomes.find((outcome) => outcome._tag === "publish");
  if (edit === undefined) return { publish: undefined, repositories: outcomes };
  return {
    publish: edit.value,
    repositories: input.repositories.map((repository): SettingsFieldOutcome => {
      if (!same(repository.local, edit.value)) return { _tag: "apply", value: edit.value };
      return repository.base !== undefined && same(repository.base, edit.value)
        ? { _tag: "none" }
        : { _tag: "settle", value: edit.value };
    }),
  };
}

/** Where a reconciled value is recorded: `scope` is '' for universal keys, else a repository id. */
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
  /** Keyed by `settingsBaseKey`. */
  readonly base: ReadonlyMap<string, Schema.Json>;
  /** The shared documents' merged fields, by document id. */
  readonly documents: ReadonlyMap<string, Readonly<Record<string, Schema.Json>>>;
  /** This machine's live repositories in each project, in a stable order. */
  readonly projects: ReadonlyMap<string, ReadonlyArray<ProjectId>>;
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

/** Decide every universal key and every project key on this machine's filed repositories. */
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
  let next: ServerSettings = { ...input.settings, ...applied };

  for (const [labelId, repositoryIds] of input.projects) {
    if (repositoryIds.length === 0) continue;
    const documentId = projectSettingsDocumentId(labelId);
    const document = input.documents.get(documentId);
    const locals = repositoryIds.map((repositoryId) =>
      encodeProjectOverrides(input.settings.projectSettingsOverrides[repositoryId]),
    );
    const entries = new Map<ProjectId, Record<string, unknown>>();
    for (const key of PROJECT_SETTINGS_SYNC_KEYS) {
      const result = reconcileProjectSettingsField({
        remote: remoteField(document, key),
        repositories: repositoryIds.map((repositoryId, index) => ({
          local: locals[index]![key],
          base: input.base.get(settingsBaseKey(documentId, repositoryId, key)),
        })),
      });
      if (result.publish !== undefined) addPublish(documentId, key, result.publish);
      result.repositories.forEach((outcome, index) => {
        if (outcome._tag === "none") return;
        const repositoryId = repositoryIds[index]!;
        if (outcome._tag === "apply") {
          const decoded = decodeProjectOverrides({ [key]: outcome.value });
          if (outcome.value !== null && !Object.hasOwn(decoded, key)) return;
          const entry = entries.get(repositoryId) ?? {
            ...next.projectSettingsOverrides[repositoryId],
          };
          if (outcome.value === null) delete entry[key];
          else entry[key] = decoded[key];
          entries.set(repositoryId, entry);
        }
        base.push({ documentId, scope: repositoryId, key, value: outcome.value });
      });
    }
    for (const [repositoryId, entry] of entries) {
      next = {
        ...next,
        projectSettingsOverrides: withProjectSettingsOverrides(
          next,
          repositoryId,
          entry as ProjectSettingsOverrides,
        ),
      };
      changed = true;
    }
  }
  return { settings: changed ? next : null, publish, base };
}
