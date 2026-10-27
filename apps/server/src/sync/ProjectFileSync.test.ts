import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectLabelId } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Machines from "../machines/Machines.ts";
import { pair, startMachine } from "../machines/testkit.ts";
import * as ProjectFiles from "../projectLabels/ProjectFiles.ts";
import * as ProjectLabelFolders from "../projectLabels/ProjectLabelFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectFileSync from "./ProjectFileSync.ts";
import { conflictName } from "./ProjectFileSync.ts";
import * as SharedState from "./SharedState.ts";
import * as SharedSync from "./SharedSync.ts";

const label = { id: ProjectLabelId.make("label:files"), name: "Files Project" };

const start = Effect.fn("startFileSyncMachine")(function* (
  name: string,
  role: "computer" | "cloud-server",
) {
  const machine = yield* startMachine(name, role);
  const stateContext = yield* machine.run(Layer.build(SharedState.layer));
  const state = yield* SharedState.SharedState.pipe(Effect.provideContext(stateContext));
  const quietState = Layer.succeed(SharedState.SharedState, { ...state, changes: Stream.never });
  const quietMachines = Layer.succeed(Machines.Machines, {
    ...machine.machines,
    subscribe: Stream.never,
  });
  // Explicit passes in tests: every exchange and reconcile is called by the test.
  const scheduler = Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void });
  const syncContext = yield* machine.run(
    Layer.build(
      SharedSync.layer.pipe(
        Layer.provide(quietState),
        Layer.provide(quietMachines),
        Layer.provide(scheduler),
      ),
    ),
  );
  const sync = yield* SharedSync.SharedSync.pipe(Effect.provideContext(syncContext));
  const filesContext = yield* machine.run(
    Layer.build(
      ProjectFiles.layer.pipe(
        Layer.provideMerge(ProjectLabelFolders.layer),
        Layer.provide(ServerSettings.layerTest({})),
      ),
    ),
  );
  const fileSyncContext = yield* machine.run(
    Layer.build(
      ProjectFileSync.layerWithoutWatch.pipe(
        Layer.provide(quietState),
        Layer.provide(quietMachines),
        Layer.provide(Layer.succeedContext(filesContext)),
      ),
    ),
  );
  const fileSync = yield* ProjectFileSync.ProjectFileSync.pipe(
    Effect.provideContext(fileSyncContext),
  );
  const sql = yield* machine.run(SqlClient.SqlClient);
  yield* sql`INSERT INTO project_labels(label_id, name, created_at, updated_at) VALUES (${label.id}, ${label.name}, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
  const folders = yield* ProjectLabelFolders.ProjectLabelFolders.pipe(
    Effect.provideContext(filesContext),
  );
  const { dir } = yield* folders.ensureForLabel(label);
  return { ...machine, name, state, sync, fileSync, dir };
});

type FileMachine = Effect.Success<ReturnType<typeof start>>;

/** Exchange documents both ways, then let each machine apply and capture. */
const settle = (hub: FileMachine, spoke: FileMachine) =>
  Effect.gen(function* () {
    for (let round = 0; round < 3; round++) {
      yield* spoke.fileSync.reconcileProject(label.id);
      yield* spoke.sync.sync(hub.environmentId);
      yield* hub.fileSync.reconcileProject(label.id);
      yield* hub.sync.sync(spoke.environmentId);
      yield* spoke.fileSync.reconcileProject(label.id);
    }
  });

const read = (machine: FileMachine, relative: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs
      .readFileString(path.join(machine.dir, relative))
      .pipe(Effect.orElseSucceed(() => null));
  });

const write = (machine: FileMachine, relative: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const full = path.join(machine.dir, relative);
    yield* fs.makeDirectory(path.dirname(full), { recursive: true });
    yield* fs.writeFileString(full, text);
  });

describe("project files across paired machines", () => {
  it("names a losing version after the machine it came from", () => {
    expect(conflictName("brief.pdf", "MacBook", 1)).toBe("brief (conflict from MacBook).pdf");
    expect(conflictName("notes", "Hub", 2)).toBe("notes (conflict from Hub 2)");
  });

  it.live(
    "adds, edits, renames and deletes files and folders on both machines",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const hub = yield* start("files-hub", "cloud-server");
        const spoke = yield* start("files-spoke", "computer");
        yield* write(spoke, "Resources/brief.md", "# Brief\n");
        yield* pair(hub, spoke);
        yield* settle(hub, spoke);
        expect(yield* read(hub, "Resources/brief.md")).toBe("# Brief\n");

        // Content larger than one blob chunk arrives whole.
        const large = new Uint8Array(2.5 * 1024 * 1024).map((_, index) => index % 251);
        yield* fs.writeFile(path.join(spoke.dir, "Resources/scan.bin"), large);
        yield* settle(hub, spoke);
        const arrived = yield* fs.readFile(path.join(hub.dir, "Resources/scan.bin"));
        expect(Buffer.from(arrived).equals(Buffer.from(large))).toBe(true);
        yield* fs.remove(path.join(spoke.dir, "Resources/scan.bin"));

        // An edit on the hub fast-forwards the spoke: no conflict copy.
        yield* write(hub, "Resources/brief.md", "# Brief v2\n");
        yield* settle(hub, spoke);
        expect(yield* read(spoke, "Resources/brief.md")).toBe("# Brief v2\n");
        expect(yield* fs.readDirectory(path.join(spoke.dir, "Resources"))).toEqual(["brief.md"]);

        // A rename is a delete and an add of the same content.
        yield* fs.rename(
          path.join(spoke.dir, "Resources/brief.md"),
          path.join(spoke.dir, "Resources/plan.md"),
        );
        yield* settle(hub, spoke);
        expect(yield* read(hub, "Resources/plan.md")).toBe("# Brief v2\n");
        expect(yield* read(hub, "Resources/brief.md")).toBeNull();

        // Nested folders arrive with their files and leave with them.
        yield* write(spoke, "Research/2026/notes.txt", "deep\n");
        yield* fs.makeDirectory(path.join(spoke.dir, "Research/empty"), { recursive: true });
        yield* settle(hub, spoke);
        expect(yield* read(hub, "Research/2026/notes.txt")).toBe("deep\n");
        expect(yield* fs.exists(path.join(hub.dir, "Research/empty"))).toBe(true);
        yield* fs.remove(path.join(hub.dir, "Research"), { recursive: true });
        yield* settle(hub, spoke);
        expect(yield* fs.exists(path.join(spoke.dir, "Research"))).toBe(false);
        // A deleted path can be made again.
        yield* write(hub, "Research/again.txt", "back\n");
        yield* settle(hub, spoke);
        expect(yield* read(spoke, "Research/again.txt")).toBe("back\n");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    30000,
  );

  it.live(
    "concurrent edits keep the losing version as a conflict copy on both machines",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const hub = yield* start("conflict-hub", "cloud-server");
        const spoke = yield* start("conflict-spoke", "computer");
        yield* pair(hub, spoke);
        yield* write(spoke, "Resources/plan.md", "base\n");
        yield* settle(hub, spoke);
        // Both edit before either hears of the other.
        yield* write(hub, "Resources/plan.md", "hub edit\n");
        yield* write(spoke, "Resources/plan.md", "spoke edit\n");
        yield* hub.fileSync.reconcileProject(label.id);
        yield* spoke.fileSync.reconcileProject(label.id);
        yield* settle(hub, spoke);
        const winner = yield* read(hub, "Resources/plan.md");
        expect(yield* read(spoke, "Resources/plan.md")).toBe(winner);
        const loser = winner === "hub edit\n" ? spoke : hub;
        const copy = `Resources/plan (conflict from ${loser.name}).md`;
        const lost = winner === "hub edit\n" ? "spoke edit\n" : "hub edit\n";
        expect(yield* read(hub, copy)).toBe(lost);
        expect(yield* read(spoke, copy)).toBe(lost);
        expect((yield* fs.readDirectory(path.join(hub.dir, "Resources"))).sort()).toEqual(
          (yield* fs.readDirectory(path.join(spoke.dir, "Resources"))).sort(),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    30000,
  );

  it.live(
    "a standalone machine publishes nothing",
    () =>
      Effect.gen(function* () {
        const lone = yield* start("files-lone", "computer");
        yield* write(lone, "Resources/solo.md", "solo\n");
        yield* lone.fileSync.reconcileProject(label.id);
        const sql = yield* lone.run(SqlClient.SqlClient);
        expect(yield* sql`SELECT id FROM shared_documents WHERE kind = 'project-file'`).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    30000,
  );
});
