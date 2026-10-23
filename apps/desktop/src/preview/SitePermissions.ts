import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { SitePermissionsController } from "./SitePermissionsController.ts";
import { SitePermissionStore } from "./SitePermissionStore.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Incognito partitions (no `persist:` prefix) forget their decisions with the process. */
const isPersistentPartition = (partition: string) => partition.startsWith("persist:");

/**
 * The preview browser's remembered site permissions and pending prompts, shared
 * by the session's permission handlers, the toolbar's IPC, and the server's
 * agent channel so all of them read and change one state.
 */
export class SitePermissions extends Context.Service<
  SitePermissions,
  { readonly controller: SitePermissionsController }
>()("@t3tools/desktop/preview/SitePermissions") {}

export const make = Effect.gen(function* SitePermissionsMake() {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const filePath = path.join(environment.stateDir, "browser-site-permissions.json");

  const saved: unknown = yield* fileSystem.readFileString(filePath).pipe(
    Effect.flatMap(decodeJson),
    // A missing or unreadable file starts with nothing decided, which asks again.
    Effect.orElseSucceed((): unknown => null),
  );

  // Saves coalesce: a burst of decisions writes the latest state once more at most.
  let writing = false;
  let dirty = false;
  const save = (): void => {
    if (writing) {
      dirty = true;
      return;
    }
    writing = true;
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    runFork(
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fileSystem.writeFileString(temporaryPath, yield* encodeJson(store.snapshot()));
        yield* fileSystem.rename(temporaryPath, filePath);
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not save browser site permissions.", { cause }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            writing = false;
            if (!dirty) return;
            dirty = false;
            save();
          }),
        ),
      ),
    );
  };

  const store = new SitePermissionStore(saved, {
    isPersistent: isPersistentPartition,
    onChange: save,
  });
  let promptCount = 0;
  const controller = new SitePermissionsController(store, () => `permission-${(promptCount += 1)}`);
  return SitePermissions.of({ controller });
}).pipe(Effect.withSpan("SitePermissions.make"));

export const layer = Layer.effect(SitePermissions, make);
