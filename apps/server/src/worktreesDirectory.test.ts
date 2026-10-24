import * as NodePath from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  managedWorktreesDirectories,
  projectWorktreesDirectories,
  resolveWorktreeParentDirectory,
  WORKTREES_SEGMENT,
} from "./worktreesDirectory.ts";

const home = "/home/tester";
const defaultDir = "/home/tester/.cogenly/worktrees";
const projectsRoot = "/home/tester/Cogenly";

it.layer(NodePath.layer)("worktreesDirectory", (it) => {
  describe("resolveWorktreeParentDirectory", () => {
    it.effect(
      "puts a project repository's worktrees in its project's .worktrees, mirroring repos/",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const projectDir = path.join(projectsRoot, "Spawn Partners");
          expect(
            resolveWorktreeParentDirectory({
              setting: "",
              defaultDir,
              projectDir,
              repositoryDirectoryName: "platform",
              path,
              home,
            }),
          ).toBe(path.join(projectDir, ".worktrees"));
          // Another owner's repository sits under repos/<owner>/, and so do its worktrees.
          expect(
            resolveWorktreeParentDirectory({
              setting: "",
              defaultDir,
              projectDir,
              repositoryDirectoryName: "aflekkas/athens-racing",
              path,
              home,
            }),
          ).toBe(path.join(projectDir, ".worktrees", "aflekkas"));
        }),
    );

    it.effect("keeps the default directory for repositories in no project", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        expect(
          resolveWorktreeParentDirectory({
            setting: "",
            defaultDir,
            projectDir: null,
            path,
            home,
          }),
        ).toBe(defaultDir);
      }),
    );

    it.effect("lets an explicit setting win over the project folder", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const projectDir = path.join(projectsRoot, "Spawn Partners");
        expect(
          resolveWorktreeParentDirectory({
            setting: "/custom/worktrees",
            defaultDir,
            projectDir,
            path,
            home,
          }),
        ).toBe("/custom/worktrees");
      }),
    );

    it.effect("returns null for a setting that is not absolute on this machine", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        expect(
          resolveWorktreeParentDirectory({
            setting: "relative/worktrees",
            defaultDir,
            projectDir: null,
            path,
            home,
          }),
        ).toBeNull();
      }),
    );
  });

  describe("managedWorktreesDirectories", () => {
    it.effect("covers project-local worktree roots passed by callers", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const projectRoots = projectWorktreesDirectories(
          projectsRoot,
          ["Spawn Partners", "Repositories"],
          path,
        );
        // Worktrees made before `.worktrees/` stay managed where they are.
        expect(projectRoots).toEqual([
          path.join(projectsRoot, "Spawn Partners", WORKTREES_SEGMENT),
          path.join(projectsRoot, "Spawn Partners", "worktrees"),
          path.join(projectsRoot, "Repositories", WORKTREES_SEGMENT),
          path.join(projectsRoot, "Repositories", "worktrees"),
        ]);
        const managed = managedWorktreesDirectories(
          { worktreesDirectory: "", previousWorktreesDirectories: [] },
          defaultDir,
          path,
          home,
          projectRoots,
        );
        expect(managed).toContain(defaultDir);
        for (const root of projectRoots) expect(managed).toContain(root);
      }),
    );
  });
});
