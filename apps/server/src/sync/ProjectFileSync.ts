// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  type EnvironmentId,
  PROJECT_FILE_BLOB_CHUNK_BYTES,
  PROJECT_FILE_SYNC_MAX_BYTES,
  ProjectFileBlobError,
  ProjectFileBlobRead,
  ProjectLabelId,
  SharedStateError,
} from "@cogenly/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Machines from "../machines/Machines.ts";
import * as PeerChannels from "../machines/PeerChannels.ts";
import {
  isReservedEntry,
  PROJECT_FILE_PARTIAL_SUFFIX,
  ProjectFiles,
  type ProjectSyncEntry,
} from "../projectLabels/ProjectFiles.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import {
  decodeProjectFile,
  projectFileDocumentId,
  type ProjectFileFields,
} from "./documentSchemas.ts";
import { SharedState } from "./SharedState.ts";

/**
 * ProjectFileSync replicates the files and folders in each project folder
 * (everything ProjectFiles lists; never `repos/` or worktrees) to every paired
 * machine. One `project-file` shared document per project and path carries
 * the content hash, never the bytes; a machine that lacks the content reads
 * it in chunks from a peer over `ProjectFileBlobRead`. See
 * docs/internals/project-workspaces.md.
 */
export class ProjectFileSync extends Context.Service<
  ProjectFileSync,
  {
    /** Publishes local changes and applies peers' for one project. */
    readonly reconcileProject: (labelId: ProjectLabelId) => Effect.Effect<void, SharedStateError>;
    /** The same for every project, when paired. */
    readonly reconcile: Effect.Effect<void, SharedStateError>;
  }
>()("cogenly-server/sync/ProjectFileSync") {}

type SyncedState = { readonly kind: "file" | "folder"; readonly sha256: string | null };
type Document = {
  readonly id: string;
  readonly fields: ProjectFileFields;
  readonly author: string;
};

const isSharedStateError = Schema.is(SharedStateError);
const storage = (cause: unknown) =>
  isSharedStateError(cause) ? cause : new SharedStateError({ reason: "storage", cause });

const FULL_PASS_INTERVAL = Duration.minutes(1);
const BLOB_CALL_TIMEOUT = Duration.seconds(30);

