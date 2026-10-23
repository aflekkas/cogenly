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
    it.effect("puts a project repository's worktrees inside its project folder", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const projectDir = path.join(projectsRoot, "Spawn Partners");
        expect(
          resolveWorktreeParentDirectory({
            setting: "",
            defaultDir,
            repoCwd: path.join(projectDir, "acme"),
            projectDir,
            projectsRoot,
            path,
            home,
          }),
        ).toBe(path.join(projectDir, WORKTREES_SEGMENT));
      }),
    );

    it.effect("puts an unfiled repository's worktrees beside it under Repositories", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        expect(
          resolveWorktreeParentDirectory({
            setting: "",
            defaultDir,
            repoCwd: path.join(projectsRoot, "Repositories", "acme"),
            projectDir: null,
            projectsRoot,
            path,
            home,
          }),
        ).toBe(path.join(projectsRoot, "Repositories", WORKTREES_SEGMENT));
      }),
    );

    it.effect("keeps the default directory for repositories outside the projects root", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        expect(
          resolveWorktreeParentDirectory({
            setting: "",
            defaultDir,
            repoCwd: "/elsewhere/acme",
            projectDir: null,
            projectsRoot,
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
            repoCwd: path.join(projectDir, "acme"),
            projectDir,
            projectsRoot,
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
            repoCwd: path.join(projectsRoot, "Repositories", "acme"),
            projectDir: null,
            projectsRoot,
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
        expect(projectRoots).toEqual([
          path.join(projectsRoot, "Spawn Partners", WORKTREES_SEGMENT),
          path.join(projectsRoot, "Repositories", WORKTREES_SEGMENT),
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
