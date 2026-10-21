import { describe, expect, it } from "@effect/vitest";
import {
  AgentId,
  ProjectId,
  ProjectLabelError,
  ProjectLabelId,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
  type CommandId,
  type ForkThreadToProjectInput,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type ProjectLabelWithRepositories,
  type ThreadSurface,
} from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { forkThreadToProject, type ForkThreadToProjectDeps } from "./ProjectLabelForkToProject.ts";

const decodeRuntimeMode = Schema.decodeUnknownSync(RuntimeMode);
const projectId = ProjectId.make("project:fork-to-project");
const providerInstanceId = ProviderInstanceId.make("codex");
const labelId = ProjectLabelId.make("label:fork-target");

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly id?: ThreadId;
  readonly surface?: ThreadSurface;
  readonly workRole?: boolean;
  readonly subagent?: boolean;
}): OrchestrationV2AppThread {
  const threadId = input.id ?? ThreadId.make("thread:fork-source");
  return {
    ...(input.surface === undefined ? {} : { surface: input.surface }),
    ...(input.workRole === true
      ? { agent: { id: AgentId.make("agent:owner"), role: "work" as const } }
      : {}),
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Source chat",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.5" },
    runtimeMode: decodeRuntimeMode("full-access"),
    interactionMode: "default",
    branch: null,
    worktreePath: "/scratch/chat",
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: input.subagent === true ? "subagent" : null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const turnedRun = { status: "completed" } as OrchestrationV2Run;

const crypto = {
  randomUUIDv4: () => Effect.succeed("00000000-0000-4000-8000-000000000000"),
} as unknown as Crypto.Crypto;

type Threads = ForkThreadToProjectDeps["threads"];
type Labels = ForkThreadToProjectDeps["labels"];

function setup(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly labelMissing?: boolean;
  readonly dispatchFails?: boolean;
}) {
  const dispatched: Array<Parameters<Threads["dispatch"]>[0]> = [];
  const moved: Array<Parameters<Labels["moveThread"]>[0]> = [];
  const threads = {
    getThreadRecords: (() =>
      Effect.succeed({ thread: input.thread, runs: input.runs })) as Threads["getThreadRecords"],
    dispatch: ((command: Parameters<Threads["dispatch"]>[0]) =>
      Effect.gen(function* () {
        dispatched.push(command);
        if (input.dispatchFails === true)
          return yield* Effect.fail(new Error("fork rejected") as never);
        return { sequence: 1, storedEvents: [] };
      })) as Threads["dispatch"],
  } satisfies Threads;
  const labels = {
    read: ((id: ProjectLabelId) =>
      input.labelMissing === true
        ? Effect.fail(new ProjectLabelError({ operation: "read", reason: "not_found" }))
        : Effect.succeed({
            label: { id } as ProjectLabelWithRepositories,
          })) as Labels["read"],
    moveThread: ((move: Parameters<Labels["moveThread"]>[0]) =>
      Effect.sync(() => {
        moved.push(move);
        return { threadId: move.threadId, projectFolderId: move.folderId };
      })) as Labels["moveThread"],
  } satisfies Labels;
  return { deps: { labels, threads, crypto } satisfies ForkThreadToProjectDeps, dispatched, moved };
}

const input: ForkThreadToProjectInput = {
  threadId: ThreadId.make("thread:fork-source"),
  labelId,
};

describe("forkThreadToProject", () => {
  it.effect("forks a turned chat and files the fork in the target project", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const { deps, dispatched, moved } = setup({
        thread: makeThread({ now, surface: "chat" }),
        runs: [turnedRun],
      });
      const result = yield* forkThreadToProject(input, deps);
      expect(result.threadId).not.toBe(input.threadId);
      expect(result.threadId.startsWith("thread:")).toBe(true);
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        type: "thread.fork",
        sourceThreadId: input.threadId,
        targetThreadId: result.threadId,
        sourcePoint: { type: "latest_stable" },
      });
      const command = dispatched[0] as { commandId: CommandId } | undefined;
      expect(command?.commandId.startsWith("server:fork-to-project:")).toBe(true);
      expect(moved).toEqual([{ threadId: result.threadId, folderId: labelId }]);
    }),
  );

  it.effect("refuses Work threads, which keep their repository project", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      for (const thread of [
        makeThread({ now, surface: "work" }),
        makeThread({ now, surface: "builder" }),
        makeThread({ now, surface: "chat", workRole: true }),
      ]) {
        const { deps, dispatched, moved } = setup({ thread, runs: [turnedRun] });
        const failure = yield* forkThreadToProject(input, deps).pipe(Effect.flip);
        expect(failure._tag).toBe("OrchestrationDispatchCommandError");
        expect(failure.message).toContain("Only chats move into a project by forking");
        expect(dispatched).toHaveLength(0);
        expect(moved).toHaveLength(0);
      }
    }),
  );

  it.effect("sends turnless chats to moveThread instead of forking", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const { deps, dispatched, moved } = setup({
        thread: makeThread({ now, surface: "chat" }),
        runs: [],
      });
      const failure = yield* forkThreadToProject(input, deps).pipe(Effect.flip);
      expect(failure._tag).toBe("OrchestrationDispatchCommandError");
      expect(failure.message).toContain("moveThread");
      expect(dispatched).toHaveLength(0);
      expect(moved).toHaveLength(0);
    }),
  );

  it.effect("fails before dispatching when the label is missing", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const { deps, dispatched, moved } = setup({
        thread: makeThread({ now, surface: "chat" }),
        runs: [turnedRun],
        labelMissing: true,
      });
      const failure = yield* forkThreadToProject(input, deps).pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "ProjectLabelError", reason: "not_found" });
      expect(dispatched).toHaveLength(0);
      expect(moved).toHaveLength(0);
    }),
  );

  it.effect("never files when the fork dispatch fails", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const { deps, dispatched, moved } = setup({
        thread: makeThread({ now, surface: "chat" }),
        runs: [turnedRun],
        dispatchFails: true,
      });
      const failure = yield* forkThreadToProject(input, deps).pipe(Effect.flip);
      expect(failure._tag).toBe("OrchestrationDispatchCommandError");
      expect(dispatched).toHaveLength(1);
      expect(moved).toHaveLength(0);
    }),
  );
});
