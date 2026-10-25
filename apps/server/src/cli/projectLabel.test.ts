import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ProjectLabelError,
  ProjectLabelId,
  type ProjectLabelWithRepositories,
  WS_METHODS,
  WsRpcGroup,
} from "@cogenly/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import {
  PROJECT_LABEL_CLI_SCOPES,
  type ProjectLabelCliCommand,
  type ProjectLabelCliContext,
  runProjectLabelCommand,
} from "./projectLabel.ts";

const called = [
  WS_METHODS.projectLabelsList,
  WS_METHODS.projectLabelsCreate,
  WS_METHODS.projectLabelsUpdate,
  WS_METHODS.projectLabelsDelete,
  WS_METHODS.projectLabelsLinkRepository,
  WS_METHODS.projectLabelsUnlinkRepository,
] as const;
const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES, (typeof called)[number]> =>
      !(called as ReadonlyArray<string>).includes(tag),
  ),
);

const repositories = [
  { id: "repo-cogenly", title: "cogenly", workspaceRoot: "/code/cogenly" },
  { id: "repo-site", title: "site", workspaceRoot: "/code/site" },
];

/** The server's label RPCs over an in-memory store, behind the real authorization middleware. */
const makeServer = (scopes: ReadonlyArray<(typeof PROJECT_LABEL_CLI_SCOPES)[number]>) => {
  const labels = new Map<string, ProjectLabelWithRepositories>();
  let next = 0;
  const at = "2026-10-22T22:00:00.000Z";
  const get = (id: string): Effect.Effect<ProjectLabelWithRepositories, ProjectLabelError> => {
    const label = labels.get(id);
    return label === undefined
      ? Effect.fail(new ProjectLabelError({ operation: "read", reason: "not_found" }))
      : Effect.succeed(label);
  };
  const save = (label: ProjectLabelWithRepositories) =>
    Effect.sync(() => {
      labels.set(label.id, label);
      return { label };
    });
  const handlers = Layer.mergeAll(
    group.toLayerHandler(WS_METHODS.projectLabelsList, () =>
      Effect.succeed({ labels: [...labels.values()] }),
    ),
    group.toLayerHandler(WS_METHODS.projectLabelsCreate, (input) =>
      save({
        id: ProjectLabelId.make(`label-${(next += 1)}`),
        name: input.name,
        ...(input.color === undefined ? {} : { color: input.color }),
        instructions: "",
        createdAt: at,
        updatedAt: at,
        repositoryIds: [],
        sourceLinks: [],
        projectChatThreadId: null,
        threadCount: 0,
      }),
    ),
    group.toLayerHandler(WS_METHODS.projectLabelsUpdate, (input) =>
      get(input.id).pipe(
        Effect.flatMap((label) => save({ ...label, ...(input.name ? { name: input.name } : {}) })),
      ),
    ),
    group.toLayerHandler(WS_METHODS.projectLabelsDelete, (input) =>
      Effect.sync(() => ({ deleted: labels.delete(input.id) })),
    ),
    group.toLayerHandler(WS_METHODS.projectLabelsLinkRepository, (input) =>
      Effect.gen(function* () {
        // A repository is filed in one project at a time.
        for (const other of labels.values()) {
          labels.set(other.id, {
            ...other,
            repositoryIds: other.repositoryIds.filter((id) => id !== input.repositoryId),
          });
        }
        const label = yield* get(input.labelId);
        return yield* save({
          ...label,
          repositoryIds: [...label.repositoryIds, input.repositoryId],
        });
      }),
    ),
    group.toLayerHandler(WS_METHODS.projectLabelsUnlinkRepository, (input) =>
      get(input.labelId).pipe(
        Effect.flatMap((label) =>
          save({
            ...label,
            repositoryIds: label.repositoryIds.filter((id) => id !== input.repositoryId),
          }),
        ),
      ),
    ),
  );
  return RpcTest.makeClient(group).pipe(
    Effect.provide(Layer.merge(handlers, RpcAuthorization.layer([...scopes]))),
    Effect.map((client): ProjectLabelCliContext => ({
      client,
      repositories: Effect.succeed(repositories),
      normalizePath: (path) =>
        Effect.succeed(path.startsWith("~/") ? `/code/${path.slice(2)}` : path),
    })),
  );
};

