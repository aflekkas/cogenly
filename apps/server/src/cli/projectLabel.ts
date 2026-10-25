/**
 * `cogenly project label`: file repositories into projects from a terminal,
 * for people and agents. A label is what the app calls a project; a
 * repository is a folder Cogenly tracks (`cogenly project add`).
 *
 * Every subcommand is a thin transport over the `projectLabels.*` RPCs the
 * app uses, on the running server (see `liveServer.ts`), with a session
 * limited to `PROJECT_LABEL_CLI_SCOPES`; the server authorizes each call as
 * it does for a client. Labels need the running server: there is no offline
 * path. `--json` prints the result for scripts.
 *
 * @module cli/projectLabel
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  ProjectId,
  ProjectLabelColor,
  type ProjectLabelWithRepositories,
  type ProjectSnapshot,
  WS_METHODS,
  type WsRpcGroup,
} from "@cogenly/contracts";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import type { RpcClient, RpcClientError } from "effect/rpc";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { liveWebSocketUrl, liveWebSocketUrlSource, makeLiveRpcClient } from "./liveServer.ts";

/** Read projects and repositories, and change them: what the app's project editor needs. */
export const PROJECT_LABEL_CLI_SCOPES = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
] as const;

export class ProjectLabelCliError extends Schema.TaggedError<ProjectLabelCliError>()(
  "ProjectLabelCliError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.reason;
  }
}

const isProjectLabelColor = Schema.is(ProjectLabelColor);

type LabelRpcTag =
  | typeof WS_METHODS.projectLabelsList
  | typeof WS_METHODS.projectLabelsCreate
  | typeof WS_METHODS.projectLabelsUpdate
  | typeof WS_METHODS.projectLabelsDelete
  | typeof WS_METHODS.projectLabelsLinkRepository
  | typeof WS_METHODS.projectLabelsUnlinkRepository;

/** The calls these commands make; the live RPC client, or a test client, provides them. */
export type ProjectLabelRpcClient = Pick<
  RpcClient.FromGroup<typeof WsRpcGroup, RpcClientError.RpcClientError>,
  LabelRpcTag
>;

