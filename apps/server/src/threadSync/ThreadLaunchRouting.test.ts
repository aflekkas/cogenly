import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectLabelId,
  ProviderInstanceId,
  ThreadId,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { resolveMachine } from "../machines/resolveMachine.ts";
import * as ServerConfig from "../config.ts";
import { awaitLinkState, pair, startProxy } from "../machines/testkit.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import type * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import { startThreadMachine, userMessage } from "./testkit.ts";

type ThreadMachine = Effect.Success<ReturnType<typeof startThreadMachine>>;

const scratchId = ProjectId.make("project:scratch");
const racingId = ProjectId.make("project:racing");
const remote = "github.com/aflekkas/athens-racing";
const at = "2026-10-24T00:00:00.000Z";

/** The machine's "No project", where ManagedProjectFolders keeps it. */
const addScratch = (machine: ThreadMachine) =>
  Effect.gen(function* () {
    const config = yield* machine.run(ServerConfig.ServerConfig);
    const path = yield* machine.run(Path.Path);
    yield* machine.sql`INSERT INTO projection_projects(project_id, title, workspace_root, auto_pull, scripts_json, created_at, updated_at)
      VALUES (${scratchId}, 'No project', ${path.resolve(config.baseDir, "scratch")}, 0, '[]', ${at}, ${at})`;
  });

/** The racing project, with this machine's checkout or, without one, only its remote. */
const addRacing = (machine: ThreadMachine, checkout: boolean) =>
  Effect.gen(function* () {
    yield* machine.sql`INSERT INTO project_labels(label_id, name, created_at, updated_at)
      VALUES ('label:racing', 'athens-racing', ${at}, ${at})`;
    if (!checkout) {
      yield* machine.sql`INSERT INTO label_repositories(label_id, repository_id, remote)
        VALUES ('label:racing', ${`remote:${remote}`}, ${remote})`;
      return;
    }
    yield* machine.sql`INSERT INTO projection_projects(project_id, title, workspace_root, auto_pull, scripts_json, created_at, updated_at)
      VALUES (${racingId}, 'Racing', '/Users/someone/racing', 0, '[]', ${at}, ${at})`;
    yield* machine.sql`INSERT INTO label_repositories(label_id, repository_id, remote)
      VALUES ('label:racing', ${racingId}, ${remote})`;
  });

const launch = (
  projectId: ProjectId,
  overrides: Partial<ThreadLaunch.ThreadLaunchInput> = {},
): ThreadLaunch.ThreadLaunchInput => ({
  commandId: CommandId.make("command:launch"),
  threadId: ThreadId.make("thread:launched"),
  projectId,
  title: "Brakes",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
  initialMessage: { text: "Fix the brakes", attachments: [] },
  createdBy: "user",
  creationSource: "web",
  ...overrides,
});

