// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  PROJECT_RECALL_DEFAULT_LIMIT,
  PROJECT_RECALL_MAX_LIMIT,
  PROJECT_RESOURCE_READ_DEFAULT_LIMIT,
  ProjectLabelError,
  ProjectLabelId,
  type ProjectLabelAddResourceInput,
  type ProjectLabelAddResourceResult,
  type ProjectLabelListResourcesResult,
  type ProjectLabelReadResourceInput,
  type ProjectLabelReadResourceResult,
  type ProjectLabelRemoveResourceInput,
  type ProjectLabelRemoveResourceResult,
  type ProjectRecallResult,
  ProjectResource,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import {
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { fileHeaderMimeType } from "../workspace/fileHeaderMimeType.ts";
import {
  PROJECT_LABEL_ID_FILE,
  PROJECT_LABEL_RESOURCES_SEGMENT,
  ProjectLabelFolders,
} from "./ProjectLabelFolders.ts";

/**
 * ProjectFiles - the one way to reach project-label resource files (rule 5
 * of the project-workspaces doc). Resources are everything at the project
 * directory's top level that is not a git work tree and not the id file,
 * recursively, plus anything under `Resources/`. Identity is relative path
 * plus sha256; no absolute path crosses the wire. The SQLite index is
 * derived and rebuildable from disk.
 */
export interface ProjectFolderLocation {
  readonly labelId: ProjectLabelId;
  readonly name: string;
  readonly dir: string;
}

export class ProjectFiles extends Context.Service<
  ProjectFiles,
  {
    readonly listResources: (
      labelId: ProjectLabelId,
    ) => Effect.Effect<ProjectLabelListResourcesResult, ProjectLabelError>;
    readonly readResource: (
      input: ProjectLabelReadResourceInput,
    ) => Effect.Effect<ProjectLabelReadResourceResult, ProjectLabelError>;
    readonly createResource: (
      input: ProjectLabelAddResourceInput,
    ) => Effect.Effect<ProjectLabelAddResourceResult, ProjectLabelError>;
    readonly removeResource: (
      input: ProjectLabelRemoveResourceInput,
    ) => Effect.Effect<ProjectLabelRemoveResourceResult, ProjectLabelError>;
    readonly searchResources: (input: {
      readonly labelId: ProjectLabelId;
      readonly query: string;
      readonly limit?: number | undefined;
    }) => Effect.Effect<ProjectRecallResult, ProjectLabelError>;
    readonly subscribeResources: (
      labelId: ProjectLabelId,
    ) => Stream.Stream<ProjectLabelListResourcesResult, ProjectLabelError>;
    /** The caller's effective project folder, if any, resolved at the edge. */
    readonly folderForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ProjectFolderLocation | null, ProjectLabelError>;
    /** One folder by id, as `@` mentions name it; null when it no longer exists. */
    readonly folderById: (
      labelId: ProjectLabelId,
    ) => Effect.Effect<ProjectFolderLocation | null, ProjectLabelError>;
    /** Fast index-only listing for turn manifests; never touches the disk. */
    readonly manifestEntries: (
      labelId: ProjectLabelId,
    ) => Effect.Effect<
      { readonly entries: ReadonlyArray<string>; readonly total: number },
      ProjectLabelError
    >;
  }
>()("t3/projectLabels/ProjectFiles") {}

const MAX_RESOURCE_ENTRIES = 10_000;
const MAX_INDEXED_TEXT_BYTES = 262_144;
const MAX_HASHED_BYTES = 8_388_608;
const READ_MAX_BYTES = 262_144;
const SNIFF_BYTES = 8_192;
const RECALL_SNIPPET_CHARS = 240;
const WATCH_DEBOUNCE = Duration.millis(250);
const WATCH_RETRY = Duration.seconds(5);
const WATCH_INSTALL_TIMEOUT = Duration.seconds(10);
const MAX_DEDUPE_ATTEMPTS = 100;

const TEXT_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".mdx", "text/markdown"],
  [".csv", "text/csv"],
  [".tsv", "text/tab-separated-values"],
  [".json", "application/json"],
  [".jsonl", "application/x-ndjson"],
  [".log", "text/plain"],
  [".yaml", "text/yaml"],
  [".yml", "text/yaml"],
  [".toml", "text/plain"],
  [".ini", "text/plain"],
  [".cfg", "text/plain"],
  [".xml", "text/xml"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".css", "text/css"],
  [".scss", "text/plain"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".cjs", "text/javascript"],
  [".jsx", "text/javascript"],
  [".ts", "text/plain"],
  [".tsx", "text/plain"],
  [".mts", "text/plain"],
  [".cts", "text/plain"],
  [".py", "text/x-python"],
  [".rb", "text/x-ruby"],
  [".sh", "text/x-shellscript"],
  [".bash", "text/x-shellscript"],
  [".zsh", "text/x-shellscript"],
  [".fish", "text/x-shellscript"],
  [".c", "text/x-c"],
  [".h", "text/x-c"],
  [".cpp", "text/x-c++"],
  [".hpp", "text/x-c++"],
  [".cc", "text/x-c++"],
  [".java", "text/x-java"],
  [".go", "text/x-go"],
  [".rs", "text/x-rust"],
  [".swift", "text/x-swift"],
  [".kt", "text/x-kotlin"],
  [".sql", "text/x-sql"],
  [".graphql", "text/plain"],
  [".vue", "text/plain"],
  [".svelte", "text/plain"],
  [".url", "text/plain"],
]);

