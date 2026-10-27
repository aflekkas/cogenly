import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "@effect/vitest";
import {
  type ChatAttachment,
  CommandId,
  MessageId,
  type OrchestrationV2ServerCommand,
  ProjectLabelId,
  ThreadId,
  ThreadCommandForward,
  ThreadAttachmentRead,
  ThreadFolderMove,
  RunId,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as PeerChannels from "../machines/PeerChannels.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ServerConfig from "../config.ts";
import { pair } from "../machines/testkit.ts";
import { startThreadMachine, threadCreated, threadId, userMessage } from "./testkit.ts";

const encodeForwardedCommand = Schema.encodeEffect(
  Schema.toCodecJson(ThreadCommandForward.payload),
);

const attachment: ChatAttachment = {
  type: "file",
  id: "on-laptop-00000000-0000-4000-8000-000000000001",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
};
const send = (
  text: string,
  target = threadId,
  attachments: ReadonlyArray<ChatAttachment> = [],
): Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }> => ({
  type: "message.dispatch",
  createdBy: "user",
  creationSource: "web",
  commandId: CommandId.make(`command:${text}`),
  threadId: target,
  messageId: MessageId.make(`message:${text}`),
  text,
  attachments,
  dispatchMode: { type: "start_immediately" },
});

describe("continuing a thread another machine runs", () => {
  it.live(
    "a lost hub's replica can be archived, restored and deleted after unpairing",
    () =>
      Effect.gen(function* () {
        const hub = yield* startThreadMachine(
          "orphan-hub",
          "cloud-server",
          undefined,
          undefined,
          true,
        );
        const spoke = yield* startThreadMachine(
          "orphan-spoke",
          "computer",
          undefined,
          undefined,
          true,
        );
        yield* pair(hub, spoke);
        const at = yield* DateTime.now;
        yield* hub.sink.write({
          events: [
            threadCreated("event:orphan-created", at),
            userMessage("event:orphan-message", at, "Keep this history"),
          ],
        });
        yield* hub.sync.sync(spoke.environmentId);
        yield* spoke.machines.unpair({ environmentId: hub.environmentId });
        const engine = Option.getOrThrow(spoke.engine);
        yield* engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("orphan:archive"),
          threadId,
        });
        expect(
          (yield* spoke.projections.getThreadProjection(threadId)).thread.archivedAt,
        ).not.toBeNull();
        expect(yield* spoke.replication.owner(threadId)).toMatchObject({
          local: true,
          owner: spoke.environmentId,
          epoch: 1,
        });
        yield* engine.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make("orphan:restore"),
          threadId,
        });
        expect(
          (yield* spoke.projections.getThreadProjection(threadId)).thread.archivedAt,
        ).toBeNull();
        yield* engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("orphan:delete"),
          threadId,
        });
        yield* Option.getOrThrow(spoke.worker).drain();
        const result = yield* spoke.projections.getThreadProjection(threadId);
        expect(result.thread.deletedAt).not.toBeNull();
        expect(result.messages.map((m) => m.text)).toEqual(["Keep this history"]);
        expect(spoke.provider.turns).toHaveLength(0);
      }).pipe(Effect.scoped),
    30000,
  );

  it.live(
    "a message sent on the hub runs on the laptop and is visible on the hub when the call returns",
    () =>
      Effect.gen(function* () {
        const at = yield* DateTime.now;
        const hub = yield* startThreadMachine("route-hub", "cloud-server");
        // The laptop's stand-in orchestrator records the message it was asked to send.
        const laptop = yield* startThreadMachine("route-laptop", "computer", (command) =>
          command.type === "message.dispatch"
            ? [userMessage(`event:${command.text}`, at, command.text)]
            : [],
        );
        yield* pair(hub, laptop);
        yield* laptop.sink.write({ events: [threadCreated("event:created", at)] });
        yield* laptop.sync.sync(hub.environmentId);

        const fileSystem = yield* hub.run(FileSystem.FileSystem);
        const path = yield* hub.run(Path.Path);
        const hubAttachments = (yield* hub.run(ServerConfig.ServerConfig)).attachmentsDir;
        const laptopAttachments = (yield* laptop.run(ServerConfig.ServerConfig)).attachmentsDir;
        yield* fileSystem.makeDirectory(hubAttachments, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(hubAttachments, `${attachment.id}.txt`),
          "notes",
        );

        const forwarded = yield* hub.remoteCommands.forward(send("hello", threadId, [attachment]));
        expect(Option.isSome(forwarded)).toBe(true);
        const result = Option.getOrThrow(forwarded);
        expect(result.storedEvents.map((stored) => stored.event.id)).toEqual(["event:hello"]);
        expect(
          (yield* hub.projections.getThreadProjection(threadId)).messages.map(
            (entry) => entry.text,
          ),
        ).toEqual(["hello"]);
        expect(
          (yield* laptop.projections.getThreadProjection(threadId)).messages.map(
            (entry) => entry.text,
          ),
        ).toEqual(["hello"]);
        expect(
          yield* fileSystem.readFileString(path.join(laptopAttachments, `${attachment.id}.txt`)),
        ).toBe("notes");

        // The hub's own threads dispatch locally.
        expect(
          Option.isNone(
            yield* hub.remoteCommands.forward(send("local", ThreadId.make("thread:hub"))),
          ),
        ).toBe(true);
      }).pipe(Effect.scoped),
    30000,
  );

  it.live(
    "while the machine that runs a thread is away, marking it read is dropped and a message fails",
    () =>
      Effect.gen(function* () {
        const hub = yield* startThreadMachine("away-hub", "cloud-server");
        const laptop = yield* startThreadMachine("away-laptop", "computer");
        yield* pair(hub, laptop);
        const away = ThreadId.make("thread:away");
        yield* hub.sql`INSERT INTO thread_owners(thread_id, owner_env, local, epoch, updated_at)
          VALUES (${away}, 'env:unpaired', 0, 0, '2026-10-24T00:00:00.000Z')`;

        const visited = yield* hub.remoteCommands.forward({
          type: "thread.visit",
          commandId: CommandId.make("command:visit"),
          threadId: away,
          visitedAt: "2026-10-24T00:00:00.000Z",
        });
        expect(Option.getOrThrow(visited).storedEvents).toEqual([]);
        const sent = yield* Effect.flip(hub.remoteCommands.forward(send("hello?", away)));
        expect(sent.reason).toBe("offline");
      }).pipe(Effect.scoped),
    30000,
  );

  it.live(
    "moving a replica into a project files it on the machine that runs it, then here",
    () =>
      Effect.gen(function* () {
        const at = yield* DateTime.now;
        const hub = yield* startThreadMachine("folder-hub", "cloud-server");
        const laptop = yield* startThreadMachine("folder-laptop", "computer");
        yield* pair(hub, laptop);
        yield* laptop.sink.write({ events: [threadCreated("event:created", at)] });
        yield* laptop.sync.sync(hub.environmentId);
        // Paired machines share the project under one id.
        for (const machine of [hub, laptop])
          yield* machine.sql`INSERT INTO project_labels(label_id, name, created_at, updated_at)
            VALUES ('label:bartr', 'Bartr', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z')`;
        const filed = (machine: typeof hub) =>
          machine.sql<{
            readonly label_id: string;
          }>`SELECT label_id FROM thread_project_labels WHERE thread_id = ${threadId}`.pipe(
            Effect.map((rows) => rows.map((row) => row.label_id)),
          );

        const moved = yield* hub.remoteCommands.moveFolder({
          threadId,
          folderId: ProjectLabelId.make("label:bartr"),
        });
        expect(Option.getOrThrow(moved).projectFolderId).toBe("label:bartr");
        expect(yield* filed(laptop)).toEqual(["label:bartr"]);
        // The owner pushed the filing back before it answered.
        expect(yield* filed(hub)).toEqual(["label:bartr"]);

        // The laptop files its own threads itself.
        expect(
          Option.isNone(yield* laptop.remoteCommands.moveFolder({ threadId, folderId: null })),
        ).toBe(true);
      }).pipe(Effect.scoped),
    30000,
  );

  it.live(
    "a replica reads an older attachment from the machine that runs the thread",
    () =>
      Effect.gen(function* () {
        const at = yield* DateTime.now;
        const hub = yield* startThreadMachine("fetch-hub", "cloud-server");
        const laptop = yield* startThreadMachine("fetch-laptop", "computer");
        yield* pair(hub, laptop);
        yield* laptop.sink.write({ events: [threadCreated("event:created", at)] });
        yield* laptop.sync.sync(hub.environmentId);
        const fileSystem = yield* laptop.run(FileSystem.FileSystem);
        const path = yield* laptop.run(Path.Path);
        const laptopAttachments = (yield* laptop.run(ServerConfig.ServerConfig)).attachmentsDir;
        yield* fileSystem.makeDirectory(laptopAttachments, { recursive: true });
        // Attachment ids begin with their thread's segment, which names the owner.
        const image = "thread-on-laptop-00000000-0000-4000-8000-000000000002";
        yield* fileSystem.writeFileString(path.join(laptopAttachments, `${image}.png`), "png");

        const fetched = yield* hub.routing.fetchAttachment(image);
        expect(Option.isSome(fetched)).toBe(true);
        expect(yield* fileSystem.readFileString(Option.getOrThrow(fetched))).toBe("png");
        expect(
          Option.isNone(
            yield* hub.routing.fetchAttachment(
              "thread-on-laptop-00000000-0000-4000-8000-000000000003",
            ),
          ),
        ).toBe(true);
        // An attachment of a thread the hub runs is never asked of a peer.
        expect(
          Option.isNone(
            yield* hub.routing.fetchAttachment("thread-hub-00000000-0000-4000-8000-000000000004"),
          ),
        ).toBe(true);
      }).pipe(Effect.scoped),
    30000,
  );
});