interface Repository {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface ProjectLabelCliContext {
  readonly client: ProjectLabelRpcClient;
  /** Active repositories, for resolving a path or id and naming them in output. */
  readonly repositories: Effect.Effect<ReadonlyArray<Repository>, ProjectLabelCliError>;
  /** Absolute, normalized form of a path argument; `null` when it isn't one. */
  readonly normalizePath: (path: string) => Effect.Effect<string | null>;
}

/** A refusal or failure from the server, worded for the terminal. */
const describe = (cause: unknown): ProjectLabelCliError => {
  const tagged =
    typeof cause === "object" && cause !== null && "_tag" in cause ? cause._tag : undefined;
  if (tagged === "EnvironmentAuthorizationError") {
    return new ProjectLabelCliError({
      reason: "This session isn't allowed to change projects on that Cogenly.",
      cause,
    });
  }
  if (tagged === "RpcClientError") {
    return new ProjectLabelCliError({ reason: "Lost the connection to Cogenly.", cause });
  }
  return new ProjectLabelCliError({
    reason: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
};

/** A label by id, else by name (any case). Ambiguous names list the ids to use instead. */
export function findLabel(
  labels: ReadonlyArray<ProjectLabelWithRepositories>,
  identifier: string,
): ProjectLabelWithRepositories | ProjectLabelCliError {
  const wanted = identifier.trim();
  const byId = labels.find((label) => label.id === wanted);
  if (byId !== undefined) return byId;
  const byName = labels.filter((label) => label.name.toLowerCase() === wanted.toLowerCase());
  if (byName.length === 1 && byName[0] !== undefined) return byName[0];
  if (byName.length > 1) {
    return new ProjectLabelCliError({
      reason: `More than one project is named "${wanted}": ${byName.map((label) => label.id).join(", ")}. Use its id.`,
    });
  }
  return new ProjectLabelCliError({
    reason: `No project matches "${wanted}". Run \`cogenly project label list\` to see them.`,
  });
}

/** A repository by id, else by folder. */
export function findRepository(
  repositories: ReadonlyArray<Repository>,
  identifier: string,
  normalizedPath: string | null,
): Repository | ProjectLabelCliError {
  const wanted = identifier.trim();
  const found =
    repositories.find((repository) => repository.id === wanted) ??
    repositories.find((repository) => repository.workspaceRoot === (normalizedPath ?? wanted));
  return (
    found ??
    new ProjectLabelCliError({
      reason: `No repository matches "${wanted}". Add the folder first with \`cogenly project add <path>\`.`,
    })
  );
}

const isProjectLabelCliError = Schema.is(ProjectLabelCliError);
const orFail = <A>(value: A | ProjectLabelCliError) =>
  isProjectLabelCliError(value) ? Effect.fail(value) : Effect.succeed(value);

/** What a command prints: a line for people, the value for `--json`. */
interface Output {
  readonly text: string;
  readonly json: unknown;
}

const describeLabel = (
  label: ProjectLabelWithRepositories,
  repositories: ReadonlyArray<Repository>,
) => {
  const lines = [
    `${label.name} (${label.id})${label.color ? ` · ${label.color}` : ""} · ${label.repositoryIds.length} ${label.repositoryIds.length === 1 ? "repository" : "repositories"} · ${label.threadCount} ${label.threadCount === 1 ? "chat" : "chats"}`,
  ];
  for (const id of label.repositoryIds) {
    const repository = repositories.find((candidate) => candidate.id === id);
    lines.push(`  ${repository ? `${repository.title}  ${repository.workspaceRoot}` : id}`);
  }
  return lines.join("\n");
};

const listLabels = (context: ProjectLabelCliContext) =>
  context.client[WS_METHODS.projectLabelsList]({}).pipe(
    Effect.map((result) => result.labels),
    Effect.mapError(describe),
  );

const labelOutput = (context: ProjectLabelCliContext, verb: string) =>
  Effect.fnUntraced(function* (label: ProjectLabelWithRepositories) {
    const repositories = yield* context.repositories;
    return {
      text: `${verb}\n${describeLabel(label, repositories)}`,
      json: { label },
    } satisfies Output;
  });

export type ProjectLabelCliCommand =
  | { readonly _tag: "list" }
  | { readonly _tag: "create"; readonly name: string; readonly color: string | undefined }
  | { readonly _tag: "rename"; readonly label: string; readonly name: string }
  | { readonly _tag: "delete"; readonly label: string }
  | { readonly _tag: "add-repo"; readonly label: string; readonly repository: string }
  | { readonly _tag: "remove-repo"; readonly label: string; readonly repository: string };

/** Run one label subcommand against `context`; the commands below only parse flags. */
export const runProjectLabelCommand = Effect.fn("cli.projectLabel.run")(function* (
  context: ProjectLabelCliContext,
  command: ProjectLabelCliCommand,
) {
  const { client } = context;
  switch (command._tag) {
    case "list": {
      const labels = yield* listLabels(context);
      const repositories = yield* context.repositories;
      return {
        text:
          labels.length === 0
            ? "No projects yet. Create one with `cogenly project label create <name>`."
            : labels.map((label) => describeLabel(label, repositories)).join("\n"),
        json: { labels },
      } satisfies Output;
    }
    case "create": {
      const color = command.color;
      if (color !== undefined && !isProjectLabelColor(color)) {
        return yield* new ProjectLabelCliError({
          reason: `Unknown color "${color}". Use one of: ${ProjectLabelColor.literals.join(", ")}.`,
        });
      }
      const { label } = yield* client[WS_METHODS.projectLabelsCreate]({
        name: command.name,
        ...(color === undefined ? {} : { color }),
      }).pipe(Effect.mapError(describe));
      return yield* labelOutput(context, "Created project")(label);
    }
    case "rename": {
      const target = yield* orFail(findLabel(yield* listLabels(context), command.label));
      const { label } = yield* client[WS_METHODS.projectLabelsUpdate]({
        id: target.id,
        name: command.name,
      }).pipe(Effect.mapError(describe));
      return yield* labelOutput(context, "Renamed project")(label);
    }
    case "delete": {
      const target = yield* orFail(findLabel(yield* listLabels(context), command.label));
      const { deleted } = yield* client[WS_METHODS.projectLabelsDelete]({ id: target.id }).pipe(
        Effect.mapError(describe),
      );
      return {
        text: deleted
          ? `Deleted project ${target.name} (${target.id}). Its repositories and chats stay.`
          : `Project ${target.name} (${target.id}) was already gone.`,
        json: { deleted, id: target.id },
      } satisfies Output;
    }
    case "add-repo":
    case "remove-repo": {
      const target = yield* orFail(findLabel(yield* listLabels(context), command.label));
      const repository = yield* orFail(
        findRepository(
          yield* context.repositories,
          command.repository,
          yield* context.normalizePath(command.repository),
        ),
      );
      const input = { labelId: target.id, repositoryId: ProjectId.make(repository.id) };
      const { label } = yield* (
        command._tag === "add-repo"
          ? client[WS_METHODS.projectLabelsLinkRepository](input)
          : client[WS_METHODS.projectLabelsUnlinkRepository](input)
      ).pipe(Effect.mapError(describe));
      return yield* labelOutput(
        context,
        command._tag === "add-repo"
          ? `Filed ${repository.title} in ${label.name}`
          : `Removed ${repository.title} from ${label.name}`,
      )(label);
    }
  }
});

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * Connect to the running server for the life of the surrounding scope, with
 * a short-lived session that is revoked on the way out.
 */
const openLiveContext = Effect.fn("cli.projectLabel.open")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  const authContext = yield* Layer.build(
    EnvironmentAuth.layerRuntime.pipe(
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
    ),
  );
  const environmentAuth = Context.get(authContext, EnvironmentAuth.EnvironmentAuth);
  const recorded = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(recorded)) {
    return yield* new ProjectLabelCliError({
      reason:
        "Cogenly isn't running. Start it, then run this again; projects are managed through it.",
    });
  }
  const origin = recorded.value.origin;
  const issued = yield* environmentAuth.issueSession({
    scopes: [...PROJECT_LABEL_CLI_SCOPES],
    label: "cogenly project label cli",
  });
  yield* Effect.addFinalizer(() =>
    environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );
  const first = yield* liveWebSocketUrl(origin, issued.token).pipe(
    Effect.provideContext(authContext),
    Effect.mapError(
      (cause) =>
        new ProjectLabelCliError({
          reason: `Couldn't reach the running Cogenly at ${origin}. Start it, then run this again.`,
          cause,
        }),
    ),
  );
  const client = yield* makeLiveRpcClient(
    liveWebSocketUrlSource({ origin, token: issued.token, first }).pipe(
      Effect.provideContext(authContext),
    ),
  );
  const http = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin }).pipe(
    Effect.provideContext(authContext),
  );
  const repositories = http.projects
    .snapshot({ headers: { authorization: `Bearer ${issued.token}` } })
    .pipe(
      Effect.provideContext(authContext),
      Effect.map((snapshot: ProjectSnapshot) =>
        snapshot.projects.filter((project) => project.deletedAt === null),
      ),
      Effect.mapError(describe),
    );
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  return {
    client,
    repositories,
    normalizePath: (path) =>
      workspacePaths.normalizeWorkspaceRoot(path).pipe(Effect.orElseSucceed(() => null)),
  } satisfies ProjectLabelCliContext;
});

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print the result as JSON."),
  Flag.withDefault(false),
);