/** `brief.pdf` loses to a peer's edit: `brief (conflict from MacBook).pdf`. */
export const conflictName = (name: string, machine: string, attempt: number) => {
  const dot = name.lastIndexOf(".");
  const stem = dot <= 0 ? name : name.slice(0, dot);
  const extension = dot <= 0 ? "" : name.slice(dot);
  // eslint-disable-next-line no-control-regex -- removing control characters is the point.
  const safeMachine = machine.replace(/[<>:"/\\|?*\0-\x1F\x7F]+/g, "-").slice(0, 60);
  const suffix = attempt === 1 ? "" : ` ${attempt}`;
  return `${stem} (conflict from ${safeMachine}${suffix})${extension}`;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const shared = yield* SharedState;
  const files = yield* ProjectFiles;
  const machines = yield* Machines.Machines;
  const channels = yield* PeerChannels.PeerChannels;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const permit = yield* Semaphore.make(1);

  const sha256OfFile = (full: string) =>
    Effect.suspend(() => {
      const hash = NodeCrypto.createHash("sha256");
      return fileSystem.stream(full).pipe(
        Stream.runForEach((chunk) => Effect.sync(() => void hash.update(chunk))),
        Effect.map(() => hash.digest("hex")),
      );
    });

  // Serves any file this machine indexes with that content. The receiver
  // verifies the whole file's hash, so a file changing mid-read only fails it.
  yield* channels.register(ProjectFileBlobRead, ({ sha256, offset }) =>
    Effect.gen(function* () {
      const full = yield* files
        .fileWithSha256(sha256)
        .pipe(Effect.mapError(() => new ProjectFileBlobError({ reason: "storage" })));
      if (full === null) return yield* new ProjectFileBlobError({ reason: "not-found" });
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fileSystem.open(full, { flag: "r" });
          const totalBytes = Number((yield* file.stat).size);
          if (offset > totalBytes || totalBytes > PROJECT_FILE_SYNC_MAX_BYTES)
            return yield* new ProjectFileBlobError({ reason: "not-found" });
          yield* file.seek(BigInt(offset), "start");
          const chunks: Array<Uint8Array> = [];
          let remaining = Math.min(PROJECT_FILE_BLOB_CHUNK_BYTES, totalBytes - offset);
          while (remaining > 0) {
            const chunk = yield* file.readAlloc(remaining);
            if (Option.isNone(chunk)) break;
            chunks.push(chunk.value);
            remaining -= chunk.value.length;
          }
          return { totalBytes, base64: Buffer.concat(chunks).toString("base64") };
        }),
      ).pipe(
        Effect.catchTags({
          PlatformError: () => Effect.fail(new ProjectFileBlobError({ reason: "storage" })),
        }),
      );
    }),
  );

  // Fills `partial` with the content, from this machine when it has it, else
  // from a peer; true once the file there has exactly that hash.
  const fetchContent = Effect.fn("ProjectFileSync.fetchContent")(function* (
    sha256: string,
    partial: string,
    sources: ReadonlyArray<EnvironmentId>,
  ) {
    const verified = sha256OfFile(partial).pipe(
      Effect.map((actual) => actual === sha256),
      Effect.orElseSucceed(() => false),
    );
    const local = yield* files.fileWithSha256(sha256).pipe(Effect.orElseSucceed(() => null));
    if (local !== null) {
      const copied = yield* fileSystem.copyFile(local, partial).pipe(
        Effect.andThen(verified),
        Effect.orElseSucceed(() => false),
      );
      if (copied) return true;
    }
    for (const source of sources) {
      const done = yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fileSystem.open(partial, { flag: "w" });
          let offset = 0;
          let total = Number.POSITIVE_INFINITY;
          while (offset < total) {
            const chunk = yield* machines
              .call(source, ProjectFileBlobRead, { sha256, offset })
              .pipe(Effect.timeout(BLOB_CALL_TIMEOUT));
            total = chunk.totalBytes;
            if (total > PROJECT_FILE_SYNC_MAX_BYTES) return false;
            const bytes = new Uint8Array(Buffer.from(chunk.base64, "base64"));
            if (bytes.length === 0 && offset < total) return false;
            yield* file.write(bytes);
            offset += bytes.length;
          }
          return true;
        }),
      ).pipe(Effect.orElseSucceed(() => false));
      if (done && (yield* verified)) return true;
    }
    return false;
  });

  const loadState = Effect.fn("ProjectFileSync.loadState")(function* (labelId: ProjectLabelId) {
    const rows = yield* sql<{ relative_path: string; kind: string; sha256: string | null }>`
      SELECT relative_path, kind, sha256 FROM project_file_sync_state WHERE label_id = ${labelId}
    `;
    return new Map<string, SyncedState>(
      rows.map((row) => [
        row.relative_path,
        { kind: row.kind === "folder" ? "folder" : "file", sha256: row.sha256 },
      ]),
    );
  });
  const setState = (labelId: ProjectLabelId, relativePath: string, state: SyncedState) =>
    sql`INSERT INTO project_file_sync_state(label_id, relative_path, kind, sha256)
      VALUES (${labelId}, ${relativePath}, ${state.kind}, ${state.sha256})
      ON CONFLICT(label_id, relative_path) DO UPDATE SET kind = excluded.kind, sha256 = excluded.sha256`;
  const dropState = (labelId: ProjectLabelId, relativePath: string) =>
    sql`DELETE FROM project_file_sync_state WHERE label_id = ${labelId} AND relative_path = ${relativePath}`;

  const loadDocuments = Effect.fn("ProjectFileSync.loadDocuments")(function* (
    labelId: ProjectLabelId,
  ) {
    const rows = yield* sql<{ id: string }>`
      SELECT id FROM shared_documents
      WHERE kind = 'project-file' AND json_extract(fields_json, '$.projectId') = ${labelId}
    `;
    const documents = new Map<string, Document>();
    for (const { id } of rows) {
      const document = yield* shared.get("project-file", id);
      if (!document || document.tombstone) continue;
      const fields = decodeProjectFile(document.fields);
      // A document this build cannot read yet waits; one whose id does not
      // name its own project and path is never applied.
      if (Option.isNone(fields)) continue;
      if (projectFileDocumentId(fields.value.projectId, fields.value.path) !== id) continue;
      documents.set(fields.value.path, {
        id,
        fields: fields.value,
        author: document.clocks.entry?.node ?? document.updatedBy,
      });
    }
    return documents;
  });

  const publish = (
    labelId: ProjectLabelId,
    relativePath: string,
    entry: ProjectFileFields["entry"],
  ) =>
    shared.write("project-file", projectFileDocumentId(labelId, relativePath), {
      projectId: labelId,
      path: relativePath,
      entry,
    });

  const isWithin = (root: string, target: string) =>
    target === root || target.startsWith(`${root}${path.sep}`);

  // The absolute path for a document's relative path, or null when it would
  // land somewhere project files never live: a reserved folder, a repository,
  // an in-flight download, or outside the folder through a symlink.
  const targetFor = Effect.fn("ProjectFileSync.targetFor")(function* (
    dir: string,
    relativePath: string,
  ) {
    const segments = relativePath.split("/");
    const top = segments[0] ?? "";
    if (isReservedEntry(top) || relativePath.endsWith(PROJECT_FILE_PARTIAL_SUFFIX)) return null;
    const realRoot = yield* fileSystem.realPath(dir).pipe(Effect.orElseSucceed(() => dir));
    if (
      yield* fileSystem.exists(path.join(dir, top, ".git")).pipe(Effect.orElseSucceed(() => false))
    )
      return null;
    let at = dir;
    for (const segment of segments) {
      at = path.join(at, segment);
      const real = yield* fileSystem.realPath(at).pipe(Effect.option);
      if (Option.isNone(real)) break;
      if (!isWithin(realRoot, real.value)) return null;
    }
    return path.join(dir, ...segments);
  });

  const makeParents = Effect.fn("ProjectFileSync.makeParents")(function* (
    dir: string,
    relativePath: string,
  ) {
    const parent = relativePath.split("/").slice(0, -1).join("/");
    if (parent === "") return true;
    const target = yield* targetFor(dir, parent);
    if (target === null) return false;
    yield* fileSystem.makeDirectory(target, { recursive: true });
    return true;
  });

  const freeConflictPath = Effect.fn("ProjectFileSync.freeConflictPath")(function* (
    full: string,
    machine: string,
  ) {
    const directory = path.dirname(full);
    const name = path.basename(full);
    for (let attempt = 1; attempt <= 100; attempt++) {
      const candidate = path.join(directory, conflictName(name, machine, attempt));
      if (!(yield* fileSystem.exists(candidate))) return candidate;
    }
    return null;
  });

  const peerSources = Effect.fn("ProjectFileSync.peerSources")(function* (author: string) {
    const view = yield* machines.list;
    const online = view.machines.filter(
      (machine) => machine.online && (machine.relation === "hub" || machine.relation === "spoke"),
    );
    // The author first: it certainly has the content. A spoke reaches others through its hub.
    return [
      ...online.filter((machine) => machine.environmentId === author),
      ...online.filter((machine) => machine.environmentId !== author),
    ].map((machine) => machine.environmentId);
  });

  const reconcileInner = Effect.fn("ProjectFileSync.reconcileProject")(function* (
    labelId: ProjectLabelId,
  ) {
    const view = yield* machines.list;
    if (view.link._tag === "standalone") return;
    const self =
      view.machines.find((machine) => machine.relation === "this")?.name ?? "this machine";
    const scan = yield* files.syncScan(labelId);
    const local = new Map<string, ProjectSyncEntry>(
      scan.entries.map((entry) => [entry.relativePath, entry]),
    );
    const state = yield* loadState(labelId);
    let documents = yield* loadDocuments(labelId);

    // Capture: anything that differs from what this machine last agreed is a local edit.
    for (const entry of local.values()) {
      // Too large to replicate: neither published nor mistaken for a delete.
      if (entry.kind === "file" && entry.sha256 === undefined) continue;
      const sha256 = entry.sha256 ?? null;
      const agreed = state.get(entry.relativePath);
      if (agreed && agreed.kind === entry.kind && agreed.sha256 === sha256) continue;
      const document = documents.get(entry.relativePath)?.fields.entry;
      if (
        !(
          document &&
          !document.deleted &&
          document.kind === entry.kind &&
          document.sha256 === sha256
        )
      ) {
        yield* publish(labelId, entry.relativePath, {
          kind: entry.kind,
          sha256,
          sizeBytes: entry.kind === "file" ? entry.sizeBytes : 0,
          baseSha256: agreed?.sha256 ?? null,
          deleted: false,
        });
      }
      yield* setState(labelId, entry.relativePath, { kind: entry.kind, sha256 });
      state.set(entry.relativePath, { kind: entry.kind, sha256 });
    }
    for (const [relativePath, agreed] of state) {
      if (local.has(relativePath)) continue;
      const document = documents.get(relativePath)?.fields.entry;
      if (document && !document.deleted)
        yield* publish(labelId, relativePath, {
          kind: agreed.kind,
          sha256: null,
          sizeBytes: 0,
          baseSha256: agreed.sha256,
          deleted: true,
        });
      yield* dropState(labelId, relativePath);
      state.delete(relativePath);
    }

    // Apply: folders before their files, deletes after, deepest first.
    documents = yield* loadDocuments(labelId);
    const depth = (relativePath: string) => relativePath.split("/").length;
    const ordered = [...documents.values()].sort((a, b) => {
      const rank = (document: Document) =>
        document.fields.entry.deleted ? 2 : document.fields.entry.kind === "folder" ? 0 : 1;
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return rank(a) === 2
        ? depth(b.fields.path) - depth(a.fields.path)
        : depth(a.fields.path) - depth(b.fields.path);
    });
    let changed = false;
    for (const { fields, author } of ordered) {
      const relativePath = fields.path;
      const entry = fields.entry;
      const full = yield* targetFor(scan.dir, relativePath);
      if (full === null) continue;
      const present = local.get(relativePath);
      const agreed = state.get(relativePath);
      if (entry.deleted) {
        if (present === undefined) {
          if (agreed) yield* dropState(labelId, relativePath);
          continue;
        }
        if (present.kind === "folder") {
          if (entry.kind !== "folder") continue;
          // Only an emptied folder goes; anything still inside keeps it.
          const removed = yield* fileSystem.readDirectory(full).pipe(
            Effect.flatMap((children) =>
              children.length === 0
                ? fileSystem.remove(full, { recursive: true }).pipe(Effect.as(true))
                : Effect.succeed(false),
            ),
            Effect.orElseSucceed(() => false),
          );
          if (removed) {
            yield* dropState(labelId, relativePath);
            changed = true;
          }
          continue;
        }
        // A file edited here since it was agreed outlives a peer's delete.
        if (
          present.sha256 !== undefined &&
          (agreed?.sha256 === present.sha256 || present.sha256 === entry.baseSha256)
        ) {
          yield* fileSystem.remove(full, { force: true });
          yield* dropState(labelId, relativePath);
          changed = true;
        }
        continue;
      }
      if (entry.kind === "folder") {
        if (present?.kind === "file") continue;
        if (present === undefined) {
          yield* fileSystem.makeDirectory(full, { recursive: true });
          changed = true;
        }
        if (agreed?.kind !== "folder")
          yield* setState(labelId, relativePath, { kind: "folder", sha256: null });
        continue;
      }
      const sha256 = entry.sha256;
      if (sha256 === null || entry.sizeBytes > PROJECT_FILE_SYNC_MAX_BYTES) continue;
      if (present?.kind === "folder") continue;
      if (present !== undefined && present.sha256 === sha256) {
        if (agreed?.sha256 !== sha256)
          yield* setState(labelId, relativePath, { kind: "file", sha256 });
        continue;
      }
      if (present !== undefined && present.sha256 === undefined) continue;
      if (!(yield* makeParents(scan.dir, relativePath))) continue;
      const partial = `${full}${PROJECT_FILE_PARTIAL_SUFFIX}`;
      const fetched = yield* fetchContent(sha256, partial, yield* peerSources(author));
      if (!fetched) {
        yield* fileSystem.remove(partial, { force: true }).pipe(Effect.ignore);
        continue;
      }
      // The peer's version wins this path. When it was not made from this
      // machine's version, this machine's version is kept beside it.
      if (present !== undefined && present.sha256 !== entry.baseSha256) {
        const conflict = yield* freeConflictPath(full, self);
        if (conflict === null) {
          yield* fileSystem.remove(partial, { force: true }).pipe(Effect.ignore);
          continue;
        }
        yield* fileSystem.copyFile(full, conflict);
      }
      yield* fileSystem.rename(partial, full);
      yield* setState(labelId, relativePath, { kind: "file", sha256 });
      changed = true;
    }
    // The rescan publishes the change, which runs one more pass: it captures
    // any conflict copy and otherwise finds nothing to do.
    if (changed) yield* files.refresh(labelId);
  });

  const reconcileProject: ProjectFileSync["Service"]["reconcileProject"] = (labelId) =>
    reconcileInner(labelId).pipe(Effect.mapError(storage), permit.withPermits(1));

  const lastFullPass = yield* Ref.make(0);
  const reconcile: ProjectFileSync["Service"]["reconcile"] = Effect.gen(function* () {
    const view = yield* machines.list.pipe(Effect.mapError(storage));
    if (view.link._tag === "standalone") return;
    yield* Ref.set(lastFullPass, yield* Clock.currentTimeMillis);
    const labels = yield* sql<{ label_id: string }>`SELECT label_id FROM project_labels`.pipe(
      Effect.mapError(storage),
    );
    for (const { label_id } of labels) {
      yield* reconcileProject(ProjectLabelId.make(label_id)).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Project file sync deferred", {
            labelId: label_id,
            reason: error.reason,
          }),
        ),
      );
    }
  });

  return {
    service: ProjectFileSync.of({ reconcileProject, reconcile }),
    lastFullPass,
  };
});

