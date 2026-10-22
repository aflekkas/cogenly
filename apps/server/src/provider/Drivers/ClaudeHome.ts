import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/**
 * Resolve the Claude config directory the CLI would use: the instance's
 * `homePath` (exported as `CLAUDE_CONFIG_DIR`), then an inherited
 * `CLAUDE_CONFIG_DIR`, then Claude's default `~/.claude`. Empty must not
 * fall back to bare `$HOME` — that leftover from the old HOME override
 * produced a different continuation group than an explicit `~/.claude`.
 */
export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath, home));
  }
  // Inherited env vars are not shell-expanded, so a literal `~` stays literal.
  const inherited = environment?.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(home, ".claude"));
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    // Isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
    // Overriding HOME also relocates the macOS login keychain lookup
    // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
    // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
    // Claude Code at its config dir directly while leaving HOME (and the
    // keychain) intact.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

// Claude Code names a project's session folder after its cwd with every
// non-alphanumeric character replaced by `-`. Longer names are cut to this
// length and get a hash suffix, which differs between the CLI and the SDK, so
// those folders are matched by prefix.
const CLAUDE_PROJECT_DIR_MAX_LENGTH = 200;

export const claudeProjectDirName = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/**
 * The config dir the spawned CLI reads sessions from: `CLAUDE_CONFIG_DIR` of
 * the environment it is spawned with (resolved against its cwd, as the CLI
 * does), else `~/.claude` under that environment's HOME.
 */
export const resolveClaudeSessionConfigDir = Effect.fn("resolveClaudeSessionConfigDir")(
  function* (input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly cwd: string;
  }): Effect.fn.Return<string, never, Path.Path> {
    const path = yield* Path.Path;
    const configured = input.environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
    if (configured.length > 0) return path.resolve(input.cwd, configured);
    const home = input.environment.HOME?.trim() || (yield* HostProcess.HomeDirectory);
    return path.join(home, ".claude");
  },
);

/**
 * Whether `claude --resume <sessionId>` run in `cwd` against `configDir` finds
 * the session. The CLI only looks in the folder for its own cwd under its own
 * config dir, so a session created in another cwd or account is not found.
 * A filesystem error other than absence counts as found: only a provably
 * missing transcript should cost the native session.
 */
export const claudeSessionTranscriptExists = Effect.fn("claudeSessionTranscriptExists")(
  function* (input: {
    readonly configDir: string;
    readonly cwd: string;
    readonly sessionId: string;
  }): Effect.fn.Return<boolean, never, FileSystem.FileSystem | Path.Path> {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectsDir = path.join(input.configDir, "projects");
    const fileName = `${input.sessionId}.jsonl`;
    const exists = (file: string) => fileSystem.exists(file).pipe(Effect.orElseSucceed(() => true));
    const cwds = new Set([input.cwd]);
    // The CLI may record the realpath (macOS /tmp -> /private/tmp).
    const realCwd = yield* fileSystem.realPath(input.cwd).pipe(Effect.option);
    if (realCwd._tag === "Some") cwds.add(realCwd.value);
    let entries: ReadonlyArray<string> | undefined;
    for (const cwd of cwds) {
      const dirName = claudeProjectDirName(cwd);
      if (dirName.length <= CLAUDE_PROJECT_DIR_MAX_LENGTH) {
        if (yield* exists(path.join(projectsDir, dirName, fileName))) return true;
        continue;
      }
      entries ??= yield* fileSystem
        .readDirectory(projectsDir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const prefix = `${dirName.slice(0, CLAUDE_PROJECT_DIR_MAX_LENGTH)}-`;
      for (const entry of entries) {
        if (entry.startsWith(prefix) && (yield* exists(path.join(projectsDir, entry, fileName)))) {
          return true;
        }
      }
    }
    return false;
  },
);

/**
 * Whether an administrator installed Claude Code's `managed-mcp.json`. While it
 * exists Claude refuses `--strict-mcp-config` and exits before initializing,
 * but it already ignores user, project and `--mcp-config` servers on its own,
 * so callers that pass the flag for isolation can drop it. Paths match the
 * ones Claude Code checks.
 */
export const hasClaudeManagedMcpConfig = Effect.fn("hasClaudeManagedMcpConfig")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const managedMcpConfigPath =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-mcp.json"
      : platform === "win32"
        ? "C:\\Program Files\\ClaudeCode\\managed-mcp.json"
        : "/etc/claude-code/managed-mcp.json";
  return yield* fileSystem.exists(managedMcpConfigPath).pipe(Effect.orElseSucceed(() => false));
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);

/**
 * Describe the spawned CLI's environment separately from the login command so
 * paths remain literal on every shell, including relative inherited values.
 */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};
