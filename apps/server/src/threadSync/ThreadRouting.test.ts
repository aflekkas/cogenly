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
  RunId,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ServerConfig from "../config.ts";
import { pair } from "../machines/testkit.ts";
import { startThreadMachine, threadCreated, threadId, userMessage } from "./testkit.ts";

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
