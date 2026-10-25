// @effect-diagnostics nodeBuiltinImport:off - regression tests use real git in isolated temporary folders.
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProjectLabelId,
  ThreadId,
  type SharedChangeBatch,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as Identity from "../environment/ServerEnvironment.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as Shared from "../sync/SharedState.ts";
import { resolveProjectLabelId } from "../sync/ProjectMergeProjection.ts";
import * as Folders from "./ProjectLabelFolders.ts";
import * as Labels from "./ProjectLabelService.ts";

const git = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();

const at = "2026-01-01T00:00:00.000Z";
const repoA = ProjectId.make("repo-a");
const repoB = ProjectId.make("repo-b");
const makeLayer = (name: string) => {
  const database = Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer));
  const infrastructure = Layer.mergeAll(Events.layer, Folders.layer, Shared.layer).pipe(
    Layer.provideMerge(database),
    Layer.provideMerge(ServerConfig.layerTest("/tmp", { prefix: `project-merge-${name}` })),
    Layer.provideMerge(Settings.layerTest()),
    Layer.provide(
      Layer.succeed(Identity.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make(name)),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return Labels.layer.pipe(
    Layer.provideMerge(infrastructure),
    Layer.provide(
      Layer.succeed(Identity.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make(name)),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
};
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const repo of [repoA, repoB])
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${repo},${repo},${`/repos/${repo}`},'[]',${at},${at})`;
  for (const thread of ["filed", "home", "target-home", "replica"])
    yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${thread},${repoA},${thread},'codex','full-access','default',${at},${at},'{}')`;
  yield* sql`INSERT INTO thread_owners(thread_id,owner_env,local,epoch,updated_at) VALUES ('replica','other-machine',0,3,${at})`;
});

