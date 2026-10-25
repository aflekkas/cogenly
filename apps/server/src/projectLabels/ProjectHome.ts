import {
  CommandId,
  OrchestrationDispatchCommandError,
  ThreadId,
  type ProjectLabelError,
  type ProjectChangeAction,
  type ProjectChangeKind,
  type ProjectChangeReceipt,
  type ProjectChatEnsureInput,
  type ProjectChatEnsureResult,
  type ProjectId,
  type ProjectInstructionsResult,
  type ProjectLabelId,
  type ProjectLabelWithRepositories,
  type ProjectOverviewResult,
  type ProjectSourceLink,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectFiles from "./ProjectFiles.ts";
import * as ProjectLabelService from "./ProjectLabelService.ts";

/**
 * ProjectHome - the chat-first project page's server side: the project's own
 * chat, and the configuration changes the project tools make. Every change
 * goes through ProjectLabelService or ProjectFiles, which publish the change
 * so project subscriptions update live, and comes back as a compact receipt.
 */
export class ProjectHome extends Context.Service<
  ProjectHome,
  {
    /** The project's own chat: created on the first call, the same thread afterwards. */
    readonly ensureChat: (
      input: ProjectChatEnsureInput,
    ) => Effect.Effect<
      ProjectChatEnsureResult,
      ProjectLabelError | OrchestrationDispatchCommandError
    >;
    readonly overview: (
      id: ProjectLabelId,
    ) => Effect.Effect<ProjectOverviewResult, ProjectLabelError>;
    readonly instructions: (
      id: ProjectLabelId,
    ) => Effect.Effect<ProjectInstructionsResult, ProjectLabelError>;
    readonly setInstructions: (input: {
      readonly id: ProjectLabelId;
      readonly instructions: string;
    }) => Effect.Effect<ProjectChangeReceipt, ProjectLabelError>;
    readonly addRepository: (input: {
      readonly id: ProjectLabelId;
      readonly repositoryId: ProjectId;
    }) => Effect.Effect<ProjectChangeReceipt, ProjectLabelError>;
    readonly removeRepository: (input: {
      readonly id: ProjectLabelId;
      readonly repositoryId: ProjectId;
    }) => Effect.Effect<ProjectChangeReceipt, ProjectLabelError>;
    readonly linkSource: (input: {
      readonly id: ProjectLabelId;
      readonly link: ProjectSourceLink;
    }) => Effect.Effect<ProjectChangeReceipt, ProjectLabelError>;
    readonly unlinkSource: (input: {
      readonly id: ProjectLabelId;
      readonly link: ProjectSourceLink;
    }) => Effect.Effect<ProjectChangeReceipt, ProjectLabelError>;
    readonly writeFile: (input: {
      readonly id: ProjectLabelId;
      readonly title: string;
      readonly text: string;
    }) => Effect.Effect<ProjectChangeReceipt, ProjectLabelError>;
    readonly removeFile: (input: {
      readonly id: ProjectLabelId;
      readonly path: string;
    }) => Effect.Effect<ProjectChangeReceipt, ProjectLabelError>;
  }
>()("cogenly-server/projectLabels/ProjectHome") {}

/** First project chat id; stable, so a retried create replays instead of duplicating. */
export const projectChatThreadIdFor = (id: ProjectLabelId) => ThreadId.make(`project-chat:${id}`);

const sourceLinkLabel = (link: ProjectSourceLink) =>
  link.kind === "github-owner" ? link.owner : `${link.owner}/${link.repo}`;

const sameSource = (a: ProjectSourceLink, b: ProjectSourceLink) =>
  sourceLinkLabel(a) === sourceLinkLabel(b) && a.kind === b.kind;

const launchFailure = (cause: unknown) =>
  new OrchestrationDispatchCommandError({
    message: userFacingDispatchErrorMessage(cause) ?? "Could not start the project chat.",
    cause,
  });

const make = Effect.gen(function* () {
  const labels = yield* ProjectLabelService.ProjectLabelService;
  const files = yield* ProjectFiles.ProjectFiles;
  const launch = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const crypto = yield* Crypto.Crypto;
  // One creation at a time, so two first visits cannot create two chats.
  const creating = yield* Semaphore.make(1);

  const receipt = (
    id: ProjectLabelId,
    kind: ProjectChangeKind,
    label: string,
    action: ProjectChangeAction,
  ): ProjectChangeReceipt => ({ projectFolderId: id, kind, label, action });

  const repositoryTitle = (repositoryId: ProjectId) =>
    projects.get(repositoryId, { includeDeleted: true }).pipe(
      Effect.map(Option.match({ onNone: () => repositoryId, onSome: (row) => row.title })),
      Effect.catch(() => Effect.succeed(repositoryId)),
    );

  const liveThread = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.map((shell) => shell !== null && shell.deletedAt === null),
      Effect.mapError(launchFailure),
    );

  // The chat runs in the Scratch project, which puts a thread filed in a
  // project in the project's own folder. Environments without Scratch (a data
  // dir inside a checkout, as in dev worktrees) run it in the project's first
  // linked repository instead; with neither there is nowhere to run it.
  const chatProjectFor = (label: ProjectLabelWithRepositories) =>
    managedFolders.ensureScratchProject.pipe(
      Effect.map(({ projectId }) => projectId),
      Effect.catchTags({
        ScratchUnavailableError: (unavailable) =>
          Effect.gen(function* () {
            for (const repositoryId of label.repositoryIds) {
              const row = yield* projects
                .get(repositoryId)
                .pipe(Effect.orElseSucceed(() => Option.none<ProjectStore.ProjectRow>()));
              if (Option.isSome(row)) return row.value.projectId;
            }
            return yield* new OrchestrationDispatchCommandError({
              message: `Add a repository to ${label.name} to talk to it on this environment.`,
              cause: unavailable,
            });
          }),
      }),
      Effect.mapError((error) =>
        error._tag === "OrchestrationDispatchCommandError" ? error : launchFailure(error),
      ),
    );

  const createChat = (label: ProjectLabelWithRepositories, input: ProjectChatEnsureInput) =>
    Effect.gen(function* () {
      const first = projectChatThreadIdFor(label.id);
      // A crash between the launch and recording it leaves the stable thread
      // behind; adopt it. A deleted one is replaced by a fresh id.
      if (yield* liveThread(first)) return { threadId: first, launched: false };
      const existing = yield* threads.getThreadShell(first).pipe(Effect.mapError(launchFailure));
      const threadId =
        existing === null
          ? first
          : ThreadId.make(`${first}:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`);
      const projectId = yield* chatProjectFor(label);
      yield* launch
        .launch({
          surface: "chat",
          commandId: CommandId.make(`server:${threadId}`),
          threadId,
          projectId,
          title: label.name,
          modelSelection: input.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          projectFolderId: label.id,
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.mapError(launchFailure));
      return { threadId, launched: true };
    });

  const ensureChat: ProjectHome["Service"]["ensureChat"] = Effect.fn("ProjectHome.ensureChat")(
    function* (input) {
      const current = (yield* labels.read(input.id)).label.projectChatThreadId;
      if (current !== null && (yield* liveThread(current)))
        return { threadId: current, created: false };
      return yield* creating.withPermits(1)(
        Effect.gen(function* () {
          // Re-read under the lock: a concurrent first visit may have won.
          const { label } = yield* labels.read(input.id);
          if (label.projectChatThreadId !== null && (yield* liveThread(label.projectChatThreadId)))
            return { threadId: label.projectChatThreadId, created: false };
          const { threadId, launched } = yield* createChat(label, input);
          yield* labels.setProjectChat({ id: input.id, threadId });
          return { threadId, created: launched };
        }),
      );
    },
  );

  const overview: ProjectHome["Service"]["overview"] = Effect.fn("ProjectHome.overview")(
    function* (id) {
      const { label } = yield* labels.read(id);
      const repositories = yield* Effect.forEach(label.repositoryIds, (repositoryId) =>
        repositoryTitle(repositoryId).pipe(
          Effect.map((title) => {
            const link = label.repositories?.find(
              (candidate) => candidate.repositoryId === repositoryId,
            );
            return {
              id: repositoryId,
              title,
              ...(link === undefined
                ? {}
                : {
                    remote: link.remote,
                    directoryName: link.directoryName,
                    ...(link.checkout === undefined ? {} : { checkout: link.checkout }),
                  }),
            };
          }),
        ),
      );
      return {
        projectFolderId: label.id,
        name: label.name,
        ...(label.description === undefined ? {} : { description: label.description }),
        instructions: label.instructions,
        repositories,
        sourceLinks: label.sourceLinks,
        projectChatThreadId: label.projectChatThreadId,
      };
    },
  );

  const instructions: ProjectHome["Service"]["instructions"] = (id) =>
    labels.read(id).pipe(
      Effect.map(({ label }) => ({
        projectFolderId: label.id,
        instructions: label.instructions,
      })),
    );

  const setInstructions: ProjectHome["Service"]["setInstructions"] = Effect.fn(
    "ProjectHome.setInstructions",
  )(function* (input) {
    const before = (yield* labels.read(input.id)).label.instructions;
    if (before === input.instructions)
      return receipt(input.id, "instructions", "Instructions", "unchanged");
    yield* labels.update({ id: input.id, instructions: input.instructions });
    return receipt(
      input.id,
      "instructions",
      "Instructions",
      input.instructions.length === 0 ? "removed" : before.length === 0 ? "added" : "updated",
    );
  });

  const addRepository: ProjectHome["Service"]["addRepository"] = Effect.fn(
    "ProjectHome.addRepository",
  )(function* (input) {
    const before = (yield* labels.read(input.id)).label.repositoryIds.includes(input.repositoryId);
    if (!before)
      yield* labels.linkRepository({ labelId: input.id, repositoryId: input.repositoryId });
    return receipt(
      input.id,
      "repository",
      yield* repositoryTitle(input.repositoryId),
      before ? "unchanged" : "added",
    );
  });

  const removeRepository: ProjectHome["Service"]["removeRepository"] = Effect.fn(
    "ProjectHome.removeRepository",
  )(function* (input) {
    const before = (yield* labels.read(input.id)).label.repositoryIds.includes(input.repositoryId);
    if (before)
      yield* labels.unlinkRepository({ labelId: input.id, repositoryId: input.repositoryId });
    return receipt(
      input.id,
      "repository",
      yield* repositoryTitle(input.repositoryId),
      before ? "removed" : "unchanged",
    );
  });

  const sourceChange = (
    input: { readonly id: ProjectLabelId; readonly link: ProjectSourceLink },
    link: boolean,
  ) =>
    Effect.gen(function* () {
      const before = (yield* labels.read(input.id)).label.sourceLinks.some((source) =>
        sameSource(source, input.link),
      );
      const changes = link ? !before : before;
      if (changes) yield* link ? labels.linkSource(input) : labels.unlinkSource(input);
      return receipt(
        input.id,
        "source",
        sourceLinkLabel(input.link),
        changes ? (link ? "added" : "removed") : "unchanged",
      );
    });

  const writeFile: ProjectHome["Service"]["writeFile"] = Effect.fn("ProjectHome.writeFile")(
    function* (input) {
      const { resource } = yield* files.createResource({
        id: input.id,
        resource: { kind: "note", title: input.title, text: input.text },
      });
      return receipt(input.id, "file", resource.relativePath, "added");
    },
  );

  const removeFile: ProjectHome["Service"]["removeFile"] = Effect.fn("ProjectHome.removeFile")(
    function* (input) {
      const { removed } = yield* files.removeResource({ id: input.id, relativePath: input.path });
      return receipt(input.id, "file", input.path, removed ? "removed" : "unchanged");
    },
  );

  return ProjectHome.of({
    ensureChat,
    overview,
    instructions,
    setInstructions,
    addRepository,
    removeRepository,
    linkSource: (input) => sourceChange(input, true),
    unlinkSource: (input) => sourceChange(input, false),
    writeFile,
    removeFile,
  });
});

export const layer = Layer.effect(ProjectHome, make);
