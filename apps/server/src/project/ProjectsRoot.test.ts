import * as NodePath from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  repositoryDirectoryNameFromRemote,
  resolveDefaultCloneDestination,
  resolveProjectsRootDirectory,
  resolveRepositoryDirectory,
  sanitizePathSegment,
} from "./ProjectsRoot.ts";

// A home that is never created: resolution is pure path computation.
const home = "/tmp/cogenly-projects-root-test-home";

it.layer(NodePath.layer)("ProjectsRoot", (it) => {
  describe("resolveProjectsRootDirectory", () => {
    it.effect("defaults to ~/Cogenly", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        expect(resolveProjectsRootDirectory("", home, path)).toBe(path.join(home, "Cogenly"));
        expect(resolveProjectsRootDirectory("   ", home, path)).toBe(path.join(home, "Cogenly"));
      }),
    );

    it.effect("expands a tilde setting", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        expect(resolveProjectsRootDirectory("~/Code", home, path)).toBe(path.join(home, "Code"));
        expect(resolveProjectsRootDirectory("~", home, path)).toBe(home);
      }),
    );

    it.effect("honours an absolute setting", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        expect(resolveProjectsRootDirectory("/Volumes/Data/Repos", home, path)).toBe(
          path.resolve("/Volumes/Data/Repos"),
        );
      }),
    );

    it.effect("resolves a relative setting against home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        expect(resolveProjectsRootDirectory("work/repos", home, path)).toBe(
          path.join(home, "work/repos"),
        );
      }),
    );
  });

  describe("sanitizePathSegment", () => {
    it.effect("keeps readable project names intact", () =>
      Effect.gen(function* () {
        expect(sanitizePathSegment("Spawn Partners", "project")).toBe("Spawn Partners");
        expect(sanitizePathSegment("acme-web", "repository")).toBe("acme-web");
      }),
    );

    it.effect("folds separators and forbidden punctuation into one segment", () =>
      Effect.gen(function* () {
        expect(sanitizePathSegment("a/b\\c", "project")).toBe("a-b-c");
        expect(sanitizePathSegment('a:b*c?d"e<f>g|h', "project")).toBe("a-b-c-d-e-f-g-h");
        expect(sanitizePathSegment("a\nb", "project")).toBe("a-b");
      }),
    );

    it.effect("strips trailing dots and spaces, and falls back when empty", () =>
      Effect.gen(function* () {
        expect(sanitizePathSegment("Project. ", "project")).toBe("Project");
        expect(sanitizePathSegment("...", "project")).toBe("project");
        expect(sanitizePathSegment("   ", "repository")).toBe("repository");
      }),
    );

    it.effect("caps runaway names", () =>
      Effect.gen(function* () {
        expect(sanitizePathSegment("a".repeat(500), "project")).toBe("a".repeat(128));
      }),
    );
  });

  describe("resolveRepositoryDirectory", () => {
    it.effect("files project repositories under the project name", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = path.join(home, "Cogenly");
        expect(resolveRepositoryDirectory(root, "Spawn Partners", "acme", path)).toBe(
          path.join(root, "Spawn Partners", "acme"),
        );
      }),
    );

    it.effect("files unprojected repositories under Repositories", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = path.join(home, "Cogenly");
        expect(resolveRepositoryDirectory(root, null, "acme", path)).toBe(
          path.join(root, "Repositories", "acme"),
        );
      }),
    );

    it.effect("sanitizes hostile names into single segments", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = path.join(home, "Cogenly");
        expect(resolveRepositoryDirectory(root, "../evil", "../../etc", path)).toBe(
          path.join(root, "..-evil", "..-..-etc"),
        );
      }),
    );
  });

  describe("repositoryDirectoryNameFromRemote", () => {
    it.effect("reads owner/repo selectors and URLs", () =>
      Effect.gen(function* () {
        expect(repositoryDirectoryNameFromRemote({ repository: "spawn-partners/acme" })).toBe(
          "acme",
        );
        expect(
          repositoryDirectoryNameFromRemote({
            remoteUrl: "https://github.com/spawn-partners/acme.git",
          }),
        ).toBe("acme");
        expect(
          repositoryDirectoryNameFromRemote({
            remoteUrl: "git@github.com:spawn-partners/acme.git",
          }),
        ).toBe("acme");
        expect(
          repositoryDirectoryNameFromRemote({
            remoteUrl: "ssh://git@github.com:22/spawn-partners/acme?x=1#frag",
          }),
        ).toBe("acme");
        expect(repositoryDirectoryNameFromRemote({ repository: "org/project/repo" })).toBe("repo");
      }),
    );

    it.effect("returns empty when nothing names a repository", () =>
      Effect.gen(function* () {
        expect(repositoryDirectoryNameFromRemote({})).toBe("");
        expect(repositoryDirectoryNameFromRemote({ remoteUrl: "https://github.com" })).toBe("");
        expect(repositoryDirectoryNameFromRemote({ remoteUrl: "https://host:22" })).toBe("");
      }),
    );
  });

  describe("resolveDefaultCloneDestination", () => {
    it.effect("resolves under Repositories", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        expect(
          resolveDefaultCloneDestination({
            projectsRootSetting: "",
            home,
            repository: "spawn-partners/acme",
            path,
          }),
        ).toBe(path.join(home, "Cogenly", "Repositories", "acme"));
      }),
    );

    it.effect("returns null when no repository name is known", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        expect(resolveDefaultCloneDestination({ projectsRootSetting: "", home, path })).toBe(null);
      }),
    );
  });
});
