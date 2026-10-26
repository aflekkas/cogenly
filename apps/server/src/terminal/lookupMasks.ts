import type { ServerSettings } from "@cogenly/contracts";
import { expandHomePath } from "@cogenly/provider-core/server/pathExpansion";
import * as HostProcess from "@cogenly/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as ServerConfig from "../config.ts";
import { resolveProjectsRootDirectory } from "../project/ProjectsRoot.ts";
import type { LookupMasks } from "./readOnlyLookup.ts";

const homeVariables = new Set(["CLAUDE_CONFIG_DIR", "CODEX_HOME"]);

const configuredHomes = (settings: ServerSettings | null): string[] =>
  Object.values(settings?.providerInstances ?? {}).flatMap((instance) => {
    const config: unknown = instance.config;
    const fromConfig =
      typeof config === "object" && config !== null
        ? ["homePath", "shadowHomePath"].map((key) => Reflect.get(config, key))
        : [];
    const fromEnvironment = (instance.environment ?? [])
      .filter((variable) => homeVariables.has(variable.name))
      .map((variable) => variable.value);
    return [...fromConfig, ...fromEnvironment].flatMap((value) =>
      typeof value === "string" && value.trim() !== "" ? [value.trim()] : [],
    );
  });

/**
 * Paths a chat lookup sandbox hides, derived from this server's config and
 * provider instances. The whole Cogenly home is hidden (database, secrets,
 * vault key, signing keys, sessions, browser profiles, provider homes,
 * backups), with the workspace and tool roots inside it shown again.
 */
export const resolveLookupMasks = Effect.fn("resolveLookupMasks")(function* (input: {
  readonly config: Option.Option<ServerConfig.ServerConfig["Service"]>;
  readonly settings: ServerSettings | null;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const inHome = (...segments: string[]) => path.join(home, ...segments);
  const config = Option.getOrUndefined(input.config);
  const hidden = [
    ...(config ? [config.baseDir, config.stateDir] : []),
    // A dev or test server's home is elsewhere; the installed one still holds real data.
    inHome(".cogenly", "userdata"),
    // Provider credentials: default homes, environment overrides, and every
    // configured instance home (including Codex shadow homes).
    inHome(".claude"),
    inHome(".claude.json"),
    inHome(".codex"),
    environment.CLAUDE_CONFIG_DIR,
    environment.CODEX_HOME,
    ...configuredHomes(input.settings),
    // SSH keys, GitHub CLI and git credential stores, keychains.
    inHome(".ssh"),
    path.join(environment.XDG_CONFIG_HOME || inHome(".config"), "gh"),
    environment.GH_CONFIG_DIR,
    inHome(".git-credentials"),
    path.join(environment.XDG_CONFIG_HOME || inHome(".config"), "git", "credentials"),
    inHome(".netrc"),
    ...(platform === "darwin" ? [inHome("Library", "Keychains"), "/Library/Keychains"] : []),
  ];
  const reexposed = config
    ? [
        config.worktreesDir,
        path.join(config.baseDir, "tools"),
        resolveProjectsRootDirectory(
          input.settings?.projectsRoot ?? "",
          home,
          config.baseDir,
          path,
        ),
        ...(input.settings?.worktreesDirectory.trim()
          ? [path.resolve(expandHomePath(input.settings.worktreesDirectory.trim(), home))]
          : []),
      ]
    : [];
  const resolved = new Map<string, LookupMasks["hidden"][number]>();
  for (const candidate of hidden) {
    if (!candidate) continue;
    const absolute = path.resolve(expandHomePath(candidate, home));
    const info = yield* fs.stat(absolute).pipe(Effect.option);
    if (Option.isNone(info)) {
      resolved.set(absolute, { path: absolute, kind: "missing" });
      continue;
    }
    const kind = info.value.type === "Directory" ? "directory" : "file";
    // Seatbelt and mounts both act on the resolved path; keep the spelled path
    // too on macOS, where a firmlink such as /var is matched as written.
    const real = yield* fs.realPath(absolute).pipe(Effect.orElseSucceed(() => absolute));
    resolved.set(real, { path: real, kind });
    if (platform === "darwin" && real !== absolute)
      resolved.set(absolute, { path: absolute, kind });
  }
  const shown: string[] = [];
  for (const root of reexposed) {
    const real = yield* fs.realPath(root).pipe(Effect.option);
    if (Option.isSome(real)) shown.push(real.value);
  }
  return {
    hidden: [...resolved.values()],
    reexposed: shown,
    serverPort: config && config.port > 0 ? config.port : null,
  } satisfies LookupMasks;
});
