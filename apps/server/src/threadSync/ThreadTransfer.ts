/**
 * ThreadTransfer: moving threads to another paired machine, which runs them
 * from then on. The current owner fences the idle thread, pushes its events,
 * then asks the target to commit; the target copies the attachments, takes
 * ownership at the next epoch and re-homes the thread in its own checkout.
 * A lost reply leaves the fence, and the owner retries the commit until the
 * target answers: the target taking a thread twice is harmless, two owners
 * are not. See docs/internals/thread-sync.md.
 */
import {
  CommandId,
  type EnvironmentId,
  EventId,
  type OrchestrationV2AppThread,
  ProjectLabelId,
  type ThreadAdoptInput,
  type ThreadAdoptResult,
  ThreadHandoffCommit,
  ThreadHandoffReceipts,
  ThreadHandoffPreview,
  type ThreadId,
  type ThreadMoveInput,
  type ThreadMovePlacement,
  type ThreadMovePlanned,
  ThreadMovePreview,
  ThreadMoveRequest,
  type ThreadMoveResult,
  type ThreadMoveSkip,
  THREAD_MOVE_MAX_THREADS,
  ThreadRemoteError,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";

import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as Machines from "../machines/Machines.ts";
import * as PeerChannels from "../machines/PeerChannels.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as RepositoryCheckout from "../project/RepositoryCheckout.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProjectLabelFolders from "../projectLabels/ProjectLabelFolders.ts";
import * as ProjectLabelService from "../projectLabels/ProjectLabelService.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SharedState from "../sync/SharedState.ts";
import * as ThreadReplication from "./ThreadReplication.ts";
import { ensureLocalCheckout, findLocalCheckout, previewClonePath } from "./localCheckout.ts";
import * as ThreadRouting from "./ThreadRouting.ts";
import * as ThreadSync from "./ThreadSync.ts";

/** Threads per request to another machine, so one request stays well inside its timeout. */
const MOVE_CHUNK = 25;
/** Threads per dry-run request: nothing moves, so a request answers quickly. */
const PREVIEW_CHUNK = 200;

/**
 * Refusals after which the target may have taken the thread: keep the fence
 * and retry. Every other refusal is the target's answer that it did not
 * take it, so the fence can drop and the thread runs here again.
 */
const isTransient = (error: ThreadRemoteError) => error.reason === "offline";

const skip = (threadId: ThreadId, error: ThreadRemoteError): ThreadMoveSkip => ({
  threadId,
  reason: error.reason,
  detail: error.message,
});

export class ThreadTransfer extends Context.Service<
  ThreadTransfer,
  {
    /**
     * Move threads to `target`, wherever they run now: threads this machine
     * runs move from here, others are asked of the machine that runs them.
     * Busy threads and Work with unpushed changes are skipped, not waited on.
     * With dryRun, nothing moves and `planned` says where each would run.
     */
    readonly move: (input: ThreadMoveInput) => Effect.Effect<ThreadMoveResult, ThreadRemoteError>;
    /** Move every live thread `from` runs, such as all of a laptop's threads to the hub. */
    readonly moveAllFrom: (input: {
      readonly from: EnvironmentId;
      readonly target: EnvironmentId;
      readonly leaveLocalChanges?: boolean | undefined;
      readonly dryRun?: boolean | undefined;
    }) => Effect.Effect<ThreadMoveResult, ThreadRemoteError>;
    /**
     * Run here the threads of a machine no longer paired with this one, and
     * finish moves that were handing threads to it. Only on request: a
     * machine that is merely offline keeps its threads.
     */
    readonly adoptFrom: (
      input: ThreadAdoptInput,
    ) => Effect.Effect<ThreadAdoptResult, ThreadRemoteError>;
    /** Retry commits whose reply was lost. The scheduler runs this. */
    readonly resume: Effect.Effect<void>;
  }
>()("cogenly-server/threadSync/ThreadTransfer") {}

const make = Effect.gen(function* () {
  const replication = yield* ThreadReplication.ThreadReplication;
  const threadSync = yield* ThreadSync.ThreadSync;
  const routing = yield* ThreadRouting.ThreadRouting;
  const machines = yield* Machines.Machines;
  const channels = yield* PeerChannels.PeerChannels;
  const projections = yield* Projections.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const scheduler = yield* Scheduler.Scheduler;
  const shared = yield* SharedState.SharedState;
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Absent in unit layers without git: local changes are then not checked.
  const git = yield* Effect.serviceOption(GitWorkflow.GitWorkflowService);
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const context = yield* Effect.context<
    | SqlClient.SqlClient
    | FileSystem.FileSystem
    | RepositoryCheckout.RepositoryCheckout
    | RepositoryIdentityResolver.RepositoryIdentityResolver
    | ProjectLabelService.ProjectLabelService
    | ProjectLabelFolders.ProjectLabelFolders
    | Path.Path
  >();
  const self = replication.environmentId;
  // ManagedProjectFolders keeps "No project" here.
  const scratchRoot = path.resolve(config.baseDir, "scratch");

  const topology = machines.list.pipe(
    Effect.mapError(() => new ThreadRemoteError({ reason: "offline" })),
  );
  const thread = (threadId: ThreadId) =>
    projections
      .getThread(threadId)
      .pipe(
        Effect.mapError(
          () => new ThreadRemoteError({ reason: "rejected", detail: "This thread was not found." }),
        ),
      );

  /** Work whose worktree holds commits or edits the target could not check out. */
  const localChanges = Effect.fn("ThreadTransfer.localChanges")(function* (
    entry: OrchestrationV2AppThread,
  ) {
    if (Option.isNone(git) || entry.worktreePath === null || entry.branch === null) return;
    const exists = yield* fileSystem
      .exists(entry.worktreePath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists)
      return yield* new ThreadRemoteError({
        reason: "local-changes",
        detail:
          "Its worktree is missing, so its pushed state cannot be verified. Restore it first, or explicitly leave local changes behind.",
      });
    const status = yield* git.value
      .status({ cwd: entry.worktreePath })
      .pipe(Effect.orElseSucceed(() => undefined));
    if (status === undefined || !status.isRepo)
      return yield* new ThreadRemoteError({
        reason: "local-changes",
        detail:
          "Could not verify the worktree's local changes and pushed commits. Check it first, or explicitly leave local changes behind.",
      });
    const detail = status.hasWorkingTreeChanges
      ? `${entry.worktreePath} has uncommitted changes.`
      : !status.hasUpstream
        ? `Branch ${entry.branch} is not pushed.`
        : status.aheadCount > 0
          ? `Branch ${entry.branch} has ${status.aheadCount} unpushed commit${status.aheadCount === 1 ? "" : "s"}.`
          : undefined;
    if (detail !== undefined)
      return yield* new ThreadRemoteError({
        reason: "local-changes",
        detail: `${detail} Push it first, or move it leaving those changes here.`,
      });
  });

  /** Attachments minted for this thread; ids begin with the thread's segment. */
  const threadAttachmentIds = Effect.fn("ThreadTransfer.threadAttachmentIds")(function* (
    threadId: ThreadId,
  ) {
    const segment = toSafeThreadAttachmentSegment(threadId);
    if (segment === null) return [];
    const entries = yield* fileSystem
      .readDirectory(config.attachmentsDir)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
    return entries.flatMap((entry) => {
      const dot = entry.lastIndexOf(".");
      const id = dot > 0 ? entry.slice(0, dot) : entry;
      return parseThreadSegmentFromAttachmentId(id) === segment ? [id] : [];
    });
  });

  /** This machine's last replicated event of the thread, by sequence. */
  const lastEvent = (threadId: ThreadId) =>
    sql<{
      readonly event_id: string;
      readonly sequence: number;
    }>`SELECT event_id, sequence FROM orchestration_events WHERE stream_id = ${threadId} AND aggregate_kind = 'thread'
      AND application_event_version = 2 ORDER BY sequence DESC LIMIT 1`.pipe(
      Effect.map((rows) => rows[0]),
      Effect.orDie,
    );

  /** Push the thread's events to the next hop, however long the backlog before them. */
  const sendThread = (threadId: ThreadId, hop: EnvironmentId) =>
    lastEvent(threadId).pipe(
      Effect.flatMap((last) => threadSync.syncThrough(hop, last?.sequence ?? 0)),
      Effect.mapError(
        () => new ThreadRemoteError({ reason: "offline", detail: "Could not send the thread." }),
      ),
    );

  const hopTo = (view: Effect.Success<typeof topology>, target: EnvironmentId) =>
    view.link._tag === "spoke" ? view.link.hubEnvironmentId : target;

  const copyReceipts = Effect.fn("ThreadTransfer.copyReceipts")(function* (
    threadId: ThreadId,
    target: EnvironmentId,
    epoch: number,
  ) {
    let after = "";
    for (;;) {
      const rows = yield* sql<{
        readonly command_id: string;
        readonly command_type: string;
        readonly accepted_at: string;
        readonly status: "accepted" | "rejected";
        readonly error: string | null;
      }>`SELECT command_id, command_type, accepted_at, status, error FROM orchestration_command_receipts
        WHERE aggregate_kind = 'thread' AND aggregate_id = ${threadId} AND command_id > ${after}
        ORDER BY command_id LIMIT 128`.pipe(Effect.orDie);
      // An empty batch is also a capability check: older targets must refuse
      // a move they cannot keep idempotent, before either side changes owner.
      yield* routing.callMachine(
        target,
        ThreadHandoffReceipts,
        {
          threadId,
          from: self,
          to: target,
          epoch,
          receipts: rows.map((row) => ({
            commandId: CommandId.make(row.command_id),
            commandType: row.command_type,
            acceptedAt: row.accepted_at,
            status: row.status,
            error: row.error,
          })),
        },
        "2 minutes",
      );
      if (rows.length < 128) return;
      after = rows.at(-1)!.command_id;
    }
  });

  // Phase two from the owner: push what the target lacks, then ask it to take the thread.
  const commit = Effect.fn("ThreadTransfer.commit")(function* (
    threadId: ThreadId,
    target: EnvironmentId,
    epoch: number,
  ) {
    yield* sendThread(threadId, hopTo(yield* topology, target));
    const last = yield* lastEvent(threadId);
    yield* copyReceipts(threadId, target, epoch);
    yield* routing.callMachine(
      target,
      ThreadHandoffCommit,
      {
        threadId,
        from: self,
        to: target,
        epoch,
        lastEventId: last === undefined ? null : EventId.make(last.event_id),
        eventCount: yield* replication.eventCount(threadId),
        attachmentIds: yield* threadAttachmentIds(threadId),
      },
      "10 minutes",
    );
  });

  /** Commit, then settle the fence by the answer: finish, release, or keep for a retry. */
  const settle = (threadId: ThreadId, target: EnvironmentId, epoch: number) =>
    commit(threadId, target, epoch).pipe(
      Effect.tap(() => replication.finish(threadId, target, epoch)),
      Effect.tapError((error) =>
        isTransient(error) ? Effect.void : replication.release(threadId, target, epoch),
      ),
    );

  /** Agents whose conversation is one of `threadIds`, with their owner machine. */
  const agentsConversing = (threadIds: ReadonlyArray<ThreadId>) =>
    sql<{
      readonly agent_id: string;
      readonly conversation_thread_id: string;
      readonly owner_machine: string | null;
    }>`SELECT agent_id, conversation_thread_id, owner_machine FROM agents
      WHERE conversation_thread_id IN ${sql.in(threadIds)}`.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          agentId: row.agent_id,
          threadId: row.conversation_thread_id as ThreadId,
          owner: (row.owner_machine ?? self) as EnvironmentId,
        })),
      ),
      Effect.orDie,
    );

  /** The checks a move makes here before fencing; the thread when it can move. */
  const checkMovable = Effect.fn("ThreadTransfer.checkMovable")(function* (
    threadId: ThreadId,
    leaveLocalChanges: boolean,
  ) {
    const entry = yield* thread(threadId);
    if (!leaveLocalChanges) yield* localChanges(entry);
    const agent = (yield* agentsConversing([threadId]))[0];
    if (agent !== undefined && agent.owner !== self)
      return yield* new ThreadRemoteError({
        reason: "not-owner",
        detail: "This agent runs on another machine; move it from there.",
      });
    return { entry, agent };
  });

  const moveHere = Effect.fn("ThreadTransfer.moveHere")(function* (
    threadId: ThreadId,
    target: EnvironmentId,
    leaveLocalChanges: boolean,
  ) {
    const { agent } = yield* checkMovable(threadId, leaveLocalChanges);
    const { epoch } = yield* replication.fence(threadId, target);
    yield* settle(threadId, target, epoch);
    // The agent runs where its conversation runs: it follows, with its schedules.
    if (agent !== undefined) yield* handOffAgent(agent.agentId, target);
  });

  /**
   * Give an agent this machine runs to `target`, after its conversation
   * moved. Only the owner may author this change (SharedState); schedules
   * bound to the agent move after it, since they must match its owner.
   */
  const handOffAgent = Effect.fn("ThreadTransfer.handOffAgent")(function* (
    agentId: string,
    target: EnvironmentId,
  ) {
    // Recovery may retry after the conversation moved. Never leave a committed
    // agent owner that makes recovery skip schedules still owned by this machine.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* shared.write("agent", agentId, { ownerMachine: target });
        const schedules = yield* sql<{
          readonly id: string;
        }>`SELECT id FROM shared_documents WHERE kind = 'schedule' AND tombstone_json IS NULL
        AND json_extract(fields_json, '$.agentId') = ${agentId}`;
        for (const schedule of schedules)
          yield* shared.write("schedule", schedule.id, { ownerMachine: target });
      }),
    );
  }, Effect.orDie);

  /** Dry run of moving threads this machine runs: the checks here, then the target's placement. */
  const previewHere = Effect.fn("ThreadTransfer.previewHere")(function* (
    threadIds: ReadonlyArray<ThreadId>,
    target: EnvironmentId,
    leaveLocalChanges: boolean,
  ) {
    const skipped: Array<ThreadMoveSkip> = [];
    const titles = new Map<ThreadId, string>();
    for (const threadId of threadIds) {
      const checked = yield* Effect.result(
        replication
          .preflight(threadId)
          .pipe(Effect.andThen(checkMovable(threadId, leaveLocalChanges))),
      );
      if (checked._tag === "Failure") skipped.push(skip(threadId, checked.failure));
      else titles.set(threadId, checked.success.entry.title);
    }
    const planned: Array<ThreadMovePlanned> = [];
    const ready = [...titles.keys()];
    if (ready.length === 0) return { planned, skipped };
    // The target places threads from its replicas; bring them up to date, as a move would.
    const hop = hopTo(yield* topology, target);
    const last = yield* Effect.forEach(ready, lastEvent);
    yield* threadSync
      .syncThrough(hop, Math.max(0, ...last.map((item) => item?.sequence ?? 0)))
      .pipe(Effect.ignore);
    for (let at = 0; at < ready.length; at += PREVIEW_CHUNK) {
      const chunk = ready.slice(at, at + PREVIEW_CHUNK);
      const answer = yield* Effect.result(
        routing.callMachine(
          target,
          ThreadHandoffPreview,
          { threadIds: chunk, to: target },
          "5 minutes",
        ),
      );
      if (answer._tag === "Failure") {
        for (const threadId of chunk) skipped.push(skip(threadId, answer.failure));
        continue;
      }
      skipped.push(...answer.success.skipped);
      for (const placed of answer.success.placed)
        planned.push({ ...placed, title: titles.get(placed.threadId) ?? "", from: self });
    }
    return { planned, skipped };
  });

  /**
   * Move threads. `relay` is true on the hub answering another machine: it
   * then asks spokes for their own threads but never sends a request back
   * to the machine that asked.
   */
  const moveFrom = Effect.fn("ThreadTransfer.moveFrom")(function* (
    input: ThreadMoveInput,
    caller: EnvironmentId | undefined,
  ) {
    const dryRun = input.dryRun === true;
    const view = yield* topology;
    if (
      input.target !== self &&
      !view.machines.some(
        (machine) =>
          machine.environmentId === input.target &&
          // A spoke reaches the hub's other spokes through the hub.
          (machine.relation === "hub" ||
            machine.relation === "spoke" ||
            machine.relation === "peer"),
      )
    )
      return yield* new ThreadRemoteError({
        reason: "rejected",
        detail: "Pair that machine before moving threads to it.",
      });
    const moved: Array<ThreadId> = [];
    const skipped: Array<ThreadMoveSkip> = [];
    const planned: Array<ThreadMovePlanned> = [];
    const byOwner = new Map<EnvironmentId, Array<ThreadId>>();
    for (const threadId of new Set(input.threadIds)) {
      const owner = yield* replication.owner(threadId);
      const runner = owner === undefined || owner.local ? self : owner.owner;
      if (runner === input.target) {
        moved.push(threadId);
        continue;
      }
      byOwner.set(runner, [...(byOwner.get(runner) ?? []), threadId]);
    }
    const leaveLocalChanges = input.leaveLocalChanges === true;
    if (dryRun) {
      const here = yield* previewHere(byOwner.get(self) ?? [], input.target, leaveLocalChanges);
      planned.push(...here.planned);
      skipped.push(...here.skipped);
    } else
      for (const threadId of byOwner.get(self) ?? []) {
        const result = yield* Effect.result(moveHere(threadId, input.target, leaveLocalChanges));
        if (result._tag === "Success") moved.push(threadId);
        else skipped.push(skip(threadId, result.failure));
      }
    for (const [owner, threadIds] of byOwner) {
      if (owner === self) continue;
      // Only the hub relays, and never back to the machine that asked.
      if (caller !== undefined && (view.link._tag !== "hub" || owner === caller)) {
        for (const threadId of threadIds)
          skipped.push(skip(threadId, new ThreadRemoteError({ reason: "not-owner" })));
        continue;
      }
      const chunkSize = dryRun ? PREVIEW_CHUNK : MOVE_CHUNK;
      for (let at = 0; at < threadIds.length; at += chunkSize) {
        const chunk = threadIds.slice(at, at + chunkSize);
        const request = {
          threadIds: chunk,
          target: input.target,
          ...(input.leaveLocalChanges === undefined
            ? {}
            : { leaveLocalChanges: input.leaveLocalChanges }),
        };
        // A dry run uses its own channel: an older machine refuses it instead of moving.
        const result = yield* Effect.result(
          dryRun
            ? routing.callMachine(owner, ThreadMovePreview, { ...request, dryRun }, "10 minutes")
            : routing.callMachine(owner, ThreadMoveRequest, request, "30 minutes"),
        );
        if (result._tag === "Success") {
          moved.push(...result.success.moved);
          skipped.push(...result.success.skipped);
          planned.push(...(result.success.planned ?? []));
        } else for (const threadId of chunk) skipped.push(skip(threadId, result.failure));
      }
    }
    return {
      moved,
      skipped,
      ...(dryRun ? { planned } : {}),
    } satisfies ThreadMoveResult;
  });

  const contains = (parent: string, child: string) => {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return (
      relative !== "" &&
      !path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`)
    );
  };
  const segment = (value: string, fallback: string) =>
    value === "" || value === "." || value === ".." ? fallback : value;

  /**
   * Where a Work thread's worktree lives on this machine. Paths come from
   * another machine, so only one inside this machine's worktrees directory
   * is kept; any other maps under it by its last two names, never outside.
   * The next turn creates a missing worktree from the branch.
   */
  const targetWorktreePath = Effect.fn("ThreadTransfer.targetWorktreePath")(function* (
    entry: OrchestrationV2AppThread,
  ) {
    if (entry.worktreePath === null) return null;
    const own = toSafeThreadAttachmentSegment(entry.id) ?? "thread";
    const candidate = contains(config.worktreesDir, entry.worktreePath)
      ? path.resolve(entry.worktreePath)
      : entry.branch === null
        ? null
        : path.join(
            config.worktreesDir,
            segment(path.basename(path.dirname(entry.worktreePath)), "moved"),
            segment(path.basename(entry.worktreePath), own),
          );
    if (candidate === null) return null;
    // Another thread here works in that folder: this one gets its own.
    const taken = yield* sql<{ readonly thread_id: string }>`SELECT thread_id
      FROM orchestration_v2_projection_threads
      WHERE thread_id <> ${entry.id} AND deleted_at IS NULL
        AND json_extract(payload_json, '$.worktreePath') = ${candidate} LIMIT 1`.pipe(Effect.orDie);
    return taken.length === 0 ? candidate : `${candidate}-${own.slice(-8)}`;
  });

  /**
   * On the target: the thread now runs here, so point it at this machine's
   * checkout and worktree layout. A provider session cannot follow, so the
   * changed directory makes the next turn start a fresh one seeded with the
   * thread's history.
   */
  const rehome = Effect.fn("ThreadTransfer.rehome")(function* (
    threadId: ThreadId,
    epoch: number,
    beforeWrite: Effect.Effect<unknown, ThreadRemoteError> = Effect.void,
  ) {
    const entry = yield* projections.getThread(threadId).pipe(Effect.orDie);
    const localProject = Option.isSome(yield* projects.get(entry.projectId).pipe(Effect.orDie))
      ? entry.projectId
      : ((yield* replication.sourceProject(threadId)).projectId ?? entry.projectId);
    const worktreePath = yield* targetWorktreePath(entry);
    const changed = localProject !== entry.projectId || worktreePath !== entry.worktreePath;
    // Read-time fields are not part of the stored thread.
    const {
      projectFolderId: _folder,
      projectFolderSource: _source,
      ownerMachine: _owner,
      ...stored
    } = entry;
    yield* sink
      .writeAtomic({
        beforeWrite,
        commandId: CommandId.make(`command:handoff:${threadId}:${epoch}`),
        events: changed
          ? [
              {
                id: EventId.make(`event:handoff:${threadId}:${epoch}`),
                type: "thread.metadata-updated",
                threadId,
                providerInstanceId: entry.providerInstanceId,
                occurredAt: yield* DateTime.now,
                payload: { ...stored, projectId: localProject, worktreePath },
              },
            ]
          : [],
      })
      .pipe(
        Effect.mapError(
          () =>
            new ThreadRemoteError({
              reason: "offline",
              detail: "The target could not commit the handoff; it can be retried.",
            }),
        ),
      );
  });

  const noRepository = (remote: string | null | undefined) =>
    new ThreadRemoteError({
      reason: "needs-repository",
      detail:
        remote != null
          ? `No project on this machine links ${remote}. Move its whole project instead.`
          : "Its repository has no remote this machine could clone.",
    });

  const linkedLabel = (remote: string | null | undefined) =>
    remote == null
      ? Effect.succeed(undefined)
      : sql<{
          readonly label_id: string;
        }>`SELECT label_id FROM label_repositories WHERE remote = ${remote} LIMIT 1`.pipe(
          Effect.map((rows) =>
            rows[0] === undefined ? undefined : ProjectLabelId.make(rows[0].label_id),
          ),
          Effect.orDie,
        );

  /** The project the thread runs in here once taken, or why it cannot run here. */
  const requireProject = Effect.fn("ThreadTransfer.requireProject")(function* (threadId: ThreadId) {
    const entry = yield* thread(threadId);
    if (Option.isSome(yield* projects.get(entry.projectId).pipe(Effect.orDie))) return;
    const { source, projectId } = yield* replication.sourceProject(threadId);
    if (projectId !== undefined) return;
    // A chat from another machine's scratch folder (its "No project", or a
    // T3 Code scratch folder) runs in this machine's "No project".
    if (source?.kind === "scratch") {
      yield* folders.ensureScratchProject.pipe(
        Effect.mapError(
          (error) =>
            new ThreadRemoteError({
              reason: "rejected",
              detail: `This machine has no "No project" folder for it: ${error.message}`,
            }),
        ),
      );
      if ((yield* replication.sourceProject(threadId)).projectId !== undefined) return;
    }
    // A project here links that remote without a checkout: file this
    // machine's own checkout of it, or start a clone. Either way the link is
    // rebound to a real record at once; turns wait for a clone.
    const labelId = yield* linkedLabel(source?.remote);
    if (labelId !== undefined && source?.remote != null) {
      yield* ensureLocalCheckout(labelId, source.remote).pipe(Effect.provideContext(context));
      if ((yield* replication.sourceProject(threadId)).projectId !== undefined) return;
    }
    return yield* noRepository(source?.remote);
  });

  /** Where requireProject and rehome would put the thread, changing nothing: a dry run. */
  const placement = Effect.fn("ThreadTransfer.placement")(function* (threadId: ThreadId) {
    const entry = yield* thread(threadId).pipe(
      Effect.mapError(
        () =>
          new ThreadRemoteError({
            reason: "behind",
            detail: "This machine has not received the thread yet; the move sends it first.",
          }),
      ),
    );
    const worktreePath = yield* targetWorktreePath(entry);
    const placed = (project: string): ThreadMovePlacement => ({ threadId, project, worktreePath });
    const record = (id: typeof entry.projectId) => projects.get(id).pipe(Effect.orDie);
    const known = yield* record(entry.projectId);
    if (Option.isSome(known)) return placed(known.value.workspaceRoot);
    const { source, projectId } = yield* replication.sourceProject(threadId);
    const mapped = projectId === undefined ? Option.none() : yield* record(projectId);
    if (Option.isSome(mapped)) return placed(mapped.value.workspaceRoot);
    if (source?.kind === "scratch") return placed(`${scratchRoot} (No project, created)`);
    const labelId = yield* linkedLabel(source?.remote);
    if (labelId !== undefined && source?.remote != null) {
      const found = yield* findLocalCheckout(labelId, source.remote).pipe(
        Effect.provideContext(context),
      );
      return placed(
        Option.isSome(found)
          ? `${found.value.workspaceRoot} (filed into the project)`
          : `${yield* previewClonePath(labelId, source.remote).pipe(
              Effect.provideContext(context),
              Effect.mapError(() => noRepository(source.remote)),
            )} (new clone)`,
      );
    }
    return yield* noRepository(source?.remote);
  });

  yield* channels.register(ThreadHandoffPreview, ({ threadIds, to }, caller) =>
    Effect.gen(function* () {
      if (to !== self) {
        const view = yield* topology;
        if (view.link._tag !== "hub" || to === caller.environmentId)
          return yield* new ThreadRemoteError({ reason: "not-owner" });
        const last = yield* Effect.forEach(threadIds, lastEvent);
        yield* threadSync
          .syncThrough(to, Math.max(0, ...last.map((item) => item?.sequence ?? 0)))
          .pipe(Effect.ignore);
        return yield* routing.callMachine(to, ThreadHandoffPreview, { threadIds, to }, "5 minutes");
      }
      const placed: Array<ThreadMovePlacement> = [];
      const skipped: Array<ThreadMoveSkip> = [];
      for (const threadId of threadIds) {
        const result = yield* Effect.result(placement(threadId));
        if (result._tag === "Success") placed.push(result.success);
        else skipped.push(skip(threadId, result.failure));
      }
      return { placed, skipped };
    }),
  );

  yield* channels.register(ThreadHandoffReceipts, (payload, caller) =>
    Effect.gen(function* () {
      const view = yield* topology;
      if (payload.to !== self) {
        if (view.link._tag !== "hub" || caller.environmentId !== payload.from)
          return yield* new ThreadRemoteError({ reason: "not-owner" });
        yield* sendThread(payload.threadId, payload.to);
        return yield* routing.callMachine(payload.to, ThreadHandoffReceipts, payload, "2 minutes");
      }
      const relayed =
        view.link._tag === "spoke" && view.link.hubEnvironmentId === caller.environmentId;
      if (caller.environmentId !== payload.from && !relayed)
        return yield* new ThreadRemoteError({ reason: "not-owner" });
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const owner = yield* replication.owner(payload.threadId);
            if (owner !== undefined && owner.epoch >= payload.epoch) return {};
            if (
              owner === undefined ||
              owner.local ||
              owner.owner !== payload.from ||
              owner.epoch + 1 !== payload.epoch
            )
              return yield* new ThreadRemoteError({ reason: "not-owner" });
            const last = yield* lastEvent(payload.threadId);
            for (const receipt of payload.receipts) {
              yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(
                receipt.acceptedAt,
              ).pipe(
                Effect.mapError(
                  () =>
                    new ThreadRemoteError({
                      reason: "rejected",
                      detail: "A command receipt has an invalid timestamp.",
                    }),
                ),
              );
              const existing = yield* sql<{
                readonly aggregate_id: string;
              }>`SELECT aggregate_id FROM orchestration_command_receipts WHERE command_id = ${receipt.commandId}`;
              if (existing.some((row) => row.aggregate_id !== payload.threadId))
                return yield* new ThreadRemoteError({
                  reason: "rejected",
                  detail: "A command receipt belongs to another thread.",
                });
              yield* sql`INSERT OR IGNORE INTO orchestration_command_receipts
          (command_id, aggregate_kind, aggregate_id, command_type, accepted_at, result_sequence, status, error)
          VALUES (${receipt.commandId}, 'thread', ${payload.threadId}, ${receipt.commandType}, ${receipt.acceptedAt}, ${last?.sequence ?? 0}, ${receipt.status}, ${receipt.error})`;
            }
            return {};
          }),
        )
        .pipe(
          Effect.catchTags({
            SqlError: () => Effect.fail(new ThreadRemoteError({ reason: "offline" })),
          }),
        );
    }),
  );

  yield* channels.register(ThreadHandoffCommit, (payload, caller) =>
    Effect.gen(function* () {
      const view = yield* topology;
      if (payload.to !== self) {
        // The hub relays a spoke's handoff to the spoke taking it, after
        // passing on the events it just received. It notes the handoff
        // first: only then does it accept the target's claim on the thread.
        if (view.link._tag !== "hub" || caller.environmentId !== payload.from)
          return yield* new ThreadRemoteError({ reason: "not-owner" });
        yield* replication.expectHandoff(payload.threadId, payload.from, payload.to, payload.epoch);
        yield* sendThread(payload.threadId, payload.to);
        return yield* routing
          .callMachine(payload.to, ThreadHandoffCommit, payload, "10 minutes")
          .pipe(
            Effect.tapError((error) =>
              isTransient(error)
                ? Effect.void
                : replication.cancelExpectedHandoff(
                    payload.threadId,
                    payload.from,
                    payload.to,
                    payload.epoch,
                  ),
            ),
          );
      }
      const relayed =
        view.link._tag === "spoke" && view.link.hubEnvironmentId === caller.environmentId;
      if (caller.environmentId !== payload.from && !relayed)
        return yield* new ThreadRemoteError({ reason: "not-owner" });
      const owner = yield* replication.owner(payload.threadId);
      if (owner === undefined || owner.epoch < payload.epoch) {
        if (
          owner === undefined ||
          owner.local ||
          owner.owner !== payload.from ||
          owner.epoch + 1 !== payload.epoch
        )
          return yield* new ThreadRemoteError({ reason: "not-owner" });
        const behind = new ThreadRemoteError({
          reason: "behind",
          detail: "This machine has not received the whole thread yet.",
        });
        if (payload.lastEventId !== null) {
          const present = yield* sql<{
            readonly event_id: string;
          }>`SELECT event_id FROM orchestration_events WHERE event_id = ${payload.lastEventId} AND stream_id = ${payload.threadId}`.pipe(
            Effect.orDie,
          );
          if (present.length === 0) return yield* behind;
        }
        // The last event alone misses a gap, such as an event this machine
        // could not apply; taking the thread then would make the gap its log.
        if (
          payload.eventCount !== undefined &&
          (yield* replication.eventCount(payload.threadId)) !== payload.eventCount
        )
          return yield* behind;
        const held =
          yield* sql`SELECT 1 FROM thread_replication_deferred WHERE thread_id = ${payload.threadId} LIMIT 1`.pipe(
            Effect.orDie,
          );
        if (held.length > 0) return yield* behind;
        yield* requireProject(payload.threadId);
        // The old owner may go offline for good once this answers.
        for (const attachmentId of payload.attachmentIds)
          if (Option.isNone(yield* routing.fetchAttachment(attachmentId)))
            return yield* new ThreadRemoteError({
              reason: "rejected",
              detail: "A thread attachment is unavailable on its owner.",
            });
      }
      // Ownership and the machine-local paths commit before the sink publishes.
      if (owner !== undefined && owner.epoch >= payload.epoch && !owner.local) return {};
      yield* rehome(
        payload.threadId,
        payload.epoch,
        replication.take(payload.threadId, payload.from, payload.epoch),
      );
      return {};
    }),
  );

  yield* channels.register(ThreadMoveRequest, (input, caller) =>
    // A dry run has its own channel; this one always moves.
    moveFrom({ ...input, dryRun: false }, caller.environmentId),
  );
  yield* channels.register(ThreadMovePreview, (input, caller) =>
    moveFrom({ ...input, dryRun: true }, caller.environmentId),
  );

  const resume: ThreadTransfer["Service"]["resume"] = Effect.gen(function* () {
    for (const { threadId, target, epoch } of yield* replication.fenced)
      yield* settle(threadId, target, epoch).pipe(
        Effect.catch((error) =>
          Effect.logInfo("Thread move still waiting on its target", {
            threadId,
            target,
            reason: error.reason,
          }),
        ),
      );
    // An agent left behind by a crash between its conversation and its profile.
    const remote = yield* replication.remoteOwners;
    if (remote.size === 0) return;
    for (const agent of yield* agentsConversing([...remote.keys()])) {
      const runner = remote.get(agent.threadId);
      if (agent.owner === self && runner !== undefined) yield* handOffAgent(agent.agentId, runner);
    }
  });
  yield* scheduler.register("thread-transfer", resume);

  const moveAllFrom: ThreadTransfer["Service"]["moveAllFrom"] = Effect.fn(
    "ThreadTransfer.moveAllFrom",
  )(function* ({ from, target, leaveLocalChanges, dryRun }) {
    const rows = yield* (
      from === self
        ? sql<{
            readonly thread_id: string;
          }>`SELECT t.thread_id FROM orchestration_v2_projection_threads t
          WHERE t.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM thread_owners o WHERE o.thread_id = t.thread_id AND o.local = 0)`
        : sql<{ readonly thread_id: string }>`SELECT o.thread_id FROM thread_owners o
          JOIN orchestration_v2_projection_threads t ON t.thread_id = o.thread_id
          WHERE o.local = 0 AND o.owner_env = ${from} AND t.deleted_at IS NULL`
    ).pipe(Effect.orDie);
    const threadIds = rows.map((row) => row.thread_id as ThreadId);
    const moved: Array<ThreadId> = [];
    const skipped: Array<ThreadMoveSkip> = [];
    const planned: Array<ThreadMovePlanned> = [];
    for (let at = 0; at < threadIds.length; at += THREAD_MOVE_MAX_THREADS) {
      const result = yield* moveFrom(
        {
          threadIds: threadIds.slice(at, at + THREAD_MOVE_MAX_THREADS),
          target,
          ...(leaveLocalChanges === undefined ? {} : { leaveLocalChanges }),
          ...(dryRun === undefined ? {} : { dryRun }),
        },
        undefined,
      );
      moved.push(...result.moved);
      skipped.push(...result.skipped);
      planned.push(...(result.planned ?? []));
    }
    return { moved, skipped, ...(dryRun === true ? { planned } : {}) } satisfies ThreadMoveResult;
  });

  const adoptFrom: ThreadTransfer["Service"]["adoptFrom"] = Effect.fn("ThreadTransfer.adoptFrom")(
    function* (input) {
      const view = yield* topology;
      if (view.link._tag === "spoke")
        return yield* new ThreadRemoteError({
          reason: "rejected",
          detail:
            "Recover lost-machine threads on the hub. Unpair a lost hub before recovering its threads here.",
        });
      const paired = ThreadSync.pairedMachines(view.machines);
      const unpaired = (yield* replication.unpairedOwners(paired)).map((row) => ({
        environmentId: row.owner,
        threads: row.threads,
      }));
      const lost = input.from;
      if (lost === undefined) {
        if (input.dryRun === true) return { adopted: [], skipped: [], unpaired };
        return yield* new ThreadRemoteError({
          reason: "rejected",
          detail: "Name the machine whose threads this machine should run.",
        });
      }
      if (lost === self)
        return yield* new ThreadRemoteError({
          reason: "rejected",
          detail: "This machine already runs its own threads.",
        });
      // Offline is not gone: a paired machine continues its threads when it reconnects.
      if (paired.has(lost)) {
        const name = view.machines.find((machine) => machine.environmentId === lost)?.name;
        return yield* new ThreadRemoteError({
          reason: "rejected",
          detail: `${name ?? lost} is still paired. Unpair it first if it is gone for good; while paired, it keeps running its threads.`,
        });
      }
      const adopted: Array<ThreadId> = [];
      const skipped: Array<ThreadMoveSkip> = [];
      for (const threadId of yield* replication.claimedBy(lost)) {
        const owner = yield* replication.owner(threadId);
        const replica = owner !== undefined && !owner.local;
        const result = yield* Effect.result(
          Effect.gen(function* () {
            yield* replication.preflight(threadId, true);
            const held =
              yield* sql`SELECT 1 FROM thread_replication_deferred WHERE thread_id = ${threadId} LIMIT 1`.pipe(
                Effect.orDie,
              );
            if (held.length > 0)
              return yield* new ThreadRemoteError({
                reason: "behind",
                detail: "Update this machine before recovering a thread with unreadable events.",
              });
            if ((yield* agentsConversing([threadId])).length > 0)
              return yield* new ThreadRemoteError({
                reason: "rejected",
                detail:
                  "Recover this agent's ownership and schedules before adopting its conversation.",
              });
            if (input.dryRun === true) {
              if (replica) yield* placement(threadId);
              return;
            }
            if (replica) yield* requireProject(threadId);
            const take = replication.adopt(threadId, lost).pipe(
              Effect.flatMap((taken) =>
                taken === undefined
                  ? Effect.fail(
                      new ThreadRemoteError({
                        reason: "rejected",
                        detail: "Its owner changed while adopting it.",
                      }),
                    )
                  : Effect.void,
              ),
            );
            if (replica && owner !== undefined) yield* rehome(threadId, owner.epoch + 1, take);
            else yield* take;
          }),
        );
        if (result._tag === "Success") adopted.push(threadId);
        else skipped.push(skip(threadId, result.failure));
      }
      return { adopted, skipped, unpaired };
    },
  );

  return ThreadTransfer.of({
    move: (input) => moveFrom(input, undefined),
    moveAllFrom,
    adoptFrom,
    resume,
  });
});

export const layer = Layer.effect(ThreadTransfer, make);
