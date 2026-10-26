import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ProjectLabelId, type ProjectLabelWithRepositories } from "@cogenly/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  cloneRepositoryIntoLabel,
  type ProjectLabelCloneDeps,
} from "./ProjectLabelCloneRepository.ts";

const harness = (homeOwner: string | null) =>
  Effect.gen(function* () {
    const linked: Array<ProjectId> = [];
    const linkedRemotes: Array<string | null | undefined> = [];
    const resolved: Array<{ cwd: string; refresh?: boolean }> = [];
    const deps: ProjectLabelCloneDeps = {
      labels: {
        readActive: (id) =>
          Effect.succeed({
            label: {
              id,
              name: "Spawn Partners",
              sourceLinks: homeOwner === null ? [] : [{ kind: "github-owner", owner: homeOwner }],
            } as never,
          }),
        linkRepository: (input) =>
          Effect.sync(() => {
            linked.push(input.repositoryId);
            linkedRemotes.push(input.remote);
            return { label: {} as ProjectLabelWithRepositories };
          }),
      },
      clones: {
        start: (input, callbacks) =>
          Effect.gen(function* () {
            yield* callbacks.onCloned({
              projectId: input.projectId,
              workspaceRoot: input.destinationPath ?? "",
            });
            return {
              projectId: input.projectId,
              cwd: input.destinationPath ?? "",
              remoteUrl: input.remoteUrl ?? "",
              repository: null,
            };
          }),
      },
      projects: {
        create: () => Effect.succeed({} as never),
        update: () => Effect.succeed({} as never),
        delete: () => Effect.succeed({} as never),
      },
      identities: {
        resolve: (cwd, options) =>
          Effect.sync(() => {
            resolved.push({ cwd, ...options });
            return null;
          }),
      },
      settings: {
        getSettings: Effect.succeed({ projectsRoot: "/projects" } as never),
      },
      crypto: {
        randomUUIDv4: () => Effect.succeed("00000000-0000-4000-8000-000000000000"),
      } as unknown as ProjectLabelCloneDeps["crypto"],
      path: yield* Path.Path,
      home: "/home",
      cogenlyHome: "/cogenly",
      refreshGitStatus: () => Effect.void,
    };
    return { deps, linked, linkedRemotes, resolved };
  });

describe("cloneRepositoryIntoLabel", () => {
  it.effect("clones another owner's repository under repos/<owner>/<repo>", () =>
    Effect.gen(function* () {
      const { deps } = yield* harness("spawn-partners");
      const started = yield* cloneRepositoryIntoLabel(
        { id: ProjectLabelId.make("label:spawn"), repository: "aflekkas/athens-racing" },
        deps,
      );
      expect(started.cwd).toBe("/projects/Spawn Partners/repos/aflekkas/athens-racing");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("clones under the project folder and links the repository in it", () =>
    Effect.gen(function* () {
      const labelId = ProjectLabelId.make("label:spawn");
      // The project's home owner: its own repositories sit directly in repos/.
      const { deps, linked, linkedRemotes, resolved } = yield* harness("spawn");
      const started = yield* cloneRepositoryIntoLabel(
        {
          id: labelId,
          remoteUrl: "git@github.com:Spawn/Platform.git",
        },
        deps,
      );
      expect(started.cwd).toBe("/projects/Spawn Partners/repos/platform");
      // Linked immediately (so the picker shows it while cloning) and again
      // once the clone lands.
      expect(linked).toEqual([started.projectId, started.projectId]);
      // The link made while the clone runs already carries the normalized
      // remote, so a failed clone leaves a recoverable record behind.
      expect(linkedRemotes).toEqual([undefined, "github.com/spawn/platform"]);
      expect(resolved).toEqual([{ cwd: "/projects/Spawn Partners/repos/platform", refresh: true }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
