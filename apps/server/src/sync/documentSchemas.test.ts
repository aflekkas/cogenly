import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type SharedDocumentChange } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { normalizeRepositoryRemote } from "../project/RepositoryRemote.ts";
import { splitChange, validateChange } from "./documentSchemas.ts";

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
  it.effect("a local settings write carries only universal keys and project overrides", () =>
    Effect.gen(function* () {
      const write = (
        kind: "settings" | "project-settings",
        id: string,
        fields: SharedDocumentChange["fields"],
      ) => Effect.result(validateChange({ ...change(kind, fields), id }));
      expect((yield* write("settings", "universal", { branchNamePrefix: "feat" }))._tag).toBe(
        "Success",
      );
      expect(
        (yield* write("project-settings", "label-one", {
          defaultAutoPull: { value: true },
          branchNamePrefix: null,
        }))._tag,
      ).toBe("Success");
      for (const [kind, fields] of [
        // Machine-local keys never travel.
        ["settings", { projectsRoot: "/srv/projects" }],
        ["project-settings", { projectsRoot: { value: "/srv" } }],
        // Overrides are `null` or `{ value }`, with values the schema accepts.
        ["project-settings", { defaultAutoPull: true }],
        ["project-settings", { defaultAutoPull: { value: "yes" } }],
      ] as const)
        expect(
          (yield* write(kind, kind === "settings" ? "universal" : "label-one", fields))._tag,
        ).toBe("Failure");
      expect(
        (yield* Effect.result(
          validateChange({
            ...change("settings", {}),
            id: "universal",
            tombstone: { wall: 1, logical: 0, node },
          }),
        ))._tag,
      ).toBe("Failure");
    }),
  );
  it("a newer build's settings keep their unknown keys and hold values this build cannot read", () => {
    const { accepted, deferred } = splitChange({
      ...change("project-settings", {
        defaultAutoPull: { value: true },
        branchNamingMode: { value: "lunar" },
        accentTheme: { value: "dark" },
      }),
      id: "label-one",
    });
    expect(deferred).toBe(true);
    expect(accepted?.fields).toEqual({
      defaultAutoPull: { value: true },
      accentTheme: { value: "dark" },
    });
  });
  it.effect.each(["bad%id", "has space", "x".repeat(201)])(
    "rejects invalid new document id %s",
    (id) =>
      Effect.gen(function* () {
        expect(
          (yield* Effect.result(validateChange({ ...change("project", { name: "P" }), id })))._tag,
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
  it.effect("integration fields validate web endpoints and exclude local credentials", () =>
    Effect.gen(function* () {
      yield* validateChange(
        change("integration", {
          name: "linear",
          transport: "http",
          url: "https://mcp.linear.app/mcp",
          auth: { type: "oauth", scope: "read" },
          enabled: true,
        }),
      );
      for (const fields of [
        { transport: "local" },
        { url: "file:///bin/sh" },
        { url: "https://user:password@example.com/mcp" },
        { headers: { authorization: "private" } },
        { approvedCredentialItems: ["secret"] },
      ])
        expect((yield* Effect.result(validateChange(change("integration", fields))))._tag).toBe(
          "Failure",
        );
      const split = splitChange(
        change("integration", {
          transport: "local",
          url: "file:///bin/sh",
          enabled: true,
          nextVersionOption: "kept",
        }),
      );
      expect(split.deferred).toBe(true);
      expect(split.accepted?.fields).toEqual({ enabled: true, nextVersionOption: "kept" });
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
