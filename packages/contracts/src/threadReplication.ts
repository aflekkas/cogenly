import * as Schema from "effect/Schema";
import { AgentId, AgentUpsertInput, AgentMutationResult } from "./agent.ts";
import { AuthPeerDelegateScope, AuthSyncReplicateScope } from "./auth.ts";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ChatAttachment } from "./chatAttachment.ts";
import { OrchestrationMessageContext } from "./composerContext.ts";
import { makePeerChannel } from "./machine.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2WorkHandoffContext,
  ThreadLaunchSubagent,
  ThreadLaunchFork,
  OrchestrationV2ThreadForkSourcePoint,
  OrchestrationV2CreationSource,
  OrchestrationV2ServerCommand,
  ThreadSurface,
  WorkOrigin,
} from "./orchestrationV2.ts";
import { ProjectLabelId } from "./projectLabel.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import {
  ScheduledTaskUpsertInput,
  ScheduledTaskMutationResult,
  ScheduledTaskRunNowInput,
  ScheduledTaskRunNowResult,
} from "./scheduledTask.ts";
import { ServerProvider } from "./server.ts";
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

/**
 * The project a thread launched on another machine runs in, in terms any
 * machine can map: its "No project", or its checkout of a repository by
 * remote. `labelId` names the project that links the remote, so the target
 * can clone it there when it has no checkout.
 */
export const ThreadLaunchProject = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("scratch") }),
  Schema.Struct({
    kind: Schema.Literal("repository"),
    remote: SharedRepositoryRemote,
    labelId: Schema.optional(ProjectLabelId),
  }),
]);
export type ThreadLaunchProject = typeof ThreadLaunchProject.Type;

/**
 * A launch as another machine runs it. Paths are machine-local, so a
 * workspace is the project root or a new worktree, never an existing one.
 */
export const ThreadLaunchPortable = Schema.Struct({
  subagent: Schema.optionalKey(ThreadLaunchSubagent),
  fork: Schema.optionalKey(ThreadLaunchFork),
  handoffSummary: Schema.optionalKey(Schema.String),
  handoffContext: Schema.optionalKey(OrchestrationV2WorkHandoffContext),
  surface: Schema.optionalKey(ThreadSurface),
  workOrigin: Schema.optionalKey(WorkOrigin),
  sourceThreadId: Schema.optionalKey(ThreadId),
  sourceAgentId: Schema.optionalKey(AgentId),
  sourceAgentRunId: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(
    Schema.Struct({ id: AgentId, role: Schema.Literals(["conversation", "work"]) }),
  ),
  title: Schema.String,
  generateTitle: Schema.optionalKey(Schema.Boolean),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceStrategy: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("root"),
      branch: Schema.optional(TrimmedNonEmptyString),
    }),
    Schema.Struct({
      type: Schema.Literal("worktree"),
      baseRef: TrimmedNonEmptyString,
      branch: Schema.optional(TrimmedNonEmptyString),
      startFromOrigin: Schema.optional(Schema.Boolean),
    }),
  ]),
  projectFolderId: Schema.optionalKey(ProjectLabelId),
  initialMessage: Schema.optionalKey(
    Schema.Struct({
      messageId: Schema.optionalKey(MessageId),
      scheduledTaskId: Schema.optionalKey(ScheduledTaskId),
      senderThreadId: Schema.optionalKey(ThreadId),
      text: Schema.String,
      attachments: Schema.Array(ChatAttachment),
      context: Schema.optional(OrchestrationMessageContext),
    }),
  ),
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
});
export type ThreadLaunchPortable = typeof ThreadLaunchPortable.Type;

/** Bounded committed Git history for worktree delegation. */
export const ThreadRepositoryBundle = Schema.Struct({
  revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)),
  ref: Schema.String.check(Schema.isPattern(/^refs\/cogenly\/delegate\/[a-zA-Z0-9._-]+$/)),
  base64: Schema.String.check(Schema.isMaxLength(45 * 1024 * 1024)),
});
export type ThreadRepositoryBundle = typeof ThreadRepositoryBundle.Type;

/**
 * Start a new thread on `target`, which owns it from its first event and
 * runs its first turn. Sent to the target, or to the hub, which relays it.
 * The same command id (and thread id, when the caller chose one) makes a
 * retry return the thread the first attempt created. The target pushes the
 * new thread's events to the caller before it replies.
 */