const run = (context: ProjectLabelCliContext, command: ProjectLabelCliCommand) =>
  runProjectLabelCommand(context, command);

describe("cogenly project label", () => {
  it.effect("creates, renames, files repositories and deletes, by name, id or folder", () =>
    Effect.gen(function* () {
      const context = yield* makeServer(PROJECT_LABEL_CLI_SCOPES);

      const created = yield* run(context, { _tag: "create", name: "Work", color: "blue" });
      expect(created.json).toMatchObject({ label: { id: "label-1", name: "Work", color: "blue" } });
      yield* run(context, { _tag: "create", name: "Side", color: undefined });
      // A color the app cannot show is refused, naming the ones it can.
      const refused = yield* run(context, { _tag: "create", name: "Hex", color: "#3b82f6" }).pipe(
        Effect.flip,
      );
      expect(refused.message).toContain("gray, red, amber, green, teal, blue, violet, pink");

      const renamed = yield* run(context, { _tag: "rename", label: "work", name: "Client work" });
      expect(renamed.text).toContain("Client work (label-1)");

      // By folder (normalized like the app does), then by id.
      yield* run(context, { _tag: "add-repo", label: "Client work", repository: "~/cogenly" });
      const filed = yield* run(context, {
        _tag: "add-repo",
        label: "label-1",
        repository: "repo-site",
      });
      expect(filed.json).toMatchObject({
        label: { repositoryIds: ["repo-cogenly", "repo-site"] },
      });
      expect(filed.text).toContain("  site  /code/site");

      // Filing it elsewhere moves it.
      yield* run(context, { _tag: "add-repo", label: "Side", repository: "/code/site" });
      const listed = yield* run(context, { _tag: "list" });
      expect(listed.json).toMatchObject({
        labels: [
          { name: "Client work", repositoryIds: ["repo-cogenly"] },
          { name: "Side", repositoryIds: ["repo-site"] },
        ],
      });

      const removed = yield* run(context, {
        _tag: "remove-repo",
        label: "Client work",
        repository: "repo-cogenly",
      });
      expect(removed.json).toMatchObject({ label: { repositoryIds: [] } });

      expect((yield* run(context, { _tag: "delete", label: "Side" })).json).toEqual({
        deleted: true,
        id: "label-2",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("names what it can't find instead of guessing", () =>
    Effect.gen(function* () {
      const context = yield* makeServer(PROJECT_LABEL_CLI_SCOPES);
      yield* run(context, { _tag: "create", name: "Work", color: undefined });
      yield* run(context, { _tag: "create", name: "work", color: undefined });

      const ambiguous = yield* run(context, { _tag: "delete", label: "WORK" }).pipe(Effect.flip);
      expect(ambiguous.message).toMatch(/More than one project is named "WORK": label-1, label-2/);

      const noRepo = yield* run(context, {
        _tag: "add-repo",
        label: "label-1",
        repository: "/code/elsewhere",
      }).pipe(Effect.flip);
      expect(noRepo.message).toMatch(/No repository matches .*cogenly project add/);

      const noLabel = yield* run(context, { _tag: "rename", label: "Nope", name: "x" }).pipe(
        Effect.flip,
      );
      expect(noLabel.message).toMatch(/No project matches "Nope"/);
    }).pipe(Effect.scoped),
  );

  it.effect("is held to the app's grants: a read-only session can list but not change", () =>
    Effect.gen(function* () {
      expect(PROJECT_LABEL_CLI_SCOPES).toEqual([
        AuthOrchestrationReadScope,
        AuthOrchestrationOperateScope,
      ]);
      const readOnly = yield* makeServer([AuthOrchestrationReadScope]);
      expect((yield* run(readOnly, { _tag: "list" })).json).toEqual({ labels: [] });
      const refused = yield* run(readOnly, {
        _tag: "create",
        name: "Work",
        color: undefined,
      }).pipe(Effect.flip);
      expect(refused.message).toBe(
        "This session isn't allowed to change projects on that Cogenly.",
      );
      expect(refused.cause).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthOrchestrationOperateScope,
      });
    }).pipe(Effect.scoped),
  );
});