it.live(
  "receivers reject worker commands and store only the files a forwarded command names",
  () =>
    Effect.gen(function* () {
      const hub = yield* startThreadMachine("input-hub", "cloud-server");
      let dispatched = 0;
      const laptop = yield* startThreadMachine("input-laptop", "computer", () => {
        dispatched++;
        return [];
      });
      yield* pair(hub, laptop);
      const rejected = yield* Effect.result(
        hub.machines.call(laptop.environmentId, ThreadCommandForward, {
          command: {
            type: "prepared-run.progress",
            commandId: CommandId.make("command:forge"),
            threadId,
            runId: RunId.make("run:forge"),
            phase: "setup",
          },
          files: [],
        }),
      );
      expect(rejected._tag).toBe("Failure");
      expect(dispatched).toBe(0);
      yield* hub.machines.call(laptop.environmentId, ThreadCommandForward, {
        command: send("files", threadId, [attachment]),
        files: [
          { name: `${attachment.id}.txt`, base64: Buffer.from("notes").toString("base64") },
          { name: "unrelated.txt", base64: Buffer.from("planted").toString("base64") },
        ],
      });
      const fs = yield* laptop.run(FileSystem.FileSystem);
      const path = yield* laptop.run(Path.Path);
      const dir = (yield* laptop.run(ServerConfig.ServerConfig)).attachmentsDir;
      expect(yield* fs.readFileString(path.join(dir, `${attachment.id}.txt`))).toBe("notes");
      expect(yield* fs.exists(path.join(dir, "unrelated.txt"))).toBe(false);
      // Filename decoding refuses traversal before it can reach the filesystem.
      expect(
        (yield* Effect.result(
          hub.machines.call(laptop.environmentId, ThreadAttachmentRead, {
            attachmentId: "../outside",
          }),
        ))._tag,
      ).toBe("Failure");
    }).pipe(Effect.scoped),
  30000,
);