/** Without the background passes, for tests that drive them. */
export const layerWithoutWatch = Layer.effect(
  ProjectFileSync,
  make.pipe(Effect.map(({ service }) => service)),
);

export const layer = Layer.effect(
  ProjectFileSync,
  Effect.gen(function* () {
    const { service, lastFullPass } = yield* make;
    const files = yield* ProjectFiles;
    const shared = yield* SharedState;
    const machines = yield* Machines.Machines;
    const scheduler = yield* Scheduler.Scheduler;
    const quietly = (effect: Effect.Effect<void, SharedStateError>) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("Project file sync pass deferred", { reason: error.reason }),
        ),
      );
    // Existing projects: linked files become real copies once, before anything syncs.
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const labels = yield* sql<{ label_id: string }>`SELECT label_id FROM project_labels`;
      for (const { label_id } of labels) {
        const copied = yield* files
          .copyLinkedFiles(ProjectLabelId.make(label_id))
          .pipe(Effect.orElseSucceed(() => 0));
        if (copied > 0)
          yield* Effect.logInfo("Copied linked project files into the project folder", {
            labelId: label_id,
            copied,
          });
      }
    }).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);
    // A local change reconciles its project; a peer's change or a new pairing everything.
    const pending = yield* Ref.make(new Set<ProjectLabelId>());
    const wake = yield* Queue.sliding<void>(1);
    yield* files.changes.pipe(
      Stream.runForEach((labelId) =>
        Ref.update(pending, (current) => new Set(current).add(labelId)).pipe(
          Effect.andThen(Queue.offer(wake, undefined)),
        ),
      ),
      Effect.forkScoped,
    );
    yield* Queue.take(wake).pipe(
      // A burst of writes (an upload of many files) settles into one pass.
      Effect.andThen(Effect.sleep(Duration.millis(500))),
      Effect.andThen(Ref.getAndSet(pending, new Set())),
      Effect.flatMap((labels) =>
        Effect.forEach(labels, (labelId) => quietly(service.reconcileProject(labelId)), {
          discard: true,
        }),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* Stream.merge(shared.changes, machines.subscribe.pipe(Stream.as(undefined))).pipe(
      Stream.debounce(Duration.seconds(1)),
      Stream.runForEach(() => quietly(service.reconcile)),
      Effect.ignoreCause,
      Effect.forkScoped,
    );
    // A slow catch-all for edits made while no watcher was running.
    yield* scheduler.register(
      "project-files",
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now - (yield* Ref.get(lastFullPass)) < Duration.toMillis(FULL_PASS_INTERVAL)) return;
        yield* quietly(service.reconcile);
      }),
    );
    return service;
  }),
);
