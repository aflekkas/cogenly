import * as Schema from "effect/Schema";
import { AuthPeerDelegateScope, AuthSyncReplicateScope } from "./auth.ts";
import { CommandId, EnvironmentId, EventId, ProjectId, ThreadId } from "./baseSchemas.ts";
import { makePeerChannel } from "./machine.ts";
import { OrchestrationV2ServerCommand } from "./orchestrationV2.ts";
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

/**
 * Items travel as plain JSON and the receiver decodes each one: an event type
 * or metadata a newer build added must hold back only its own thread, never
 * fail the batch (see docs/internals/thread-sync.md). Senders encode events
 * with `OrchestrationV2DomainEventJson` and metadata with `ThreadReplicaMeta`.
 */
export const ThreadReplicationBatch = Schema.Struct({
  after: ThreadReplicationCursor,
  cursor: ThreadReplicationCursor,
  events: Schema.Array(Schema.Json).check(Schema.isMaxLength(THREAD_REPLICATION_BATCH_EVENTS)),
  /** Metadata for every thread with events in the batch, plus any whose metadata changed. */
  meta: Schema.Array(Schema.Json).check(Schema.isMaxLength(THREAD_REPLICATION_BATCH_EVENTS * 2)),
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
  /** Report what would move, what would be skipped and where, without moving anything. */
  dryRun: Schema.optional(Schema.Boolean),
});
export type ThreadMoveInput = typeof ThreadMoveInput.Type;

/** Every live thread `from` runs, such as all of a laptop's threads to the hub. */
export const ThreadMoveAllInput = Schema.Struct({
  from: EnvironmentId,
  target: EnvironmentId,
  leaveLocalChanges: Schema.optional(Schema.Boolean),
  dryRun: Schema.optional(Schema.Boolean),
});
export type ThreadMoveAllInput = typeof ThreadMoveAllInput.Type;

export const ThreadMoveSkip = Schema.Struct({
  threadId: ThreadId,
  reason: ThreadRemoteError.fields.reason,
  detail: Schema.String,
});
export type ThreadMoveSkip = typeof ThreadMoveSkip.Type;

/** Where a thread would run on the target, from a dry run. */
export const ThreadMovePlacement = Schema.Struct({
  threadId: ThreadId,
  /** The target's checkout, or what the move does to get one. */
  project: Schema.String,
  /** The target's worktree path for Work; the next turn creates it from the branch. */
  worktreePath: Schema.NullOr(Schema.String),
});
export type ThreadMovePlacement = typeof ThreadMovePlacement.Type;

export const ThreadMovePlanned = Schema.Struct({
  ...ThreadMovePlacement.fields,
  title: Schema.String,
  /** The machine that runs it now. */
  from: EnvironmentId,
});
export type ThreadMovePlanned = typeof ThreadMovePlanned.Type;

export const ThreadMoveResult = Schema.Struct({
  /** Threads the target runs now, including ones it already ran. A dry run lists only those. */
  moved: Schema.Array(ThreadId),
  /** Threads left where they were, with the reason. Moving them again retries. */
  skipped: Schema.Array(ThreadMoveSkip),
  /** Dry run only: the threads that would move, and where. */
  planned: Schema.optional(Schema.Array(ThreadMovePlanned)),
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
/** Receipt data is portable; result sequences are remapped to the receiver's log. */
export const ThreadReplicaCommandReceipt = Schema.Struct({
  commandId: CommandId,
  commandType: Schema.String,
  acceptedAt: Schema.String,
  status: Schema.Literals(["accepted", "rejected"]),
  error: Schema.NullOr(Schema.String),
});
export type ThreadReplicaCommandReceipt = typeof ThreadReplicaCommandReceipt.Type;

/** Idempotency receipts accompany a move so a retried command cannot start another turn. */
export const ThreadHandoffReceipts = makePeerChannel({
  name: "threads.handoff.receipts.v1",
  scope: AuthPeerDelegateScope,
  payload: Schema.Struct({
    threadId: ThreadId,
    from: EnvironmentId,
    to: EnvironmentId,
    epoch: Counter,
    receipts: Schema.Array(ThreadReplicaCommandReceipt).check(Schema.isMaxLength(128)),
  }),
  success: Schema.Struct({}),
  error: ThreadRemoteError,
});

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
    /**
     * How many of the thread's events the owner replicates. The target
     * refuses as behind with fewer, so a gap in its copy never becomes the log.
     */
    eventCount: Schema.optional(Counter),
    /** Attachment ids the target copies before it accepts, since the owner may go offline. */
    attachmentIds: Schema.Array(ThreadAttachmentFile.fields.name),
  }),
  success: Schema.Struct({}),
  error: ThreadRemoteError,
});

