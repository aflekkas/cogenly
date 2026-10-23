// @effect-diagnostics nodeBuiltinImport:off - tests run real git against temp folders on disk.
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

const git = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], { cwd, stdio: "pipe" });

function makeRepo(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "git-ref-guard-"));
  git(root, ["init", "--initial-branch=main"]);
  NodeFS.writeFileSync(NodePath.join(root, "README.md"), "hello\n");
  git(root, ["add", "."]);
  git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
  return root;
}

const layer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest("/tmp", { prefix: "git-ref-guard" })),
  Layer.provideMerge(NodeServices.layer),
);

describe("GitVcsDriver ref-name guard", () => {
  it.effect("refuses to create a branch named like a git option", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = makeRepo();
      const result = yield* Effect.result(driver.createRef({ cwd, refName: "--force" }));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.detail).toContain("--force");
      expect(() => git(cwd, ["show-ref", "--verify", "refs/heads/--force"])).toThrow();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses to switch to a ref named like a git option", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = makeRepo();
      const result = yield* Effect.result(driver.switchRef({ cwd, refName: "--force" }));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.detail).toContain("--force");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("still creates and switches to an ordinary branch", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = makeRepo();
      const created = yield* driver.createRef({ cwd, refName: "feature/plain" });
      expect(created.refName).toBe("feature/plain");
      const switched = yield* driver.switchRef({ cwd, refName: "feature/plain" });
      expect(switched.refName).toBe("feature/plain");
    }).pipe(Effect.provide(layer)),
  );
});
