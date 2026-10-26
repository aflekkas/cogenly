/**
 * ThreadRouting: continuing a thread another machine runs. Commands for it go
 * to its owner over the machine link (through the hub when both are spokes);
 * the owner dispatches through its own intake, pushes the resulting events
 * back, then replies, so the caller's projection already shows the result.
 * Attachments a command names travel with it; a replica reads older ones
 * from the owner on demand.
 */
import {
  type ChatAttachment,
  type EnvironmentId,
  EventId,
  type MachineListResult,
  type MoveThreadProjectFolderInput,
  type OrchestrationV2ServerCommand,
  type PeerCallError,
  type PeerChannel,
  THREAD_FORWARD_MAX_FILE_BYTES,
  ThreadAttachmentRead,
  type ThreadAttachmentFile,
  ThreadCommandForward,
  ThreadDelegatedRead,
  type ThreadReplicationCursor,
  ThreadFolderMove,
  type ThreadId,
  ThreadRemoteError,
} from "@cogenly/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import {
  attachmentRelativePath,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as Machines from "../machines/Machines.ts";
import * as PeerChannels from "../machines/PeerChannels.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import { commandThreadId } from "../orchestration-v2/Orchestrator.ts";
import * as RemoteThreadCommands from "../orchestration-v2/RemoteThreadCommands.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectLabels from "../projectLabels/ProjectLabelService.ts";
import { writeAttachmentFiles } from "./attachmentFiles.ts";
import * as ThreadReplication from "./ThreadReplication.ts";
import * as ThreadSync from "./ThreadSync.ts";

/** New commands require an explicit portability decision before peers may invoke them. */
const PORTABLE_COMMANDS: ReadonlySet<OrchestrationV2ServerCommand["type"]> = new Set([
  "thread.archive",
  "thread.unarchive",
  "thread.delete",
  "thread.settle",
  "thread.unsettle",
  "thread.snooze",
  "thread.unsnooze",
  "thread.pin",
  "thread.unpin",
  "thread.pin.reorder",
  "thread.active.reorder",
  "thread.visit",
  "thread.mark-unread",
  "work.task.dismiss",
  "thread.metadata.update",
  "thread.pull-request.link",
  "thread.pull-request.unlink",
  "thread.pull-request.watch",
  "thread.runtime-mode.set",
  "thread.interaction-mode.set",
  "thread.model-selection.set",
  "provider-session.detach",
  "message.dispatch",
  "prepared-run.release",
  "prepared-run.retry",
  "subagent.stop",
  "run.interrupt",
  "queued-message.promote-to-steer",
  "queue.resume",
  "queue.clear",
  "queue.send-all",
  "queued-run.reorder",
  "queued-run.cancel",
  "queued-run.edit",
  "runtime-request.respond",
  "thread.user-input.dismiss",
  "checkpoint.rollback",
  "thread.fork",
  "thread.merge_back",
  "delegated_task.request",
  "delegated_task.wake-policy",
  "provider.switch",
  "visual-state.set",
  "visual-state.submit",
  "thread.stop",
]);

const validatePortableCommand = (command: OrchestrationV2ServerCommand) => {
  const strategy =
    command.type === "message.dispatch" && command.dispatchMode.type === "defer_start"
      ? command.dispatchMode.workspaceStrategy
      : command.type === "delegated_task.request"
        ? command.workspaceStrategy
        : undefined;
  // Checkout paths belong to the destination. Root/worktree strategies resolve there;
  // a replica cannot supply a path or a path-shaped compare-and-swap precondition.
  return (
    PORTABLE_COMMANDS.has(command.type) &&
    !(
      command.type === "thread.metadata.update" &&
      (command.worktreePath !== undefined || command.expectedWorktreePath !== undefined)
    ) &&
    strategy?.type !== "existing_worktree"
  );
};

/** Read-state bookkeeping, dropped rather than failed while the owner is offline. */
const BEST_EFFORT_COMMANDS: ReadonlySet<OrchestrationV2ServerCommand["type"]> = new Set([
  "thread.visit",
  "thread.mark-unread",
]);

const decodeRemoteError = Schema.decodeUnknownOption(ThreadRemoteError);

const commandAttachments = (
  command: OrchestrationV2ServerCommand,
): ReadonlyArray<ChatAttachment> => {
  switch (command.type) {
    case "message.dispatch":
      return command.attachments;
    case "queued-run.edit":
      return command.attachments ?? [];
    case "runtime-request.respond":
      return Object.values(command.attachmentsByQuestionId ?? {}).flat();
    default:
      return [];
  }
};

