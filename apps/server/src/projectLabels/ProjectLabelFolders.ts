import {
  PROJECT_REPOSITORIES_SEGMENT,
  ProjectLabelId,
  type ProjectOrphanFolder,
} from "@cogenly/contracts";
import * as HostProcess from "@cogenly/shared/HostProcess";
import { UNFILED_REPOSITORIES_SEGMENT, sanitizePathSegment } from "@cogenly/shared/path";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { resolveProjectsRootDirectory } from "../project/ProjectsRoot.ts";
import { isWorktreesSegment } from "../worktreesDirectory.ts";
import * as ServerSettings from "../serverSettings.ts";

export const PROJECT_LABEL_ID_FILE = ".cogenly-project.json";
export const PROJECT_LABEL_RESOURCES_SEGMENT = "Resources";

const ProjectLabelIdFile = Schema.fromJsonString(Schema.Struct({ id: ProjectLabelId }));
const decodeIdFile = Schema.decodeUnknownOption(ProjectLabelIdFile);
const encodeIdFile = Schema.encodeSync(ProjectLabelIdFile);

export class ProjectLabelFolderError extends Schema.TaggedError<ProjectLabelFolderError>()(
  "ProjectLabelFolderError",
  {
    operation: Schema.String,
    labelId: Schema.optional(ProjectLabelId),
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} the project folder.`;
  }
}

export interface ProjectLabelFolder {
  readonly dir: string;
  readonly dirName: string;
}

export interface ProjectLabelRef {
  readonly id: ProjectLabelId;
  readonly name: string;
}

export class ProjectLabelFolders extends Context.Service<
  ProjectLabelFolders,
  {
    /** The resolved projects root. Blank settings land in `<Cogenly home>/projects`. */
    readonly projectsRoot: Effect.Effect<string, ProjectLabelFolderError>;
    /**
     * The label's folder: the reconciled directory when an id file claims
     * the label, else `<root>/<sanitized name>/`. Refreshes from disk on a
     * miss, so a Finder rename is picked up without a restart.
     */
    readonly dirForLabel: (
      label: ProjectLabelRef,
    ) => Effect.Effect<ProjectLabelFolder, ProjectLabelFolderError>;
    /** Just the reconciled directory name (for destinations under the folder). */
    readonly dirNameForLabel: (
      label: ProjectLabelRef,
    ) => Effect.Effect<string, ProjectLabelFolderError>;
    /** Creates the folder, its id file and `Resources/`; existing folders are adopted. */
    readonly ensureForLabel: (
      label: ProjectLabelRef,
    ) => Effect.Effect<ProjectLabelFolder, ProjectLabelFolderError>;
    /** Renames the folder after the label; a taken name gains a ` (2)` suffix. */
    readonly renameForLabel: (
      label: ProjectLabelRef,
    ) => Effect.Effect<ProjectLabelFolder, ProjectLabelFolderError>;
    /**
     * Claims an existing folder under the projects root for the label (an
     * orphan the user adopts): writes its id file, keeps everything in it.
     */
    readonly claimForLabel: (
      label: ProjectLabelRef,
      dirName: string,
    ) => Effect.Effect<ProjectLabelFolder, ProjectLabelFolderError>;
    /**
     * Removes the label's folder when it is only the skeleton Cogenly made
     * (id file, empty `Resources/`, empty repository and worktree folders).
     * Anything else stays; returns whether the folder went.
     */
    readonly removeSkeleton: (
      label: ProjectLabelRef,
    ) => Effect.Effect<boolean, ProjectLabelFolderError>;
    /**
     * Folders directly under the projects root that no project claims: no id
     * file, or one naming a project that no longer exists. `Repositories/`
     * and worktree folders are never orphans.
     */
    readonly listOrphans: Effect.Effect<
      ReadonlyArray<ProjectOrphanFolder>,
      ProjectLabelFolderError
    >;
    /** Deletes an orphan that is only a skeleton; false when it holds anything else. */
    readonly removeOrphan: (dirName: string) => Effect.Effect<boolean, ProjectLabelFolderError>;
    /**
     * Startup pass: folders whose id file matches a label become that
     * label's folder even after a Finder rename, and labels without a
     * folder get one.
     */
    readonly reconcile: Effect.Effect<
      { readonly labels: number; readonly folders: number },
      ProjectLabelFolderError
    >;
  }
>()("cogenly-server/projectLabels/ProjectLabelFolders") {}

const MAX_DIR_NAME_ATTEMPTS = 100;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  // Label id to directory name, from the last reconcile or refresh.
  const folders = yield* Ref.make(new Map<string, string>());

  const fail = (operation: string, label?: ProjectLabelRef, dir?: string) => (cause: unknown) =>
    new ProjectLabelFolderError({
      operation,
      ...(label === undefined ? {} : { labelId: label.id }),
      ...(dir === undefined ? {} : { path: dir }),
      cause,
    });

  const projectsRoot = serverSettings.getSettings.pipe(
    Effect.map((settings) =>
      resolveProjectsRootDirectory(settings.projectsRoot, home, config.baseDir, path),
    ),
    Effect.mapError(fail("resolve")),
  );

  const readIdFile = (dir: string) =>
    fileSystem.readFileString(path.join(dir, PROJECT_LABEL_ID_FILE)).pipe(
      Effect.map((text) => decodeIdFile(text)),
      Effect.map(Option.map((file) => file.id)),
      Effect.catch(() => Effect.succeed(Option.none<ProjectLabelId>())),
    );

  const isDirectory = (dir: string) =>
    fileSystem.stat(dir).pipe(
      Effect.map((stat) => stat.type === "Directory"),
      Effect.catch(() => Effect.succeed(false)),
    );

  // The id files on disk, first sorted name winning a contested id.
  const scanFolders = Effect.gen(function* () {
    const root = yield* projectsRoot;
    const entries = yield* fileSystem.readDirectory(root).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed([]),
      ),
      Effect.mapError(fail("scan", undefined, root)),
    );
    const found = new Map<string, string>();
    for (const entry of [...entries].sort()) {
      // Worktree containers are reserved, never project folders.
      if (isWorktreesSegment(entry)) continue;
      const dir = path.join(root, entry);
      if (!(yield* isDirectory(dir))) continue;
      const id = yield* readIdFile(dir);
      if (Option.isNone(id) || found.has(id.value)) continue;
      found.set(id.value, entry);
    }
    yield* Ref.set(folders, found);
    return found;
  });

  const dirNameForLabel: ProjectLabelFolders["Service"]["dirNameForLabel"] = Effect.fn(
    "ProjectLabelFolders.dirNameForLabel",
  )(function* (label) {
    const cached = (yield* Ref.get(folders)).get(label.id);
    if (cached !== undefined) return cached;
    const found = yield* scanFolders;
    return found.get(label.id) ?? sanitizePathSegment(label.name, "project");
  });

  const dirForLabel: ProjectLabelFolders["Service"]["dirForLabel"] = Effect.fn(
    "ProjectLabelFolders.dirForLabel",
  )(function* (label) {
    const dirName = yield* dirNameForLabel(label);
    return { dir: path.join(yield* projectsRoot, dirName), dirName };
  });

  const writeIdFile = (label: ProjectLabelRef, dir: string) =>
    fileSystem
      .writeFileString(path.join(dir, PROJECT_LABEL_ID_FILE), `${encodeIdFile({ id: label.id })}\n`)
      .pipe(Effect.mapError(fail("create", label, dir)));

  const ensureResources = (label: ProjectLabelRef, dir: string) =>
    fileSystem
      .makeDirectory(path.join(dir, PROJECT_LABEL_RESOURCES_SEGMENT), { recursive: true })
      .pipe(Effect.mapError(fail("create", label, dir)));

  const recordFolder = (label: ProjectLabelRef, dirName: string) =>
    Ref.update(folders, (all) => new Map(all).set(label.id, dirName));

  const freeDirName = Effect.fn("ProjectLabelFolders.freeDirName")(function* (
    label: ProjectLabelRef,
    root: string,
    base: string,
  ) {
    for (let attempt = 1; attempt <= MAX_DIR_NAME_ATTEMPTS; attempt++) {
      const candidate = attempt === 1 ? base : `${base} (${attempt})`;
      const dir = path.join(root, candidate);
      const claimed = yield* fileSystem.makeDirectory(dir).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed(false),
        ),
        Effect.mapError(fail("create", label, dir)),
      );
      if (claimed) return { dir, dirName: candidate };
    }
    return yield* fail(
      "create",
      label,
      path.join(root, base),
    )(`Every folder name for "${base}" is taken.`);
  });

  // A marker left by a project that is gone: deleted here, or deleted on
  // another machine. A project still syncing in keeps its claim.
  const isAbandonedMarker = (id: ProjectLabelId) =>
    sql<{ readonly live: number; readonly synced: number }>`
      SELECT
        (SELECT count(*) FROM project_labels WHERE label_id = ${id}) AS live,
        (SELECT count(*) FROM shared_documents WHERE kind = 'project' AND id = ${id} AND tombstone_json IS NULL) AS synced
    `.pipe(
      Effect.map((rows) => (rows[0]?.live ?? 0) === 0 && (rows[0]?.synced ?? 0) === 0),
      Effect.mapError(fail("scan")),
    );

  // Only what Cogenly made: the id file, and empty Resources/, repos/ and worktree folders.
  const isSkeleton = (dir: string) =>
    Effect.gen(function* () {
      const entries = yield* fileSystem
        .readDirectory(dir)
        .pipe(Effect.mapError(fail("scan", undefined, dir)));
      for (const entry of entries) {
        // Finder drops `.DS_Store` into any folder it opens.
        if (entry === PROJECT_LABEL_ID_FILE || entry === ".DS_Store") continue;
        const reserved =
          entry === PROJECT_LABEL_RESOURCES_SEGMENT ||
          entry === PROJECT_REPOSITORIES_SEGMENT ||
          isWorktreesSegment(entry);
        if (!reserved) return false;
        const full = path.join(dir, entry);
        if (!(yield* isDirectory(full))) return false;
        const inside = yield* fileSystem
          .readDirectory(full)
          .pipe(Effect.orElseSucceed(() => ["?"]));
        if (inside.some((name) => name !== ".DS_Store")) return false;
      }
      return true;
    });

  const ensureForLabel: ProjectLabelFolders["Service"]["ensureForLabel"] = Effect.fn(
    "ProjectLabelFolders.ensureForLabel",
  )(function* (label) {
    const root = yield* projectsRoot;
    yield* fileSystem
      .makeDirectory(root, { recursive: true })
      .pipe(Effect.mapError(fail("create", label, root)));
    const dirName = yield* dirNameForLabel(label);
    const dir = path.join(root, dirName);
    if (yield* isDirectory(dir)) {
      const id = yield* readIdFile(dir);
      if (Option.isSome(id) && id.value === label.id) {
        yield* ensureResources(label, dir);
        yield* recordFolder(label, dirName);
        return { dir, dirName };
      }
      // An empty foreign directory is safe to adopt; anything else keeps its
      // contents and the label takes a suffixed name instead.
      const entries = yield* fileSystem
        .readDirectory(dir)
        .pipe(Effect.mapError(fail("create", label, dir)));
      // Empty and unclaimed, or claimed by a project that is gone (the
      // marker a deleted project left behind): adopt it rather than making
      // "Name (2)" beside it.
      if (
        (entries.length === 0 && Option.isNone(id)) ||
        (Option.isSome(id) && (yield* isAbandonedMarker(id.value)))
      ) {
        yield* writeIdFile(label, dir);
        yield* ensureResources(label, dir);
        yield* recordFolder(label, dirName);
        return { dir, dirName };
      }
      const claimed = yield* freeDirName(label, root, sanitizePathSegment(label.name, "project"));
      yield* writeIdFile(label, claimed.dir);
      yield* ensureResources(label, claimed.dir);
      yield* recordFolder(label, claimed.dirName);
      return claimed;
    }
    const claimed = yield* freeDirName(label, root, dirName);
    yield* writeIdFile(label, claimed.dir);
    yield* ensureResources(label, claimed.dir);
    yield* recordFolder(label, claimed.dirName);
    return claimed;
  });

  const renameForLabel: ProjectLabelFolders["Service"]["renameForLabel"] = Effect.fn(
    "ProjectLabelFolders.renameForLabel",
  )(function* (label) {
    const root = yield* projectsRoot;
    const current = yield* dirNameForLabel(label);
    const target = sanitizePathSegment(label.name, "project");
    const currentDir = path.join(root, current);
    if (!(yield* isDirectory(currentDir))) return yield* ensureForLabel(label);
    if (current === target) {
      yield* writeIdFile(label, currentDir);
      yield* ensureResources(label, currentDir);
      yield* recordFolder(label, current);
      return { dir: currentDir, dirName: current };
    }
    for (let attempt = 1; attempt <= MAX_DIR_NAME_ATTEMPTS; attempt++) {
      const candidate = attempt === 1 ? target : `${target} (${attempt})`;
      const dir = path.join(root, candidate);
      if (yield* isDirectory(dir)) continue;
      yield* fileSystem.rename(currentDir, dir).pipe(Effect.mapError(fail("rename", label, dir)));
      yield* writeIdFile(label, dir);
      yield* ensureResources(label, dir);
      yield* recordFolder(label, candidate);
      return { dir, dirName: candidate };
    }
    return yield* fail(
      "rename",
      label,
      path.join(root, target),
    )(`Every folder name for "${target}" is taken.`);
  });

  const reconcile: ProjectLabelFolders["Service"]["reconcile"] = Effect.gen(function* () {
    yield* scanFolders;
    const labels = yield* sql<{ label_id: string; name: string }>`
      SELECT label_id, name FROM project_labels ORDER BY label_id
    `.pipe(Effect.mapError(fail("reconcile")));
    let foldersCount = 0;
    for (const row of labels) {
      const label = { id: ProjectLabelId.make(row.label_id), name: row.name };
      const known = (yield* Ref.get(folders)).get(label.id);
      if (known !== undefined && (yield* isDirectory(path.join(yield* projectsRoot, known)))) {
        foldersCount += 1;
        continue;
      }
      yield* ensureForLabel(label);
      foldersCount += 1;
    }
    return { labels: labels.length, folders: foldersCount };
  });

  const claimForLabel: ProjectLabelFolders["Service"]["claimForLabel"] = Effect.fn(
    "ProjectLabelFolders.claimForLabel",
  )(function* (label, dirName) {
    const dir = path.join(yield* projectsRoot, dirName);
    if (!(yield* isDirectory(dir))) return yield* fail("adopt", label, dir)("Not a folder.");
    const id = yield* readIdFile(dir);
    if (Option.isSome(id) && id.value !== label.id && !(yield* isAbandonedMarker(id.value)))
      return yield* fail("adopt", label, dir)("Another project owns this folder.");
    yield* writeIdFile(label, dir);
    yield* ensureResources(label, dir);
    yield* recordFolder(label, dirName);
    return { dir, dirName };
  });

  const removeSkeleton: ProjectLabelFolders["Service"]["removeSkeleton"] = Effect.fn(
    "ProjectLabelFolders.removeSkeleton",
  )(function* (label) {
    const { dir } = yield* dirForLabel(label);
    if (!(yield* isDirectory(dir))) return false;
    const id = yield* readIdFile(dir);
    if (Option.isSome(id) && id.value !== label.id) return false;
    if (!(yield* isSkeleton(dir))) return false;
    yield* fileSystem
      .remove(dir, { recursive: true })
      .pipe(Effect.mapError(fail("remove", label, dir)));
    yield* Ref.update(folders, (all) => {
      const next = new Map(all);
      next.delete(label.id);
      return next;
    });
    return true;
  });

  const listOrphans: ProjectLabelFolders["Service"]["listOrphans"] = Effect.gen(function* () {
    const root = yield* projectsRoot;
    const entries = yield* fileSystem.readDirectory(root).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed([]),
      ),
      Effect.mapError(fail("scan", undefined, root)),
    );
    const orphans: Array<ProjectOrphanFolder> = [];
    for (const entry of [...entries].sort()) {
      if (
        entry.startsWith(".") ||
        isWorktreesSegment(entry) ||
        entry === UNFILED_REPOSITORIES_SEGMENT
      )
        continue;
      const dir = path.join(root, entry);
      if (!(yield* isDirectory(dir))) continue;
      const id = yield* readIdFile(dir);
      if (Option.isSome(id) && !(yield* isAbandonedMarker(id.value))) continue;
      orphans.push({
        dirName: entry,
        path: dir,
        reason: Option.isSome(id) ? "deleted_project" : "no_marker",
        empty: yield* isSkeleton(dir),
      });
    }
    return orphans;
  });

  const removeOrphan: ProjectLabelFolders["Service"]["removeOrphan"] = Effect.fn(
    "ProjectLabelFolders.removeOrphan",
  )(function* (dirName) {
    const orphan = (yield* listOrphans).find((candidate) => candidate.dirName === dirName);
    if (orphan === undefined || !orphan.empty) return false;
    yield* fileSystem
      .remove(orphan.path, { recursive: true })
      .pipe(Effect.mapError(fail("remove", undefined, orphan.path)));
    return true;
  });

  return ProjectLabelFolders.of({
    claimForLabel,
    removeSkeleton,
    listOrphans,
    removeOrphan,
    projectsRoot,
    dirForLabel,
    dirNameForLabel,
    ensureForLabel,
    renameForLabel,
    reconcile,
  });
});

export const layer = Layer.effect(ProjectLabelFolders, make);