export const ThreadLaunchRemote = makePeerChannel({
  name: "threads.launch.v1",
  scope: AuthPeerDelegateScope,
  payload: Schema.Struct({
    target: EnvironmentId,
    commandId: CommandId,
    threadId: Schema.optional(ThreadId),
    project: ThreadLaunchProject,
    launch: ThreadLaunchPortable,
    bundle: Schema.optional(ThreadRepositoryBundle),
    /** Files of the initial message's attachments, by their names here. */
    files: Schema.Array(ThreadAttachmentFile),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    resumed: Schema.Boolean,
    eventIds: Schema.Array(EventId),
  }),
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

/** The target's own provider catalog; local instance IDs and models differ between machines. */
export const ThreadMachineCatalog = makePeerChannel({
  name: "threads.catalog.v1",
  scope: AuthPeerDelegateScope,
  payload: Schema.Struct({ target: EnvironmentId }),
  success: Schema.Struct({ providers: Schema.Array(ServerProvider) }),
  error: ThreadRemoteError,
});

/** Result publication waits for the owner's own restart/limit recovery and descendants. */
export const ThreadTaskProgress = makePeerChannel({
  name: "threads.task-progress.v1",
  scope: AuthPeerDelegateScope,
  payload: Schema.Struct({
    target: EnvironmentId,
    threadId: ThreadId,
    taskId: Schema.optional(NodeId),
  }),
  success: Schema.Struct({ pending: Schema.Boolean }),
  error: ThreadRemoteError,
});

/** Creation is authored by the target, including its owned conversation and first turn. */
const {
  projectId: _agentProjectId,
  ownerMachine: _agentOwner,
  id: _agentId,
  ...PortableAgentFields
} = AgentUpsertInput.fields;
export const ThreadAgentCreate = makePeerChannel({
  name: "threads.agent-create.v1",
  scope: AuthPeerDelegateScope,
  payload: Schema.Struct({
    target: EnvironmentId,
    agentId: AgentId,
    project: ThreadLaunchProject,
    input: Schema.Struct(PortableAgentFields),
  }),
  success: AgentMutationResult,
  error: ThreadRemoteError,
});

/** Committed task results can return without a push to the repository remote. */
export const ThreadTaskBranch = makePeerChannel({
  name: "threads.task-branch.v1",
  scope: AuthPeerDelegateScope,
  payload: Schema.Struct({ target: EnvironmentId, threadId: ThreadId }),
  success: Schema.Struct({ branch: TrimmedNonEmptyString, bundle: ThreadRepositoryBundle }),
  error: ThreadRemoteError,
});

const {
  projectId: _scheduleProjectId,
  ownerMachine: _scheduleOwner,
  ...PortableScheduleFields
} = ScheduledTaskUpsertInput.fields;
export const ThreadScheduleUpsert = makePeerChannel({
  name: "threads.schedule-upsert.v1",
  scope: AuthPeerDelegateScope,
  payload: Schema.Struct({
    target: EnvironmentId,
    project: ThreadLaunchProject,
    input: Schema.Struct(PortableScheduleFields),
  }),
  success: ScheduledTaskMutationResult,
  error: ThreadRemoteError,
});
export const ThreadScheduleRun = makePeerChannel({
  name: "threads.schedule-run.v1",
  scope: AuthPeerDelegateScope,
  payload: Schema.Struct({ target: EnvironmentId, input: ScheduledTaskRunNowInput }),
  success: ScheduledTaskRunNowResult,
  error: ThreadRemoteError,
});

/** Fork through the source owner, preserving the repo and its pushed revision. */
export const ThreadForkMachineInput = Schema.Struct({
  commandId: CommandId,
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
  machine: EnvironmentId,
  sourcePoint: Schema.optional(OrchestrationV2ThreadForkSourcePoint),
  title: Schema.optional(TrimmedNonEmptyString),
  allowLastPushed: Schema.optional(Schema.Boolean),
});
export type ThreadForkMachineInput = typeof ThreadForkMachineInput.Type;
export const ThreadForkMachineResult = Schema.Struct({
  targetThreadId: ThreadId,
  sequence: Schema.Number,
  branch: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(Schema.String),
  usedLastPushed: Schema.Boolean,
});
export type ThreadForkMachineResult = typeof ThreadForkMachineResult.Type;
export const ThreadForkRequest = makePeerChannel({
  name: "threads.fork.v1",
  scope: AuthPeerDelegateScope,
  payload: Schema.Struct({
    owner: EnvironmentId,
    input: ThreadForkMachineInput,
    createdBy: OrchestrationV2Actor,
    creationSource: OrchestrationV2CreationSource,
  }),
  success: ThreadForkMachineResult,
  error: ThreadRemoteError,
});