describe("launching a thread on another machine", () => {
  it.live(
    "the hub starts a thread the laptop owns from its first event, and sees it when the launch returns",
    () =>
      Effect.gen(function* () {
        const hub = yield* startThreadMachine("launch-hub", "cloud-server");
        const laptop = yield* startThreadMachine("launch-laptop", "computer");
        yield* pair(hub, laptop);
        yield* addScratch(hub);
        expect(yield* hub.run(resolveMachine("launch-laptop"))).toBe(laptop.environmentId);
        expect(yield* laptop.run(resolveMachine("this"))).toBe(laptop.environmentId);
        expect(yield* laptop.run(resolveMachine("auto"))).toBe(hub.environmentId);

        const launched = Option.getOrThrow(
          yield* hub.remoteLaunch.launch(laptop.environmentId, launch(scratchId)),
        );
        const thread = ThreadId.make("thread:launched");
        expect(launched.threadId).toBe(thread);
        expect(launched.resumed).toBe(false);
        // The hub's projection already holds the replica, owned by the laptop.
        expect(launched.projection.thread.ownerMachine).toBe(laptop.environmentId);
        expect(launched.projection.messages.map((message) => message.text)).toEqual([
          "Fix the brakes",
        ]);
        expect(yield* hub.replication.owner(thread)).toMatchObject({
          local: false,
          owner: laptop.environmentId,
          epoch: 0,
        });
        // The laptop created it, so it runs there; its first turn was asked of the laptop
        // in the laptop's own "No project".
        expect(yield* laptop.replication.owner(thread)).toBeUndefined();
        expect(hub.launched).toEqual([]);
        expect(
          laptop.launched.map((input) => [input.projectId, input.initialMessage?.text]),
        ).toEqual([["project:scratch", "Fix the brakes"]]);
        expect(laptop.launched[0]?.machine).toBeUndefined();
        const now = yield* DateTime.now;
        const refused = yield* Effect.flip(
          hub.sink.write({ events: [userMessage("event:hub-write", now, "x", thread)] }),
        );
        expect(refused.cause).toBeInstanceOf(EventSink.ThreadOwnedElsewhereError);

        // A retry of the same command returns the thread the first attempt made.
        const retried = Option.getOrThrow(
          yield* hub.remoteLaunch.launch(laptop.environmentId, launch(scratchId)),
        );
        expect(retried).toMatchObject({ threadId: thread, resumed: true });
        expect(
          (yield* hub.projections.getThreadProjection(thread)).messages.map((entry) => entry.text),
        ).toEqual(["Fix the brakes"]);

        // Naming this machine launches here.
        expect(
          Option.isNone(yield* hub.remoteLaunch.launch(hub.environmentId, launch(scratchId))),
        ).toBe(true);
      }).pipe(Effect.scoped),
    30000,
  );

  it.live(
    "one spoke launches on another through the hub, which clones the repository it lacks",
    () =>
      Effect.gen(function* () {
        const hub = yield* startThreadMachine("launch-relay-hub", "cloud-server");
        const laptop = yield* startThreadMachine("launch-relay-laptop", "computer");
        const mini = yield* startThreadMachine("launch-relay-mini", "computer");
        yield* pair(hub, laptop);
        yield* pair(hub, mini);
        yield* addRacing(laptop, true);
        yield* addRacing(mini, false);

        const launched = Option.getOrThrow(
          yield* laptop.remoteLaunch.launch(
            mini.environmentId,
            launch(racingId, {
              workspaceStrategy: { type: "worktree", baseRef: "main" },
              projectFolderId: ProjectLabelId.make("label:racing"),
            }),
          ),
        );
        expect(launched.projection.thread.ownerMachine).toBe(mini.environmentId);
        // The mini had only the remote: the launch started its clone and runs in it.
        expect(mini.checkouts).toEqual([{ labelId: "label:racing", remote }]);
        expect(mini.launched.map((input) => input.projectId)).toEqual([`project:clone:${remote}`]);
        expect(mini.launched[0]?.workspaceStrategy).toEqual({ type: "worktree", baseRef: "main" });
        // The hub relayed it and holds the replica too.
        expect(yield* hub.replication.owner(launched.threadId)).toMatchObject({
          local: false,
          owner: mini.environmentId,
        });
      }).pipe(Effect.scoped),
    30000,
  );

  it.live(
    "a launch the target cannot place is refused, and nothing is created on either side",
    () =>
      Effect.gen(function* () {
        const hub = yield* startThreadMachine("launch-refuse-hub", "cloud-server");
        const laptop = yield* startThreadMachine("launch-refuse-laptop", "computer");
        yield* pair(hub, laptop);
        yield* addRacing(laptop, true);

        // The hub has no project that links the laptop's repository.
        const missing = yield* Effect.flip(
          laptop.remoteLaunch.launch(hub.environmentId, launch(racingId)),
        );
        expect(missing.reason).toBe("needs-repository");
        expect(missing.message).toContain(remote);
        // A path on the laptop means nothing on the hub.
        const worktree = yield* Effect.flip(
          laptop.remoteLaunch.launch(
            hub.environmentId,
            launch(racingId, {
              workspaceStrategy: { type: "existing_worktree", worktreePath: "/Users/someone/wt" },
            }),
          ),
        );
        expect(worktree.reason).toBe("rejected");
        const unknown = yield* Effect.flip(
          laptop.remoteLaunch.launch(EnvironmentId.make("env:never-paired"), launch(racingId)),
        );
        expect(unknown.message).toBe("That machine is not paired with this one.");
        expect(hub.launched).toEqual([]);
        expect(laptop.launched).toEqual([]);
      }).pipe(Effect.scoped),
    30000,
  );

  it.live(
    "an offline target fails the launch at once with its name, and nothing is created",
    () =>
      Effect.gen(function* () {
        const hub = yield* startThreadMachine("launch-offline-hub", "cloud-server");
        const laptop = yield* startThreadMachine("launch-offline-laptop", "computer");
        const proxy = yield* startProxy(hub);
        yield* pair(hub, laptop, proxy.url);
        yield* addScratch(laptop);
        // The hub goes away for good: no socket reaches it any more.
        yield* Effect.sync(() => proxy.server.close());
        yield* proxy.dropAll;
        yield* awaitLinkState(laptop, (state) => state.status !== "online");

        const error = yield* Effect.flip(
          laptop.remoteLaunch.launch(hub.environmentId, launch(scratchId)),
        );
        expect(error.reason).toBe("offline");
        expect(error.message).toBe(
          "launch-offline-hub is offline. Launch on this machine instead, or try again when it reconnects.",
        );
        expect(hub.launched).toEqual([]);
        expect(laptop.launched).toEqual([]);
        expect(
          Option.isNone(
            yield* Effect.option(
              laptop.projections.getThreadProjection(ThreadId.make("thread:launched")),
            ),
          ),
        ).toBe(true);
      }).pipe(Effect.scoped),
    30000,
  );
});