it.live(
  "peers cannot create threads or supply workspace paths to forwarded commands",
  () =>
    Effect.gen(function* () {
      const hub = yield* startThreadMachine("paths-hub", "cloud-server");
      let dispatched = 0;
      const laptop = yield* startThreadMachine("paths-laptop", "computer", () => {
        dispatched++;
        return [];
      });
      yield* pair(hub, laptop);
      const shell = idleThreadProjection(liveThreadShell(threadId)).thread;
      const commands: ReadonlyArray<OrchestrationV2ServerCommand> = [
        {
          type: "thread.create",
          commandId: CommandId.make("command:create"),
          threadId,
          projectId: shell.projectId,
          title: "Injected",
          modelSelection: shell.modelSelection,
          runtimeMode: shell.runtimeMode,
          interactionMode: shell.interactionMode,
          createdBy: "user",
          creationSource: "web",
          branch: null,
          worktreePath: "/private/peer-cwd",
        },
        {
          type: "thread.metadata.update",
          commandId: CommandId.make("command:path"),
          threadId,
          worktreePath: "/private/peer-cwd",
        },
        {
          type: "thread.metadata.update",
          commandId: CommandId.make("command:expected-path"),
          threadId,
          expectedWorktreePath: "/private/peer-cwd",
          title: "Injected",
        },
        {
          ...send("workspace"),
          dispatchMode: {
            type: "defer_start",
            workspaceStrategy: {
              type: "existing_worktree",
              worktreePath: "/private/peer-cwd",
            },
          },
        },
      ];
      for (const command of commands) {
        const result = yield* Effect.result(
          hub.machines.call(laptop.environmentId, ThreadCommandForward, { command, files: [] }),
        );
        expect(result._tag).toBe("Failure");
      }
      expect(dispatched).toBe(0);
      yield* hub.machines.call(laptop.environmentId, ThreadCommandForward, {
        command: {
          type: "thread.metadata.update",
          commandId: CommandId.make("command:title"),
          threadId,
          title: "Portable",
        },
        files: [],
      });
      expect(dispatched).toBe(1);
    }).pipe(Effect.scoped),
  30000,
);

