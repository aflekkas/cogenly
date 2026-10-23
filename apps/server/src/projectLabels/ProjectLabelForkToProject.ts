import {
  CommandId,
  OrchestrationDispatchCommandError,
  ThreadId,
  type ForkThreadToProjectInput,
  type ForkThreadToProjectResult,
  type OrchestrationV2AppThread,
  ProjectLabelError,
} from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import type * as ProjectLabelService from "./ProjectLabelService.ts";

export interface ForkThreadToProjectDeps {
  readonly labels: Pick<
    ProjectLabelService.ProjectLabelService["Service"],
    "readActive" | "moveThread" | "list"
  >;
  readonly threads: Pick<
    ThreadManagementService.ThreadManagementService["Service"],
    "dispatch" | "getThreadRecords"
  >;
  readonly crypto: Crypto.Crypto;
}

const forkFailure = (message: string, cause?: unknown) =>
  new OrchestrationDispatchCommandError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const isForkableChat = (thread: OrchestrationV2AppThread): boolean =>
  (thread.surface === undefined || thread.surface === "chat") &&
  thread.agent?.role !== "work" &&
  thread.lineage.relationshipToParent !== "subagent";

/**
 * Move a chat with turns into a project by forking it: the source chat keeps
 * its history untouched, and the new chat — filed in the target project,
 * carrying the history through a `thread.fork` context transfer — runs with
 * the project dir as its working directory from its first turn. Turnless
 * chats keep using moveThread, and Work threads keep their repo assignment.
 */
export const forkThreadToProject: (
  input: ForkThreadToProjectInput,
  deps: ForkThreadToProjectDeps,
) => Effect.Effect<
  ForkThreadToProjectResult,
  OrchestrationDispatchCommandError | ProjectLabelError
> = Effect.fn("ProjectLabelForkToProject.fork")(function* (
  input: ForkThreadToProjectInput,
  deps: ForkThreadToProjectDeps,
) {
  const records = yield* deps.threads
    .getThreadRecords(input.threadId, ["runs"])
    .pipe(
      Effect.mapError((cause) =>
        forkFailure(
          userFacingDispatchErrorMessage(cause) ?? "Could not load the chat to move.",
          cause,
        ),
      ),
    );
  const source = records.thread;
  if (source.deletedAt !== null) return yield* forkFailure("This chat was deleted.");
  // A project's own conversation stays on its page; it never forks elsewhere.
  const home = (yield* deps.labels.list()).labels.find(
    (label) => label.projectChatThreadId === source.id,
  );
  if (home !== undefined)
    return yield* new ProjectLabelError({
      operation: "forkThreadToProject",
      reason: "project_chat",
      projectName: home.name,
    });
  // An agent's conversation is its single ongoing thread: forking would split
  // the agent from its history, so it re-files in place instead.
  if (source.agent?.role === "conversation") {
    yield* deps.labels.moveThread({ threadId: source.id, folderId: input.labelId });
    return { threadId: source.id };
  }
  if (!isForkableChat(source))
    return yield* forkFailure(
      "Only chats move into a project by forking; Work threads keep their repository's project.",
    );
  if (records.runs.length === 0)
    return yield* forkFailure(
      "This chat has no turns yet; file it with moveThread instead of forking.",
    );
  // Before forking, so an archived project leaves no stray fork behind.
  yield* deps.labels.readActive(input.labelId);
  const commandId = CommandId.make(
    `server:fork-to-project:${yield* deps.crypto.randomUUIDv4().pipe(Effect.orDie)}`,
  );
  const targetThreadId = ThreadId.make(
    `thread:${yield* deps.crypto.randomUUIDv4().pipe(Effect.orDie)}`,
  );
  yield* deps.threads
    .dispatch({
      type: "thread.fork",
      commandId,
      createdBy: "user",
      creationSource: "web",
      sourceThreadId: source.id,
      targetThreadId,
      sourcePoint: { type: "latest_stable" },
    })
    .pipe(
      Effect.mapError((cause) =>
        forkFailure(
          userFacingDispatchErrorMessage(cause) ?? "Could not fork the chat into the project.",
          cause,
        ),
      ),
    );
  // The fork lands turnless, so the re-parenting gate lets it file.
  yield* deps.labels.moveThread({ threadId: targetThreadId, folderId: input.labelId });
  return { threadId: targetThreadId };
});
