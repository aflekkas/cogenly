import { describe, expect, it } from "@effect/vitest";
import {
  type ProjectCloneSnapshot,
  ProjectId,
  SourceControlProviderKind,
  SourceControlRepositoryError,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as ProjectCloneTracker from "./ProjectCloneTracker.ts";

const projectId = ProjectId.make("project:smile-express");
const destinationPath = "/projects/Spawn/smile-express";

/** Git always fails here, with the message a missing repository gives. */
const failingRepositories = (discarded: Array<string>) =>
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
    prepareClone: () =>
      Effect.succeed({
        destinationPath,
        remoteUrl: "https://github.com/spawn/smile-express.git",
        cloneUrl: "https://github.com/spawn/smile-express.git",
        repository: null,
      }),
    cloneRepository: () =>
      Effect.fail(
        new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: SourceControlProviderKind.make("github"),
          detail: "remote: Repository not found.",
        }),
      ),
    discardClone: (path) => Effect.sync(() => void discarded.push(path)),
  });

const startInput = {
  projectId,
  title: "smile-express",
  createdAt: "2026-10-23T00:00:00.000Z",
  remoteUrl: "https://github.com/spawn/smile-express.git",
  destinationPath,
};

/**
 * The clone once it failed; a flow that removes its project settles only
 * once the removal is recorded.
 */
const failedClone = (
  tracker: ProjectCloneTracker.ProjectCloneTracker["Service"],
  removesProject: boolean,
) =>
  tracker.stream.pipe(
    Stream.map((clones) => clones.find((clone) => clone.projectId === projectId)),
    Stream.filter(
      (clone): clone is ProjectCloneSnapshot =>
        clone !== undefined &&
        clone.phase === "failed" &&
        (clone.projectRemoved === true || !removesProject),
    ),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

describe("ProjectCloneTracker", () => {
  it.effect("a failed clone that owns its project removes the project and checkout", () => {
    const discarded: Array<string> = [];
    const removed: Array<ProjectId> = [];
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.make;
      yield* tracker.start(startInput, {
        createProject: () => Effect.void,
        onCloned: () => Effect.void,
        removeProject: (input) => Effect.sync(() => void removed.push(input.projectId)),
      });
      const clone = yield* failedClone(tracker, true);
      expect(clone).toMatchObject({
        phase: "failed",
        error: "remote: Repository not found.",
        projectRemoved: true,
      });
      expect(removed).toEqual([projectId]);
      expect(discarded).toContain(destinationPath);
      // Nothing is left to retry in place; the picker starts a fresh clone,
      // which the abandoned one no longer blocks from the same destination.
      expect(yield* tracker.retry(projectId)).toBe(false);
      const fresh = ProjectId.make("project:smile-express-again");
      const restarted = yield* tracker.start(
        { ...startInput, projectId: fresh },
        { createProject: () => Effect.void, onCloned: () => Effect.void },
      );
      expect(restarted.projectId).toBe(fresh);
    }).pipe(Effect.scoped, Effect.provide(failingRepositories(discarded)));
  });

  it.effect("a failed clone without removeProject keeps its project for Retry", () => {
    const discarded: Array<string> = [];
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.make;
      yield* tracker.start(startInput, {
        createProject: () => Effect.void,
        onCloned: () => Effect.void,
      });
      const clone = yield* failedClone(tracker, false);
      expect(clone.projectRemoved).toBeUndefined();
      expect(discarded).toEqual([]);
      expect(yield* tracker.retry(projectId)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(failingRepositories(discarded)));
  });
});
