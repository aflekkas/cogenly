import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type SharedDocumentChange } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { normalizeRepositoryRemote } from "../project/RepositoryRemote.ts";
import { checkIntegrity, factDocumentId, validateChange } from "./documentSchemas.ts";

const node = EnvironmentId.make("local");
const change = (kind: SharedDocumentChange["kind"], fields: SharedDocumentChange["fields"]) => ({
  kind,
  id: "document:one",
  fields,
  clocks: Object.fromEntries(
    Object.keys(fields).map((key) => [key, { wall: 1, logical: 0, node }]),
  ),
  tombstone: null,
  updatedBy: node,
});
describe("shared configuration schemas", () => {
  it.effect.each([
    { type: "root", branch: "feature/" + "x".repeat(250) },
    { type: "worktree", baseRef: "refs/heads/" + "x".repeat(250) },
    {
      type: "existing_worktree",
      relativePath: Array.from({ length: 100 }, () => "worktrees").join("/") + "/checkout",
    },
  ])("accepts domain workspace references %s", (workspaceStrategy) =>
    validateChange(change("schedule", { workspaceStrategy })),
  );
  it.effect("carries a repository's icon path, and only one inside the repository", () =>
    Effect.gen(function* () {
      const repositories = (iconPath: string) => [
        { remote: "github.com/acme/site", directoryName: "site", iconPath },
      ];
      yield* validateChange(change("project", { repositories: repositories("public/icon.svg") }));
      for (const outside of ["../secret.svg", "/etc/icon.svg", "~/icon.svg"])
        expect(
          (yield* Effect.result(
            validateChange(change("project", { repositories: repositories(outside) })),
          ))._tag,
        ).toBe("Failure");
    }),
  );
  it.effect.each(["bad%id", "has space", "x".repeat(201)])(
    "rejects invalid new document id %s",
    (id) =>
      Effect.gen(function* () {
        expect(
          (yield* Effect.result(validateChange({ ...change("project", { name: "P" }), id })))._tag,
        ).toBe("Failure");
      }),
  );
  it.effect("peer fact identities must name their own document, including tombstones", () =>
    Effect.gen(function* () {
      const legacy = 'legacy-memory:["agent","note"]';
      yield* checkIntegrity({ ...change("fact", { factId: legacy }), id: factDocumentId(legacy) });
      for (const tombstone of [null, { wall: 1, logical: 0, node }])
        expect(
          (yield* checkIntegrity({
            ...change("fact", { factId: "fact:original" }),
            id: "fact:alias",
            tombstone,
          }).pipe(Effect.result))._tag,
        ).toBe("Failure");
    }),
  );
  it.effect("accepts domain schedule text, long fallback chains and documents above 96 KiB", () =>
    Effect.gen(function* () {
      yield* validateChange(
        change("schedule", { title: "t".repeat(201), prompt: "p".repeat(300_000) }),
      );
      yield* validateChange(
        change("agent", {
          fallbackChain: Array.from({ length: 17 }, () => ({
            instanceId: "codex",
            model: "gpt-5",
          })),
        }),
      );
    }),
  );
  it.effect.each([
    "https://dev.azure.com/org/My%20Project/_git/tools",
    "ssh://git@bitbucket.example.com:7999/~alice/repo.git",
    "git@gitlab.example.com:group/sub/repo.git",
  ])("accepts normalized remote %s", (url) =>
    Effect.gen(function* () {
      const remote = normalizeRepositoryRemote(url);
      expect(remote).not.toBeNull();
      yield* validateChange(change("project", { repositories: [{ remote, directoryName: null }] }));
    }),
  );
});