const BINARY_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".pdf", "application/pdf"],
  [".zip", "application/zip"],
  [".gz", "application/gzip"],
  [".tar", "application/x-tar"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
  [".sqlite", "application/vnd.sqlite3"],
  [".db", "application/vnd.sqlite3"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
]);

const DIRECTORY_MIME_TYPE = "inode/directory";

const isProjectLabelError = Schema.is(ProjectLabelError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const folders = yield* ProjectLabelFolders;
  const scope = yield* Effect.scope;
  // Rescans serialize: watcher events, subscriptions and mutations share it.
  const scanLock = yield* Semaphore.make(1);
  const watchers = yield* Ref.make(
    new Map<
      string,
      { readonly hub: PubSub.PubSub<void>; readonly installed: Deferred.Deferred<void> }
    >(),
  );
  // Read once like GlobalSearch: the migration fixes the engine per database.
  const fts =
    (yield* sql<{ engine: string }>`SELECT engine FROM project_resource_search_config`.pipe(
      Effect.orElseSucceed(() => [] as ReadonlyArray<{ engine: string }>),
    ))[0]?.engine === "fts5";

  const storage =
    (operation: string) =>
    (cause: unknown): ProjectLabelError =>
      isProjectLabelError(cause)
        ? cause
        : new ProjectLabelError({ operation, reason: "storage", cause });
  const missing = (operation: string) => new ProjectLabelError({ operation, reason: "not_found" });
  const invalidPath = (operation: string) =>
    new ProjectLabelError({ operation, reason: "invalid_path" });

  const requireLabel = Effect.fn("ProjectFiles.requireLabel")(function* (labelId: ProjectLabelId) {
    const rows = yield* sql<{ name: string }>`
      SELECT name FROM project_labels WHERE label_id = ${labelId}
    `.pipe(Effect.mapError(storage("read")));
    const name = rows[0]?.name;
    if (name === undefined) return yield* missing("read");
    return { id: labelId, name };
  });

  const isDirectory = (dir: string) =>
    fileSystem.stat(dir).pipe(
      Effect.map((stat) => stat.type === "Directory"),
      Effect.catch(() => Effect.succeed(false)),
    );

  const isGitWorkTree = (dir: string) =>
    fileSystem.stat(path.join(dir, ".git")).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );

  const extensionOf = (relativePath: string) => {
    const base = relativePath.slice(relativePath.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    return dot <= 0 ? "" : base.slice(dot).toLowerCase();
  };

  const hasNullByte = (bytes: Uint8Array) => {
    const end = Math.min(bytes.length, SNIFF_BYTES);
    for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
    return false;
  };

  const mimeFor = (relativePath: string, header: Uint8Array | null, text: boolean): string => {
    const known = TEXT_EXTENSIONS.get(extensionOf(relativePath));
    if (known !== undefined) return known;
    const binary = BINARY_EXTENSIONS.get(extensionOf(relativePath));
    if (binary !== undefined) return binary;
    if (header !== null) {
      const sniffed = fileHeaderMimeType(header);
      if (sniffed !== undefined) return sniffed;
    }
    return text ? "text/plain" : "application/octet-stream";
  };

  const sha256Of = (bytes: Uint8Array): string =>
    NodeCrypto.createHash("sha256").update(bytes).digest("hex");

  // Effect reports mtime as an optional Date; filesystems without one read as epoch.
  const modifiedAtOf = (stat: FileSystem.File.Info): string =>
    Option.getOrNull(stat.mtime)?.toISOString() ?? "1970-01-01T00:00:00.000Z";

  const toPosix = (value: string) => value.replaceAll("\\", "/");

  type ScannedEntry = {
    readonly relativePath: string;
    readonly kind: "file" | "folder";
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly sha256: string | undefined;
    readonly modifiedAt: string;
    readonly content: string | null;
  };

  type IndexedRow = {
    readonly relative_path: string;
    readonly kind: string;
    readonly mime_type: string;
    readonly size_bytes: number;
    readonly sha256: string | null;
    readonly modified_at: string;
    readonly content_text: string | null;
  };

  const decodeResource = Schema.decodeUnknownEffect(ProjectResource);

  // Unchanged files (same size and mtime) keep their indexed hash and text,
  // so a rescan only reads what changed.
  const scanDirectory = Effect.fn("ProjectFiles.scan")(function* (
    labelId: ProjectLabelId,
    dir: string,
  ) {
    const known = new Map<string, IndexedRow>();
    const rows = yield* sql<IndexedRow>`
      SELECT relative_path, kind, mime_type, size_bytes, sha256, modified_at, content_text
      FROM project_resource_files WHERE label_id = ${labelId}
    `.pipe(Effect.mapError(storage("scan")));
    for (const row of rows) known.set(row.relative_path, row);
    const entries: Array<ScannedEntry> = [];
    let truncated = false;
    const top = yield* fileSystem.readDirectory(dir).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed([]),
      ),
      Effect.mapError(storage("scan")),
    );
    const stack: Array<{ full: string; relative: string }> = [...top]
      .sort()
      .filter((entry) => entry !== PROJECT_LABEL_ID_FILE)
      .map((entry) => ({ full: path.join(dir, entry), relative: entry }));
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      if (entries.length >= MAX_RESOURCE_ENTRIES) {
        truncated = true;
        break;
      }
      // A file removed mid-scan simply drops out of the index.
      const stat = yield* fileSystem
        .stat(current.full)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (stat === null) continue;
      if (stat.type !== "File" && stat.type !== "Directory") continue;
      // Only top-level entries exclude git work trees; deeper content,
      // including anything under Resources/, is always a resource.
      if (!current.relative.includes("/") && stat.type === "Directory") {
        if (yield* isGitWorkTree(current.full)) continue;
      }
      const modifiedAt = modifiedAtOf(stat);
      if (stat.type === "Directory") {
        entries.push({
          relativePath: current.relative,
          kind: "folder",
          mimeType: DIRECTORY_MIME_TYPE,
          sizeBytes: 0,
          sha256: undefined,
          modifiedAt,
          content: null,
        });
        const children = yield* fileSystem
          .readDirectory(current.full)
          .pipe(Effect.catch(() => Effect.succeed([])));
        for (const child of [...children].sort().toReversed()) {
          stack.push({
            full: path.join(current.full, child),
            relative: `${current.relative}/${child}`,
          });
        }
        continue;
      }
      const sizeBytes = Number(stat.size);
      const cached = known.get(current.relative);
      if (
        cached !== undefined &&
        cached.kind === "file" &&
        cached.size_bytes === sizeBytes &&
        cached.modified_at === modifiedAt
      ) {
        entries.push({
          relativePath: current.relative,
          kind: "file",
          mimeType: cached.mime_type,
          sizeBytes,
          sha256: cached.sha256 ?? undefined,
          modifiedAt,
          content: cached.content_text,
        });
        continue;
      }
      // Oversize files are never read: no hash, no indexed text, extension mime.
      if (sizeBytes > MAX_HASHED_BYTES) {
        entries.push({
          relativePath: current.relative,
          kind: "file",
          mimeType: mimeFor(current.relative, null, false),
          sizeBytes,
          sha256: undefined,
          modifiedAt,
          content: null,
        });
        continue;
      }
      const bytes = yield* fileSystem
        .readFile(current.full)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (bytes === null) continue;
      const extension = extensionOf(current.relative);
      const text = (TEXT_EXTENSIONS.has(extension) || extension === "") && !hasNullByte(bytes);
      entries.push({
        relativePath: current.relative,
        kind: "file",
        mimeType: mimeFor(current.relative, bytes.slice(0, 32), text),
        sizeBytes,
        sha256: sha256Of(bytes),
        modifiedAt,
        content: text
          ? new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, MAX_INDEXED_TEXT_BYTES)))
          : null,
      });
    }
    return { entries, truncated };
  });

  const writeIndex = Effect.fn("ProjectFiles.writeIndex")(function* (
    labelId: ProjectLabelId,
    scanned: { readonly entries: ReadonlyArray<ScannedEntry>; readonly truncated: boolean },
  ) {
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM project_resource_files WHERE label_id = ${labelId}`;
          for (const entry of scanned.entries) {
            yield* sql`INSERT INTO project_resource_files(label_id, relative_path, kind, mime_type, size_bytes, sha256, modified_at, content_text)
            VALUES (${labelId}, ${entry.relativePath}, ${entry.kind}, ${entry.mimeType}, ${entry.sizeBytes}, ${entry.sha256 ?? null}, ${entry.modifiedAt}, ${entry.content})`;
          }
          yield* sql`INSERT INTO project_resource_index_state(label_id, truncated, scanned_at)
          VALUES (${labelId}, ${scanned.truncated ? 1 : 0}, ${DateTime.formatIso(yield* DateTime.now)})
          ON CONFLICT(label_id) DO UPDATE SET truncated = excluded.truncated, scanned_at = excluded.scanned_at`;
        }),
      )
      .pipe(Effect.mapError(storage("scan")));
  });

  const rescanLabel = Effect.fn("ProjectFiles.rescan")(function* (label: {
    readonly id: ProjectLabelId;
    readonly name: string;
  }) {
    const { dir } = yield* folders.ensureForLabel(label).pipe(Effect.mapError(storage("scan")));
    const scanned = yield* scanDirectory(label.id, dir);
    yield* writeIndex(label.id, scanned);
    return scanned;
  });

  const readIndex = Effect.fn("ProjectFiles.readIndex")(function* (labelId: ProjectLabelId) {
    const rows = yield* sql<IndexedRow>`
      SELECT relative_path, kind, mime_type, size_bytes, sha256, modified_at, content_text
      FROM project_resource_files WHERE label_id = ${labelId} ORDER BY relative_path
    `.pipe(Effect.mapError(storage("read")));
    const state = yield* sql<{ truncated: number }>`
      SELECT truncated FROM project_resource_index_state WHERE label_id = ${labelId}
    `.pipe(Effect.mapError(storage("read")));
    const resources = yield* Effect.forEach(rows, (row) =>
      decodeResource({
        relativePath: row.relative_path,
        kind: row.kind,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
        modifiedAt: row.modified_at,
      }).pipe(Effect.mapError(storage("read"))),
    );
    return { resources, truncated: (state[0]?.truncated ?? 0) === 1 };
  });

  const ensureIndexed = Effect.fn("ProjectFiles.ensureIndexed")(function* (label: {
    readonly id: ProjectLabelId;
    readonly name: string;
  }) {
    const rows = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM project_resource_files WHERE label_id = ${label.id}
    `.pipe(Effect.mapError(storage("read")));
    if ((rows[0]?.count ?? 0) === 0) yield* scanLock.withPermits(1)(rescanLabel(label));
  });

  const publish = Effect.fn("ProjectFiles.publish")(function* (labelId: ProjectLabelId) {
    const entry = (yield* Ref.get(watchers)).get(labelId);
    if (entry !== undefined) yield* PubSub.publish(entry.hub, undefined);
  });

  const listResources: ProjectFiles["Service"]["listResources"] = Effect.fn(
    "ProjectFiles.listResources",
  )(function* (labelId) {
    const label = yield* requireLabel(labelId);
    yield* scanLock.withPermits(1)(rescanLabel(label));
    return yield* readIndex(labelId);
  });

  // A relative path that stays inside the project directory. Absolute paths,
  // drive prefixes, backslashes-as-separators, and `.`/`..` segments are
  // rejected; the resolved path is containment-checked against the dir.
  const resolveResourcePath = (
    operation: string,
    dir: string,
    relativePath: string,
  ): Effect.Effect<{ readonly full: string; readonly relative: string }, ProjectLabelError> =>
    Effect.gen(function* () {
      const relative = toPosix(relativePath).trim().replace(/\/+/g, "/").replace(/^\//, "");
      const segments = relative.split("/");
      if (
        relative === "" ||
        segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
        /^[a-zA-Z]:/.test(relative)
      ) {
        return yield* invalidPath(operation);
      }
      const full = path.resolve(path.join(dir, relative));
      const root = path.resolve(dir);
      if (full !== root && !full.startsWith(`${root}${path.sep}`)) {
        return yield* invalidPath(operation);
      }
      return { full, relative };
    });

  // Membership mirrors the scan: the id file and git work trees are not
  // resources, everything else under the directory is.
  const requireMember = Effect.fn("ProjectFiles.requireMember")(function* (
    operation: string,
    dir: string,
    relative: string,
    full: string,
  ) {
    const top = relative.split("/")[0] ?? "";
    if (top === PROJECT_LABEL_ID_FILE) return yield* invalidPath(operation);
    if (yield* isDirectory(path.join(dir, top))) {
      if (yield* isGitWorkTree(path.join(dir, top))) return yield* invalidPath(operation);
    }
    return full;
  });

  // A bounded prefix read: huge files never load fully into memory.
  const readPrefix = Effect.fn("ProjectFiles.readPrefix")(function* (full: string, max: number) {
    const file = yield* fileSystem.open(full, { flag: "r" });
    const chunks: Array<Uint8Array> = [];
    let remaining = max;
    while (remaining > 0) {
      const chunk = yield* file.readAlloc(Math.min(remaining, 65536));
      if (Option.isNone(chunk)) break;
      chunks.push(chunk.value);
      remaining -= chunk.value.length;
    }
    const out = new Uint8Array(max - remaining);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  });

  // The prefix reads open file handles, so the scoped inner effect keeps the
  // service method free of Scope.
  const readResourceInner = Effect.fn("ProjectFiles.readResource")(function* (
    input: ProjectLabelReadResourceInput,
  ) {
    const label = yield* requireLabel(input.id);
    const { dir } = yield* folders.dirForLabel(label).pipe(Effect.mapError(storage("read")));
    const { full, relative } = yield* resolveResourcePath("read", dir, input.relativePath);
    yield* requireMember("read", dir, relative, full);
    const stat = yield* fileSystem
      .stat(full)
      .pipe(
        Effect.mapError((cause) =>
          cause.reason._tag === "NotFound" ? missing("read") : storage("read")(cause),
        ),
      );
    if (stat.type !== "File") return yield* invalidPath("read");
    const sizeBytes = Number(stat.size);
    const modifiedAt = modifiedAtOf(stat);
    const extension = extensionOf(relative);
    const header = yield* readPrefix(full, SNIFF_BYTES).pipe(Effect.mapError(storage("read")));
    const text = (TEXT_EXTENSIONS.has(extension) || extension === "") && !hasNullByte(header);
    const sha256 =
      sizeBytes > MAX_HASHED_BYTES
        ? undefined
        : sha256Of(yield* readPrefix(full, sizeBytes).pipe(Effect.mapError(storage("read"))));
    if (!text) {
      return {
        relativePath: relative,
        mimeType: mimeFor(relative, header.slice(0, 32), false),
        sizeBytes,
        ...(sha256 === undefined ? {} : { sha256 }),
        modifiedAt,
        binary: true,
        truncated: false,
      };
    }
    // Large text reads stop at the byte cap; the window still pages by line.
    const window = yield* readPrefix(full, READ_MAX_BYTES + 4096).pipe(
      Effect.mapError(storage("read")),
    );
    const decoded = new TextDecoder().decode(window);
    const capped = decoded.length > READ_MAX_BYTES ? decoded.slice(0, READ_MAX_BYTES) : decoded;
    const fileTruncated = sizeBytes > window.length || decoded.length > capped.length;
    const lines = capped.split("\n");
    const offset = input.offset ?? 0;
    const limit = input.limit ?? PROJECT_RESOURCE_READ_DEFAULT_LIMIT;
    const page = lines.slice(offset, offset + limit);
    const fullyRead = !fileTruncated && capped === decoded;
    return {
      relativePath: relative,
      mimeType: mimeFor(relative, header.slice(0, 32), true),
      sizeBytes,
      ...(sha256 === undefined ? {} : { sha256 }),
      modifiedAt,
      binary: false,
      text: page.join("\n"),
      truncated: offset + limit < lines.length || fileTruncated,
      ...(fullyRead ? { totalLines: lines.length } : {}),
    };
  });

  const readResource: ProjectFiles["Service"]["readResource"] = (input) =>
    Effect.scoped(readResourceInner(input));

  const sanitizeFileName = (name: string, fallback: string): string => {
    const base = toPosix(name).split("/").pop() ?? "";
    const cleaned = base
      // eslint-disable-next-line no-control-regex -- removing control characters is the point.
      .replace(/[<>:"|?*\0-\x1F\x7F\\/]+/g, "-")
      .trim()
      .replace(/[. ]+$/, "")
      .slice(0, 128)
      .replace(/[. ]+$/, "");
    return cleaned.length > 0 ? cleaned : fallback;
  };

  const dedupeName = Effect.fn("ProjectFiles.dedupeName")(function* (
    directory: string,
    name: string,
  ) {
    const dot = name.lastIndexOf(".");
    const stem = dot <= 0 ? name : name.slice(0, dot);
    const suffix = dot <= 0 ? "" : name.slice(dot);
    for (let attempt = 1; attempt <= MAX_DEDUPE_ATTEMPTS; attempt++) {
      const candidate = attempt === 1 ? name : `${stem} (${attempt})${suffix}`;
      const exists = yield* fileSystem
        .exists(path.join(directory, candidate))
        .pipe(Effect.mapError(storage("add")));
      if (!exists) return candidate;
    }
    return yield* new ProjectLabelError({ operation: "add", reason: "storage" });
  });

  const createResource: ProjectFiles["Service"]["createResource"] = Effect.fn(
    "ProjectFiles.createResource",
  )(function* (input) {
    const label = yield* requireLabel(input.id);
    const { dir } = yield* folders.ensureForLabel(label).pipe(Effect.mapError(storage("add")));
    const resourcesDir = path.join(dir, PROJECT_LABEL_RESOURCES_SEGMENT);
    yield* fileSystem
      .makeDirectory(resourcesDir, { recursive: true })
      .pipe(Effect.mapError(storage("add")));
    const kind = input.resource.kind;
    let fileName: string;
    if (kind === "upload") {
      const { attachmentId } = input.resource;
      if (parseThreadSegmentFromAttachmentId(attachmentId) !== PENDING_ATTACHMENT_THREAD_SEGMENT) {
        return yield* invalidPath("add");
      }
      const source = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId,
      });
      if (source === null) return yield* missing("add");
      const diskBase = source.slice(source.lastIndexOf("/") + 1);
      const diskExtension = diskBase.includes(".") ? diskBase.slice(diskBase.lastIndexOf(".")) : "";
      const wanted = sanitizeFileName(
        input.resource.fileName ?? `upload${diskExtension}`,
        `upload${diskExtension}`,
      );
      fileName = yield* dedupeName(
        resourcesDir,
        wanted.includes(".") || diskExtension === "" ? wanted : `${wanted}${diskExtension}`,
      );
      const target = path.join(resourcesDir, fileName);
      // A rename across filesystems fails; copy and remove instead.
      yield* fileSystem.rename(source, target).pipe(
        Effect.catch(() =>
          fileSystem.copyFile(source, target).pipe(Effect.andThen(fileSystem.remove(source))),
        ),
        Effect.mapError(storage("add")),
      );
    } else if (kind === "link") {
      const { url } = input.resource;
      if (!/^https?:\/\//i.test(url)) return yield* invalidPath("add");
      const wanted = sanitizeFileName(input.resource.name, "link");
      fileName = yield* dedupeName(
        resourcesDir,
        wanted.toLowerCase().endsWith(".url") ? wanted : `${wanted}.url`,
      );
      yield* fileSystem
        .writeFileString(path.join(resourcesDir, fileName), `[InternetShortcut]\nURL=${url}\n`)
        .pipe(Effect.mapError(storage("add")));
    } else {
      const wanted = sanitizeFileName(input.resource.title, "note");
      fileName = yield* dedupeName(
        resourcesDir,
        wanted.toLowerCase().endsWith(".md") ? wanted : `${wanted}.md`,
      );
      const text = input.resource.text;
      yield* fileSystem
        .writeFileString(
          path.join(resourcesDir, fileName),
          text.endsWith("\n") ? text : `${text}\n`,
        )
        .pipe(Effect.mapError(storage("add")));
    }
    const relative = `${PROJECT_LABEL_RESOURCES_SEGMENT}/${fileName}`;
    yield* scanLock.withPermits(1)(rescanLabel(label));
    yield* publish(label.id);
    const stat = yield* fileSystem
      .stat(path.join(resourcesDir, fileName))
      .pipe(Effect.mapError(storage("add")));
    return {
      resource: {
        relativePath: relative,
        kind: "file" as const,
        mimeType: mimeFor(relative, null, kind !== "upload"),
        sizeBytes: Number(stat.size),
        modifiedAt: modifiedAtOf(stat),
      },
    };
  });

  const removeResource: ProjectFiles["Service"]["removeResource"] = Effect.fn(
    "ProjectFiles.removeResource",
  )(function* (input) {
    const label = yield* requireLabel(input.id);
    const { dir } = yield* folders.dirForLabel(label).pipe(Effect.mapError(storage("remove")));
    const { full, relative } = yield* resolveResourcePath("remove", dir, input.relativePath);
    yield* requireMember("remove", dir, relative, full);
    const stat = yield* fileSystem.stat(full).pipe(Effect.catch(() => Effect.succeed(null)));
    if (stat === null) return { removed: false };
    // No trash helper exists in the repo, so removal deletes.
    yield* fileSystem
      .remove(full, { recursive: stat.type === "Directory", force: true })
      .pipe(Effect.mapError(storage("remove")));
    yield* scanLock.withPermits(1)(rescanLabel(label));
    yield* publish(label.id);
    return { removed: true };
  });

  const tokenize = (query: string): ReadonlyArray<string> =>
    query
      .match(/[\p{L}\p{N}_]+/gu)
      ?.slice(0, 32)
      .map((token) => token.toLowerCase()) ?? [];

  const snippetAround = (text: string, tokens: ReadonlyArray<string>): string => {
    const lower = text.toLowerCase();
    let at = -1;
    for (const token of tokens) {
      const found = lower.indexOf(token);
      if (found >= 0 && (at < 0 || found < at)) at = found;
    }
    if (at < 0) return text.slice(0, RECALL_SNIPPET_CHARS);
    const start = Math.max(0, at - 60);
    const end = Math.min(text.length, start + RECALL_SNIPPET_CHARS);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < text.length ? "…" : "";
    return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
  };

  const searchResources: ProjectFiles["Service"]["searchResources"] = Effect.fn(
    "ProjectFiles.searchResources",
  )(function* (input) {
    const label = yield* requireLabel(input.labelId);
    const tokens = tokenize(input.query.trim().slice(0, 500));
    if (tokens.length === 0) return { matches: [] };
    const limit = Math.min(
      Math.max(input.limit ?? PROJECT_RECALL_DEFAULT_LIMIT, 1),
      PROJECT_RECALL_MAX_LIMIT,
    );
    yield* ensureIndexed(label);
    if (fts) {
      // Quote every token; FTS operators, quotes and punctuation are user text.
      const match = tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
      const rows = yield* sql
        .unsafe<{
          relative_path: string;
          kind: string;
          mime_type: string;
          excerpt: string;
        }>(
          `SELECT f.relative_path, f.kind, f.mime_type,
          substr(snippet(project_resource_fts, 1, '', '', '…', 32), 1, 240) AS excerpt
          FROM project_resource_fts JOIN project_resource_files f
          ON f.rowid = project_resource_fts.rowid
          WHERE project_resource_fts MATCH ? AND f.label_id = ?
          ORDER BY bm25(project_resource_fts) LIMIT ?`,
          [match, label.id, limit],
        )
        .pipe(Effect.mapError(storage("search")));
      return {
        matches: rows.map((row) => ({
          relativePath: row.relative_path,
          kind: (row.kind === "folder" ? "folder" : "file") as "file" | "folder",
          mimeType: row.mime_type,
          snippet: row.excerpt.trim() === "" ? row.relative_path : row.excerpt,
        })),
      };
    }
    const escapeLike = (token: string) =>
      `%${token.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;
    const conditions = tokens
      .map(() => `(relative_path LIKE ? ESCAPE '!' OR content_text LIKE ? ESCAPE '!')`)
      .join(" AND ");
    const params: Array<string | number> = [label.id];
    for (const token of tokens) params.push(escapeLike(token), escapeLike(token));
    params.push(limit);
    const rows = yield* sql
      .unsafe<{
        relative_path: string;
        kind: string;
        mime_type: string;
        content_text: string | null;
      }>(
        `SELECT relative_path, kind, mime_type, substr(content_text, 1, 4000) AS content_text
        FROM project_resource_files WHERE label_id = ? AND (${conditions})
        ORDER BY relative_path LIMIT ?`,
        params,
      )
      .pipe(Effect.mapError(storage("search")));
    return {
      matches: rows.map((row) => ({
        relativePath: row.relative_path,
        kind: (row.kind === "folder" ? "folder" : "file") as "file" | "folder",
        mimeType: row.mime_type,
        snippet:
          row.content_text === null || row.content_text.trim() === ""
            ? row.relative_path
            : snippetAround(row.content_text.replace(/\s+/g, " "), tokens),
      })),
    };
  });

  // One debounced recursive watch per subscribed label. Each cycle re-resolves
  // the directory, so a label rename moves the watch along; a deleted label
  // ends its watcher. A missing directory publishes an empty index and retries.
  // watcherFor returns only once the watch is installed and capturing (or the
  // loop is live on a missing directory), so a write after subscribing always
  // produces an emission: anything before install was covered by the warm scan.
  const watcherFor = Effect.fn("ProjectFiles.watcherFor")(function* (label: {
    readonly id: ProjectLabelId;
    readonly name: string;
  }) {
    const labelId = label.id;
    const installed = yield* Deferred.make<void>();
    const claim = yield* Ref.modify(watchers, (all) => {
      const existing = all.get(labelId);
      if (existing !== undefined) return [existing, all] as const;
      return [null, all] as const;
    });
    if (claim !== null) {
      yield* Deferred.await(claim.installed);
      return claim.hub;
    }
    // The warm scan runs before the fork, so the directory deterministically
    // exists when the first cycle starts.
    yield* scanLock.withPermits(1)(rescanLabel(label));
    const hub = yield* PubSub.sliding<void>(1);
    const entry = { hub, installed };
    yield* Ref.update(watchers, (all) => {
      if (all.has(labelId)) return all;
      return new Map(all).set(labelId, entry);
    });
    const current = (yield* Ref.get(watchers)).get(labelId) ?? entry;
    if (current !== entry) {
      yield* Deferred.await(current.installed);
      return current.hub;
    }
    const cycle = Effect.gen(function* () {
      const rows = yield* sql<{ name: string }>`
        SELECT name FROM project_labels WHERE label_id = ${labelId}
      `;
      const name = rows[0]?.name;
      if (name === undefined) {
        yield* Ref.update(watchers, (all) => {
          const next = new Map(all);
          next.delete(labelId);
          return next;
        });
        yield* Deferred.succeed(installed, undefined);
        return yield* Effect.interrupt;
      }
      const live = { id: labelId, name };
      const { dir } = yield* folders.dirForLabel(live);
      if (!(yield* isDirectory(dir))) {
        yield* writeIndex(labelId, { entries: [], truncated: false }).pipe(
          Effect.catch(() => Effect.void),
        );
        yield* publish(labelId);
        yield* Deferred.succeed(installed, undefined);
        yield* Effect.sleep(WATCH_RETRY);
        return;
      }
      yield* fileSystem
        .watch(dir, {
          recursive: true,
          onReady: () => {
            Effect.runFork(Deferred.succeed(installed, undefined));
          },
        })
        .pipe(
          Stream.debounce(WATCH_DEBOUNCE),
          Stream.take(1),
          Stream.runDrain,
          Effect.catch(() => Effect.sleep(WATCH_RETRY)),
        );
      yield* scanLock
        .withPermits(1)(rescanLabel(live))
        .pipe(Effect.ignoreCause({ log: true }));
      yield* publish(labelId);
    });
    yield* Effect.forever(cycle).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope));
    // A watcher that never installs (broken filesystem) degrades to explicit
    // rescans rather than hanging the subscription.
    yield* Deferred.await(installed).pipe(
      Effect.timeout(WATCH_INSTALL_TIMEOUT),
      Effect.catch(() =>
        Effect.logWarning("Project watcher did not install; live updates will lag.", {
          labelId,
        }),
      ),
    );
    return hub;
  });

  const subscribeResources: ProjectFiles["Service"]["subscribeResources"] = (labelId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const label = yield* requireLabel(labelId);
        const hub = yield* watcherFor(label);
        const subscription = yield* PubSub.subscribe(hub);
        return Stream.concat(
          Stream.fromEffect(readIndex(labelId)),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => readIndex(labelId))),
        );
      }),
    );

  const folderById: ProjectFiles["Service"]["folderById"] = Effect.fn("ProjectFiles.folderById")(
    function* (labelId) {
      const rows = yield* sql<{ name: string }>`
        SELECT name FROM project_labels WHERE label_id = ${labelId}
      `.pipe(Effect.mapError(storage("read")));
      const name = rows[0]?.name;
      if (name === undefined) return null;
      const { dir } = yield* folders
        .dirForLabel({ id: labelId, name })
        .pipe(Effect.mapError(storage("read")));
      return { labelId, name, dir };
    },
  );

  const folderForThread: ProjectFiles["Service"]["folderForThread"] = Effect.fn(
    "ProjectFiles.folderForThread",
  )(function* (threadId) {
    const membership = yield* sql<{ folder_id: string | null }>`
      SELECT folder_id FROM effective_thread_project_folders WHERE thread_id = ${threadId}
    `.pipe(Effect.mapError(storage("read")));
    const folderId = membership[0]?.folder_id;
    if (folderId === null || folderId === undefined) return null;
    return yield* folderById(ProjectLabelId.make(folderId));
  });

  const manifestEntries: ProjectFiles["Service"]["manifestEntries"] = Effect.fn(
    "ProjectFiles.manifestEntries",
  )(function* (labelId) {
    const rows = yield* sql<{ relative_path: string }>`
      SELECT relative_path FROM project_resource_files
      WHERE label_id = ${labelId} ORDER BY relative_path LIMIT 31
    `.pipe(Effect.mapError(storage("read")));
    const total = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM project_resource_files WHERE label_id = ${labelId}
    `.pipe(Effect.mapError(storage("read")));
    return {
      entries: rows.map((row) => row.relative_path),
      total: total[0]?.count ?? 0,
    };
  });

  return ProjectFiles.of({
    listResources,
    readResource,
    createResource,
    removeResource,
    searchResources,
    subscribeResources,
    folderForThread,
    folderById,
    manifestEntries,
  });
});

export const layer = Layer.effect(ProjectFiles, make);