export class ThreadRouting extends Context.Service<
  ThreadRouting,
  {
    /**
     * Copy an attachment of a thread another machine runs from that machine.
     * Returns the local file path; none when the thread runs here or the
     * owner has no such file.
     */
    readonly refreshDelegated: (
      machine: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<void, ThreadRemoteError>;
    readonly fetchAttachment: (
      attachmentId: string,
    ) => Effect.Effect<Option.Option<string>, ThreadRemoteError>;
    /**
     * Call `channel` on `machine`: directly from the hub, or through the hub
     * from a spoke. The receiving handler relays when it is the hub and not
     * the machine named in the payload.
     */
    readonly callMachine: <C extends PeerChannel>(
      machine: EnvironmentId,
      channel: C,
      payload: C["payload"]["Type"],
      timeout: Duration.Input,
    ) => Effect.Effect<C["success"]["Type"], ThreadRemoteError>;
  }
>()("cogenly-server/threadSync/ThreadRouting") {}

const make = Effect.gen(function* () {
  const replication = yield* ThreadReplication.ThreadReplication;
  const threadSync = yield* ThreadSync.ThreadSync;
  const machines = yield* Machines.Machines;
  const channels = yield* PeerChannels.PeerChannels;
  const remoteCommands = yield* RemoteThreadCommands.RemoteThreadCommands;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projectLabels = yield* ProjectLabels.ProjectLabelService;
  const eventStore = yield* EventStore.EventStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const topology = machines.list.pipe(
    Effect.mapError(() => new ThreadRemoteError({ reason: "offline" })),
  );
  const machineName = (view: MachineListResult, environmentId: EnvironmentId) =>
    view.machines.find((machine) => machine.environmentId === environmentId)?.name ??
    "the machine that runs this thread";

  /**
   * The directly linked machine a request for `owner` goes to: the owner
   * itself, or the hub, which relays to the spoke that runs it.
   */
  const nextHop = Effect.fn("ThreadRouting.nextHop")(function* (owner: EnvironmentId) {
    const view = yield* topology;
    const hop =
      view.link._tag === "spoke"
        ? view.link.hubEnvironmentId
        : view.link._tag === "hub"
          ? owner
          : undefined;
    const online = view.machines.some(
      (machine) => machine.environmentId === hop && machine.online && machine.relation !== "this",
    );
    if (hop === undefined || !online)
      return yield* new ThreadRemoteError({
        reason: "offline",
        detail: `${machineName(view, owner)} runs this thread and is offline. It continues when that machine reconnects.`,
      });
    return hop;
  });

  const attachmentPath = (name: string) => path.join(config.attachmentsDir, name);

  const readFiles = Effect.fn("ThreadRouting.readFiles")(function* (
    attachments: ReadonlyArray<ChatAttachment>,
  ) {
    const files: Array<ThreadAttachmentFile> = [];
    let total = 0;
    for (const attachment of attachments) {
      const name = attachmentRelativePath(attachment);
      if (name === null) continue;
      const bytes = yield* fileSystem
        .readFile(attachmentPath(name))
        .pipe(Effect.orElseSucceed(() => undefined));
      if (bytes === undefined) continue;
      total += bytes.byteLength;
      if (total > THREAD_FORWARD_MAX_FILE_BYTES)
        return yield* new ThreadRemoteError({
          reason: "too-large",
          detail: "These attachments are too large to send to the machine that runs this thread.",
        });
      files.push({ name, base64: Buffer.from(bytes).toString("base64") });
    }
    return files;
  });

  const attachmentContext = yield* Effect.context<
    ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path | Crypto.Crypto
  >();
  const writeFiles = (files: ReadonlyArray<ThreadAttachmentFile>) =>
    writeAttachmentFiles(files).pipe(Effect.provideContext(attachmentContext));

  const fromPeer =
    (view: MachineListResult | undefined, owner: EnvironmentId) =>
    <A>(effect: Effect.Effect<A, PeerCallError | Cause.TimeoutError>) =>
      effect.pipe(
        Effect.mapError((error) => {
          if (
            error._tag === "PeerCallError" &&
            error.reason === "unknown-channel" &&
            error.channel === ThreadDelegatedRead.name
          )
            return new ThreadRemoteError({
              reason: "rejected",
              detail:
                "This peer cannot track cloud subagents independently of sync. Update both machines to Cogenly 0.3.3 or later.",
            });
          const remote =
            error._tag === "PeerCallError" && error.reason === "handler-failed"
              ? decodeRemoteError(error.error)
              : Option.none<ThreadRemoteError>();
          if (Option.isSome(remote)) return remote.value;
          const name =
            view === undefined ? "The machine that runs this thread" : machineName(view, owner);
          return new ThreadRemoteError({ reason: "offline", detail: `${name} did not answer.` });
        }),
      );

  // These cursors belong only to targeted reads, never the bulk sync stream.
  // After restart, replay from zero is safe because replica writes deduplicate events.
  const priorityCursors = new Map<string, ThreadReplicationCursor>();
  const priorityPermits = new Map<string, { permit: Semaphore.Semaphore; users: number }>();
  const refreshDelegated: ThreadRouting["Service"]["refreshDelegated"] = (machine, threadId) =>
    Effect.suspend(() => {
      const key = `${machine}:${threadId}`;
      const entry = priorityPermits.get(key) ?? { permit: Semaphore.makeUnsafe(1), users: 0 };
      entry.users++;
      priorityPermits.set(key, entry);
      return Effect.gen(function* () {
        const hop = yield* nextHop(machine);
        for (let page = 0; page < 64; page++) {
          const after = priorityCursors.get(key) ?? { events: 0, meta: 0 };
          const batch = yield* machines
            .call(hop, ThreadDelegatedRead, {
              target: machine,
              threadId,
              after,
            })
            .pipe(Effect.timeout("30 seconds"), fromPeer(undefined, machine));
          if (batch.cursor.events < after.events || batch.cursor.meta < after.meta)
            return yield* new ThreadRemoteError({ reason: "behind" });
          const view = yield* topology;
          yield* replication
            .receivePriority(
              threadId,
              batch,
              hop,
              view.link._tag === "spoke" && view.link.hubEnvironmentId === hop,
            )
            .pipe(Effect.mapError(() => new ThreadRemoteError({ reason: "behind" })));
          priorityCursors.set(key, batch.cursor);
          if (priorityCursors.size > 2048)
            priorityCursors.delete(priorityCursors.keys().next().value!);
          if (batch.events.length === 0 && batch.meta.length === 0) return;
        }
      }).pipe(
        entry.permit.withPermits(1),
        Effect.ensuring(
          Effect.sync(() => {
            if (--entry.users === 0) priorityPermits.delete(key);
          }),
        ),
      );
    });

  yield* channels.register(ThreadDelegatedRead, (payload, caller) =>
    Effect.gen(function* () {
      if (payload.target !== replication.environmentId) {
        const view = yield* topology;
        if (view.link._tag !== "hub" || payload.target === caller.environmentId)
          return yield* new ThreadRemoteError({ reason: "not-owner" });
        const batch = yield* callMachine(
          payload.target,
          ThreadDelegatedRead,
          payload,
          "30 seconds",
        );
        // Remember ownership even when the hub's bulk replica is behind, so a
        // subsequent stop can be relayed without mistaking this for a local thread.
        yield* replication
          .receivePriority(payload.threadId, { ...batch, events: [] }, payload.target, false)
          .pipe(Effect.mapError(() => new ThreadRemoteError({ reason: "behind" })));
        return batch;
      }
      return yield* replication
        .readBatch(payload.after, caller.environmentId, true, payload.threadId)
        .pipe(Effect.mapError(() => new ThreadRemoteError({ reason: "behind" })));
    }),
  );

  /** The local copies of events the owner committed, once they have replicated here. */
  const localResult = Effect.fn("ThreadRouting.localResult")(function* (
    threadId: ThreadId,
    eventIds: ReadonlyArray<EventId>,
  ) {
    const rows =
      eventIds.length === 0
        ? []
        : yield* sql<{
            readonly sequence: number;
          }>`SELECT sequence FROM orchestration_events WHERE event_id IN ${sql.in(eventIds)} ORDER BY sequence`;
    if (rows.length === 0) {
      const sequence = yield* eventStore.latestSequence({ threadId });
      return { sequence, storedEvents: [] };
    }
    const wanted = new Set<string>(eventIds);
    const storedEvents = (yield* Stream.runCollect(
      eventStore.read({
        threadId,
        afterSequence: rows[0]!.sequence - 1,
        throughSequence: rows.at(-1)!.sequence,
      }),
    )).filter((stored) => wanted.has(stored.event.id));
    return { sequence: rows.at(-1)!.sequence, storedEvents };
  });

  yield* remoteCommands.register((command) =>
    Effect.gen(function* () {
      const threadId = commandThreadId(command);
      const owner = yield* replication.owner(threadId);
      if (owner === undefined || (owner.local && owner.handoff === null)) return Option.none();
      if (owner.local)
        return yield* new ThreadRemoteError({
          reason: "moving",
          detail: "This thread is moving to another machine. Try again when the move finishes.",
        });
      if (!validatePortableCommand(command))
        return yield* new ThreadRemoteError({
          reason: "not-owner",
          detail: `${command.type} is not portable across machines with these inputs.`,
        });
      const forwarded = Effect.gen(function* () {
        const hop = yield* nextHop(owner.owner);
        const files = yield* readFiles(commandAttachments(command));
        const view = yield* topology;
        const result = yield* machines
          .call(hop, ThreadCommandForward, {
            command,
            files,
            priority:
              command.type === "thread.stop" ||
              command.type === "run.interrupt" ||
              command.type === "subagent.stop",
          })
          .pipe(Effect.timeout("2 minutes"), fromPeer(view, owner.owner));
        if (
          command.type === "thread.stop" ||
          command.type === "run.interrupt" ||
          command.type === "subagent.stop"
        )
          yield* refreshDelegated(owner.owner, threadId).pipe(Effect.ignore);
        return yield* localResult(threadId, result.eventIds).pipe(
          Effect.mapError(() => new ThreadRemoteError({ reason: "rejected" })),
        );
      });
      // Opening a thread marks it read; that must not fail while its machine is away.
      return Option.some(
        yield* BEST_EFFORT_COMMANDS.has(command.type)
          ? forwarded.pipe(
              Effect.catchTags({
                ThreadRemoteError: (error) =>
                  error.reason === "offline"
                    ? eventStore.latestSequence({ threadId }).pipe(
                        Effect.map((sequence) => ({ sequence, storedEvents: [] })),
                        Effect.mapError(() => error),
                      )
                    : Effect.fail(error),
              }),
            )
          : forwarded,
      );
    }),
  );

  yield* channels.register(ThreadCommandForward, ({ command, files, priority }, caller) =>
    Effect.gen(function* () {
      // A peer never speaks for this machine's own workers.
      if (!validatePortableCommand(command))
        return yield* new ThreadRemoteError({
          reason: "not-owner",
          detail: `${command.type} is not portable across machines with these inputs.`,
        });
      const threadId = commandThreadId(command);
      const owner = yield* replication.owner(threadId);
      if (owner === undefined || (owner.local && owner.handoff === null)) {
        // Only the files the command names, so a peer cannot plant others here.
        const named = new Set(
          commandAttachments(command).flatMap((attachment) => {
            const name = attachmentRelativePath(attachment);
            return name === null ? [] : [name];
          }),
        );
        yield* writeFiles(files.filter((file) => named.has(file.name)));
        const result = yield* threads
          .dispatch(command)
          .pipe(
            Effect.mapError(
              (error) => new ThreadRemoteError({ reason: "rejected", detail: error.message }),
            ),
          );
        // The caller's projection shows the result by the time it hears back.
        if (priority !== true) yield* threadSync.sync(caller.environmentId).pipe(Effect.ignore);
        return { eventIds: result.storedEvents.map((stored) => stored.event.id) };
      }
      if (owner.local) return yield* new ThreadRemoteError({ reason: "moving" });
      const view = yield* topology;
      // Only the hub relays, and only to the spoke that runs the thread.
      if (view.link._tag !== "hub" || owner.owner === caller.environmentId)
        return yield* new ThreadRemoteError({ reason: "not-owner" });
      const relayed = yield* machines
        .call(owner.owner, ThreadCommandForward, {
          command,
          files,
          ...(priority === undefined ? {} : { priority }),
        })
        .pipe(Effect.timeout("2 minutes"), fromPeer(view, owner.owner));
      if (priority !== true) yield* threadSync.sync(caller.environmentId).pipe(Effect.ignore);
      return relayed;
    }),
  );

  // Filing a thread into a project folder is the owner's to record, like a
  // command: the filing replicates back to this machine before the owner answers.
  const decodeFolderMoveError = Schema.decodeUnknownOption(ThreadFolderMove.error);
  const callFolderMove = (
    hop: EnvironmentId,
    owner: EnvironmentId,
    input: MoveThreadProjectFolderInput,
  ) =>
    Effect.gen(function* () {
      const view = yield* topology;
      return yield* machines.call(hop, ThreadFolderMove, input).pipe(
        Effect.timeout("1 minute"),
        Effect.mapError((error) => {
          const refusal =
            error._tag === "PeerCallError" && error.reason === "handler-failed"
              ? decodeFolderMoveError(error.error)
              : Option.none();
          return Option.isSome(refusal)
            ? refusal.value
            : new ThreadRemoteError({
                reason: "offline",
                detail: `${machineName(view, owner)} did not answer.`,
              });
        }),
      );
    });

  yield* remoteCommands.registerFolderMove((input) =>
    Effect.gen(function* () {
      const owner = yield* replication.owner(input.threadId);
      if (owner === undefined || (owner.local && owner.handoff === null)) return Option.none();
      if (owner.local)
        return yield* new ThreadRemoteError({
          reason: "moving",
          detail: "This thread is moving to another machine. Try again when the move finishes.",
        });
      const hop = yield* nextHop(owner.owner);
      return Option.some(yield* callFolderMove(hop, owner.owner, input));
    }),
  );

  yield* channels.register(ThreadFolderMove, (input, caller) =>
    Effect.gen(function* () {
      const owner = yield* replication.owner(input.threadId);
      if (owner === undefined || (owner.local && owner.handoff === null)) {
        const result = yield* projectLabels.moveLocalThread(input);
        // The caller's thread shows the new filing by the time it hears back.
        yield* threadSync.sync(caller.environmentId).pipe(Effect.ignore);
        return result;
      }
      if (owner.local) return yield* new ThreadRemoteError({ reason: "moving" });
      const view = yield* topology;
      // Only the hub relays, and only to the spoke that runs the thread.
      if (view.link._tag !== "hub" || owner.owner === caller.environmentId)
        return yield* new ThreadRemoteError({ reason: "not-owner" });
      const relayed = yield* callFolderMove(owner.owner, owner.owner, input);
      yield* threadSync.sync(caller.environmentId).pipe(Effect.ignore);
      return relayed;
    }),
  );

  /** The machine that runs the thread an attachment id belongs to; undefined when it runs here. */
  const attachmentOwner = Effect.fn("ThreadRouting.attachmentOwner")(function* (
    attachmentId: string,
  ) {
    const segment = parseThreadSegmentFromAttachmentId(attachmentId);
    if (segment === null) return undefined;
    for (const [threadId, owner] of yield* replication.remoteOwners)
      if (toSafeThreadAttachmentSegment(threadId) === segment) return owner;
    return undefined;
  });

  const readLocal = (attachmentId: string) => {
    const file = resolveAttachmentPathById({
      attachmentsDir: config.attachmentsDir,
      attachmentId,
    });
    return file === null
      ? Effect.succeed(null)
      : fileSystem.readFile(file).pipe(
          Effect.map((bytes): ThreadAttachmentFile => ({
            name: path.basename(file),
            base64: Buffer.from(bytes).toString("base64"),
          })),
          Effect.orElseSucceed(() => null),
        );
  };

  yield* channels.register(ThreadAttachmentRead, ({ attachmentId }, caller) =>
    Effect.gen(function* () {
      const owner = yield* attachmentOwner(attachmentId);
      if (owner === undefined) return yield* readLocal(attachmentId);
      const view = yield* topology;
      if (view.link._tag !== "hub" || owner === caller.environmentId)
        return yield* new ThreadRemoteError({ reason: "not-owner" });
      return yield* machines
        .call(owner, ThreadAttachmentRead, { attachmentId })
        .pipe(Effect.timeout("1 minute"), fromPeer(view, owner));
    }),
  );

  const fetchAttachment: ThreadRouting["Service"]["fetchAttachment"] = Effect.fn(
    "ThreadRouting.fetchAttachment",
  )(function* (attachmentId) {
    const owner = yield* attachmentOwner(attachmentId);
    if (owner === undefined) return Option.none();
    const hop = yield* nextHop(owner);
    const file = yield* machines
      .call(hop, ThreadAttachmentRead, { attachmentId })
      .pipe(Effect.timeout("1 minute"), fromPeer(undefined, owner));
    // The owner names the file it has; only accept the id that was asked for.
    if (file === null || !file.name.startsWith(`${attachmentId}.`)) return Option.none();
    yield* writeFiles([file]);
    return Option.some(attachmentPath(file.name));
  });

  const callMachine: ThreadRouting["Service"]["callMachine"] = (
    machine,
    channel,
    payload,
    timeout,
  ) =>
    Effect.gen(function* () {
      const hop = yield* nextHop(machine);
      const view = yield* topology;
      return yield* machines
        .call(hop, channel, payload)
        .pipe(Effect.timeout(timeout), fromPeer(view, machine));
    });

  return ThreadRouting.of({
    refreshDelegated,
    fetchAttachment,
    callMachine,
  });
});

export const layer = Layer.effect(ThreadRouting, make);