it.live(
  "forwarding repairs truncated and same-length corrupt attachment copies",
  () =>
    Effect.gen(function* () {
      const hub = yield* startThreadMachine("repair-hub", "cloud-server");
      const laptop = yield* startThreadMachine("repair-laptop", "computer");
      yield* pair(hub, laptop);
      const fs = yield* laptop.run(FileSystem.FileSystem);
      const path = yield* laptop.run(Path.Path);
      const dir = (yield* laptop.run(ServerConfig.ServerConfig)).attachmentsDir;
      yield* fs.makeDirectory(dir, { recursive: true });
      for (const corrupt of ["no", "wrong"]) {
        yield* fs.writeFileString(path.join(dir, `${attachment.id}.txt`), corrupt);
        yield* hub.machines.call(laptop.environmentId, ThreadCommandForward, {
          command: send(`repair:${corrupt}`, threadId, [attachment]),
          files: [
            { name: `${attachment.id}.txt`, base64: Buffer.from("notes").toString("base64") },
          ],
        });
        expect(yield* fs.readFileString(path.join(dir, `${attachment.id}.txt`))).toBe("notes");
      }
    }).pipe(Effect.scoped),
  30000,
);

it.live(
  "filing rechecks ownership after routing and rejects stale local writes",
  () =>
    Effect.gen(function* () {
      const hub = yield* startThreadMachine("filing-race-hub", "cloud-server");
      const laptop = yield* startThreadMachine(
        "filing-race-owner",
        "computer",
        undefined,
        undefined,
        false,
        undefined,
        true,
      );
      yield* pair(hub, laptop);
      const at = yield* DateTime.now;
      yield* laptop.sink.write({ events: [threadCreated("event:filing-race", at)] });
      const folderId = ProjectLabelId.make("label:race");
      yield* laptop.sql`INSERT INTO project_labels(label_id, name, created_at, updated_at)
      VALUES (${folderId}, 'Race', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z')`;
      const projectId = (yield* laptop.projections.getThreadProjection(threadId)).thread.projectId;
      yield* laptop.sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${projectId}, 'Race', '/tmp/race', '[]', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z')`;
      yield* laptop.sql`INSERT INTO label_repositories(label_id, repository_id) VALUES (${folderId}, ${projectId})`;
      // Finish a handoff after the local entry point's routing decision, before its mutation.
      yield* laptop.remoteCommands.registerFolderMove(() =>
        Effect.gen(function* () {
          expect(yield* laptop.replication.owner(threadId)).toBeUndefined();
          yield* laptop.sql`INSERT INTO thread_owners(thread_id, owner_env, local, epoch, updated_at)
        VALUES (${threadId}, ${hub.environmentId}, 0, 1, '2026-10-24T00:00:00.000Z')`;
          return Option.none();
        }).pipe(Effect.orDie),
      );
      const input = { threadId, folderId };
      expect((yield* Effect.result(laptop.labels.moveThread(input)))._tag).toBe("Failure");
      expect((yield* Effect.result(laptop.labels.moveLocalThread(input)))._tag).toBe("Failure");
      yield* laptop.sql`UPDATE thread_owners SET local = 1, owner_env = ${laptop.environmentId}, handoff_json = '{"target":"other","epoch":2}'`;
      expect((yield* Effect.result(laptop.labels.moveLocalThread(input)))._tag).toBe("Failure");
      expect(
        (yield* Effect.result(hub.machines.call(laptop.environmentId, ThreadFolderMove, input)))
          ._tag,
      ).toBe("Failure");
      expect(
        yield* laptop.sql`SELECT * FROM thread_project_labels WHERE thread_id = ${threadId}`,
      ).toEqual([]);
      expect(
        yield* laptop.sql`SELECT * FROM project_label_audit WHERE operation = 'moveThread'`,
      ).toEqual([]);
    }).pipe(Effect.scoped),
  30000,
);

