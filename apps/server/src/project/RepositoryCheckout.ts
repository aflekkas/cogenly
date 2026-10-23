import { CommandId, ProjectId, SourceControlProviderKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectLabelService from "../projectLabels/ProjectLabelService.ts";
import * as ProjectCloneTracker from "./ProjectCloneTracker.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import { repositoryDirectoryName } from "./RepositoryRemote.ts";

export class RepositoryCheckoutError extends Schema.TaggedError<RepositoryCheckoutError>()(
  "RepositoryCheckoutError",
  {
    repositoryId: ProjectId,
    repositoryName: Schema.String,
    reason: Schema.Literals(["not_found", "no_remote", "clone_failed", "storage"]),
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_found":
        return `Repository ${this.repositoryId} was not found.`;
      case "no_remote":
        return `${this.repositoryName} has no checkout and no known remote; clone it with project_label_clone_repository or link an existing checkout.`;
      case "clone_failed":
        return `${this.repositoryName} could not be cloned${this.detail ? `: ${this.detail}` : ""}.`;
      case "storage":
        return `The checkout for ${this.repositoryName} could not be inspected.`;
    }
  }
}

/**
 * Guarantees a repository launch lands in a real checkout: an existing
 * checkout passes, a missing or empty folder with a known remote is cloned
 * in place through the tracked clone flow (progress on the project-clone
 * subscription, the machine's usual GitHub auth), a folder that already has
 * files is left to launch as before, and a missing checkout with no known
 * remote fails with what to do instead. User files are never touched.
 */
export class RepositoryCheckout extends Context.Service<
  RepositoryCheckout,
  {
    readonly ensureCheckout: (
      repositoryId: ProjectId,
    ) => Effect.Effect<void, RepositoryCheckoutError>;
  }
>()("cogenly-server/project/RepositoryCheckout") {}

