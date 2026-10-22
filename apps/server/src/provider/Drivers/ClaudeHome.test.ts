import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeProjectDirName,
  claudeSessionTranscriptExists,
  resolveClaudeSessionConfigDir,
} from "./ClaudeHome.ts";

const SESSION_ID = "267a7dd8-0f4f-41d6-8a0e-d4129aedce7f";

const writeTranscript = (input: { configDir: string; cwd: string; dirName?: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(
      input.configDir,
      "projects",
      input.dirName ?? claudeProjectDirName(input.cwd),
    );
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path.join(dir, `${SESSION_ID}.jsonl`), "{}\n");
  });

describe("claudeSessionTranscriptExists", () => {
  it.effect("finds a session only under the cwd and config dir that created it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "claude-home-" }),
      );
      const work = path.join(root, ".cogenly", "scratch", "chat");
      const project = path.join(root, "projects", "filed");
      yield* fs.makeDirectory(work, { recursive: true });
      yield* fs.makeDirectory(project, { recursive: true });
      const uchicago = path.join(root, ".claude");
      const personal = path.join(root, ".claude_personal");
      yield* writeTranscript({ configDir: uchicago, cwd: work });

      const exists = (configDir: string, cwd: string) =>
        claudeSessionTranscriptExists({ configDir, cwd, sessionId: SESSION_ID });
      assert.isTrue(yield* exists(uchicago, work));
      // The chat was filed into a project: its cwd moved.
      assert.isFalse(yield* exists(uchicago, project));
      // The same instance now runs with another CLAUDE_CONFIG_DIR.
      assert.isFalse(yield* exists(personal, work));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("matches the hashed folder Claude uses for a long cwd by prefix", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "claude-home-" }),
      );
      const cwd = path.join(root, "x".repeat(240));
      yield* fs.makeDirectory(cwd, { recursive: true });
      const configDir = path.join(root, ".claude");
      const dirName = `${claudeProjectDirName(cwd).slice(0, 200)}-1abc2de`;
      yield* writeTranscript({ configDir, cwd, dirName });
      assert.isTrue(
        yield* claudeSessionTranscriptExists({ configDir, cwd, sessionId: SESSION_ID }),
      );
      assert.isFalse(
        yield* claudeSessionTranscriptExists({ configDir, cwd: root, sessionId: SESSION_ID }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("resolveClaudeSessionConfigDir", () => {
  it.effect("follows CLAUDE_CONFIG_DIR, else HOME/.claude", () =>
    Effect.gen(function* () {
      assert.equal(
        yield* resolveClaudeSessionConfigDir({
          environment: { HOME: "/home/me", CLAUDE_CONFIG_DIR: "/home/me/.claude_personal" },
          cwd: "/work",
        }),
        "/home/me/.claude_personal",
      );
      assert.equal(
        yield* resolveClaudeSessionConfigDir({ environment: { HOME: "/home/me" }, cwd: "/work" }),
        "/home/me/.claude",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