it.live("forwarded commands overtake background SQL already queued on the owner", () =>
  Effect.gen(function* () {
    const finished: Array<string> = [];
    const laptop = yield* startThreadMachine("priority-owner", "computer", () => {
      finished.push("command");
      return [];
    });
    yield* laptop.sink.write({ events: [threadCreated("priority:created", yield* DateTime.now)] });
    const sql = yield* laptop.run(SqlClient.SqlClient);
    const channels = yield* laptop.run(PeerChannels.PeerChannels);
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holder = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const original = NodeSqlite.StatementSync.prototype.all;
        NodeSqlite.StatementSync.prototype.all = function (
          this: NodeSqlite.StatementSync,
          ...args: Array<never>
        ) {
          const rows = original.apply(this, args as never);
          if (this.sourceSQL.includes("FROM thread_owners") && args.includes(threadId as never)) {
            finished.push("owner-read");
          }
          return rows;
        } as typeof original;
        return original;
      }),
      (original) =>
        Effect.sync(() => {
          NodeSqlite.StatementSync.prototype.all = original;
        }),
    );
    const backlog = yield* Effect.forEach(
      Array.from({ length: 20 }, (_, i) => i),
      (i) =>
        sql`SELECT 1`.pipe(
          Effect.tap(() => Effect.sync(() => finished.push(`background-${i}`))),
          Effect.forkChild({ startImmediately: true }),
        ),
    );
    const command = yield* channels
      .dispatch({
        channel: ThreadCommandForward.name,
        payload: yield* encodeForwardedCommand({
          command: send("priority"),
          files: [],
          priority: true,
        }),
        caller: { environmentId: laptop.environmentId, scopes: [ThreadCommandForward.scope] },
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    yield* Fiber.join(command);
    yield* Fiber.joinAll(backlog);
    expect(finished.indexOf("owner-read")).toBeGreaterThanOrEqual(0);
    expect(finished.indexOf("owner-read")).toBeLessThan(20);
  }).pipe(Effect.scoped),
);
