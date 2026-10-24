import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  GitManagerError,
  ThreadHandoffCommit,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProjectLabelId,
  ThreadId,
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
    "one spoke hands a thread to another through the hub, attachments included",
    () =>
      Effect.gen(function* () {
        const { hub, laptop, at } = yield* start("spokes");
        const mini = yield* startThreadMachine("spokes-mini", "computer");
        yield* pair(hub, mini);
        yield* addProject(laptop, "/Users/someone/racing");
        yield* addProject(mini, "/Users/other/racing");
        yield* laptop.sink.write({ events: [threadCreated("event:created", at)] });
        const fileSystem = yield* laptop.run(FileSystem.FileSystem);
        const path = yield* laptop.run(Path.Path);
        const image = "thread-on-laptop-00000000-0000-4000-8000-000000000020";
        const laptopDir = (yield* laptop.run(ServerConfig.ServerConfig)).attachmentsDir;
        yield* fileSystem.makeDirectory(laptopDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(laptopDir, `${image}.png`), "png");

        expect(
          yield* laptop.transfer.move({ threadIds: [threadId], target: mini.environmentId }),
        ).toEqual({ moved: [threadId], skipped: [] });
        expect(yield* mini.replication.owner(threadId)).toMatchObject({ local: true, epoch: 1 });
        expect(yield* laptop.replication.owner(threadId)).toMatchObject({
          local: false,
          owner: mini.environmentId,
        });
        const miniDir = (yield* mini.run(ServerConfig.ServerConfig)).attachmentsDir;
        expect(yield* fileSystem.readFileString(path.join(miniDir, `${image}.png`))).toBe("png");
        // The hub learns the new owner from it.
        yield* mini.sync.sync(hub.environmentId);
        expect(yield* hub.replication.owner(threadId)).toMatchObject({
          local: false,
          owner: mini.environmentId,
          epoch: 1,
        });
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
        // A repository known here only by its remote starts cloning into the project.
        expect(result.repositories).toEqual([
          { remote: "github.com/aflekkas/athens-racing", status: "present" },
          { remote: "github.com/aflekkas/pit-wall", status: "cloning" },
        ]);
        expect(hub.checkouts).toEqual([
          { labelId: "label:racing", remote: "github.com/aflekkas/pit-wall" },
        ]);
        expect(yield* hub.replication.owner(threadId)).toMatchObject({ local: true });
      }).pipe(Effect.scoped),
    30000,
  );

  it.live(
    "a thread whose repository the target knows only by its remote starts the clone and moves",
    () =>
      Effect.gen(function* () {
        const { hub, laptop, at } = yield* start("clone");
        const remote = "github.com/aflekkas/athens-racing";
        yield* addProject(laptop, "/Users/someone/racing");
        for (const machine of [hub, laptop])
          yield* machine.sql`INSERT INTO project_labels(label_id, name, created_at, updated_at)
            VALUES ('label:racing', 'athens-racing', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z')`;
        yield* laptop.sql`INSERT INTO label_repositories(label_id, repository_id, remote)
          VALUES ('label:racing', ${projectId}, ${remote})`;
        yield* hub.sql`INSERT INTO label_repositories(label_id, repository_id, remote)
          VALUES ('label:racing', ${`remote:${remote}`}, ${remote})`;
        yield* laptop.sink.write({ events: [threadCreated("event:created", at)] });
        yield* laptop.sync.sync(hub.environmentId);

        expect(
          yield* laptop.transfer.move({ threadIds: [threadId], target: hub.environmentId }),
        ).toEqual({ moved: [threadId], skipped: [] });
        expect(hub.checkouts).toEqual([{ labelId: "label:racing", remote }]);
        // The thread now runs in the hub's checkout of the same remote.
        expect((yield* hub.projections.getThreadProjection(threadId)).thread.projectId).toBe(
          `project:clone:${remote}`,
        );
      }).pipe(Effect.scoped),
    30000,
  );

  it.live(
    "a chat from a T3 Code scratch folder moves into the target's No project",
    () =>
      Effect.gen(function* () {
        const { hub, laptop, at } = yield* start("t3-scratch");
        // T3 imports recorded ~/.t3/scratch as a repository; the hub has no No project yet.
        yield* addProject(laptop, "/Users/someone/.t3/scratch");
        yield* laptop.sink.write({ events: [threadCreated("event:created", at)] });
        yield* laptop.sync.sync(hub.environmentId);

        expect(
          yield* laptop.transfer.move({ threadIds: [threadId], target: hub.environmentId }),
        ).toEqual({ moved: [threadId], skipped: [] });
        expect((yield* hub.projections.getThreadProjection(threadId)).thread.projectId).toBe(
          "project:scratch",
        );
      }).pipe(Effect.scoped),
    30000,
  );

  it.live(
    "moving a project files the target's own checkout of it instead of cloning another",
    () =>
      Effect.gen(function* () {
        const { hub, laptop, at } = yield* start("adopt");
        const remote = "github.com/aflekkas/athens-racing";
        const fileSystem = yield* hub.run(FileSystem.FileSystem);
        const path = yield* hub.run(Path.Path);
        const checkout = yield* fileSystem.makeTempDirectoryScoped();
        yield* fileSystem.writeFileString(path.join(checkout, "README.md"), "racing");
        hub.remotes.set(checkout, remote);
        // The hub already works in its own unfiled checkout, with threads of its own.
        const vpsRacing = ProjectId.make("project:vps-racing");
        yield* hub.sql`INSERT INTO projection_projects(project_id, title, workspace_root, auto_pull, scripts_json, created_at, updated_at)
          VALUES (${vpsRacing}, 'athens-racing', ${checkout}, 0, '[]', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z')`;
        const created = threadCreated("event:hub-created", at);
        const hubThread = ThreadId.make("thread:on-hub");
        yield* hub.sink.write({
          events: [
            {
              ...created,
              threadId: hubThread,
              payload: { ...(created.payload as object), id: hubThread, projectId: vpsRacing },
            } as OrchestrationV2DomainEvent,
          ],
        });
        yield* addProject(laptop, "/Users/someone/racing");
        for (const machine of [hub, laptop])
          yield* machine.sql`INSERT INTO project_labels(label_id, name, created_at, updated_at)
            VALUES ('label:racing', 'athens-racing', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z')`;
        yield* laptop.sql`INSERT INTO label_repositories(label_id, repository_id, remote)
          VALUES ('label:racing', ${projectId}, ${remote})`;
        yield* hub.sql`INSERT INTO label_repositories(label_id, repository_id, remote)
          VALUES ('label:racing', ${`remote:${remote}`}, ${remote})`;
        yield* laptop.sink.write({ events: [threadCreated("event:created", at)] });
        yield* laptop.sql`INSERT INTO thread_project_labels(thread_id, label_id) VALUES (${threadId}, 'label:racing')`;
        yield* laptop.sync.sync(hub.environmentId);

        const result = yield* hub.projectMove.move({
          id: ProjectLabelId.make("label:racing"),
          target: hub.environmentId,
        });
        expect(result.repositories).toEqual([
          {
            remote,
            status: "present",
            detail: `Filed the checkout at ${checkout} into the project.`,
          },
        ]);
        expect(hub.checkouts).toEqual([]);
        expect(hub.bound).toEqual([{ labelId: "label:racing", remote, repositoryId: vpsRacing }]);
        // Filing the checkout brings the hub's own threads in; they already run here.
        expect([...result.threads.moved].sort()).toEqual([hubThread, threadId].sort());
        // The moved thread runs in that checkout, and the hub's own threads join the project.
        expect((yield* hub.projections.getThreadProjection(threadId)).thread.projectId).toBe(
          vpsRacing,
        );
        expect(
          yield* hub.sql`SELECT folder_id FROM effective_thread_project_folders WHERE thread_id = ${hubThread}`,
        ).toEqual([{ folder_id: "label:racing" }]);
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

describe("handoff failure regressions", () => {
  it.live(
    "the old owner accepts new events before a late commit reply, and a round trip preserves ids",
    () =>
      Effect.gen(function* () {
        const { hub, laptop, at } = yield* start("late-reply");
        yield* addProject(laptop, "/laptop/racing");
        yield* addProject(hub, "/hub/racing");
        yield* laptop.sink.write({
          events: [workThread(at), userMessage("event:initial", at, "before")],
        });
        const { epoch } = yield* laptop.replication.fence(threadId, hub.environmentId);
        yield* laptop.sync.sync(hub.environmentId);
        yield* laptop.machines.call(hub.environmentId, ThreadHandoffCommit, {
          threadId,
          from: laptop.environmentId,
          to: hub.environmentId,
          epoch,
          lastEventId: EventId.make("event:initial"),
          eventCount: 2,
          attachmentIds: [],
        });
        // The old owner has not received the commit reply or called finish.
        expect((yield* laptop.replication.owner(threadId))?.handoff).not.toBeNull();
        yield* hub.sink.write({
          events: [userMessage("event:after-take", DateTime.add(at, { seconds: 1 }), "after")],
        });
        yield* hub.sync.sync(laptop.environmentId);
        expect(yield* laptop.replication.owner(threadId)).toMatchObject({
          local: false,
          owner: hub.environmentId,
          epoch: 1,
        });
        expect(
          (yield* laptop.projections.getThreadProjection(threadId)).messages.map((x) => x.text),
        ).toEqual(["before", "after"]);
        expect(
          (yield* hub.transfer.move({ threadIds: [threadId], target: laptop.environmentId })).moved,
        ).toEqual([threadId]);
        yield* laptop.sync.sync(hub.environmentId);
        const ids = (machine: ThreadMachine) =>
          machine.sql<{
            event_id: string;
          }>`SELECT event_id FROM orchestration_events WHERE stream_id = ${threadId} ORDER BY sequence`;
        expect(yield* ids(laptop)).toEqual(yield* ids(hub));
        expect((yield* laptop.projections.getThread(threadId)).id).toBe(threadId);
      }).pipe(Effect.scoped),
    30000,
  );

  it.live(
    "a crash while rehoming rolls ownership back, and the fenced source retries safely",
    () =>
      Effect.gen(function* () {
        const { hub, laptop, at } = yield* start("atomic-home");
        yield* addProject(laptop, "/laptop/racing");
        yield* addProject(hub, "/hub/racing");
        yield* laptop.sink.write({ events: [workThread(at)] });
        yield* laptop.sync.sync(hub.environmentId);
        yield* hub.sql`CREATE TRIGGER reject_rehome BEFORE UPDATE ON orchestration_v2_projection_threads BEGIN SELECT RAISE(FAIL, 'test crash'); END`;
        const result = yield* laptop.transfer.move({
          threadIds: [threadId],
          target: hub.environmentId,
        });
        expect(result.moved).toEqual([]);
        expect((yield* laptop.replication.owner(threadId))?.handoff).not.toBeNull();
        expect((yield* hub.replication.owner(threadId))?.local).toBe(false);
        yield* hub.sql`DROP TRIGGER reject_rehome`;
        yield* laptop.transfer.resume;
        expect(yield* hub.replication.owner(threadId)).toMatchObject({ local: true, epoch: 1 });
        expect(yield* laptop.replication.owner(threadId)).toMatchObject({ local: false, epoch: 1 });
      }).pipe(Effect.scoped),
    30000,
  );

  it.live(
    "a target with a gap refuses ownership even when it has the last event",
    () =>
      Effect.gen(function* () {
        const { hub, laptop, at } = yield* start("gap");
        yield* addProject(laptop, "/laptop/racing");
        yield* addProject(hub, "/hub/racing");
        yield* laptop.sink.write({
          events: [
            threadCreated("event:gap-thread", at),
            userMessage("event:middle", at, "middle"),
            userMessage("event:last", at, "last"),
          ],
        });
        yield* laptop.sync.sync(hub.environmentId);
        yield* hub.sql`DELETE FROM orchestration_events WHERE event_id = 'event:middle'`;
        const result = yield* laptop.transfer.move({
          threadIds: [threadId],
          target: hub.environmentId,
        });
        expect(result.skipped[0]?.reason).toBe("behind");
        expect((yield* hub.replication.owner(threadId))?.local).toBe(false);
        expect((yield* laptop.replication.owner(threadId))?.handoff).toBeNull();
      }).pipe(Effect.scoped),
    30000,
  );

  it.live(
    "dry run reports placement and missing repositories without taking ownership",
    () =>
      Effect.gen(function* () {
        const { hub, laptop, at } = yield* start("preview");
        yield* addProject(laptop, "/laptop/racing");
        yield* addProject(hub, "/hub/racing");
        yield* laptop.sink.write({ events: [workThread(at)] });
        const result = yield* laptop.transfer.move({
          threadIds: [threadId],
          target: hub.environmentId,
          dryRun: true,
        });
        expect(result.moved).toEqual([]);
        expect(result.planned).toMatchObject([{ threadId, project: "/hub/racing" }]);
        expect(yield* laptop.replication.owner(threadId)).toBeUndefined();
        expect((yield* hub.replication.owner(threadId))?.local).toBe(false);
        yield* hub.sql`DELETE FROM projection_projects`;
        const missing = yield* laptop.transfer.move({
          threadIds: [threadId],
          target: hub.environmentId,
          dryRun: true,
        });
        expect(missing.skipped[0]?.reason).toBe("needs-repository");
        expect(yield* laptop.replication.owner(threadId)).toBeUndefined();
      }).pipe(Effect.scoped),
    30000,
  );

  it.live(
    "recovery requires unpairing and an explicit local adoption",
    () =>
      Effect.gen(function* () {
        const { hub, laptop, at } = yield* start("adopt");
        yield* addProject(laptop, "/laptop/racing");
        yield* addProject(hub, "/hub/racing");
        yield* laptop.sink.write({ events: [workThread(at)] });
        yield* laptop.sync.sync(hub.environmentId);
        expect(
          (yield* Effect.result(hub.transfer.adoptFrom({ from: laptop.environmentId })))._tag,
        ).toBe("Failure");
        yield* hub.machines.unpair({ environmentId: laptop.environmentId });
        const preview = yield* hub.transfer.adoptFrom({ dryRun: true });
        expect(preview.unpaired).toEqual([{ environmentId: laptop.environmentId, threads: 1 }]);
        expect((yield* hub.replication.owner(threadId))?.local).toBe(false);
        expect((yield* hub.transfer.adoptFrom({ from: laptop.environmentId })).adopted).toEqual([
          threadId,
        ]);
        expect(yield* hub.replication.owner(threadId)).toMatchObject({ local: true, epoch: 1 });
        yield* hub.sink.write({ events: [userMessage("event:recovered", at, "recovered")] });
      }).pipe(Effect.scoped),
    30000,
  );
});

it.live(
  "dry run and real moves both refuse Work whose Git safety check fails",
  () =>
    Effect.gen(function* () {
      const hub = yield* startThreadMachine("git-hub", "cloud-server");
      const laptop = yield* startThreadMachine(
        "git-laptop",
        "computer",
        () => [],
        ({ cwd }) =>
          Effect.fail(new GitManagerError({ operation: "status", cwd, detail: "unavailable" })),
      );
      yield* pair(hub, laptop);
      yield* addProject(hub, "/hub/racing");
      yield* addProject(laptop, "/laptop/racing");
      const fs = yield* laptop.run(FileSystem.FileSystem);
      const root = yield* fs.makeTempDirectoryScoped();
      const event = workThread(yield* DateTime.now);
      yield* laptop.sink.write({
        events: [
          event.type === "thread.created"
            ? { ...event, payload: { ...event.payload, worktreePath: root } }
            : event,
        ],
      });
      for (const dryRun of [true, false]) {
        const result = yield* laptop.transfer.move({
          threadIds: [threadId],
          target: hub.environmentId,
          dryRun,
        });
        expect(result.skipped[0]?.reason).toBe("local-changes");
        expect(yield* laptop.replication.owner(threadId)).toBeUndefined();
      }
      expect(
        (yield* laptop.transfer.move({
          threadIds: [threadId],
          target: hub.environmentId,
          dryRun: true,
          leaveLocalChanges: true,
        })).planned?.length,
      ).toBe(1);
    }).pipe(Effect.scoped),
  30000,
);

it.live(
  "a definite spoke refusal releases the hub's handoff reservation for a different target",
  () =>
    Effect.gen(function* () {
      const { hub, laptop, at } = yield* start("refused-relay");
      const missing = yield* startThreadMachine("refused-missing", "computer");
      const ready = yield* startThreadMachine("refused-ready", "computer");
      yield* pair(hub, missing);
      yield* pair(hub, ready);
      yield* addProject(laptop, "/laptop/racing");
      yield* addProject(ready, "/ready/racing");
      yield* laptop.sink.write({ events: [threadCreated("event:relay-refused", at)] });
      expect(
        (yield* laptop.transfer.move({ threadIds: [threadId], target: missing.environmentId }))
          .skipped[0]?.reason,
      ).toBe("needs-repository");
      expect(
        (yield* laptop.transfer.move({ threadIds: [threadId], target: ready.environmentId })).moved,
      ).toEqual([threadId]);
      expect((yield* ready.replication.owner(threadId))?.local).toBe(true);
      expect((yield* laptop.replication.owner(threadId))?.local).toBe(false);
    }).pipe(Effect.scoped),
  30000,
);

it.live(
  "command receipts follow a move so a lost-response retry cannot duplicate a turn",
  () =>
    Effect.gen(function* () {
      const { hub, laptop, at } = yield* start("receipts");
      yield* addProject(hub, "/hub/racing");
      yield* addProject(laptop, "/laptop/racing");
      yield* laptop.sink.write({ events: [threadCreated("event:receipt-thread", at)] });
      const commandId = CommandId.make("command:lost-response");
      yield* laptop.sink.commitCommand({
        commandId,
        threadId,
        commandType: "message.dispatch",
        acceptedAt: at,
        events: [userMessage("event:accepted-on-laptop", at, "once")],
        effects: [],
      });
      yield* laptop.sync.sync(hub.environmentId);
      expect(
        (yield* hub.sql`SELECT command_id FROM orchestration_command_receipts WHERE command_id = ${commandId}`)
          .length,
      ).toBe(1);
      expect(
        (yield* laptop.transfer.move({ threadIds: [threadId], target: hub.environmentId })).moved,
      ).toEqual([threadId]);
      const retry = yield* hub.sink.commitCommand({
        commandId,
        threadId,
        commandType: "message.dispatch",
        acceptedAt: at,
        events: [userMessage("event:duplicate-on-hub", at, "twice")],
        effects: [],
      });
      expect(retry.committed).toBe(false);
      expect(
        (yield* hub.projections.getThreadProjection(threadId)).messages.map((x) => x.text),
      ).toEqual(["once"]);
    }).pipe(Effect.scoped),
  30000,
);

it.live(
  "a late reply from an earlier move cannot release or finish a newer fence",
  () =>
    Effect.gen(function* () {
      const { hub, laptop, at } = yield* start("late-fence");
      const next = yield* startThreadMachine("late-fence-next", "computer");
      yield* pair(hub, next);
      yield* laptop.sink.write({ events: [threadCreated("event:fence-generation", at)] });
      const first = yield* laptop.replication.fence(threadId, hub.environmentId);
      yield* laptop.replication.release(threadId, hub.environmentId, first.epoch);
      yield* laptop.replication.fence(threadId, next.environmentId);
      const current = yield* laptop.replication.owner(threadId);
      yield* laptop.replication.release(threadId, hub.environmentId, first.epoch);
      yield* laptop.replication.finish(threadId, hub.environmentId, first.epoch);
      expect(yield* laptop.replication.owner(threadId)).toEqual(current);
      expect((yield* laptop.replication.owner(threadId))?.handoff).not.toBeNull();
    }).pipe(Effect.scoped),
  30000,
);

it.live(
  "a finished root turn with provider background work is not a safe transfer boundary",
  () =>
    Effect.gen(function* () {
      const { laptop, at } = yield* start("background-boundary");
      yield* laptop.sink.write({ events: [threadCreated("event:background-thread", at)] });
      yield* laptop.sql`INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id, thread_id, provider, provider_instance_id, status, updated_at, payload_json)
      VALUES ('provider-thread:background', ${threadId}, 'codex', 'codex', 'idle', ${DateTime.formatIso(at)},
        '{"pendingBackgroundTasks":[{"taskId":"command:background","kind":"command"}]}')`;
      expect((yield* Effect.flip(laptop.replication.preflight(threadId))).reason).toBe("busy");
      yield* laptop.sql`DELETE FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = 'provider-thread:background'`;
      yield* laptop.replication.preflight(threadId);
    }).pipe(Effect.scoped),
  30000,
);
