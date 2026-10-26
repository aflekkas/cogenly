import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectLabelId } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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

  it.effect("never lists, reads or recalls repos/, .worktrees/ or the legacy worktrees/", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = yield* Files.ProjectFiles;
      const folders = yield* Folders.ProjectLabelFolders;
      const label = labelRef("label:worktrees", "Worktrees Me");
      yield* seedLabel(label.id, label.name);
      const { dir } = yield* folders.ensureForLabel(label);
      const reserved = [
        "worktrees/repo/fix-login/code.ts",
        ".worktrees/aflekkas/repo/fix-login/code.ts",
        "repos/aflekkas/repo/code.ts",
      ];
      for (const relative of reserved) {
        yield* fs.makeDirectory(path.dirname(path.join(dir, relative)), { recursive: true });
        yield* fs.writeFileString(path.join(dir, relative), "code\n");
      }
      yield* fs.writeFileString(path.join(dir, "top.txt"), "top\n");
      const { resources } = yield* files.listResources(label.id);
      const paths = resources.map((resource) => resource.relativePath);
      expect(paths).toContain("top.txt");
      for (const top of ["worktrees", ".worktrees", "repos"])
        expect(paths.some((p) => p === top || p.startsWith(`${top}/`))).toBe(false);
      for (const relativePath of reserved) {
        const read = yield* files.readResource({ id: label.id, relativePath }).pipe(Effect.flip);
        expect(read.reason).toBe("invalid_path");
      }
      const recall = yield* files.searchResources({ labelId: label.id, query: "code" });
      expect(recall.matches).toEqual([]);
    }).pipe(Effect.provide(filesLayer("label-files-worktrees"))),
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

  it.effect("makes folders, adds into nested folders, and copies chat attachments", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const files = yield* Files.ProjectFiles;
      const folders = yield* Folders.ProjectLabelFolders;
      const label = labelRef("label:folders", "Folder Me");
      yield* seedLabel(label.id, label.name);
      const { dir } = yield* folders.ensureForLabel(label);
      const folder = yield* files.createResource({
        id: label.id,
        resource: { kind: "folder", name: "Briefs" },
      });
      expect(folder.resource).toMatchObject({ relativePath: "Resources/Briefs", kind: "folder" });
      const nested = yield* files.createResource({
        id: label.id,
        folder: "Resources/Briefs/2026/Q4",
        resource: { kind: "note", title: "Plan", text: "deep" },
      });
      expect(nested.resource.relativePath).toBe("Resources/Briefs/2026/Q4/Plan.md");
      expect(yield* fs.readFileString(path.join(dir, nested.resource.relativePath))).toBe("deep\n");
      // Attaching from a chat copies; the chat keeps its file.
      const attachmentId = createPendingAttachmentId(".pdf");
      const source = path.join(config.attachmentsDir, `${attachmentId}.pdf`);
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fs.writeFileString(source, "%PDF\n");
      const copied = yield* files.createResource({
        id: label.id,
        folder: "Resources/Briefs",
        resource: { kind: "attachment", attachmentId, fileName: "deck.pdf" },
      });
      expect(copied.resource.relativePath).toBe("Resources/Briefs/deck.pdf");
      expect(yield* fs.readFileString(source)).toBe("%PDF\n");
      // Reserved folders and paths leaving the project are refused.
      for (const target of ["repos/x", "../outside", ".worktrees/a"]) {
        const refused = yield* files
          .createResource({
            id: label.id,
            folder: target,
            resource: { kind: "note", title: "No", text: "no" },
          })
          .pipe(Effect.flip);
        expect(refused.reason).toBe("invalid_path");
      }
    }).pipe(Effect.provide(filesLayer("label-files-folders"))),
  );

  it.effect("replaces files linked from outside the project with copies, once", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = yield* Files.ProjectFiles;
      const folders = yield* Folders.ProjectLabelFolders;
      const label = labelRef("label:linked", "Linked Me");
      yield* seedLabel(label.id, label.name);
      const { dir } = yield* folders.ensureForLabel(label);
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-linked-" });
      const original = path.join(outside, "report.txt");
      yield* fs.writeFileString(original, "original\n");
      const linked = path.join(dir, "Resources", "report.txt");
      yield* fs.symlink(original, linked);
      expect(yield* files.copyLinkedFiles(label.id)).toBe(1);
      expect(yield* fs.readLink(linked).pipe(Effect.option)).toEqual(Option.none());
      expect(yield* fs.readFileString(linked)).toBe("original\n");
      // The original outside the project is untouched and stays independent.
      yield* fs.writeFileString(original, "changed\n");
      expect(yield* fs.readFileString(linked)).toBe("original\n");
      expect(yield* files.copyLinkedFiles(label.id)).toBe(0);
      const { resources } = yield* files.listResources(label.id);
      expect(resources.map((resource) => resource.relativePath)).toContain("Resources/report.txt");
    }).pipe(Effect.scoped, Effect.provide(filesLayer("label-files-linked"))),
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

  it.effect("refuses to add anything through a Resources symlink that leaves the project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const files = yield* Files.ProjectFiles;
      const folders = yield* Folders.ProjectLabelFolders;
      const label = labelRef("label:resources-escape", "Escape Me");
      yield* seedLabel(label.id, label.name);
      const { dir } = yield* folders.ensureForLabel(label);
      const outsideDir = path.join(path.dirname(dir), "outside-resources");
      yield* fs.makeDirectory(outsideDir, { recursive: true });
      yield* fs.remove(path.join(dir, "Resources"), { recursive: true });
      yield* fs.symlink(outsideDir, path.join(dir, "Resources"));

      const attachmentId = createPendingAttachmentId(".txt");
      const pendingPath = path.join(config.attachmentsDir, `${attachmentId}.txt`);
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fs.writeFileString(pendingPath, "uploaded\n");
      for (const resource of [
        { kind: "note", title: "Ideas", text: "escaped" },
        { kind: "link", name: "Spec", url: "https://example.com/spec" },
        { kind: "upload", attachmentId, fileName: "hello.txt" },
      ] as const) {
        const refused = yield* files.createResource({ id: label.id, resource }).pipe(Effect.flip);
        expect(refused.reason).toBe("invalid_path");
      }
      expect(yield* fs.readDirectory(outsideDir)).toEqual([]);
      expect(yield* fs.exists(pendingPath)).toBe(true);
    }).pipe(Effect.provide(filesLayer("label-files-resources-escape"))),
  );

  it.effect("never writes a note through a dangling symlink inside Resources", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = yield* Files.ProjectFiles;
      const folders = yield* Folders.ProjectLabelFolders;
      const label = labelRef("label:dangling", "Dangle Me");
      yield* seedLabel(label.id, label.name);
      const { dir } = yield* folders.ensureForLabel(label);
      const outsideFile = path.join(path.dirname(dir), "outside-note.md");
      yield* fs.symlink(outsideFile, path.join(dir, "Resources", "Ideas.md"));
      const note = yield* files.createResource({
        id: label.id,
        resource: { kind: "note", title: "Ideas", text: "kept inside" },
      });
      expect(note.resource.relativePath).toBe("Resources/Ideas (2).md");
      expect(yield* fs.exists(outsideFile)).toBe(false);
    }).pipe(Effect.provide(filesLayer("label-files-dangling"))),
  );

  it.effect("refuses symlinks that escape the project folder and never indexes them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = yield* Files.ProjectFiles;
      const folders = yield* Folders.ProjectLabelFolders;
      const label = labelRef("label:symlink", "Symlink Me");
      yield* seedLabel(label.id, label.name);
      const { dir } = yield* folders.ensureForLabel(label);
      const outsideDir = path.join(path.dirname(dir), "outside-secret");
      yield* fs.makeDirectory(outsideDir, { recursive: true });
      yield* fs.writeFileString(path.join(outsideDir, "secret.txt"), "secretoutside\n");
      yield* fs.symlink(path.join(outsideDir, "secret.txt"), path.join(dir, "escape.txt"));
      yield* fs.symlink(outsideDir, path.join(dir, "escape-dir"));
      yield* fs.writeFileString(path.join(dir, "kept.txt"), "kept\n");
      const read = yield* files
        .readResource({ id: label.id, relativePath: "escape.txt" })
        .pipe(Effect.flip);
      expect(read.reason).toBe("invalid_path");
      const readDir = yield* files
        .readResource({ id: label.id, relativePath: "escape-dir/secret.txt" })
        .pipe(Effect.flip);
      expect(readDir.reason).toBe("invalid_path");
      const { resources } = yield* files.listResources(label.id);
      const paths = resources.map((resource) => resource.relativePath);
      expect(paths).toContain("kept.txt");
      expect(paths).not.toContain("escape.txt");
      expect(paths.some((p) => p === "escape-dir" || p.startsWith("escape-dir/"))).toBe(false);
      const recall = yield* files.searchResources({ labelId: label.id, query: "secretoutside" });
      expect(recall.matches).toEqual([]);
    }).pipe(Effect.provide(filesLayer("label-files-symlink"))),
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
