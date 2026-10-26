/**
 * Repository actions from before 0.3.2, when settings could be overridden per
 * project. They lived in settings.json (`projectSettingsOverrides[id]
 * .defaultProjectScripts`, and the older `projectScriptOverrides` map); they
 * now live on the repository record (`Project.scripts`).
 *
 * The settings loader copies them into a sidecar beside settings.json before
 * it rewrites the file without the retired keys, and
 * `LegacyProjectActionsMigration` moves them onto each repository at boot.
 *
 * @module project/legacyProjectActions
 */
import { ProjectId, ProjectScript } from "@cogenly/contracts";
import { fromJsonStringPretty } from "@cogenly/shared/schemaJson";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const LEGACY_PROJECT_ACTIONS_FILE_NAME = "legacy-project-actions.json";

export const LegacyProjectActions = Schema.Struct({
  /** The settings had folded the repository record's own scripts into overrides. */
  folded: Schema.Boolean,
  /** A repository's own list; `null` meant "use the machine's actions". */
  scripts: Schema.Record(ProjectId, Schema.NullOr(Schema.Array(ProjectScript))),
});
export type LegacyProjectActions = typeof LegacyProjectActions.Type;

export const LegacyProjectActionsJson = fromJsonStringPretty(LegacyProjectActions);

const decodeScripts = Schema.decodeUnknownOption(Schema.Array(ProjectScript));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The legacy actions in a settings.json's parsed contents, or null when it
 * holds none. Each entry is read on its own, so one invalid list drops only
 * that repository's actions.
 */
export function readLegacyProjectActions(stored: unknown): LegacyProjectActions | null {
  if (!isRecord(stored)) return null;
  const folded = stored.projectSettingsFolded === true;
  const scripts: Record<string, ReadonlyArray<ProjectScript> | null> = {};
  const set = (projectId: string, value: unknown) => {
    const decoded = decodeScripts(value);
    if (Option.isSome(decoded)) scripts[projectId] = decoded.value;
  };
  const legacyMap = stored.projectScriptOverrides;
  if (isRecord(legacyMap)) {
    for (const [projectId, value] of Object.entries(legacyMap)) {
      if (value === null) scripts[projectId] = null;
      else set(projectId, value);
    }
  }
  // The generic record is the newer representation and wins over the old map.
  const overrides = stored.projectSettingsOverrides;
  if (isRecord(overrides)) {
    for (const [projectId, entry] of Object.entries(overrides)) {
      if (isRecord(entry) && Object.hasOwn(entry, "defaultProjectScripts")) {
        set(projectId, entry.defaultProjectScripts);
      }
    }
  }
  if (!folded && Object.keys(scripts).length === 0) return null;
  return { folded, scripts: scripts as LegacyProjectActions["scripts"] };
}

/**
 * The actions a repository should hold so it keeps the actions it ran before,
 * or null to leave it as it is. After the fold, a repository without its own
 * list followed the machine's actions, so it holds none of its own.
 */
export function legacyProjectActionsTarget(
  legacy: LegacyProjectActions,
  project: { readonly id: ProjectId; readonly scripts: ReadonlyArray<ProjectScript> },
): ReadonlyArray<ProjectScript> | null {
  const stored = Object.hasOwn(legacy.scripts, project.id) ? legacy.scripts[project.id] : undefined;
  const target = legacy.folded ? (stored ?? []) : stored === undefined ? null : (stored ?? []);
  return target === null || Equal.equals(target, project.scripts) ? null : target;
}
