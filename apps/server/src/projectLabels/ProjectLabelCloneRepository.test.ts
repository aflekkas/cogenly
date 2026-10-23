import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ProjectLabelId, type ProjectLabelWithRepositories } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  cloneRepositoryIntoLabel,
  type ProjectLabelCloneDeps,
} from "./ProjectLabelCloneRepository.ts";

describe("cloneRepositoryIntoLabel", () => {
  it.effect("clones under the project folder and links the repository in it", () =>
    Effect.gen(function* () {
      const labelId = ProjectLabelId.make("label:spawn");
      const linked: Array<ProjectId> = [];
      const resolved: Array<{ cwd: string; refresh?: boolean }> = [];
      const deps: ProjectLabelCloneDeps = {
        labels: {
          readActive: (id) =>
            Effect.succeed({
              label: { id, name: "Spawn Partners" } as ProjectLabelWithRepositories,
            }),
          linkRepository: (input) =>
            Effect.sync(() => {
              linked.push(input.repositoryId);
              return { label: {} as ProjectLabelWithRepositories };
            }),
        },
        clones: {
          start: (input, callbacks) =>
            Effect.gen(function* () {
              // The tracked clone landing files the repository again, which
              // is where its remote is read and stored on the link.
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
              resolved.push({ cwd, ...(options ?? {}) });
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
      const started = yield* cloneRepositoryIntoLabel(
        {
          id: labelId,
          remoteUrl: "git@github.com:Spawn/Platform.git",
        },
        deps,
      );
      expect(started.cwd).toBe("/projects/Spawn Partners/Platform");
      // Linked immediately (so the picker shows it while cloning) and again
      // once the clone lands.
      expect(linked).toEqual([started.projectId, started.projectId]);
      expect(resolved).toEqual([{ cwd: "/projects/Spawn Partners/Platform", refresh: true }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