describe("project merge", () => {
  it.effect("adopts the source project chat and keeps identical instructions once", () =>
    Effect.gen(function* () {
      yield* seed;
      const labels = yield* Labels.ProjectLabelService;
      const source = (yield* labels.create({
        name: "Source",
        instructions: "Same guidance",
        description: "Source description",
      })).label;
      const target = (yield* labels.create({
        name: "Target",
        instructions: "Same guidance",
        description: "Target description",
      })).label;
      yield* labels.setProjectChat({ id: source.id, threadId: ThreadId.make("home") });
      const merged = (yield* labels.merge({ sourceId: source.id, targetId: target.id })).label;
      expect(merged.projectChatThreadId).toBe("home");
      expect(merged.instructions).toBe("Same guidance");
      expect(merged.description).toBe("Target description");
    }).pipe(Effect.provide(makeLayer("adopt-chat"))),
  );

  it.effect("refuses instructions overflow without losing either project's guidance", () =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      const source = (yield* labels.create({ name: "Source", instructions: "a".repeat(12000) }))
        .label;
      const target = (yield* labels.create({ name: "Target", instructions: "b".repeat(12000) }))
        .label;
      expect(
        (yield* labels.merge({ sourceId: source.id, targetId: target.id }).pipe(Effect.flip))
          .reason,
      ).toBe("instructions_too_long");
      expect((yield* labels.read(source.id)).label.instructions).toBe(source.instructions);
      expect((yield* labels.read(target.id)).label.instructions).toBe(target.instructions);
    }).pipe(Effect.provide(makeLayer("instructions-limit"))),
  );

  it.effect("keeps non-owner schedule renames authorized after re-filing by a merge", () =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      const shared = yield* Shared.SharedState;
      const sql = yield* SqlClient.SqlClient;
      const source = (yield* labels.create({ name: "Source" })).label;
      const target = (yield* labels.create({ name: "Target" })).label;
      const peer = EnvironmentId.make("schedule-owner");
      const fields = {
        agentId: null,
        title: "Owned elsewhere",
        prompt: "Do work",
        enabled: false,
        schedule: { type: "interval", everyMs: 60000 },
        projectFolderId: source.id,
        repositoryRemote: null,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        ownerMachine: peer,
        machine: null,
        createdAt: at,
      };
      yield* shared.receive(
        {
          after: 0,
          cursor: 1,
          changes: [
            {
              kind: "schedule",
              id: "task:replica",
              fields,
              clocks: Object.fromEntries(
                Object.keys(fields).map((key) => [key, { wall: 1, logical: 0, node: peer }]),
              ),
              tombstone: null,
              updatedBy: peer,
            },
          ],
        },
        peer,
        false,
      );
      yield* labels.merge({ sourceId: source.id, targetId: target.id });
      yield* sql`UPDATE scheduled_tasks SET title='Renamed here' WHERE task_id='task:replica'`;
      yield* shared.capture("schedule", "task:replica");
      expect((yield* shared.get("schedule", "task:replica"))?.fields.title).toBe("Renamed here");
      expect((yield* shared.get("schedule", "task:replica"))?.fields.projectFolderId).toBe(
        source.id,
      );
      expect(
        (yield* sql`SELECT project_folder_id FROM scheduled_tasks WHERE task_id='task:replica'`)[0]
          ?.project_folder_id,
      ).toBe(target.id);
    }).pipe(Effect.provide(makeLayer("schedule-ownership"))),
  );

  it.effect("moves all local filing and portable configuration, retaining both project chats", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const labels = yield* Labels.ProjectLabelService;
      const shared = yield* Shared.SharedState;
      const source = (yield* labels.create({
        name: "Source",
        instructions: "Source guidance",
        description: "Source description",
      })).label;
      const target = (yield* labels.create({ name: "Target", instructions: "Target guidance" }))
        .label;
      yield* labels.linkRepository({
        labelId: source.id,
        repositoryId: repoA,
        remote: "https://github.com/me/a.git",
      });
      yield* labels.linkRepository({
        labelId: target.id,
        repositoryId: repoB,
        remote: "https://github.com/me/b.git",
      });
      yield* labels.linkSource({
        id: source.id,
        link: { kind: "github-owner", owner: "source-owner" },
      });
      yield* labels.moveThread({ threadId: ThreadId.make("filed"), folderId: source.id });
      yield* labels.moveThread({ threadId: ThreadId.make("replica"), folderId: source.id });
      yield* labels.setProjectChat({ id: source.id, threadId: ThreadId.make("home") });
      yield* labels.setProjectChat({ id: target.id, threadId: ThreadId.make("target-home") });
      yield* sql`INSERT INTO agents(agent_id,conversation_thread_id,payload_json,enabled) VALUES ('agent:merge','filed',${JSON.stringify({ projectFolderId: source.id })},1)`;
      yield* sql`INSERT INTO scheduled_tasks(task_id,title,prompt,enabled,schedule_json,project_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,next_run_at,last_run_status,run_count,project_folder_id) VALUES ('schedule:merge','Task','Prompt',0,'{}',${repoA},'{"type":"root"}','{}','full-access','default','user','web',${at},${at},NULL,'never',0,${source.id})`;
      for (const table of ["facts", "commitments"] as const) {
        const payload = JSON.stringify({ labelIds: [source.id, target.id] });
        if (table === "facts") {
          yield* sql`INSERT INTO facts(id,status,payload_json,updated_at) VALUES ('fact:merge','confirmed',${payload},${at})`;
          yield* sql`INSERT INTO fact_labels(fact_id,label_id) VALUES ('fact:merge',${source.id})`;
        } else {
          yield* sql`INSERT INTO commitments(id,status,payload_json,created_at,updated_at) VALUES ('commitment:merge','open',${payload},${at},${at})`;
          yield* sql`INSERT INTO commitment_labels(commitment_id,label_id) VALUES ('commitment:merge',${source.id})`;
        }
      }
      yield* shared.write("project-settings", source.id, {
        defaultRuntimeMode: { value: "approval-required" },
        enableAgentBrowserAccess: { value: false },
      });
      yield* shared.write("project-settings", target.id, {
        defaultRuntimeMode: { value: "full-access" },
      });
      const merged = (yield* labels.merge({ sourceId: source.id, targetId: target.id })).label;
      expect(
        (yield* labels.merge({ sourceId: source.id, targetId: target.id })).label.instructions,
      ).toBe(merged.instructions);
      expect(merged.instructions).toBe(
        "Target guidance\n\n--- Instructions from Source ---\n\nSource guidance",
      );
      expect(merged.description).toBe("Source description");
      expect(merged.repositoryIds).toEqual([repoA, repoB]);
      expect(merged.sourceLinks).toContainEqual({ kind: "github-owner", owner: "source-owner" });
      expect(merged.projectChatThreadId).toBe("target-home");
      expect((yield* labels.list()).labels.map((label) => label.id)).toEqual([target.id]);
      expect(
        yield* sql`SELECT thread_id FROM thread_project_labels WHERE label_id=${target.id} ORDER BY thread_id`,
      ).toEqual([{ thread_id: "filed" }, { thread_id: "home" }, { thread_id: "replica" }]);
      expect(
        (yield* sql`SELECT owner_env,epoch FROM thread_owners WHERE thread_id='replica'`)[0],
      ).toEqual({ owner_env: "other-machine", epoch: 3 });
      expect(
        (yield* sql`SELECT json_extract(payload_json,'$.projectFolderId') AS folder FROM agents`)[0]
          ?.folder,
      ).toBe(target.id);
      expect(
        (yield* sql`SELECT project_folder_id FROM scheduled_tasks`)[0]?.project_folder_id,
      ).toBe(target.id);
      for (const table of ["facts", "commitments"] as const) {
        const rows = yield* sql<{ payload_json: string }>`SELECT payload_json FROM ${sql(table)}`;
        expect(JSON.parse(rows[0]!.payload_json).labelIds).toEqual([target.id]);
      }
      const tombstone = yield* shared.get("project", source.id);
      expect(tombstone?.tombstone).not.toBeNull();
      expect(tombstone?.fields.mergedInto).toBe(target.id);
      expect((yield* shared.get("project", target.id))?.fields.repositories).toHaveLength(2);
      expect((yield* shared.get("project-settings", target.id))?.fields.defaultRuntimeMode).toEqual(
        { value: "full-access" },
      );
      expect(yield* sql`SELECT * FROM orchestration_v2_events`).toHaveLength(0);
    }).pipe(Effect.provide(makeLayer("local"))),
  );

  it.effect(
    "exposes local creates and renames as duplicates, syncs dismissal, and omits deleted pairs",
    () =>
      Effect.gen(function* () {
        const labels = yield* Labels.ProjectLabelService;
        const shared = yield* Shared.SharedState;
        const first = (yield* labels.create({ name: "Same" })).label;
        const second = (yield* labels.create({ name: " same " })).label;
        expect((yield* labels.read(first.id)).label.possibleDuplicateIds).toEqual([second.id]);
        expect((yield* labels.read(second.id)).label.possibleDuplicateIds).toEqual([first.id]);
        yield* labels.dismissDuplicate({ id: second.id, otherId: first.id });
        expect((yield* labels.read(first.id)).label.possibleDuplicateIds).toEqual([]);
        expect((yield* labels.read(second.id)).label.possibleDuplicateIds).toEqual([]);
        expect(
          (yield* shared.get("project", [first.id, second.id].sort()[0]!))?.fields
            .dismissedDuplicateIds,
        ).toHaveLength(1);
        const third = (yield* labels.create({ name: "Different" })).label;
        yield* labels.update({ id: third.id, name: "SAME" });
        expect((yield* labels.read(first.id)).label.possibleDuplicateIds).toEqual([third.id]);
        yield* labels.delete(third.id);
        expect((yield* labels.read(first.id)).label.possibleDuplicateIds).toEqual([]);
        expect(
          (yield* labels.merge({ sourceId: first.id, targetId: first.id }).pipe(Effect.flip))
            .reason,
        ).toBe("same_project");
      }).pipe(Effect.provide(makeLayer("duplicates"))),
  );

  it.effect.each(
    ["repos/platform", "platform", ".worktrees", "worktrees"].flatMap((layout) =>
      [false, true].map((gitFile) => ({ layout, gitFile })),
    ),
  )("keeps colliding $layout checkouts atomic (.git file: $gitFile)", ({ layout, gitFile }) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      const folders = yield* Folders.ProjectLabelFolders;
      const fs = yield* FileSystem.FileSystem;
      const source = (yield* labels.create({ name: "Source" })).label;
      const target = (yield* labels.create({ name: "Target" })).label;
      const from = (yield* folders.dirForLabel(source)).dir;
      const to = (yield* folders.dirForLabel(target)).dir;
      const seed = yield* fs.makeTempDirectoryScoped();
      git(seed, ["init", "--initial-branch=main"]);
      git(seed, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "init",
      ]);
      for (const [root, branch] of [
        [from, "source"],
        [to, "target"],
      ]) {
        const checkout = `${root}/${layout}`;
        yield* fs.makeDirectory(checkout, { recursive: true });
        if (gitFile) git(seed, ["worktree", "add", checkout, "-b", branch!]);
        else {
          git(checkout, ["init", `--initial-branch=${branch}`]);
          git(checkout, [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-m",
            branch!,
          ]);
        }
        yield* fs.writeFileString(`${checkout}/${branch}.txt`, branch!);
      }
      yield* labels.merge({ sourceId: source.id, targetId: target.id });
      const moved = `${to}/${layout} (2)`;
      expect(yield* fs.readFileString(`${moved}/source.txt`)).toBe("source");
      expect(yield* fs.exists(`${to}/${layout}/source.txt`)).toBe(false);
      expect(git(`${to}/${layout}`, ["branch", "--show-current"])).toBe("target");
      expect(git(moved, ["branch", "--show-current"])).toBe("source");
    }).pipe(Effect.provide(makeLayer(`atomic-${layout.replaceAll("/", "-")}-${gitFile}`))),
  );

  it.effect(
    "moves files without overwriting conflicts, preserves checkout paths, and resumes after a crash",
    () =>
      Effect.gen(function* () {
        const labels = yield* Labels.ProjectLabelService;
        const folders = yield* Folders.ProjectLabelFolders;
        const fs = yield* FileSystem.FileSystem;
        const sql = yield* SqlClient.SqlClient;
        const source = (yield* labels.create({ name: "Source" })).label;
        const target = (yield* labels.create({ name: "Target" })).label;
        const from = (yield* folders.dirForLabel(source)).dir;
        const to = (yield* folders.dirForLabel(target)).dir;
        yield* fs.writeFileString(`${from}/Resources/note.md`, "source");
        yield* fs.writeFileString(`${to}/Resources/note.md`, "target");
        yield* fs.makeDirectory(`${from}/repos/a`, { recursive: true });
        yield* fs.writeFileString(`${from}/repos/a/README.md`, "checkout");
        yield* labels.merge({ sourceId: source.id, targetId: target.id });
        expect(yield* fs.readFileString(`${to}/Resources/note.md`)).toBe("target");
        expect(yield* fs.readFileString(`${to}/Resources/note (2).md`)).toBe("source");
        expect(yield* fs.readFileString(`${from}/Resources/note.md`)).toBe("source");
        expect(yield* fs.readFileString(`${to}/repos/a/README.md`)).toBe("checkout");
        expect(yield* fs.readFileString(`${from}/repos/a/README.md`)).toBe("checkout");
        // Simulate process death after a directory rename, before its forwarding link.
        yield* fs.makeDirectory(`${to}/resumed`);
        yield* fs.writeFileString(`${to}/resumed/data`, "saved");
        yield* sql`INSERT INTO project_merge_file_moves(source,target,directory) VALUES (${`${from}/resumed`},${`${to}/resumed`},1)`;
        yield* folders.reconcileMerges;
        yield* folders.reconcileMerges;
        expect(yield* fs.readFileString(`${from}/resumed/data`)).toBe("saved");
        expect((yield* fs.readDirectory(`${to}/Resources`)).sort()).toEqual([
          "note (2).md",
          "note.md",
        ]);
      }).pipe(Effect.provide(makeLayer("files"))),
  );

  it.effect("defers missing targets and redirects facts and filing that arrive after a merge", () =>
    Effect.gen(function* () {
      yield* seed;
      const labels = yield* Labels.ProjectLabelService;
      const shared = yield* Shared.SharedState;
      const sql = yield* SqlClient.SqlClient;
      const source = (yield* labels.create({ name: "Source" })).label;
      const targetId = ProjectLabelId.make("label:late-target");
      yield* sql`INSERT INTO thread_project_labels(thread_id,label_id) VALUES ('replica',${source.id})`;
      yield* shared.write(
        "project",
        source.id,
        { mergedInto: targetId, mergeSourceName: source.name },
        true,
      );
      expect((yield* labels.list()).labels).toEqual([]);
      yield* shared.write("fact", "fact:late", {
        factId: "fact:late",
        subject: "Preference",
        predicate: null,
        text: "Keep this",
        labelIds: [source.id],
        visibility: "labels",
        agentId: null,
        sourceRefs: [],
        validFrom: null,
        supersedes: null,
        createdBy: "user",
        createdAt: at,
        legacyNoteId: null,
        legacySource: null,
        confirmedAt: at,
        supersededBy: null,
        retractedAt: null,
      });
      yield* shared.write("project", targetId, {
        name: "Target",
        color: null,
        description: null,
        instructions: "",
        archivedAt: null,
        repositories: [],
        sourceLinks: [],
        createdAt: at,
      });
      expect(
        (yield* sql`SELECT label_id FROM thread_project_labels WHERE thread_id='replica'`)[0]
          ?.label_id,
      ).toBe(targetId);
      expect(
        (yield* sql`SELECT label_id FROM fact_labels WHERE fact_id='fact:late'`)[0]?.label_id,
      ).toBe(targetId);
      yield* shared.write("fact", "fact:late", { confirmedAt: null });
      expect(
        (yield* sql`SELECT label_id FROM fact_labels WHERE fact_id='fact:late'`)[0]?.label_id,
      ).toBe(targetId);
      expect(yield* resolveProjectLabelId(source.id)).toBe(targetId);
    }).pipe(Effect.provide(makeLayer("late"))),
  );

  it.effect("a second machine applies the merge and dismissal to its own replicas and files", () =>
    Effect.gen(function* () {
      const firstContext = yield* Layer.build(makeLayer("machine-one"));
      const secondContext = yield* Layer.build(makeLayer("machine-two"));
      const one = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.provideContext(effect, firstContext);
      const two = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.provideContext(effect, secondContext);
      const sourceState = yield* one(Shared.SharedState);
      const peerState = yield* two(Shared.SharedState);
      const labels = yield* one(Labels.ProjectLabelService);
      const peerLabels = yield* two(Labels.ProjectLabelService);
      const source = (yield* labels.create({ name: "Same" })).label;
      const target = (yield* labels.create({ name: "Same" })).label;
      let cursor = 0;
      const sync = Effect.gen(function* () {
        const batch: SharedChangeBatch = yield* sourceState.readBatch(
          cursor,
          peerState.environmentId,
          true,
        );
        yield* peerState.receive(batch, sourceState.environmentId, false);
        cursor = batch.cursor;
      });
      yield* sync;
      expect((yield* peerLabels.read(source.id)).label.possibleDuplicateIds).toEqual([target.id]);
      yield* labels.dismissDuplicate({ id: source.id, otherId: target.id });
      yield* sync;
      expect((yield* peerLabels.read(source.id)).label.possibleDuplicateIds).toEqual([]);
      yield* two(seed);
      const peerSql = yield* two(SqlClient.SqlClient);
      yield* peerSql`INSERT INTO thread_project_labels(thread_id,label_id) VALUES ('replica',${source.id})`;
      const peerFolders = yield* two(Folders.ProjectLabelFolders);
      const peerFs = yield* two(FileSystem.FileSystem);
      const peerFrom = (yield* peerFolders.ensureForLabel(source)).dir;
      const peerTo = (yield* peerFolders.ensureForLabel(target)).dir;
      yield* peerFs.writeFileString(`${peerFrom}/Resources/peer.md`, "machine-local");
      yield* labels.merge({ sourceId: source.id, targetId: target.id });
      yield* sync;
      yield* peerFolders.reconcileMerges;
      expect((yield* peerLabels.list()).labels.map((label) => label.id)).toEqual([target.id]);
      expect(
        (yield* peerSql`SELECT label_id FROM thread_project_labels WHERE thread_id='replica'`)[0]
          ?.label_id,
      ).toBe(target.id);
      expect(
        (yield* peerSql`SELECT owner_env FROM thread_owners WHERE thread_id='replica'`)[0]
          ?.owner_env,
      ).toBe("other-machine");
      expect(yield* peerFs.readFileString(`${peerTo}/Resources/peer.md`)).toBe("machine-local");
      expect(yield* two(resolveProjectLabelId(source.id))).toBe(target.id);
    }),
  );
});
