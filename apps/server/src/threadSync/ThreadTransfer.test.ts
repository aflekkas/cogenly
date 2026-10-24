import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProjectLabelId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { pair } from "../machines/testkit.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { startThreadMachine, threadCreated, threadId, userMessage } from "./testkit.ts";

type ThreadMachine = Effect.Success<ReturnType<typeof startThreadMachine>>;

const projectId = ProjectId.make("project:mcp-test");
const addProject = (machine: ThreadMachine, root: string) =>
  machine.sql`INSERT INTO projection_projects(project_id, title, workspace_root, auto_pull, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Racing', ${root}, 0, '[]', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z')`;

const workThread = (at: DateTime.Utc): OrchestrationV2DomainEvent => {
  const created = threadCreated("event:created", at);
  return created.type === "thread.created"
    ? {
        ...created,
        payload: {
          ...created.payload,
          branch: "feature/pit-stops",
          worktreePath: "/Users/someone/.cogenly/worktrees/racing/pit-stops",
        },
      }
    : created;
};

const start = Effect.fn("startTransferMachines")(function* (prefix: string) {
  const hub = yield* startThreadMachine(`${prefix}-hub`, "cloud-server");
  const laptop = yield* startThreadMachine(`${prefix}-laptop`, "computer");
  yield* pair(hub, laptop);
  return { hub, laptop, at: yield* DateTime.now };
});