const labelArgument = Argument.String("project").pipe(
  Argument.withDescription("Project (label) id or name."),
);
const repositoryArgument = Argument.String("repository").pipe(
  Argument.withDescription("Repository id or folder."),
);

const runLive = (
  flags: { readonly baseDir: Option.Option<string>; readonly json: boolean },
  command: ProjectLabelCliCommand,
) =>
  Effect.gen(function* () {
    const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
    const context = yield* openLiveContext(config);
    const output = yield* runProjectLabelCommand(context, command);
    yield* Console.log(flags.json ? yield* encodeJson(output.json) : output.text);
  }).pipe(Effect.scoped, Effect.provide(WorkspacePaths.layer));

const handle =
  <F extends { readonly baseDir: Option.Option<string>; readonly json: boolean }>(
    toCommand: (flags: F) => ProjectLabelCliCommand,
  ) =>
  (flags: F) =>
    runLive(flags, toCommand(flags));

const listCommand = Command.make("list", { ...projectLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("List projects and the repositories filed in each."),
  Command.withHandler(handle(() => ({ _tag: "list" }))),
);

const createCommand = Command.make("create", {
  ...projectLocationFlags,
  json: jsonFlag,
  name: Argument.String("name").pipe(Argument.withDescription("Project name.")),
  color: Flag.String("color").pipe(
    Flag.withDescription("Project color: gray, red, amber, green, teal, blue, violet or pink."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Create a project."),
  Command.withHandler(
    handle((flags) => ({
      _tag: "create",
      name: flags.name,
      color: Option.getOrUndefined(flags.color),
    })),
  ),
);

const renameCommand = Command.make("rename", {
  ...projectLocationFlags,
  json: jsonFlag,
  label: labelArgument,
  name: Argument.String("name").pipe(Argument.withDescription("New project name.")),
}).pipe(
  Command.withDescription("Rename a project."),
  Command.withHandler(
    handle((flags) => ({ _tag: "rename", label: flags.label, name: flags.name })),
  ),
);

const deleteCommand = Command.make("delete", {
  ...projectLocationFlags,
  json: jsonFlag,
  label: labelArgument,
}).pipe(
  Command.withDescription("Delete a project. Its repositories and chats stay."),
  Command.withHandler(handle((flags) => ({ _tag: "delete", label: flags.label }))),
);

const addRepoCommand = Command.make("add-repo", {
  ...projectLocationFlags,
  json: jsonFlag,
  label: labelArgument,
  repository: repositoryArgument,
}).pipe(
  Command.withDescription(
    "File a repository in a project. A repository is in one project at a time; this moves it.",
  ),
  Command.withHandler(
    handle((flags) => ({ _tag: "add-repo", label: flags.label, repository: flags.repository })),
  ),
);

const removeRepoCommand = Command.make("remove-repo", {
  ...projectLocationFlags,
  json: jsonFlag,
  label: labelArgument,
  repository: repositoryArgument,
}).pipe(
  Command.withDescription("Take a repository out of a project."),
  Command.withHandler(
    handle((flags) => ({
      _tag: "remove-repo",
      label: flags.label,
      repository: flags.repository,
    })),
  ),
);

export const projectLabelCommand = Command.make("label").pipe(
  Command.withDescription("Manage projects (labels) and the repositories filed in them."),
  Command.withSubcommands([
    listCommand,
    createCommand,
    renameCommand,
    deleteCommand,
    addRepoCommand,
    removeRepoCommand,
  ]),
);