/**
 * A dry run of moves: the machine that runs the threads checks each as a
 * move would, without fencing. A separate channel from ThreadMoveRequest, so
 * an older machine that does not know dry runs refuses instead of moving.
 */
export const ThreadMovePreview = makePeerChannel({
  name: "threads.move.preview.v1",
  scope: AuthPeerDelegateScope,
  payload: ThreadMoveInput,
  success: ThreadMoveResult,
  error: ThreadRemoteError,
});

/** Ask the target where it would run threads it has replicas of, as a commit would place them. */
export const ThreadHandoffPreview = makePeerChannel({
  name: "threads.handoff.preview.v1",
  scope: AuthPeerDelegateScope,
  payload: Schema.Struct({
    threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(THREAD_MOVE_MAX_THREADS)),
    to: EnvironmentId,
  }),
  success: Schema.Struct({
    placed: Schema.Array(ThreadMovePlacement),
    skipped: Schema.Array(ThreadMoveSkip),
  }),
  error: ThreadRemoteError,
});

/**
 * Run here the threads a machine that is no longer paired ran, or was
 * taking in a move that never finished. An explicit recovery: that machine
 * must be unpaired first, so one that is only offline keeps its threads.
 */
export const ThreadAdoptInput = Schema.Struct({
  /** The lost machine's environment id. Omit it with dryRun to list lost machines. */
  from: Schema.optional(EnvironmentId),
  dryRun: Schema.optional(Schema.Boolean),
});
export type ThreadAdoptInput = typeof ThreadAdoptInput.Type;

export const ThreadAdoptResult = Schema.Struct({
  /** Threads that run here now; with dryRun, the ones that would. */
  adopted: Schema.Array(ThreadId),
  skipped: Schema.Array(ThreadMoveSkip),
  /** Machines no longer paired that still own threads here, with how many. */
  unpaired: Schema.Array(Schema.Struct({ environmentId: EnvironmentId, threads: Counter })),
});
export type ThreadAdoptResult = typeof ThreadAdoptResult.Type;

export const ProjectMoveInput = Schema.Struct({
  id: ProjectLabelId,
  /** The paired machine that runs the project's threads and agents from now on. */
  target: EnvironmentId,
  leaveLocalChanges: Schema.optional(Schema.Boolean),
  /** Report repositories and threads as the move would handle them, without moving. */
  dryRun: Schema.optional(Schema.Boolean),
});
export type ProjectMoveInput = typeof ProjectMoveInput.Type;

export const ProjectMoveRepository = Schema.Struct({
  remote: Schema.String,
  /** `cloning` continues on the target after the move answers; `will-clone` is a dry run's. */
  status: Schema.Literals(["present", "cloning", "will-clone", "failed"]),
  detail: Schema.optional(Schema.String),
});
export type ProjectMoveRepository = typeof ProjectMoveRepository.Type;

export const ProjectMoveResult = Schema.Struct({
  repositories: Schema.Array(ProjectMoveRepository),
  threads: ThreadMoveResult,
});
export type ProjectMoveResult = typeof ProjectMoveResult.Type;

/** Make sure `target` has a checkout of every repository the project links (the hub relays). */
export const ProjectMovePrepare = makePeerChannel({
  name: "threads.project.prepare.v1",
  scope: AuthPeerDelegateScope,
  payload: Schema.Struct({ id: ProjectLabelId, target: EnvironmentId }),
  success: Schema.Array(ProjectMoveRepository),
  error: ThreadRemoteError,
});

/** What ProjectMovePrepare would do on `target`, changing nothing (the hub relays). */
export const ProjectMovePreview = makePeerChannel({
  name: "threads.project.preview.v1",
  scope: AuthPeerDelegateScope,
  payload: ProjectMovePrepare.payload,
  success: ProjectMovePrepare.success,
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
