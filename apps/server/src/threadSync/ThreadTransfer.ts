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
  ThreadHandoffCommit,
  type ThreadId,
  type ThreadMoveInput,
  ThreadMoveRequest,
  type ThreadMoveResult,
  type ThreadMoveSkip,
  THREAD_MOVE_MAX_THREADS,
  ThreadRemoteError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import {
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
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
import * as ProjectLabelService from "../projectLabels/ProjectLabelService.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SharedState from "../sync/SharedState.ts";
import * as ThreadReplication from "./ThreadReplication.ts";
import { ensureLocalCheckout } from "./localCheckout.ts";
import * as ThreadRouting from "./ThreadRouting.ts";
import * as ThreadSync from "./ThreadSync.ts";

/** Threads per request to another machine, so one request stays well inside its timeout. */
const MOVE_CHUNK = 25;

/** Refusals that may succeed on a retry without changing anything: keep the fence. */
const isTransient = (error: ThreadRemoteError) =>
  error.reason === "offline" || error.reason === "behind";

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
     */
    readonly move: (input: ThreadMoveInput) => Effect.Effect<ThreadMoveResult, ThreadRemoteError>;
    /** Move every live thread `from` runs, such as all of a laptop's threads to the hub. */
    readonly moveAllFrom: (input: {
      readonly from: EnvironmentId;
      readonly target: EnvironmentId;
      readonly leaveLocalChanges?: boolean | undefined;
    }) => Effect.Effect<ThreadMoveResult, ThreadRemoteError>;
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
  >();
  const self = replication.environmentId;

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
    if (!exists) return;
    const status = yield* git.value
      .status({ cwd: entry.worktreePath })
      .pipe(Effect.orElseSucceed(() => undefined));
    if (status === undefined || !status.isRepo) return;
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

  // Phase two from the owner: push what the target lacks, then ask it to take the thread.
  const commit = Effect.fn("ThreadTransfer.commit")(function* (
    threadId: ThreadId,
    target: EnvironmentId,
    epoch: number,
  ) {
    const view = yield* topology;
    const hop = view.link._tag === "spoke" ? view.link.hubEnvironmentId : target;
    yield* threadSync
      .sync(hop)
      .pipe(
        Effect.mapError(
          () => new ThreadRemoteError({ reason: "offline", detail: "Could not send the thread." }),
        ),
      );
    const last = yield* sql<{
      readonly event_id: string;
    }>`SELECT event_id FROM orchestration_events WHERE stream_id = ${threadId} AND aggregate_kind = 'thread'
      ORDER BY sequence DESC LIMIT 1`.pipe(Effect.orDie);
    yield* routing.callMachine(
      target,
      ThreadHandoffCommit,
      {
        threadId,
        from: self,
        to: target,
        epoch,
        lastEventId: last[0] === undefined ? null : EventId.make(last[0].event_id),
        attachmentIds: yield* threadAttachmentIds(threadId),
      },
      "10 minutes",
    );
  });

  /** Commit, then settle the fence by the answer: finish, release, or keep for a retry. */
  const settle = (threadId: ThreadId, target: EnvironmentId, epoch: number) =>
    commit(threadId, target, epoch).pipe(
      Effect.tap(() => replication.finish(threadId)),
      Effect.tapError((error) =>
        isTransient(error) ? Effect.void : replication.release(threadId),
      ),
    );

  const moveHere = Effect.fn("ThreadTransfer.moveHere")(function* (
    threadId: ThreadId,
    target: EnvironmentId,
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
    const { epoch } = yield* replication.fence(threadId, target);
    yield* settle(threadId, target, epoch);
    // The agent runs where its conversation runs: it follows, with its schedules.
    if (agent !== undefined) yield* handOffAgent(agent.agentId, target);
  });

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

  /**
   * Give an agent this machine runs to `target`, after its conversation
   * moved. Only the owner may author this change (SharedState); schedules
   * bound to the agent move after it, since they must match its owner.
   */
  const handOffAgent = Effect.fn("ThreadTransfer.handOffAgent")(function* (
    agentId: string,
    target: EnvironmentId,
  ) {
    yield* shared.write("agent", agentId, { ownerMachine: target });
    const schedules = yield* sql<{
      readonly id: string;
    }>`SELECT id FROM shared_documents WHERE kind = 'schedule' AND tombstone_json IS NULL
      AND json_extract(fields_json, '$.agentId') = ${agentId}`;
    for (const schedule of schedules)
      yield* shared.write("schedule", schedule.id, { ownerMachine: target });
  }, Effect.orDie);

  /**
   * Move threads. `relay` is true on the hub answering another machine: it
   * then asks spokes for their own threads but never sends a request back
   * to the machine that asked.
   */
  const moveFrom = Effect.fn("ThreadTransfer.moveFrom")(function* (
    input: ThreadMoveInput,
    caller: EnvironmentId | undefined,
  ) {
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
    for (const threadId of byOwner.get(self) ?? []) {
      const result = yield* Effect.result(
        moveHere(threadId, input.target, input.leaveLocalChanges === true),
      );
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
      for (let at = 0; at < threadIds.length; at += MOVE_CHUNK) {
        const chunk = threadIds.slice(at, at + MOVE_CHUNK);
        const result = yield* Effect.result(
          routing.callMachine(
            owner,
            ThreadMoveRequest,
            { ...input, threadIds: chunk },
            "30 minutes",
          ),
        );
        if (result._tag === "Success") {
          moved.push(...result.success.moved);
          skipped.push(...result.success.skipped);
        } else for (const threadId of chunk) skipped.push(skip(threadId, result.failure));
      }
    }
    return { moved, skipped } satisfies ThreadMoveResult;
  });

  /**
   * On the target: the thread now runs here, so point it at this machine's
   * checkout. A Work worktree path from the old machine moves under this
   * machine's worktrees directory; the next turn recreates it from the
   * branch. A provider session cannot follow, so the changed directory makes
   * the next turn start a fresh one seeded with the thread's history.
   */
  const rehome = Effect.fn("ThreadTransfer.rehome")(function* (threadId: ThreadId, epoch: number) {
    const entry = yield* projections.getThread(threadId).pipe(Effect.orDie);
    const localProject = Option.isSome(yield* projects.get(entry.projectId).pipe(Effect.orDie))
      ? entry.projectId
      : ((yield* replication.sourceProject(threadId)).projectId ?? entry.projectId);
    const worktreePath =
      entry.worktreePath === null ||
      (yield* fileSystem.exists(entry.worktreePath).pipe(Effect.orElseSucceed(() => false)))
        ? entry.worktreePath
        : entry.branch === null
          ? null
          : path.join(
              config.worktreesDir,
              path.basename(path.dirname(entry.worktreePath)),
              path.basename(entry.worktreePath),
            );
    if (localProject === entry.projectId && worktreePath === entry.worktreePath) return;
    // Read-time fields are not part of the stored thread.
    const {
      projectFolderId: _folder,
      projectFolderSource: _source,
      ownerMachine: _owner,
      ...stored
    } = entry;
    yield* sink
      .write({
        commandId: CommandId.make(`command:handoff:${threadId}:${epoch}`),
        events: [
          {
            id: EventId.make(`event:handoff:${threadId}:${epoch}`),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: entry.providerInstanceId,
            occurredAt: yield* DateTime.now,
            payload: { ...stored, projectId: localProject, worktreePath },
          },
        ],
      })
      .pipe(Effect.orDie);
  });

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
    const linked =
      source?.remote == null
        ? []
        : yield* sql<{
            readonly label_id: string;
          }>`SELECT label_id FROM label_repositories WHERE remote = ${source.remote} LIMIT 1`.pipe(
            Effect.orDie,
          );
    if (linked[0] !== undefined && source?.remote != null) {
      yield* ensureLocalCheckout(ProjectLabelId.make(linked[0].label_id), source.remote).pipe(
        Effect.provideContext(context),
      );
      if ((yield* replication.sourceProject(threadId)).projectId !== undefined) return;
    }
    return yield* new ThreadRemoteError({
      reason: "needs-repository",
      detail:
        source?.remote != null
          ? `No project on this machine links ${source.remote}. Move its whole project instead.`
          : "Its repository has no remote this machine could clone.",
    });
  });

  yield* channels.register(ThreadHandoffCommit, (payload, caller) =>
    Effect.gen(function* () {
      const view = yield* topology;
      if (payload.to !== self) {
        // The hub relays a spoke's handoff to the spoke taking it, after
        // passing on the events it just received.
        if (view.link._tag !== "hub" || caller.environmentId !== payload.from)
          return yield* new ThreadRemoteError({ reason: "not-owner" });
        yield* threadSync
          .sync(payload.to)
          .pipe(Effect.mapError(() => new ThreadRemoteError({ reason: "offline" })));
        return yield* routing.callMachine(payload.to, ThreadHandoffCommit, payload, "10 minutes");
      }
      const relayed =
        view.link._tag === "spoke" && view.link.hubEnvironmentId === caller.environmentId;
      if (caller.environmentId !== payload.from && !relayed)
        return yield* new ThreadRemoteError({ reason: "not-owner" });
      const owner = yield* replication.owner(payload.threadId);
      if (owner === undefined || owner.epoch < payload.epoch) {
        if (payload.lastEventId !== null) {
          const present = yield* sql<{
            readonly event_id: string;
          }>`SELECT event_id FROM orchestration_events WHERE event_id = ${payload.lastEventId}`.pipe(
            Effect.orDie,
          );
          if (present.length === 0)
            return yield* new ThreadRemoteError({
              reason: "behind",
              detail: "This machine has not received the whole thread yet.",
            });
        }
        yield* requireProject(payload.threadId);
        // The old owner may go offline for good once this answers.
        for (const attachmentId of payload.attachmentIds)
          if (
            resolveAttachmentPathById({ attachmentsDir: config.attachmentsDir, attachmentId }) ===
            null
          )
            yield* routing.fetchAttachment(attachmentId);
      }
      yield* replication.take(payload.threadId, payload.from, payload.epoch);
      // A retried commit re-homes again only while the thread still runs here.
      if ((yield* replication.owner(payload.threadId))?.local === true)
        yield* rehome(payload.threadId, payload.epoch);
      return {};
    }),
  );

  yield* channels.register(ThreadMoveRequest, (input, caller) =>
    moveFrom(input, caller.environmentId),
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
  )(function* ({ from, target, leaveLocalChanges }) {
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
    for (let at = 0; at < threadIds.length; at += THREAD_MOVE_MAX_THREADS) {
      const result = yield* moveFrom(
        {
          threadIds: threadIds.slice(at, at + THREAD_MOVE_MAX_THREADS),
          target,
          ...(leaveLocalChanges === undefined ? {} : { leaveLocalChanges }),
        },
        undefined,
      );
      moved.push(...result.moved);
      skipped.push(...result.skipped);
    }
    return { moved, skipped } satisfies ThreadMoveResult;
  });

  return ThreadTransfer.of({ move: (input) => moveFrom(input, undefined), moveAllFrom, resume });
});

export const layer = Layer.effect(ThreadTransfer, make);
