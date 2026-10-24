import * as Schema from "effect/Schema";
import { AuthPeerDelegateScope, AuthSyncReplicateScope } from "./auth.ts";
import { EnvironmentId, EventId, ProjectId, ThreadId } from "./baseSchemas.ts";
import { makePeerChannel } from "./machine.ts";
import { OrchestrationV2DomainEventJson, OrchestrationV2ServerCommand } from "./orchestrationV2.ts";
import { ProjectLabelId } from "./projectLabel.ts";
import { SharedRepositoryRemote } from "./sharedDocument.ts";

/** One batch: a single larger event still travels alone so it cannot wedge a cursor. */
export const THREAD_REPLICATION_BATCH_BYTES = 256 * 1024;
export const THREAD_REPLICATION_BATCH_EVENTS = 256;

const Counter = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

/** Positions in the sender's own event sequence and thread metadata log. */
export const ThreadReplicationCursor = Schema.Struct({ events: Counter, meta: Counter });
export type ThreadReplicationCursor = typeof ThreadReplicationCursor.Type;

/**
 * The portable identity of the checkout a thread runs in on its owner. Project
 * ids are local to each machine; a receiver maps this to its own checkout.
 */
export const ThreadReplicaSource = Schema.Struct({
  projectId: ProjectId,
  kind: Schema.Literals(["scratch", "repository", "local"]),
  remote: Schema.NullOr(SharedRepositoryRemote),
});
export type ThreadReplicaSource = typeof ThreadReplicaSource.Type;

/** Per-thread state that is not an orchestration event. */
export const ThreadReplicaMeta = Schema.Struct({
  threadId: ThreadId,
  owner: EnvironmentId,
  /** Increments each time ownership moves; the newer epoch wins. */
  epoch: Counter,
  folderId: Schema.NullOr(ProjectLabelId),
  source: Schema.NullOr(ThreadReplicaSource),
});
export type ThreadReplicaMeta = typeof ThreadReplicaMeta.Type;

export const ThreadReplicationBatch = Schema.Struct({
  after: ThreadReplicationCursor,
  cursor: ThreadReplicationCursor,
  events: Schema.Array(OrchestrationV2DomainEventJson).check(
    Schema.isMaxLength(THREAD_REPLICATION_BATCH_EVENTS),
  ),
  /** Metadata for every thread with events in the batch, plus any whose metadata changed. */
  meta: Schema.Array(ThreadReplicaMeta).check(
    Schema.isMaxLength(THREAD_REPLICATION_BATCH_EVENTS * 2),
  ),
});
export type ThreadReplicationBatch = typeof ThreadReplicationBatch.Type;

