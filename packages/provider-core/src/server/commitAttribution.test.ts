// @effect-diagnostics nodeBuiltinImport:off -- real Git integration in isolated temporary repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import {
  prepareCommitAttributionEnvironment,
  stripAiAttribution,
  withCommitAttributionEnvironment,
} from "./commitAttribution.ts";

const fixtures = [
  "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
  "Co-authored-by: Codex <codex@openai.com>",
  "Co-authored-by: Muse <muse@example.test>",
  "Co-authored-by: Grok <grok@x.ai>",
  "Co-authored-by: OpenAI <noreply@openai.com>",
  "Co-authored-by: GitHub Copilot <copilot@github.com>",
  "Co-authored-by: Cursor <cursoragent@cursor.com>",
  "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  "Generated with Codex",
  "Claude-Session: https://claude.ai/code/session_abc",
  "https://claude.ai/code/session_abc",
];

describe("AI attribution filter", () => {
  it.each(fixtures)("removes %s while preserving human and unrelated trailers", (line) => {
    const preserved =
      "fix: example\n\nCo-authored-by: Jane <jane@example.test>\nCo-authored-by: Jane Claude <jane.claude@example.test>\nReviewed-by: Claude <reviewer@example.test>\nSigned-off-by: Jane <jane@example.test>\nGenerated with the release script\n";
    expect(stripAiAttribution(preserved + line + "\n")).toBe(preserved);
    expect(stripAiAttribution(stripAiAttribution(preserved + line + "\n"))).toBe(preserved);
  });

  it("preserves CRLF and a message without a trailing newline", () => {
    expect(
      stripAiAttribution(
        "subject\r\n\r\nCo-Authored-By: Claude <noreply@anthropic.com>\r\nAcked-by: Jane",
      ),
    ).toBe("subject\r\n\r\nAcked-by: Jane");
  });

  it("does not inject configuration when attribution is allowed", () => {
    const env = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Jane",
    };
    expect(withCommitAttributionEnvironment(env, "/hooks", true)).toBe(env);
    const off = withCommitAttributionEnvironment(env, "/hooks", false);
    expect(off.GIT_CONFIG_COUNT).toBe("2");
    expect(off.GIT_CONFIG_KEY_0).toBe("user.name");
    expect(off.GIT_CONFIG_VALUE_0).toBe("Jane");
    expect(off.GIT_CONFIG_KEY_1).toBe("core.hooksPath");
    expect(withCommitAttributionEnvironment(off, "/other", false)).toBe(off);
  });
});

