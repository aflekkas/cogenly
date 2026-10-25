import { ThreadId } from "@cogenly/contracts";
import * as GitHubRest from "@cogenly/source-control-github/server/GitHubRest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RepoMcpTrust from "./RepoMcpTrust.ts";
import { readClaudeRepoMcpServers } from "./NativeMcpPolicy.ts";

const github = Layer.mock(GitHubRest.GitHubRest)({
  rest: () =>
    Effect.succeed({
      status: 200,
      body: '{"login":"aflekkas"}',
      headers: {},
      truncated: false,
      invalidUtf8: false,
    }),
});
const deps = Layer.mergeAll(Sqlite.layerMemory, ProcessRunner.layer, github).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const layer = RepoMcpTrust.layer.pipe(Layer.provideMerge(deps));
const threadId = ThreadId.make("thread:repo-trust");
const definitions = {
  local: { command: "node", args: ["tools.mjs"], env: { KEY: "PRIVATE-ENV" } },
  web: { type: "http", url: "https://vendor.example/mcp" },
  events: { type: "sse", url: "https://vendor.example/sse" },
};
const fixture = (remote?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runner = yield* ProcessRunner.ProcessRunner;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-repo-trust-" });
    expect((yield* runner.run({ command: "git", args: ["init", cwd] })).code).toBe(0);
    if (remote)
      expect(
        (yield* runner.run({
          command: "git",
          args: ["-C", cwd, "remote", "add", "origin", remote],
        })).code,
      ).toBe(0);
    yield* fs.writeFileString(`${cwd}/.mcp.json`, JSON.stringify({ mcpServers: definitions }));
    const trust = yield* RepoMcpTrust.RepoMcpTrust;
    return { cwd, trust, review: () => trust.review({ cwd, threadId, definitions }) };
  });
const prompts = (trust: RepoMcpTrust.RepoMcpTrust["Service"]) =>
  trust.subscribe(threadId).pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map((results) => results[0]!.prompts),
  );

describe("repository MCP command trust", () => {
  it.effect.each([
    "git@github.com:aflekkas/repo.git",
    "https://github.com/AFLEKKAS/repo.git",
    undefined,
  ])("auto-trusts the connected identity or a local repo: %s", (remote) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture(remote);
        expect(yield* f.review()).toEqual({
          allowedNames: ["local", "web", "events"],
          waitingNames: [],
        });
        expect(yield* prompts(f.trust)).toEqual([]);
      }),
    ).pipe(Effect.provide(layer)),
  );
  it.effect.each(["Spawn-Partners", "bartr-app"])(
    "auto-trusts a GitHub owner linked to any project: %s",
    (owner) =>
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO project_labels(label_id,name,created_at,updated_at) VALUES ('label:linked','Linked','2026-01-01','2026-01-01')`;
          yield* sql`INSERT INTO label_source_links(label_id,kind,owner,repo,created_at) VALUES ('label:linked','github-owner',${owner},'','2026-01-01')`;
          const f = yield* fixture(`https://github.com/${owner}/repo.git`);
          expect((yield* f.review()).waitingNames).toEqual([]);
          expect(yield* prompts(f.trust)).toEqual([]);
        }),
      ).pipe(Effect.provide(layer)),
  );
  it.effect(
    "blocks third-party commands, keeps URL servers, asks once and persists trust across service restarts",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture("https://github.com/third-party/repo.git");
          const repo = yield* readClaudeRepoMcpServers(f.cwd);
          expect(yield* f.trust.review({ cwd: f.cwd, threadId, definitions: repo })).toEqual({
            allowedNames: ["web", "events"],
            waitingNames: ["local"],
          });
          yield* f.review();
          const pending = yield* prompts(f.trust);
          expect(pending).toHaveLength(1);
          expect(pending[0]).toMatchObject({
            remote: "github.com/third-party/repo",
            servers: [{ name: "local", command: "node", args: ["tools.mjs"] }],
          });
          expect(JSON.stringify(pending)).not.toContain("PRIVATE-ENV");
          yield* f.trust.respond({ threadId, id: pending[0]!.id, trust: true });
          expect((yield* f.review()).allowedNames).toEqual(["local", "web", "events"]);
          expect((yield* prompts(f.trust))[0]?.decision).toBe("trusted");
          const restarted = yield* RepoMcpTrust.RepoMcpTrust.pipe(
            Effect.provide(RepoMcpTrust.layer),
          );
          expect(
            (yield* restarted.review({ cwd: f.cwd, threadId, definitions })).waitingNames,
          ).toEqual([]);
        }),
      ).pipe(Effect.provide(layer)),
  );
  it.effect.each(["args", "env", "command"] as const)(
    "re-asks on changed %s and rejects a stale prompt decision",
    (field) =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture("git@github.com:third-party/repo.git");
          yield* f.review();
          const first = (yield* prompts(f.trust))[0]!;
          yield* f.trust.respond({ threadId, id: first.id, trust: true });
          const changed = {
            ...definitions,
            local: {
              ...definitions.local,
              [field]:
                field === "args"
                  ? ["other.mjs"]
                  : field === "env"
                    ? { KEY: "CHANGED-PRIVATE-ENV" }
                    : "python",
            },
          };
          expect(
            (yield* f.trust.review({ cwd: f.cwd, threadId, definitions: changed })).waitingNames,
          ).toEqual(["local"]);
          const next = yield* prompts(f.trust);
          expect(next).toHaveLength(1);
          expect(next[0]!.id).not.toBe(first.id);
          expect(
            (yield* f.trust.respond({ threadId, id: first.id, trust: true }).pipe(Effect.flip))
              .reason,
          ).toBe("not_found");
        }),
      ).pipe(Effect.provide(layer)),
  );
  it.effect("remembers Don't trust, and another remote never inherits consent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture("https://github.com/third-party/repo.git");
        yield* f.review();
        const pending = (yield* prompts(f.trust))[0]!;
        yield* f.trust.respond({ threadId, id: pending.id, trust: false });
        expect((yield* f.review()).waitingNames).toEqual(["local"]);
        expect((yield* prompts(f.trust))[0]?.decision).toBe("denied");
        // The same card lets the user reverse a decision without editing the repo.
        yield* f.trust.respond({ threadId, id: pending.id, trust: true });
        expect((yield* f.review()).waitingNames).toEqual([]);
        const other = yield* fixture("https://github.com/another/repo.git");
        expect((yield* other.review()).waitingNames).toEqual(["local"]);
        expect(yield* prompts(f.trust)).toHaveLength(1);
      }),
    ).pipe(Effect.provide(layer)),
  );
  it.effect("web-only repositories need no trust, even when Git is unavailable", () =>
    Effect.gen(function* () {
      const trust = yield* RepoMcpTrust.RepoMcpTrust;
      expect(
        yield* trust.review({
          cwd: "/does-not-exist",
          threadId,
          definitions: { web: definitions.web, events: definitions.events },
        }),
      ).toEqual({ allowedNames: ["web", "events"], waitingNames: [] });
      expect(yield* prompts(trust)).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );
});