/** Turns a stored remote back into clone input for the tracked clone flow. */
export function cloneInputForRemote(remote: string): {
  readonly provider?: SourceControlProviderKind;
  readonly repository?: string;
  readonly remoteUrl?: string;
} {
  const trimmed = remote.trim();
  // A URL, an scp-style remote, or a filesystem path (a local bare remote)
  // is given to git as-is.
  if (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ||
    /^[^\s/@:]+@[^\s/:]+:[^\s]+$/.test(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith(".") ||
    trimmed.startsWith("~")
  ) {
    return { remoteUrl: trimmed };
  }
  // The stored normalized form is `host/owner/repo`. GitHub goes through
  // the provider so the clone uses the machine's GitHub auth and preferred
  // transport, exactly like a fresh project clone.
  const [host, ...rest] = trimmed.split("/");
  if (host === "github.com" && rest.length === 2) {
    return {
      provider: SourceControlProviderKind.make("github"),
      repository: rest.join("/"),
    };
  }
  return { remoteUrl: `https://${trimmed}` };
}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitWorkflow.GitWorkflowService;
  const clones = yield* ProjectCloneTracker.ProjectCloneTracker;
  const labels = yield* ProjectLabelService.ProjectLabelService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const identities = yield* Effect.serviceOption(
    RepositoryIdentityResolver.RepositoryIdentityResolver,
  );

  // The folder's own `.git` (a directory, or a file for a linked worktree),
  // not `git rev-parse`: an empty folder inside some other repository is
  // inside a work tree, yet holds no checkout of this repository.
  const hasOwnCheckout = (workspaceRoot: string) =>
    fileSystem.exists(path.join(workspaceRoot, ".git")).pipe(
      Effect.flatMap((exists) =>
        exists ? git.isRepository(workspaceRoot) : Effect.succeed(false),
      ),
      Effect.orElseSucceed(() => false),
    );

  const waitForClone = (repositoryId: ProjectId) =>
    Effect.scoped(
      clones.stream.pipe(
        Stream.map((snapshots) => snapshots.find((clone) => clone.projectId === repositoryId)),
        Stream.filter((clone) => clone === undefined || clone.phase !== "running"),
        Stream.runHead,
      ),
    );

  const ensureCheckout: RepositoryCheckout["Service"]["ensureCheckout"] = Effect.fn(
    "RepositoryCheckout.ensureCheckout",
  )(function* (repositoryId) {
    const project = yield* projects.getById(repositoryId).pipe(
      Effect.mapError(
        (cause) =>
          new RepositoryCheckoutError({
            repositoryId,
            repositoryName: repositoryId,
            reason: "storage",
            cause,
          }),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new RepositoryCheckoutError({
                repositoryId,
                repositoryName: repositoryId,
                reason: "not_found",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
    const workspaceRoot = project.workspaceRoot;
    const repositoryName = repositoryDirectoryName(workspaceRoot) ?? project.title ?? repositoryId;

    if (yield* hasOwnCheckout(workspaceRoot)) {
      return;
    }

    const exists = yield* fileSystem
      .exists(workspaceRoot)
      .pipe(
        Effect.mapError(
          (cause) =>
            new RepositoryCheckoutError({ repositoryId, repositoryName, reason: "storage", cause }),
        ),
      );
    if (exists) {
      const entries = yield* fileSystem.readDirectory(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new RepositoryCheckoutError({
              repositoryId,
              repositoryName,
              reason: "storage",
              cause,
            }),
        ),
      );
      // A folder with files launches as it always did: a monorepo subfolder,
      // or a plain folder filed as a repository. Only a missing or empty
      // checkout is cloned, so nothing here can touch the user's files.
      if (entries.length > 0) return;
    }

    const { labels: allLabels } = yield* labels
      .list()
      .pipe(
        Effect.mapError(
          (cause) =>
            new RepositoryCheckoutError({ repositoryId, repositoryName, reason: "storage", cause }),
        ),
      );
    const link = allLabels
      .flatMap((label) => label.repositories ?? [])
      .find((candidate) => candidate.repositoryId === repositoryId);
    const remote = link?.remote?.trim() ? link.remote.trim() : null;
    if (remote === null) {
      return yield* new RepositoryCheckoutError({
        repositoryId,
        repositoryName,
        reason: "no_remote",
      });
    }

    const existing = yield* clones.get(repositoryId);
    if (existing === null || existing.phase === "done") {
      yield* clones
        .start(
          {
            projectId: repositoryId,
            title: project.title,
            createdAt: DateTime.formatIso(yield* DateTime.now),
            destinationPath: workspaceRoot,
            ...cloneInputForRemote(remote),
          },
          {
            // The project record already exists; only the checkout is missing.
            createProject: () => Effect.void,
            // Like a fresh project clone: re-resolve the folder's repository
            // (it may have been cached as an enclosing repo while empty),
            // then refresh the project record.
            onCloned: () =>
              (Option.isSome(identities)
                ? identities.value.resolve(workspaceRoot, { refresh: true })
                : Effect.void
              ).pipe(
                Effect.andThen(
                  projects.update({
                    commandId: CommandId.make(`repository-checkout-cloned:${repositoryId}`),
                    projectId: repositoryId,
                  }),
                ),
                Effect.asVoid,
                Effect.ignoreCause({ log: true }),
              ),
          },
          // Server-initiated re-clone of a stored remote: local remotes that
          // came from a previous clone or the repository's own config are allowed.
          { cloneCaller: "owner" },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new RepositoryCheckoutError({
                repositoryId,
                repositoryName,
                reason: "clone_failed",
                detail:
                  cause._tag === "SourceControlRepositoryError" ? cause.detail : cause.message,
                cause,
              }),
          ),
        );
    } else if (existing.phase === "failed" || existing.phase === "cancelled") {
      const retried = yield* clones.retry(repositoryId).pipe(
        Effect.mapError(
          (cause) =>
            new RepositoryCheckoutError({
              repositoryId,
              repositoryName,
              reason: "clone_failed",
              detail: cause.detail,
              cause,
            }),
        ),
      );
      if (!retried) {
        return yield* new RepositoryCheckoutError({
          repositoryId,
          repositoryName,
          reason: "clone_failed",
          detail: existing.error ?? "The previous clone did not finish.",
        });
      }
    }

    const settled = Option.getOrUndefined(yield* waitForClone(repositoryId));
    if (settled !== undefined && settled.phase !== "done") {
      return yield* new RepositoryCheckoutError({
        repositoryId,
        repositoryName,
        reason: "clone_failed",
        detail:
          settled.phase === "cancelled"
            ? "The clone was cancelled."
            : (settled.error ?? "The repository could not be cloned."),
      });
    }
    if (!(yield* hasOwnCheckout(workspaceRoot))) {
      return yield* new RepositoryCheckoutError({
        repositoryId,
        repositoryName,
        reason: "clone_failed",
        detail: "The clone finished without producing a checkout.",
      });
    }
  });

  return RepositoryCheckout.of({ ensureCheckout });
});

export const layer = Layer.effect(RepositoryCheckout, make);