it.live("real commits strip AI attribution, preserve identities, and chain repository hooks", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-git-attribution-test-" });
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("GIT_") && !key.startsWith("COGENLY_ATTRIBUTION_"),
      ),
    );
    const env = {
      ...inherited,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: `${dir}/no-global-config`,
      GIT_AUTHOR_NAME: "Original Author",
      GIT_AUTHOR_EMAIL: "author@example.test",
      GIT_COMMITTER_NAME: "Original Committer",
      GIT_COMMITTER_EMAIL: "committer@example.test",
    };
    const git = (cwd: string, args: string[], environment: NodeJS.ProcessEnv = env) => {
      const result = NodeChildProcess.spawnSync("git", args, {
        cwd,
        env: environment,
        encoding: "utf8",
      });
      expect(result.stderr, args.join(" ")).toBeDefined();
      if (result.status !== 0) throw new Error(`Git failed (${result.status}): ${result.stderr}`);
      return result.stdout.trim();
    };
    const protectedEnv = yield* prepareCommitAttributionEnvironment(env, false);
    expect(yield* prepareCommitAttributionEnvironment(env, true)).toBe(env);
    // Each invocation resolves its own repository and configured hooks path.
    for (const [name, hookPath, viaEnv] of [
      ["default", undefined, false],
      ["relative", ".custom hooks", false],
      ["absolute", `${dir}/absolute hooks`, false],
      ["environment", ".environment hooks", true],
    ] as const) {
      const repo = `${dir}/repo-${name}`;
      yield* fs.makeDirectory(repo);
      git(repo, ["init", "--quiet"]);
      const incomingEnv = viaEnv
        ? {
            ...env,
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "core.hooksPath",
            GIT_CONFIG_VALUE_0: hookPath,
          }
        : env;
      const effectiveEnv = viaEnv
        ? withCommitAttributionEnvironment(incomingEnv, protectedEnv.GIT_CONFIG_VALUE_0!, false)
        : protectedEnv;
      const hooks =
        hookPath === undefined
          ? `${repo}/.git/hooks`
          : hookPath.startsWith(".")
            ? `${repo}/${hookPath}`
            : hookPath;
      yield* fs.makeDirectory(hooks, { recursive: true });
      if (hookPath && !viaEnv) git(repo, ["config", "core.hooksPath", hookPath]);
      const hook = `${hooks}/commit-msg`;
      yield* fs.writeFileString(
        hook,
        '#!/bin/sh\nprintf "hook-ran\\n" > hook-result\nprintf "Co-authored-by: Hook Human <hook@example.test>\\nCo-authored-by: Claude <noreply@anthropic.com>\\n" >> "$1"\n',
      );
      yield* fs.chmod(hook, 0o700);
      const preCommit = `${hooks}/pre-commit`;
      yield* fs.writeFileString(
        preCommit,
        '#!/bin/sh\nprintf "pre-commit-ran\\n" > pre-commit-result\n',
      );
      yield* fs.chmod(preCommit, 0o700);
      const postIndex = `${hooks}/post-index-change`;
      yield* fs.writeFileString(
        postIndex,
        '#!/bin/sh\nprintf "index-hook-ran\\n" > index-hook-result\n',
      );
      yield* fs.chmod(postIndex, 0o700);
      yield* fs.writeFileString(`${repo}/file.txt`, "example\n");
      git(repo, ["add", "file.txt"], effectiveEnv);
      expect(yield* fs.readFileString(`${repo}/index-hook-result`)).toBe("index-hook-ran\n");
      const message =
        "fix: isolated attribution test\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nCo-authored-by: Jane <jane@example.test>\nSigned-off-by: Jane <jane@example.test>\n";
      git(repo, ["commit", "--allow-empty", "-m", message], effectiveEnv);
      const committed = git(repo, ["log", "-1", "--format=%B"]);
      expect(committed).not.toMatch(/Claude|anthropic/);
      expect(committed).toContain("Co-authored-by: Jane <jane@example.test>");
      expect(committed).toContain("Co-authored-by: Hook Human <hook@example.test>");
      expect(committed).toContain("Signed-off-by: Jane <jane@example.test>");
      expect(git(repo, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"])).toBe(
        "Original Author <author@example.test>|Original Committer <committer@example.test>",
      );
      expect(yield* fs.readFileString(`${repo}/hook-result`)).toBe("hook-ran\n");
      expect(yield* fs.readFileString(`${repo}/pre-commit-result`)).toBe("pre-commit-ran\n");
      // An ordinary process is unaffected; existing commits remain unchanged.
      git(repo, ["commit", "--allow-empty", "-m", message], incomingEnv);
      expect(git(repo, ["log", "-1", "--format=%B"])).toContain("noreply@anthropic.com");
      expect(git(repo, ["log", "-1", "--skip=1", "--format=%B"])).not.toContain(
        "noreply@anthropic.com",
      );
      yield* fs.writeFileString(hook, "#!/bin/sh\nexit 37\n");
      const rejected = NodeChildProcess.spawnSync(
        "git",
        ["commit", "--allow-empty", "-m", "rejected"],
        { cwd: repo, env: effectiveEnv },
      );
      expect(rejected.status).not.toBe(0);
      expect(git(repo, ["rev-list", "--count", "HEAD"])).toBe("2");
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
