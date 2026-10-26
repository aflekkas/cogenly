import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import {
  SourceControlRepositoryError,
  type SourceControlCloneRepositoryInput,
  type SourceControlCloneRepositoryResult,
  type SourceControlCloneProtocol,
  SourceControlProviderKind,
  type SourceControlPublishRepositoryInput,
  type SourceControlPublishRepositoryResult,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryInfo,
  type SourceControlRepositoryLookupInput,
} from "@cogenly/contracts";

import * as ServerConfig from "../config.ts";
import { expandHomePath } from "@cogenly/provider-core/server/pathExpansion";
import {
  parseGitCloneProgressLine,
  type GitCloneProgressLine,
} from "../project/gitCloneProgress.ts";
import { resolveDefaultCloneDestination } from "../project/ProjectsRoot.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as HostProcess from "@cogenly/shared/HostProcess";
const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);

export class SourceControlRepositoryService extends Context.Service<
  SourceControlRepositoryService,
  {
    readonly lookupRepository: (
      input: SourceControlRepositoryLookupInput,
    ) => Effect.Effect<SourceControlRepositoryInfo, SourceControlRepositoryError>;
    /**
     * Everything `cloneRepository` checks before running git: the resolved
     * remote, the normalized destination, and that the destination is empty.
     * Lets a caller create the project first and clone afterwards.
     */
    readonly prepareClone: (
      input: SourceControlCloneRepositoryInput,
      options?: SourceControlPrepareCloneOptions,
    ) => Effect.Effect<SourceControlPreparedClone, SourceControlRepositoryError>;
    readonly cloneRepository: (
      input: SourceControlCloneRepositoryInput,
      options?: SourceControlCloneOptions,
    ) => Effect.Effect<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;
    /** Removes a partial or failed clone so the destination is empty again. */
    readonly discardClone: (
      destinationPath: string,
    ) => Effect.Effect<void, SourceControlRepositoryError>;
    readonly publishRepository: (
      input: SourceControlPublishRepositoryInput,
    ) => Effect.Effect<SourceControlPublishRepositoryResult, SourceControlRepositoryError>;
  }
>()("cogenly-server/sourceControl/SourceControlRepositoryService") {}

export interface SourceControlPreparedClone {
  readonly destinationPath: string;
  /** Credential-free; safe to show and to store in snapshots. */
  readonly remoteUrl: string;
  /** What git is given; may carry embedded credentials. */
  readonly cloneUrl: string;
  readonly repository: SourceControlRepositoryInfo | null;
}

/**
 * Who asked for a clone. `owner` is the user (or the server itself, re-cloning
 * a stored remote); `agent` is an MCP agent. Local remotes are owner-only.
 */
export type CloneCaller = "owner" | "agent";

export interface SourceControlPrepareCloneOptions {
  readonly caller?: CloneCaller;
}

export interface SourceControlCloneOptions {
  readonly onProgress?: (line: GitCloneProgressLine) => Effect.Effect<void>;
  /** Overrides the default clone budget; `null` disables the deadline. */
  readonly timeoutMs?: number | null;
  readonly caller?: CloneCaller;
}

// The synchronous RPC (older clients, mobile) keeps a deadline: nothing else
// tells the user a clone stalled. The tracked path passes null and relies on
// progress and Cancel instead.
const CLONE_TIMEOUT_MS = 120_000;
const CLONE_ENV = {
  // `--progress` forces the transfer counters through the pipe; the delay env
  // makes the checkout counter start immediately. No tty means a credential
  // prompt would hang forever, so tell git to fail instead.
  GIT_PROGRESS_DELAY: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
} satisfies NodeJS.ProcessEnv;

const NETWORK_PROTOCOLS: ReadonlySet<string> = new Set(["https", "http", "ssh", "git"]);

/**
 * Why a clone remote is refused, or null when it may be cloned. Option-like
 * remotes and helper transports (`ext::`, `fd::`) are refused for everyone;
 * `file://` and bare local paths are refused for agent-requested clones, so
 * an agent cannot clone arbitrary repositories off this machine.
 */
