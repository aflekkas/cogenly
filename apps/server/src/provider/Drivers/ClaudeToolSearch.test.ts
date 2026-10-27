import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@cogenly/shared/HostProcess";
import { claudeToolSearchOverride, resolveClaudeToolSearchOverride } from "./ClaudeToolSearch.ts";

it("defers explicit auto thresholds while respecting on/off and endpoint opt-outs", () => {
  for (const value of ["auto", "auto:10", "auto:99.5", "auto:x", "auto:Infinity", "auto:1e-1"]) {
    expect(claudeToolSearchOverride(value), value).toBe("true");
  }
  for (const value of [
    undefined,
    "true",
    "false",
    "auto:0",
    "auto:-5",
    "auto:100",
    "auto:1e2",
    "auto:1_000",
    "auto:1,000",
    "AUTO",
  ]) {
    expect(claudeToolSearchOverride(value), String(value)).toBeUndefined();
  }
});

it.effect(
  "uses local, project, custom-home then process precedence, including linked worktrees",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "claude-search-" });
      const home = path.join(root, "config");
      const repo = path.join(root, "repo");
      const worktree = path.join(root, "worktree");
      const nested = path.join(repo, "packages", "app");
      const gitDir = path.join(repo, ".git", "worktrees", "wt");
      for (const dir of [
        home,
        path.join(repo, ".claude"),
        path.join(worktree, ".claude"),
        nested,
        gitDir,
      ]) {
        yield* fs.makeDirectory(dir, { recursive: true });
      }
      yield* fs.writeFileString(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
      yield* fs.writeFileString(path.join(gitDir, "commondir"), "../..\n");
      const userFile = path.join(home, "settings.json");
      const projectFile = path.join(worktree, ".claude", "settings.json");
      const localFile = path.join(worktree, ".claude", "settings.local.json");
      const rootLocalFile = path.join(repo, ".claude", "settings.local.json");
      const write = (file: string, value: string) =>
        fs.writeFileString(file, JSON.stringify({ env: { ENABLE_TOOL_SEARCH: value } }));
      const resolve = (
        cwd: string | null = worktree,
        environment: NodeJS.ProcessEnv = { ENABLE_TOOL_SEARCH: "auto" },
        homePath = home,
      ) => resolveClaudeToolSearchOverride({ cwd, settings: { homePath }, environment });
      expect(yield* resolve()).toBe("true");
      yield* write(userFile, "false");
      expect(yield* resolve()).toBeUndefined();
      yield* write(projectFile, "auto:10");
      expect(yield* resolve()).toBe("true");
      yield* write(localFile, "false");
      expect(yield* resolve()).toBeUndefined();
      yield* write(rootLocalFile, "auto");
      expect(yield* resolve()).toBe("true");
      expect(yield* resolve(nested)).toBe("true");
      yield* write(rootLocalFile, "false");
      expect(yield* resolve()).toBeUndefined();
      expect(yield* resolve(nested)).toBeUndefined();
      // Relative inherited config dirs resolve against the CLI cwd, not the server cwd.
      yield* write(userFile, "auto");
      expect(yield* resolve(null)).toBe("true");
      expect(
        yield* resolve(root, { CLAUDE_CONFIG_DIR: "config", ENABLE_TOOL_SEARCH: "false" }, ""),
      ).toBe("true");
      yield* fs.writeFileString(
        userFile,
        '{ /* accepted settings comments */ "env": { "ENABLE_TOOL_SEARCH": "auto:50", }, }',
      );
      expect(yield* resolve(null)).toBe("true");
      yield* fs.writeFileString(userFile, "invalid");
      expect(yield* resolve(null, {})).toBeUndefined();
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.Platform, "darwin"),
    ),
);
