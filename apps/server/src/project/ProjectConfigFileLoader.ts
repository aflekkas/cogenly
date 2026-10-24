/**
 * ProjectConfigFileLoader - Effect service that loads the checked-in
 * `cogenly.json` project file from a workspace root, or the legacy `t3.json`
 * when a repository has no `cogenly.json`.
 *
 * Loading is best-effort: a missing file resolves to `Option.none`, and
 * unreadable or invalid files are logged and treated as absent so callers
 * can fall back to their defaults. An invalid `cogenly.json` still wins over
 * a `t3.json` beside it.
 *
 * @module ProjectConfigFileLoader
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { PROJECT_CONFIG_FILE_NAMES, type T3ProjectFile } from "@cogenly/contracts";
import { T3ProjectFileFromJson } from "@cogenly/shared/t3ProjectFile";

const decodeProjectConfigFileJson = Schema.decodeEffect(T3ProjectFileFromJson);

export class ProjectConfigFileLoadError extends Schema.TaggedError<ProjectConfigFileLoadError>()(
  "ProjectConfigFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} the project config file at ${this.filePath}.`;
  }
}

/** Service tag for project config file loading. */
export class ProjectConfigFileLoader extends Context.Service<
  ProjectConfigFileLoader,
  {
    /**
     * Load and decode `cogenly.json` (or the legacy `t3.json`) at the workspace root.
     *
     * Never fails: missing, unreadable, or invalid files resolve to
     * `Option.none` (invalid files are logged as warnings).
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<T3ProjectFile>>;
  }
>()("cogenly-server/project/ProjectConfigFileLoader") {}

const logProjectConfigFileLoadError = (error: ProjectConfigFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  /** The first config file present: its path and contents, or none when neither exists. */
  const readFirstPresent = Effect.fn("ProjectConfigFileLoader.readFirstPresent")(function* (
    workspaceRoot: string,
  ) {
    for (const fileName of PROJECT_CONFIG_FILE_NAMES) {
      const filePath = path.join(workspaceRoot, fileName);
      const raw = yield* fileSystem.readFileString(filePath).pipe(
        Effect.map((contents) => Option.some({ filePath, contents: Option.some(contents) })),
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(Option.none<{ filePath: string; contents: Option.Option<string> }>())
              : logProjectConfigFileLoadError(
                  new ProjectConfigFileLoadError({
                    operation: "read",
                    workspaceRoot,
                    filePath,
                    cause: error,
                  }),
                ).pipe(Effect.as(Option.some({ filePath, contents: Option.none<string>() }))),
        }),
      );
      if (Option.isSome(raw)) return raw;
    }
    return Option.none<{ filePath: string; contents: Option.Option<string> }>();
  });

  const load: ProjectConfigFileLoader["Service"]["load"] = Effect.fn(
    "ProjectConfigFileLoader.load",
  )(function* (workspaceRoot) {
    const found = yield* readFirstPresent(workspaceRoot);
    if (Option.isNone(found) || Option.isNone(found.value.contents)) {
      return Option.none<T3ProjectFile>();
    }
    const { filePath, contents } = found.value;
    return yield* decodeProjectConfigFileJson(contents.value).pipe(
      Effect.asSome,
      Effect.catchTags({
        SchemaError: (error) =>
          logProjectConfigFileLoadError(
            new ProjectConfigFileLoadError({
              operation: "decode",
              workspaceRoot,
              filePath,
              cause: error,
            }),
          ).pipe(Effect.as(Option.none<T3ProjectFile>())),
      }),
    );
  });

  return ProjectConfigFileLoader.of({ load });
});

export const layer = Layer.effect(ProjectConfigFileLoader, make);
