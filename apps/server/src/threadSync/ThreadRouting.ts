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
  type OrchestrationV2ServerCommand,
  type PeerCallError,
  type PeerChannel,
  THREAD_FORWARD_MAX_FILE_BYTES,
  ThreadAttachmentRead,
  type ThreadAttachmentFile,
  ThreadCommandForward,
  type ThreadId,
  ThreadRemoteError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
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
import * as ThreadReplication from "./ThreadReplication.ts";
import * as ThreadSync from "./ThreadSync.ts";

/**
 * Bookkeeping the owner's own workers record. A replica never produces these;
 * if one does, it is a bug to surface, not a command to send elsewhere.
 */
const OWNER_ONLY_COMMANDS: ReadonlySet<OrchestrationV2ServerCommand["type"]> = new Set([
  "prepared-run.progress",
  "prepared-run.fail",
  "checkpoint.rollback.fail",
  "thread.title.regeneration.complete",
  "thread.background-work.settle",
  "thread.pull-request-link.sync",
  "thread.pull-request-watch.sync",
  "thread.pull-request.sync",
  "notification.delivery.accept",
  "delegated_task.completion-delivery.acknowledge",
  "delegated_task.completion-delivery.dispose",
  "thread.created.record",
  "secret_request.record",
]);

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

  // Ids name their files, so an existing file is the same attachment.
  const writeFiles = (files: ReadonlyArray<ThreadAttachmentFile>) =>
    Effect.gen(function* () {
      if (
        files.reduce((total, file) => total + Buffer.byteLength(file.base64, "base64"), 0) >
        THREAD_FORWARD_MAX_FILE_BYTES
      )
        return yield* new ThreadRemoteError({ reason: "too-large" });
      yield* Effect.forEach(
        files,
        (file) =>
          fileSystem
            .exists(attachmentPath(file.name))
            .pipe(
              Effect.flatMap((exists) =>
                exists
                  ? Effect.void
                  : fileSystem
                      .makeDirectory(config.attachmentsDir, { recursive: true })
                      .pipe(
                        Effect.andThen(
                          fileSystem.writeFile(
                            attachmentPath(file.name),
                            new Uint8Array(Buffer.from(file.base64, "base64")),
                          ),
                        ),
                      ),
              ),
            ),
        { discard: true },
      ).pipe(
        Effect.mapError(
          () =>
            new ThreadRemoteError({ reason: "rejected", detail: "Could not store an attachment." }),
        ),
      );
    });

  const fromPeer =
    (view: MachineListResult | undefined, owner: EnvironmentId) =>
    <A>(effect: Effect.Effect<A, PeerCallError | Cause.TimeoutError>) =>
      effect.pipe(
        Effect.mapError((error) => {
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
      if (OWNER_ONLY_COMMANDS.has(command.type))
        return yield* new ThreadRemoteError({
          reason: "not-owner",
          detail: `${command.type} runs only on the machine that runs the thread.`,
        });
      const forwarded = Effect.gen(function* () {
        const hop = yield* nextHop(owner.owner);
        const files = yield* readFiles(commandAttachments(command));
        const view = yield* topology;
        const result = yield* machines
          .call(hop, ThreadCommandForward, { command, files })
          .pipe(Effect.timeout("2 minutes"), fromPeer(view, owner.owner));
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

  yield* channels.register(ThreadCommandForward, ({ command, files }, caller) =>
    Effect.gen(function* () {
      // A peer never speaks for this machine's own workers.
      if (OWNER_ONLY_COMMANDS.has(command.type))
        return yield* new ThreadRemoteError({
          reason: "not-owner",
          detail: `${command.type} runs only on the machine that runs the thread.`,
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
        yield* threadSync.sync(caller.environmentId).pipe(Effect.ignore);
        return { eventIds: result.storedEvents.map((stored) => stored.event.id) };
      }
      if (owner.local) return yield* new ThreadRemoteError({ reason: "moving" });
      const view = yield* topology;
      // Only the hub relays, and only to the spoke that runs the thread.
      if (view.link._tag !== "hub" || owner.owner === caller.environmentId)
        return yield* new ThreadRemoteError({ reason: "not-owner" });
      const relayed = yield* machines
        .call(owner.owner, ThreadCommandForward, { command, files })
        .pipe(Effect.timeout("2 minutes"), fromPeer(view, owner.owner));
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

  return ThreadRouting.of({ fetchAttachment, callMachine });
});

export const layer = Layer.effect(ThreadRouting, make);