describe("moving threads between paired machines", () => {
  it.live(
    "the hub takes a laptop's thread with its attachments and runs it from then on",
    () =>
      Effect.gen(function* () {
        const { hub, laptop, at } = yield* start("move");
        yield* addProject(laptop, "/Users/someone/racing");
        yield* addProject(hub, "/srv/racing");
        yield* laptop.sink.write({ events: [workThread(at), userMessage("event:one", at, "hi")] });
        yield* laptop.sync.sync(hub.environmentId);
        const fileSystem = yield* laptop.run(FileSystem.FileSystem);
        const path = yield* laptop.run(Path.Path);
        const laptopConfig = yield* laptop.run(ServerConfig.ServerConfig);
        const hubConfig = yield* hub.run(ServerConfig.ServerConfig);
        const image = "thread-on-laptop-00000000-0000-4000-8000-000000000010";
        yield* fileSystem.makeDirectory(laptopConfig.attachmentsDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(laptopConfig.attachmentsDir, `${image}.png`),
          "png",
        );

        // Asked on the hub: the laptop runs the thread, so the laptop moves it.
        const result = yield* hub.transfer.move({
          threadIds: [threadId],
          target: hub.environmentId,
        });
        expect(result).toEqual({ moved: [threadId], skipped: [] });

        expect(yield* hub.replication.owner(threadId)).toMatchObject({ local: true, epoch: 1 });
        expect(yield* laptop.replication.owner(threadId)).toMatchObject({
          local: false,
          owner: hub.environmentId,
          epoch: 1,
        });
        expect(
          yield* fileSystem.readFileString(path.join(hubConfig.attachmentsDir, `${image}.png`)),
        ).toBe("png");
        // The worktree path follows the hub's layout; the next turn recreates it from the branch.
        const moved = (yield* hub.projections.getThreadProjection(threadId)).thread;
        expect(moved.worktreePath).toBe(path.join(hubConfig.worktreesDir, "racing", "pit-stops"));
        expect(moved.ownerMachine).toBeNull();

        // Only the hub writes the thread now, and the laptop follows it.
        yield* hub.sink.write({ events: [userMessage("event:two", at, "on the hub")] });
        const refused = yield* Effect.flip(
          laptop.sink.write({ events: [userMessage("event:three", at, "x")] }),
        );
        expect(refused.cause).toBeInstanceOf(EventSink.ThreadOwnedElsewhereError);
        yield* hub.sync.sync(laptop.environmentId);
        const replica = yield* laptop.projections.getThreadProjection(threadId);
        expect(replica.messages.map((entry) => entry.text)).toEqual(["hi", "on the hub"]);
        expect(replica.thread.ownerMachine).toBe(hub.environmentId);

        // Moving it again where it already runs is a no-op.
        expect(
          yield* laptop.transfer.move({ threadIds: [threadId], target: hub.environmentId }),
        ).toEqual({ moved: [threadId], skipped: [] });
      }).pipe(Effect.scoped),
    30000,
  );

  it.live(
    "a busy thread, or one whose repository the target lacks, stays where it is",
    () =>
      Effect.gen(function* () {
        const { hub, laptop, at } = yield* start("refuse");
        yield* addProject(laptop, "/Users/someone/racing");
        yield* laptop.sink.write({ events: [threadCreated("event:created", at)] });
        yield* laptop.sync.sync(hub.environmentId);

        const missing = yield* laptop.transfer.move({
          threadIds: [threadId],
          target: hub.environmentId,
        });
        expect(missing.moved).toEqual([]);
        expect(missing.skipped[0]?.reason).toBe("needs-repository");
        // The refusal released the fence: the laptop runs the thread as before.
        yield* laptop.sink.write({ events: [userMessage("event:one", at, "still here")] });
        expect((yield* laptop.replication.owner(threadId))?.handoff).toBeNull();

        yield* addProject(hub, "/srv/racing");
        yield* laptop.sql`INSERT INTO orchestration_v2_effect_outbox(effect_id, command_id, thread_id, effect_type, payload_json, status, attempt_count, available_at, created_at, updated_at)
          VALUES ('effect:pending', 'command:pending', ${threadId}, 'thread-title.generate', '{}', 'pending', 0, '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z')`;
        const busy = yield* laptop.transfer.move({
          threadIds: [threadId],
          target: hub.environmentId,
        });
        expect(busy.skipped[0]?.reason).toBe("busy");
        expect(yield* hub.replication.owner(threadId)).toMatchObject({ local: false });
      }).pipe(Effect.scoped),
    30000,
  );

  it.live(
    "an agent moves with its conversation, and its schedules follow",
    () =>
      Effect.gen(function* () {
        const { hub, laptop, at } = yield* start("agent");
        yield* addProject(laptop, "/Users/someone/racing");
        yield* addProject(hub, "/srv/racing");
        yield* laptop.sink.write({ events: [threadCreated("event:created", at)] });
        yield* laptop.sync.sync(hub.environmentId);
        yield* laptop.sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled, daily_run_cap, owner_machine)
          VALUES ('agent:pit', ${threadId}, '{}', 1, 10, ${laptop.environmentId})`;
        yield* laptop.shared.write("agent", "agent:pit", { ownerMachine: laptop.environmentId });
        yield* laptop.shared.write("schedule", "task:pit", {
          agentId: "agent:pit",
          title: "Morning check",
          prompt: "Check",
          enabled: true,
          schedule: { type: "interval", everyMs: 60000 },
          repositoryRemote: null,
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: "codex", model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          ownerMachine: laptop.environmentId,
          createdAt: "2026-10-24T00:00:00.000Z",
        });

        expect(
          yield* laptop.transfer.move({ threadIds: [threadId], target: hub.environmentId }),
        ).toEqual({ moved: [threadId], skipped: [] });
        expect((yield* laptop.shared.get("agent", "agent:pit"))?.fields.ownerMachine).toBe(
          hub.environmentId,
        );
        expect((yield* laptop.shared.get("schedule", "task:pit"))?.fields.ownerMachine).toBe(
          hub.environmentId,
        );
      }).pipe(Effect.scoped),
    30000,
  );

  it.live(
    "moving a project checks its repositories out on the target, then moves its threads",
    () =>
      Effect.gen(function* () {
        const { hub, laptop, at } = yield* start("project");
        const fileSystem = yield* hub.run(FileSystem.FileSystem);
        const path = yield* hub.run(Path.Path);
        const checkout = yield* fileSystem.makeTempDirectoryScoped();
        yield* fileSystem.writeFileString(path.join(checkout, "README.md"), "racing");
        yield* addProject(laptop, "/Users/someone/racing");
        yield* addProject(hub, checkout);
        for (const machine of [hub, laptop])
          yield* machine.sql`INSERT INTO project_labels(label_id, name, created_at, updated_at)
            VALUES ('label:racing', 'athens-racing', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z')`;
        yield* hub.sql`INSERT INTO label_repositories(label_id, repository_id, remote) VALUES
          ('label:racing', ${projectId}, 'github.com/aflekkas/athens-racing'),
          ('label:racing', 'remote:github.com/aflekkas/pit-wall', 'github.com/aflekkas/pit-wall')`;
        yield* laptop.sink.write({ events: [threadCreated("event:created", at)] });
        yield* laptop.sql`INSERT INTO thread_project_labels(thread_id, label_id) VALUES (${threadId}, 'label:racing')`;
        yield* laptop.sync.sync(hub.environmentId);

        const result = yield* hub.projectMove.move({
          id: ProjectLabelId.make("label:racing"),
          target: hub.environmentId,
        });
        expect(result.threads).toEqual({ moved: [threadId], skipped: [] });
        // A repository known only by its remote is cloned; this layer cannot clone.
        expect(result.repositories).toEqual([
          { remote: "github.com/aflekkas/athens-racing", status: "present" },
          {
            remote: "github.com/aflekkas/pit-wall",
            status: "failed",
            detail: "This machine cannot clone repositories.",
          },
        ]);
        expect(yield* hub.replication.owner(threadId)).toMatchObject({ local: true });
      }).pipe(Effect.scoped),
    30000,
  );

  it.live(
    "a move whose commit reply was lost finishes on the next retry",
    () =>
      Effect.gen(function* () {
        const { hub, laptop, at } = yield* start("resume");
        yield* addProject(laptop, "/Users/someone/racing");
        yield* addProject(hub, "/srv/racing");
        yield* laptop.sink.write({ events: [threadCreated("event:created", at)] });
        yield* laptop.sync.sync(hub.environmentId);

        // Fenced as if the commit was sent and its answer never arrived.
        yield* laptop.replication.fence(threadId, hub.environmentId);
        const fenced = yield* Effect.flip(
          laptop.sink.write({ events: [userMessage("event:one", at, "x")] }),
        );
        expect(fenced.cause).toBeInstanceOf(EventSink.ThreadOwnedElsewhereError);
        expect(
          (yield* Effect.flip(
            laptop.remoteCommands.forward({
              type: "thread.archive",
              commandId: CommandId.make("command:archive"),
              threadId,
            }),
          )).reason,
        ).toBe("moving");

        yield* laptop.transfer.resume;
        expect(yield* laptop.replication.fenced).toEqual([]);
        expect(yield* hub.replication.owner(threadId)).toMatchObject({ local: true, epoch: 1 });
        // Retrying after the target took it is harmless.
        yield* laptop.transfer.resume;
        expect(yield* laptop.replication.owner(threadId)).toMatchObject({
          local: false,
          owner: hub.environmentId,
        });
      }).pipe(Effect.scoped),
    30000,
  );
});
