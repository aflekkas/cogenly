import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectLabelId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { createPendingAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Files from "./ProjectFiles.ts";
import * as Folders from "./ProjectLabelFolders.ts";

const database = Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer));

const foldersLayer = (prefix: string) =>
  Folders.layer.pipe(
    Layer.provideMerge(database),
    Layer.provideMerge(ServerConfig.layerTest("/tmp", { prefix })),
    Layer.provideMerge(ServerSettings.layerTest({})),
    Layer.provideMerge(NodeServices.layer),
  );

const filesLayer = (prefix: string) =>
  Files.layer.pipe(
    Layer.provideMerge(foldersLayer(prefix)),
    Layer.provideMerge(NodeServices.layer),
  );

const seedLabel = (id: string, name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO project_labels(label_id, name, created_at, updated_at) VALUES (${id}, ${name}, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
  });

const labelRef = (id: string, name: string) => ({ id: ProjectLabelId.make(id), name });

describe("project files", () => {
  it.effect("lists resources and skips git trees and the id file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = yield* Files.ProjectFiles;
      const folders = yield* Folders.ProjectLabelFolders;
      const label = labelRef("label:list", "List Me");
      yield* seedLabel(label.id, label.name);
      const { dir } = yield* folders.ensureForLabel(label);
      yield* fs.writeFileString(path.join(dir, "Resources", "notes.md"), "# notes\n");
      yield* fs.writeFileString(path.join(dir, "top.txt"), "top\n");
      yield* fs.makeDirectory(path.join(dir, "repo", ".git"), { recursive: true });
      yield* fs.writeFileString(path.join(dir, "repo", "code.ts"), "code\n");
      const { resources, truncated } = yield* files.listResources(label.id);
      expect(truncated).toBe(false);
      const paths = resources.map((resource) => resource.relativePath).sort();
      expect(paths).toContain("Resources/notes.md");
      expect(paths).toContain("top.txt");
      expect(paths).toContain("Resources");
      expect(paths).not.toContain("repo");
      expect(paths.some((p) => p.startsWith("repo/"))).toBe(false);
      expect(paths).not.toContain(".cogenly-project.json");
      const notes = resources.find((resource) => resource.relativePath === "Resources/notes.md");
      expect(notes?.kind).toBe("file");
      expect(notes?.mimeType).toBe("text/markdown");
      expect(notes?.sha256).toMatch(/^[0-9a-f]{64}$/);
    }).pipe(Effect.provide(filesLayer("label-files-list"))),
  );

  it.effect("reads paged text and marks other files binary", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = yield* Files.ProjectFiles;
      const folders = yield* Folders.ProjectLabelFolders;
      const label = labelRef("label:read", "Read Me");
      yield* seedLabel(label.id, label.name);
      const { dir } = yield* folders.ensureForLabel(label);
      const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
      yield* fs.writeFileString(path.join(dir, "Resources", "log.txt"), `${lines.join("\n")}\n`);
      // A PDF header without an extractor reads as binary.
      yield* fs.writeFile(
        path.join(dir, "Resources", "brief.pdf"),
        new TextEncoder().encode("%PDF-1.7 binary\n"),
      );
      const page = yield* files.readResource({
        id: label.id,
        relativePath: "Resources/log.txt",
        offset: 2,
        limit: 3,
      });
      expect(page.binary).toBe(false);
      expect(page.text).toBe("line 2\nline 3\nline 4");
      expect(page.truncated).toBe(true);
      expect(page.totalLines).toBe(11);
      const pdf = yield* files.readResource({ id: label.id, relativePath: "Resources/brief.pdf" });
      expect(pdf.binary).toBe(true);
      expect(pdf.text).toBe(undefined);
      expect(pdf.mimeType).toBe("application/pdf");
      const escape = yield* files
        .readResource({ id: label.id, relativePath: "../top.txt" })
        .pipe(Effect.flip);
      expect(escape.reason).toBe("invalid_path");
    }).pipe(Effect.provide(filesLayer("label-files-read"))),
  );

  it.effect("adds notes, links and uploads, de-duping names", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const files = yield* Files.ProjectFiles;
      const folders = yield* Folders.ProjectLabelFolders;
      const label = labelRef("label:add", "Add Me");
      yield* seedLabel(label.id, label.name);
      const { dir } = yield* folders.ensureForLabel(label);
      const note = yield* files.createResource({
        id: label.id,
        resource: { kind: "note", title: "Ideas", text: "first" },
      });
      expect(note.resource.relativePath).toBe("Resources/Ideas.md");
      const again = yield* files.createResource({
        id: label.id,
        resource: { kind: "note", title: "Ideas", text: "second" },
      });
      expect(again.resource.relativePath).toBe("Resources/Ideas (2).md");
      const link = yield* files.createResource({
        id: label.id,
        resource: { kind: "link", name: "Spec", url: "https://example.com/spec" },
      });
      expect(link.resource.relativePath).toBe("Resources/Spec.url");
      expect(yield* fs.readFileString(path.join(dir, "Resources", "Spec.url"))).toContain(
        "https://example.com/spec",
      );
      const attachmentId = createPendingAttachmentId(".txt");
      const pendingPath = path.join(config.attachmentsDir, `${attachmentId}.txt`);
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fs.writeFileString(pendingPath, "uploaded\n");
      const upload = yield* files.createResource({
        id: label.id,
        resource: { kind: "upload", attachmentId, fileName: "hello.txt" },
      });
      expect(upload.resource.relativePath).toBe("Resources/hello.txt");
      expect(yield* fs.exists(pendingPath)).toBe(false);
      expect(yield* fs.readFileString(path.join(dir, "Resources", "hello.txt"))).toBe("uploaded\n");
    }).pipe(Effect.provide(filesLayer("label-files-add"))),
  );

  it.effect("removes files and refuses the id file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = yield* Files.ProjectFiles;
      const folders = yield* Folders.ProjectLabelFolders;
      const label = labelRef("label:remove", "Remove Me");
      yield* seedLabel(label.id, label.name);
      const { dir } = yield* folders.ensureForLabel(label);
      yield* fs.writeFileString(path.join(dir, "Resources", "gone.md"), "bye\n");
      expect(
        (yield* files.removeResource({ id: label.id, relativePath: "Resources/gone.md" })).removed,
      ).toBe(true);
      expect(yield* fs.exists(path.join(dir, "Resources", "gone.md"))).toBe(false);
      expect(
        (yield* files.removeResource({ id: label.id, relativePath: "Resources/gone.md" })).removed,
      ).toBe(false);
      const idFile = yield* files
        .removeResource({ id: label.id, relativePath: ".cogenly-project.json" })
        .pipe(Effect.flip);
      expect(idFile.reason).toBe("invalid_path");
    }).pipe(Effect.provide(filesLayer("label-files-remove"))),
  );

  it.effect("recalls across filenames and contents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = yield* Files.ProjectFiles;
      const folders = yield* Folders.ProjectLabelFolders;
      const label = labelRef("label:recall", "Recall Me");
      yield* seedLabel(label.id, label.name);
      const { dir } = yield* folders.ensureForLabel(label);
      yield* fs.writeFileString(
        path.join(dir, "Resources", "launch.md"),
        "# launch\nThe narwhal ships on Friday.\n",
      );
      yield* fs.writeFileString(
        path.join(dir, "Resources", "other.md"),
        "# other\nNothing here.\n",
      );
      const { matches } = yield* files.searchResources({ labelId: label.id, query: "narwhal" });
      expect(matches.map((match) => match.relativePath)).toEqual(["Resources/launch.md"]);
      expect(matches[0]?.snippet).toContain("narwhal");
      const byName = yield* files.searchResources({ labelId: label.id, query: "other" });
      expect(byName.matches.map((match) => match.relativePath)).toEqual(["Resources/other.md"]);
      expect((yield* files.searchResources({ labelId: label.id, query: "   " })).matches).toEqual(
        [],
      );
    }).pipe(Effect.provide(filesLayer("label-files-recall"))),
  );

  it.effect("rebuilds the derived index from disk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const files = yield* Files.ProjectFiles;
      const folders = yield* Folders.ProjectLabelFolders;
      const label = labelRef("label:rebuild", "Rebuild Me");
      yield* seedLabel(label.id, label.name);
      const { dir } = yield* folders.ensureForLabel(label);
      yield* fs.writeFileString(path.join(dir, "Resources", "kept.md"), "kept\n");
      expect((yield* files.listResources(label.id)).resources.length).toBeGreaterThan(0);
      yield* sql`DELETE FROM project_resource_files WHERE label_id = ${label.id}`;
      yield* sql`DELETE FROM project_resource_index_state WHERE label_id = ${label.id}`;
      const rebuilt = yield* files.listResources(label.id);
      expect(rebuilt.resources.map((resource) => resource.relativePath)).toContain(
        "Resources/kept.md",
      );
    }).pipe(Effect.provide(filesLayer("label-files-rebuild"))),
  );

  // Live clock: the debounced file watcher runs on real time, like the PTY and
  // tail-following tests elsewhere in the repo.
  it.live("pushes fresh lists when files change on disk", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const files = yield* Files.ProjectFiles;
        const folders = yield* Folders.ProjectLabelFolders;
        const label = labelRef("label:watch", "Watch Me");
        yield* seedLabel(label.id, label.name);
        const { dir } = yield* folders.ensureForLabel(label);
        const live = yield* files
          .subscribeResources(label.id)
          .pipe(Stream.toQueue({ capacity: 8 }));
        const initial = yield* Queue.take(live);
        expect(initial.resources.some((r) => r.relativePath === "Resources/late.md")).toBe(false);
        yield* fs.writeFileString(path.join(dir, "Resources", "late.md"), "late\n");
        const updated = yield* Queue.take(live);
        expect(updated.resources.some((r) => r.relativePath === "Resources/late.md")).toBe(true);
      }),
    ).pipe(Effect.provide(filesLayer("label-files-watch"))),
  );
});
