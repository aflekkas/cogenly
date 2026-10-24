import * as Schema from "effect/Schema";
import { AuthSyncReplicateScope } from "./auth.ts";
import { EnvironmentId, ProjectId, ThreadId } from "./baseSchemas.ts";
import { makePeerChannel } from "./machine.ts";
import { OrchestrationV2DomainEventJson } from "./orchestrationV2.ts";
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

/** Push the sender's next batch; the reply names the cursor the receiver committed. */
export const ThreadReplicationApply = makePeerChannel({
  name: "sync.threads.apply.v1",
  scope: AuthSyncReplicateScope,
  payload: ThreadReplicationBatch,
  success: Schema.Struct({ acknowledged: ThreadReplicationCursor }),
  error: ThreadReplicationError,
});