export class ThreadReplicationError extends Schema.TaggedError<ThreadReplicationError>()(
  "ThreadReplicationError",
  {
    reason: Schema.Literals(["storage", "invalid-cursor", "invalid-batch"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Thread replication failed (${this.reason}).`;
  }
}

/** Attachments a forwarded command carries total at most this many bytes. */
export const THREAD_FORWARD_MAX_FILE_BYTES = 32 * 1024 * 1024;

/** An attachment file by its name in the attachments directory; the name derives from its id. */
export const ThreadAttachmentFile = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/)),
  base64: Schema.String,
});
export type ThreadAttachmentFile = typeof ThreadAttachmentFile.Type;

export class ThreadRemoteError extends Schema.TaggedError<ThreadRemoteError>()(
  "ThreadRemoteError",
  {
    reason: Schema.Literals([
      "offline",
      "not-owner",
      "moving",
      "rejected",
      "too-large",
      // Handoff refusals a move reports per thread.
      "busy",
      "local-changes",
      "needs-repository",
      "behind",
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message() {
    return this.detail ?? `The machine that runs this thread refused (${this.reason}).`;
  }
}

/**
 * A command for a thread another machine runs, sent to that machine (or to
 * the hub, which relays it to the spoke that runs it). The owner dispatches
 * it, pushes the resulting events back, then replies with their ids.
 */
export const ThreadCommandForward = makePeerChannel({
  name: "threads.command.v1",
  scope: AuthPeerDelegateScope,
  payload: Schema.Struct({
    command: OrchestrationV2ServerCommand,
    files: Schema.Array(ThreadAttachmentFile),
  }),
  success: Schema.Struct({ eventIds: Schema.Array(EventId) }),
  error: ThreadRemoteError,
});

/**
 * Read one attachment file by id. Ids start with their thread's segment, so
 * the hub can relay the read to the spoke that runs that thread.
 */
export const ThreadAttachmentRead = makePeerChannel({
  name: "threads.attachment.read.v1",
  scope: AuthPeerDelegateScope,
  payload: Schema.Struct({ attachmentId: ThreadAttachmentFile.fields.name }),
  success: Schema.NullOr(ThreadAttachmentFile),
  error: ThreadRemoteError,
});

/** Threads one move request names, at most. Larger moves are split by the caller. */
export const THREAD_MOVE_MAX_THREADS = 1000;

export const ThreadMoveInput = Schema.Struct({
  threadIds: Schema.Array(ThreadId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(THREAD_MOVE_MAX_THREADS),
  ),
  /** The paired machine that runs the threads from now on. */
  target: EnvironmentId,
  /**
   * Move Work threads whose worktree has uncommitted or unpushed changes.
   * Those changes stay on the old machine; the target checks out the branch
   * as pushed.
   */
  leaveLocalChanges: Schema.optional(Schema.Boolean),
});
export type ThreadMoveInput = typeof ThreadMoveInput.Type;

export const ThreadMoveSkip = Schema.Struct({
  threadId: ThreadId,
  reason: ThreadRemoteError.fields.reason,
  detail: Schema.String,
});
export type ThreadMoveSkip = typeof ThreadMoveSkip.Type;

export const ThreadMoveResult = Schema.Struct({
  /** Threads the target runs now, including ones it already ran. */
  moved: Schema.Array(ThreadId),
  /** Threads left where they were, with the reason. Moving them again retries. */
  skipped: Schema.Array(ThreadMoveSkip),
});
export type ThreadMoveResult = typeof ThreadMoveResult.Type;

/** Ask the machine that runs some threads to move them (the hub relays to a spoke). */
export const ThreadMoveRequest = makePeerChannel({
  name: "threads.move.v1",
  scope: AuthPeerDelegateScope,
  payload: ThreadMoveInput,
  success: ThreadMoveResult,
  error: ThreadRemoteError,
});

/**
 * The second phase of a move, sent by the current owner once the target has
 * every event: the target takes the thread at `epoch` or refuses. Repeating a
 * commit the target already took succeeds, so the owner can retry after a
 * lost reply.
 */
export const ThreadHandoffCommit = makePeerChannel({
  name: "threads.handoff.commit.v1",
  scope: AuthPeerDelegateScope,
  payload: Schema.Struct({
    threadId: ThreadId,
    from: EnvironmentId,
    to: EnvironmentId,
    epoch: Counter,
    /** The owner's last event for the thread; null for a thread without events. */
    lastEventId: Schema.NullOr(EventId),
    /** Attachment ids the target copies before it accepts, since the owner may go offline. */
    attachmentIds: Schema.Array(ThreadAttachmentFile.fields.name),
  }),
  success: Schema.Struct({}),
  error: ThreadRemoteError,
});

/** Push the sender's next batch; the reply names the cursor the receiver committed. */
export const ThreadReplicationApply = makePeerChannel({
  name: "sync.threads.apply.v1",
  scope: AuthSyncReplicateScope,
  payload: ThreadReplicationBatch,
  success: Schema.Struct({ acknowledged: ThreadReplicationCursor }),
  error: ThreadReplicationError,
});