export function cloneRemoteRejection(remoteUrl: string, caller: CloneCaller): string | null {
  const remote = remoteUrl.trim();
  if (remote.startsWith("-")) return 'The clone remote must not start with "-".';
  const lower = remote.toLowerCase();
  if (lower.startsWith("ext::") || lower.startsWith("fd::")) {
    return "This clone transport is not allowed.";
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(lower)?.[1];
  if (scheme !== undefined && NETWORK_PROTOCOLS.has(scheme)) return null;
  if (scheme === "file") {
    return caller === "agent"
      ? "Agents cannot clone local repositories; use an https, ssh or git remote."
      : null;
  }
  if (scheme !== undefined && remote.includes("://")) {
    return "This clone protocol is not allowed; use https, http, ssh or git.";
  }
  // An scp-style remote (`git@host:path`) rides ssh; anything else is a local path.
  if (/^[^\s/@:]+@[^\s/:]+:[^\s]+$/.test(remote)) return null;
  return caller === "agent"
    ? "Agents cannot clone local repositories; use an https, ssh or git remote."
    : null;
}

const cloneEnvFor = (caller: CloneCaller): NodeJS.ProcessEnv => ({
  ...CLONE_ENV,
  // Defense in depth behind cloneRemoteRejection: git itself refuses any
  // transport outside this list (notably `ext::`/`fd::` helper commands).
  GIT_ALLOW_PROTOCOL: caller === "agent" ? "https:http:ssh:git" : "https:http:ssh:git:file",
});

function mapRepositoryError(operation: string, provider: SourceControlProviderKind) {
  return Effect.mapError((cause: unknown) =>
    isSourceControlRepositoryError(cause)
      ? cause
      : new SourceControlRepositoryError({
          operation,
          provider,
          detail: "The source control operation could not be completed.",
          cause,
        }),
  );
}

function toRepositoryInfo(
  provider: SourceControlProviderKind,
  urls: SourceControlRepositoryCloneUrls,
): SourceControlRepositoryInfo {
  return {
    provider,
    nameWithOwner: urls.nameWithOwner,
    url: urls.url,
    sshUrl: urls.sshUrl,
  };
}

/**
 * The URL clients see. A pasted `https://user:token@host/…` must not travel
 * back over `subscribeProjectClones` to every reader; git still gets the
 * original.
 */
function redactRemoteUrl(remoteUrl: string): string {
  try {
    const url = new URL(remoteUrl);
    // Clone URLs have no legitimate query; when one is present it is a token.
    if (url.username.length === 0 && url.password.length === 0 && url.search.length === 0) {
      return remoteUrl;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch {
    return remoteUrl;
  }
}

// Userinfo may itself contain `@`; everything up to the last one before the
// host boundary goes.
const URL_WITH_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi;

/** Drops `user:token@` from any URL embedded in free text. */
function redactUrlCredentials(text: string): string {
  return text.replace(URL_WITH_USERINFO, "$1");
}

/**
 * The URL git is given. `auto` takes the provider's preferred transport
 * (`preferred`), else SSH.
 */
export function selectRemoteUrl(
  urls: SourceControlRepositoryCloneUrls,
  protocol: SourceControlCloneProtocol | undefined,
  preferred: "https" | "ssh" | null = null,
): string {
  switch (protocol ?? "auto") {
    case "https":
      return urls.url;
    case "ssh":
      return urls.sshUrl;
    case "auto":
      return preferred === "https" ? urls.url : urls.sshUrl;
  }
}

/**
 * What a failed clone tells the user: git's last lines, led by what to do
 * when they name a refused SSH key or HTTPS login.
 */
export function cloneFailureDetail(stderrTail: ReadonlyArray<string>): string {
  if (stderrTail.length === 0) return "The repository could not be cloned.";
  const raw = stderrTail.join(" ");
  if (/permission denied \(publickey/i.test(raw)) {
    return `The host refused this machine's SSH key. Add an SSH key to your account, or sign in over HTTPS (for GitHub, \`gh auth login\`), then retry. Git said: ${raw}`;
  }
  if (/authentication failed|could not read username|terminal prompts disabled/i.test(raw)) {
    return `The host asked for a login this machine does not have. Sign in on this machine (for GitHub, Settings → Source control → GitHub: save a token, or run \`gh auth login\` there), then retry. Git said: ${raw}`;
  }
  return raw;
}

function urlHost(url: string): string | null {
  return URL.parse(url)?.host ?? null;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const ensureConcreteProvider = (input: {
    readonly operation: string;
    readonly provider: SourceControlProviderKind;
  }) => {
    if (input.provider !== "unknown") {
      return Effect.succeed(input.provider);
    }

    return Effect.fail(
      new SourceControlRepositoryError({
        operation: input.operation,
        provider: input.provider,
        detail: "Choose a source control provider before continuing.",
      }),
    );
  };

  const lookupRepository = Effect.fn("SourceControlRepositoryService.lookupRepository")(function* (
    input: SourceControlRepositoryLookupInput,
  ) {
    const providerKind = yield* ensureConcreteProvider({
      operation: "lookupRepository",
      provider: input.provider,
    });
    const provider = yield* providers.get(providerKind);
    const urls = yield* provider.getRepositoryCloneUrls({
      cwd: input.cwd ?? config.cwd,
      repository: input.repository.trim(),
    });
    return toRepositoryInfo(providerKind, urls);
  });

  // Asks the provider only when `auto` leaves the transport open.
  const resolveRemoteUrl = Effect.fn("SourceControlRepositoryService.resolveRemoteUrl")(function* (
    providerKind: SourceControlProviderKind,
    urls: SourceControlRepositoryCloneUrls,
    protocol: SourceControlCloneProtocol | undefined,
    cwd: string,
  ) {
    const host = urlHost(urls.url);
    if ((protocol ?? "auto") !== "auto" || host === null) return selectRemoteUrl(urls, protocol);
    const provider = yield* providers.get(providerKind);
    const preferred = provider.preferredCloneProtocol
      ? yield* provider.preferredCloneProtocol({ cwd, host })
      : null;
    return selectRemoteUrl(urls, protocol, preferred);
  });

  const normalizeDestinationPath = Effect.fn("SourceControlRepositoryService.normalizeDestination")(
    function* (destinationPath: string) {
      const trimmed = destinationPath.trim();
      if (trimmed.length === 0) {
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: SourceControlProviderKind.make("unknown"),
          detail: "Choose a destination path before cloning.",
        });
      }

      return path.resolve(expandHomePath(trimmed, yield* HostProcess.HomeDirectory));
    },
  );

  const prepareDestination = Effect.fn("SourceControlRepositoryService.prepareDestination")(
    function* (destinationPath: string) {
      const normalizedDestination = yield* normalizeDestinationPath(destinationPath);
      if (yield* fileSystem.exists(normalizedDestination)) {
        const entries = yield* fileSystem
          .readDirectory(normalizedDestination, { recursive: false })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: SourceControlProviderKind.make("unknown"),
                  detail: "Destination path already exists and is not a directory.",
                  cause,
                }),
            ),
          );
        if (entries.length > 0) {
          return yield* new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: SourceControlProviderKind.make("unknown"),
            detail: "Destination path already exists and is not empty.",
          });
        }
      } else {
        yield* fileSystem.makeDirectory(path.dirname(normalizedDestination), { recursive: true });
      }

      return {
        destinationPath: normalizedDestination,
        parentPath: path.dirname(normalizedDestination),
        directoryName: path.basename(normalizedDestination),
      };
    },
  );

  const defaultCloneDestinationPath = Effect.fn(
    "SourceControlRepositoryService.defaultCloneDestination",
  )(function* (
    input: Pick<SourceControlCloneRepositoryInput, "provider" | "repository" | "remoteUrl">,
  ) {
    const provider = input.provider ?? SourceControlProviderKind.make("unknown");
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider,
            detail: "The projects root setting could not be read.",
            cause,
          }),
      ),
    );
    const resolved = resolveDefaultCloneDestination({
      projectsRootSetting: settings.projectsRoot,
      home: yield* HostProcess.HomeDirectory,
      cogenlyHome: config.baseDir,
      repository: input.repository,
      remoteUrl: input.remoteUrl,
      path,
    });
    if (resolved === null) {
      return yield* new SourceControlRepositoryError({
        operation: "cloneRepository",
        provider,
        detail: "Enter a repository path or clone URL before cloning.",
      });
    }
    return resolved;
  });

  const prepareClone = Effect.fn("SourceControlRepositoryService.prepareClone")(function* (
    input: SourceControlCloneRepositoryInput,
    options?: SourceControlPrepareCloneOptions,
  ) {
    const trimmedDestination = input.destinationPath?.trim() ?? "";
    const destinationPath =
      trimmedDestination === "" ? yield* defaultCloneDestinationPath(input) : trimmedDestination;
    const preparedDestination = yield* prepareDestination(destinationPath);
    let repository: SourceControlRepositoryInfo | null = null;
    let remoteUrl = input.remoteUrl?.trim() ?? null;
    let provider: SourceControlProviderKind =
      input.provider ?? SourceControlProviderKind.make("unknown");

    if (input.provider && input.repository) {
      repository = yield* lookupRepository({
        provider: input.provider,
        repository: input.repository,
        cwd: preparedDestination.parentPath,
      });
      remoteUrl = yield* resolveRemoteUrl(
        input.provider,
        repository,
        input.protocol,
        preparedDestination.parentPath,
      );
      provider = input.provider;
    }

    if (!remoteUrl) {
      return yield* new SourceControlRepositoryError({
        operation: "cloneRepository",
        provider,
        detail: "Enter a repository path or clone URL before cloning.",
      });
    }

    const rejection = cloneRemoteRejection(remoteUrl, options?.caller ?? "owner");
    if (rejection !== null) {
      return yield* new SourceControlRepositoryError({
        operation: "cloneRepository",
        provider,
        detail: rejection,
      });
    }

    return {
      destinationPath: preparedDestination.destinationPath,
      remoteUrl: redactRemoteUrl(remoteUrl),
      cloneUrl: remoteUrl,
      repository,
    } satisfies SourceControlPreparedClone;
  });

  const cloneRepository = Effect.fn("SourceControlRepositoryService.cloneRepository")(function* (
    input: SourceControlCloneRepositoryInput,
    options?: SourceControlCloneOptions,
  ) {
    const prepared = yield* prepareClone(input, { caller: options?.caller ?? "owner" });
    const onProgress = options?.onProgress;
    // Git interleaves progress redraws with its real messages on stderr. The
    // last non-progress lines are what explain a failure ("Repository not
    // found", "Permission denied"), so keep them for the error detail.
    const stderrTail: Array<string> = [];
    const onStderrLine = (line: string) => {
      const parsed = parseGitCloneProgressLine(line);
      if (parsed) return onProgress ? onProgress(parsed) : Effect.void;
      return Effect.sync(() => {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("Cloning into")) return;
        // Git echoes the remote in some failures; the tail becomes user-facing text.
        stderrTail.push(redactUrlCredentials(trimmed));
        if (stderrTail.length > 4) stderrTail.shift();
      });
    };
    yield* git
      .execute({
        operation: "SourceControlRepositoryService.cloneRepository",
        cwd: path.dirname(prepared.destinationPath),
        args: [
          "clone",
          "--progress",
          "--",
          prepared.cloneUrl,
          path.basename(prepared.destinationPath),
        ],
        timeoutMs: options?.timeoutMs === undefined ? CLONE_TIMEOUT_MS : options.timeoutMs,
        // Progress redraws add up on a slow multi-GB clone. The buffered copy
        // is never read (the tail is kept by hand above), so keep it small
        // and let the line callbacks keep flowing past the cap.
        maxOutputBytes: 256 * 1024,
        appendTruncationMarker: true,
        keepLineCallbacksAfterTruncation: true,
        env: cloneEnvFor(options?.caller ?? "owner"),
        progress: { onStderrLine },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider: input.provider ?? SourceControlProviderKind.make("unknown"),
              detail: cloneFailureDetail(stderrTail),
              cause,
            }),
        ),
      );

    return {
      cwd: prepared.destinationPath,
      remoteUrl: prepared.remoteUrl,
      repository: prepared.repository,
    };
  });

  const discardClone = Effect.fn("SourceControlRepositoryService.discardClone")(function* (
    destinationPath: string,
  ) {
    const normalized = yield* normalizeDestinationPath(destinationPath);
    // Only what git left behind may go. The destination was empty when the
    // clone started, so anything without a `.git` inside was put there by
    // someone else since; refuse rather than delete their files.
    // A missing destination is already discarded; any other read failure
    // (a file in its place, permissions) is not something to remove through.
    const entries = yield* fileSystem.readDirectory(normalized).pipe(
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed<ReadonlyArray<string>>([]),
      ),
      Effect.mapError(
        (cause) =>
          new SourceControlRepositoryError({
            operation: "discardClone",
            provider: SourceControlProviderKind.make("unknown"),
            detail: "The clone destination could not be inspected.",
            cause,
          }),
      ),
    );
    if (entries.length > 0 && !entries.includes(".git")) {
      return yield* new SourceControlRepositoryError({
        operation: "discardClone",
        provider: SourceControlProviderKind.make("unknown"),
        detail: "Destination path contains files that are not from the clone.",
      });
    }
    // The directory itself is the project's workspace root and must stay;
    // only git's partial contents go. An interrupted git may still be closing
    // files, so removal retries briefly.
    yield* fileSystem.remove(normalized, { recursive: true, force: true }).pipe(
      Effect.andThen(fileSystem.makeDirectory(normalized, { recursive: true })),
      Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 5 }),
      Effect.mapError(
        (cause) =>
          new SourceControlRepositoryError({
            operation: "discardClone",
            provider: SourceControlProviderKind.make("unknown"),
            detail: "The partial clone could not be removed.",
            cause,
          }),
      ),
    );
  });

  const publishRepository = Effect.fn("SourceControlRepositoryService.publishRepository")(
    function* (input: SourceControlPublishRepositoryInput) {
      const providerKind = yield* ensureConcreteProvider({
        operation: "publishRepository",
        provider: input.provider,
      });
      const provider = yield* providers.get(providerKind);
      const urls = yield* provider.createRepository({
        cwd: input.cwd,
        repository: input.repository.trim(),
        visibility: input.visibility,
      });
      const remoteUrl = yield* resolveRemoteUrl(providerKind, urls, input.protocol, input.cwd);
      const remoteName = yield* git.ensureRemote({
        cwd: input.cwd,
        preferredName: input.remoteName?.trim() || "origin",
        url: remoteUrl,
      });

      // An empty local repo (no commits) would make `git push HEAD:...` fail
      // with an opaque "src refspec HEAD does not match any". Treat this as a
      // partial success: the remote was created and wired up, but there is
      // nothing to push yet.
      const hasCommits = yield* git
        .execute({
          operation: "SourceControlRepositoryService.publishRepository.headCheck",
          cwd: input.cwd,
          args: ["rev-parse", "--verify", "HEAD"],
        })
        .pipe(
          Effect.map(() => true),
          Effect.orElseSucceed(() => false),
        );
      if (!hasCommits) {
        const details = yield* git.statusDetails(input.cwd).pipe(Effect.orElseSucceed(() => null));
        return {
          repository: toRepositoryInfo(providerKind, urls),
          remoteName,
          remoteUrl,
          branch: details?.branch ?? "main",
          status: "remote_added" as const,
        };
      }

      const pushResult = yield* git.pushCurrentBranch(input.cwd, null, { remoteName });

      return {
        repository: toRepositoryInfo(providerKind, urls),
        remoteName,
        remoteUrl,
        branch: pushResult.branch,
        ...(pushResult.upstreamBranch ? { upstreamBranch: pushResult.upstreamBranch } : {}),
        status: "pushed" as const,
      };
    },
  );

  return SourceControlRepositoryService.of({
    lookupRepository: (input) =>
      lookupRepository(input).pipe(mapRepositoryError("lookupRepository", input.provider)),
    prepareClone: (input, options) =>
      prepareClone(input, options).pipe(
        mapRepositoryError(
          "cloneRepository",
          input.provider ?? SourceControlProviderKind.make("unknown"),
        ),
      ),
    cloneRepository: (input, options) =>
      cloneRepository(input, options).pipe(
        mapRepositoryError(
          "cloneRepository",
          input.provider ?? SourceControlProviderKind.make("unknown"),
        ),
      ),
    discardClone: (destinationPath) =>
      discardClone(destinationPath).pipe(
        mapRepositoryError("discardClone", SourceControlProviderKind.make("unknown")),
      ),
    publishRepository: (input) =>
      publishRepository(input).pipe(mapRepositoryError("publishRepository", input.provider)),
  });
});

export const layer = Layer.effect(SourceControlRepositoryService, make);
