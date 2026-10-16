/**
 * ProjectFaviconResolver - Effect service contract for project icon discovery.
 *
 * Resolves a representative favicon or app icon file for a workspace by
 * checking common file locations and project source metadata.
 *
 * @module ProjectFaviconResolver
 */
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

// Resolution probes ~40 well-known paths plus 7 source files per package
// root, so a miss costs a few hundred filesystem probes across a monorepo.
// AssetAccess resolves on every project-favicon asset URL, and a project's
// icon does not move, so the answer is cached.
const FAVICON_CACHE_CAPACITY = 512;
const FAVICON_POSITIVE_CACHE_TTL = Duration.minutes(10);
const FAVICON_NEGATIVE_CACHE_TTL = Duration.minutes(1);

function faviconCacheKey(cwd: string, faviconPath?: string): string {
  return `${faviconPath ?? ""}\0${cwd}`;
}

function parseFaviconCacheKey(key: string): {
  readonly cwd: string;
  readonly faviconPath?: string;
} {
  const separatorIndex = key.indexOf("\0");
  if (separatorIndex === -1) {
    return { cwd: key };
  }
  const faviconPath = key.slice(0, separatorIndex);
  const cwd = key.slice(separatorIndex + 1);
  return faviconPath.length === 0 ? { cwd } : { cwd, faviconPath };
}

// Well-known favicon paths checked in order, relative to a package root.
// Vector and large raster icons come before .ico, which is often 16px only.
const FAVICON_CANDIDATES = [
  "favicon.svg",
  "favicon.png",
  "favicon.ico",
  "icon.svg",
  "icon.png",
  "public/favicon.svg",
  "public/icon.svg",
  "public/logo.svg",
  "public/apple-touch-icon.png",
  "public/favicon.png",
  "public/icon.png",
  "public/favicon.ico",
  "static/favicon.svg",
  "static/favicon.png",
  "static/favicon.ico",
  "app/icon.svg",
  "app/icon.png",
  "app/apple-icon.png",
  "app/favicon.png",
  "app/favicon.ico",
  "app/icon.ico",
  "src/favicon.svg",
  "src/favicon.png",
  "src/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "src/app/apple-icon.png",
  "src/app/favicon.ico",
  "src/assets/logo.svg",
  "src/assets/icon.svg",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
  "assets/images/icon.png",
  "apple-touch-icon.png",
  "build/icon.png",
  "resources/icon.png",
  ".idea/icon.svg",
  "Resources/AppIcon.icns",
  "AppIcon.icns",
] as const;

// Monorepo folders whose children are package roots worth probing when the
// workspace root has no icon of its own.
const MONOREPO_PACKAGE_DIRS = ["apps", "packages", "sites", "services"] as const;

// Single-folder frontends that sit beside a backend at the workspace root.
const NESTED_APP_DIRS = ["web", "frontend", "client", "site", "www", "app", "ui"] as const;

// User-facing apps carry the brand icon, so they are probed first. Other
// packages follow alphabetically.
const PREFERRED_PACKAGE_NAMES = [
  "web",
  "app",
  "frontend",
  "client",
  "site",
  "www",
  "desktop",
  "mobile",
  "marketing",
  "docs",
] as const;

// Bounds a miss in a large monorepo.
const MAX_NESTED_PACKAGE_ROOTS = 16;

// Files that may contain a <link rel="icon"> or icon metadata declaration.
const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
] as const;

// Matches <link ...> tags or object-like icon metadata where rel/href can appear in any order.
// The tag pattern is anchored on `<link`, so it only starts at real candidates. Object metadata
// is matched by scanning brace-free runs instead of by one combined pattern: an unanchored
// pattern restarts at every offset and rescans forward, which is quadratic on large sources.
const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon|apple-touch-icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const ICON_REL_RE = /\brel\s*:\s*["'](?:icon|shortcut icon)["']/i;
const ICON_HREF_RE = /\bhref\s*:\s*["']([^"'?]+)/i;

export class ProjectFaviconResolutionError extends Schema.TaggedError<ProjectFaviconResolutionError>()(
  "ProjectFaviconResolutionError",
  {
    operation: Schema.Literals([
      "normalize-workspace",
      "resolve-path",
      "stat-candidate",
      "read-source",
    ]),
    workspaceRoot: Schema.String,
    relativePath: Schema.optional(Schema.String),
    absolutePath: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to resolve project favicon during ${this.operation} for workspace ${this.workspaceRoot}.`;
  }
}

const isWorkspaceRootNotExistsError = Schema.is(WorkspacePaths.WorkspaceRootNotExistsError);

/** True when the workspace root itself is gone, e.g. a moved or deleted checkout. */
export const isMissingWorkspaceRoot = (error: ProjectFaviconResolutionError): boolean =>
  error.operation === "normalize-workspace" && isWorkspaceRootNotExistsError(error.cause);

/** Service tag for project favicon resolution. */
export class ProjectFaviconResolver extends Context.Service<
  ProjectFaviconResolver,
  {
    /**
     * Resolve a favicon or icon file path for the provided workspace root.
     *
     * Returns `null` when no candidate icon file can be found.
     */
    readonly resolvePath: (
      cwd: string,
      faviconPath?: string,
    ) => Effect.Effect<string | null, ProjectFaviconResolutionError>;
  }
>()("t3/project/ProjectFaviconResolver") {}

function extractIconHref(source: string): string | null {
  const htmlMatch = source.match(LINK_ICON_HTML_RE);
  if (htmlMatch?.[1]) return htmlMatch[1];
  // Icon metadata counts when `rel` and `href` share a brace-free run, so a run holding `rel`
  // but no href falls through to the next one rather than ending the search.
  for (const run of source.split("}")) {
    if (!ICON_REL_RE.test(run)) continue;
    const hrefMatch = run.match(ICON_HREF_RE);
    if (hrefMatch?.[1]) return hrefMatch[1];
  }
  return null;
}

const optionOnNotFound = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<Option.Option<A>, PlatformError.PlatformError, R> =>
  effect.pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none<A>()) : Effect.fail(error),
    }),
  );

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const projectFileLoader = yield* T3ProjectFileLoader.T3ProjectFileLoader;

  const resolveIconHref = (packageRoot: string, href: string): ReadonlyArray<string> => {
    const clean = href.replace(/^\//, "");
    return [path.join(packageRoot, "public", clean), path.join(packageRoot, clean)];
  };

  const findExistingFile = Effect.fn("ProjectFaviconResolver.findExistingFile")(function* (
    projectCwd: string,
    relativeCandidates: ReadonlyArray<string>,
    candidateScope: "workspace" | "filesystem",
  ): Effect.fn.Return<string | null, ProjectFaviconResolutionError> {
    for (const relativePath of relativeCandidates) {
      const candidate = yield* (
        candidateScope === "filesystem" && path.isAbsolute(relativePath)
          ? Effect.succeed({ absolutePath: relativePath, relativePath })
          : workspacePaths.resolveRelativePathWithinRoot({
              workspaceRoot: projectCwd,
              relativePath,
            })
      ).pipe(
        Effect.asSome,
        Effect.catchTags({
          WorkspacePathOutsideRootError: () =>
            Effect.succeed(
              Option.none<{ readonly absolutePath: string; readonly relativePath: string }>(),
            ),
        }),
      );
      if (Option.isNone(candidate)) {
        continue;
      }
      const stats = yield* optionOnNotFound(fileSystem.stat(candidate.value.absolutePath)).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectFaviconResolutionError({
              operation: "stat-candidate",
              workspaceRoot: projectCwd,
              relativePath,
              absolutePath: candidate.value.absolutePath,
              cause,
            }),
        ),
      );
      if (Option.isSome(stats) && stats.value.type === "File") {
        return candidate.value.absolutePath;
      }
    }
    return null;
  });

  // Reads one source file under a package root and resolves the icon it
  // declares, if any. Hrefs are relative to that package's web root.
  const findIconFromSource = Effect.fn("ProjectFaviconResolver.findIconFromSource")(function* (
    projectCwd: string,
    packageRoot: string,
    packageSourceFile: string,
  ): Effect.fn.Return<string | null, ProjectFaviconResolutionError> {
    const sourceFile = path.join(packageRoot, packageSourceFile);
    const sourcePath = yield* workspacePaths
      .resolveRelativePathWithinRoot({
        workspaceRoot: projectCwd,
        relativePath: sourceFile,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectFaviconResolutionError({
              operation: "resolve-path",
              workspaceRoot: projectCwd,
              relativePath: sourceFile,
              cause,
            }),
        ),
      );
    const source = yield* optionOnNotFound(fileSystem.readFileString(sourcePath.absolutePath)).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectFaviconResolutionError({
            operation: "read-source",
            workspaceRoot: projectCwd,
            relativePath: sourceFile,
            absolutePath: sourcePath.absolutePath,
            cause,
          }),
      ),
    );
    if (Option.isNone(source)) {
      return null;
    }
    const href = extractIconHref(source.value);
    if (!href) {
      return null;
    }
    return yield* findExistingFile(projectCwd, resolveIconHref(packageRoot, href), "workspace");
  });

  // Starts every probe at once and returns the first hit in list order. A miss
  // costs one round of filesystem latency instead of one per probe, which
  // matters when the disk is slow. Fibers are joined in order, so a hit returns
  // without waiting for lower-ranked probes (the scope interrupts them), and a
  // failure surfaces only when no earlier probe found a file.
  const firstInOrder = <A>(
    items: ReadonlyArray<A>,
    probe: (item: A) => Effect.Effect<string | null, ProjectFaviconResolutionError>,
  ) =>
    Effect.gen(function* () {
      const fibers = yield* Effect.forEach(items, (item) => Effect.forkScoped(probe(item)));
      for (const fiber of fibers) {
        const found = yield* Fiber.join(fiber);
        if (found) {
          return found;
        }
      }
      return null;
    }).pipe(Effect.scoped);

  // Well-known files first, then icons declared in HTML or route sources.
  const resolveInPackageRoot = (projectCwd: string, packageRoot: string) =>
    Effect.gen(function* () {
      const wellKnown = yield* firstInOrder(FAVICON_CANDIDATES, (candidate) =>
        findExistingFile(projectCwd, [path.join(packageRoot, candidate)], "workspace"),
      );
      if (wellKnown) {
        return wellKnown;
      }
      return yield* firstInOrder(ICON_SOURCE_FILES, (sourceFile) =>
        findIconFromSource(projectCwd, packageRoot, sourceFile),
      );
    });

  const isDirectory = (absolutePath: string) =>
    fileSystem.stat(absolutePath).pipe(
      Effect.map((stats) => stats.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  // Package roots one level below the monorepo folders, plus a lone web/ or
  // client/ beside a backend. Listing is best effort: an unreadable folder
  // just contributes nothing.
  const listNestedPackageRoots = Effect.fn("ProjectFaviconResolver.listNestedPackageRoots")(
    function* (projectCwd: string) {
      const listed = yield* Effect.forEach(
        MONOREPO_PACKAGE_DIRS,
        (parent) =>
          fileSystem.readDirectory(path.join(projectCwd, parent)).pipe(
            Effect.orElseSucceed((): ReadonlyArray<string> => []),
            Effect.map((names) =>
              names
                .filter((name) => !name.startsWith(".") && name !== "node_modules")
                .toSorted((left, right) => {
                  const rank = (name: string) => {
                    const index = (PREFERRED_PACKAGE_NAMES as ReadonlyArray<string>).indexOf(name);
                    return index === -1 ? PREFERRED_PACKAGE_NAMES.length : index;
                  };
                  return rank(left) - rank(right) || left.localeCompare(right);
                })
                .map((name) => path.join(parent, name)),
            ),
          ),
        { concurrency: "unbounded" },
      );
      const candidates = [...NESTED_APP_DIRS, ...listed.flat()];
      const directories = yield* Effect.forEach(
        candidates,
        (relative) =>
          isDirectory(path.join(projectCwd, relative)).pipe(
            Effect.map((isDir) => (isDir ? relative : null)),
          ),
        { concurrency: "unbounded" },
      );
      return directories
        .filter((relative): relative is string => relative !== null)
        .slice(0, MAX_NESTED_PACKAGE_ROOTS);
    },
  );

  const resolvePathUncached = Effect.fn("ProjectFaviconResolver.resolvePathUncached")(function* (
    cwd: string,
    faviconPath?: string,
  ): Effect.fn.Return<string | null, ProjectFaviconResolutionError> {
    const projectCwd = yield* workspacePaths.normalizeWorkspaceRoot(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectFaviconResolutionError({
            operation: "normalize-workspace",
            workspaceRoot: cwd,
            cause,
          }),
      ),
    );
    // A grouped project's saved path can be absent from one checkout. Use it
    // where it exists and retain automatic discovery for the other checkouts.
    if (faviconPath !== undefined) {
      const existing = yield* findExistingFile(projectCwd, [faviconPath], "filesystem");
      if (existing) {
        return existing;
      }
    }

    // A t3.json iconPath takes precedence over the well-known locations.
    const projectFile = yield* projectFileLoader.load(projectCwd);
    if (Option.isSome(projectFile) && projectFile.value.iconPath !== undefined) {
      const existing = yield* findExistingFile(
        projectCwd,
        [projectFile.value.iconPath],
        "workspace",
      );
      if (existing) {
        return existing;
      }
    }

    const atRoot = yield* resolveInPackageRoot(projectCwd, "");
    if (atRoot) {
      return atRoot;
    }

    // A monorepo keeps its icon in an app: apps/web/public/favicon.svg.
    const packageRoots = yield* listNestedPackageRoots(projectCwd);
    return yield* firstInOrder(packageRoots, (packageRoot) =>
      resolveInPackageRoot(projectCwd, packageRoot),
    );
  });

  const faviconCache = yield* Cache.makeWith<string, string | null, ProjectFaviconResolutionError>(
    (key) => {
      const { cwd, faviconPath } = parseFaviconCacheKey(key);
      return resolvePathUncached(cwd, faviconPath);
    },
    {
      capacity: FAVICON_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (value: string | null) =>
          value === null ? FAVICON_NEGATIVE_CACHE_TTL : FAVICON_POSITIVE_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );

  const resolvePath: ProjectFaviconResolver["Service"]["resolvePath"] = Effect.fn(
    "ProjectFaviconResolver.resolvePath",
  )(function* (cwd, faviconPath) {
    const key = faviconCacheKey(cwd, faviconPath);
    const cached = yield* Cache.get(faviconCache, key);
    if (cached === null) {
      return null;
    }

    // A hit still confirms the file with one stat rather than the ~20 probes a
    // full walk costs, so a deleted icon falls back at once instead of after
    // the TTL.
    const stats = yield* optionOnNotFound(fileSystem.stat(cached)).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectFaviconResolutionError({
            operation: "stat-candidate",
            workspaceRoot: cwd,
            absolutePath: cached,
            cause,
          }),
      ),
    );
    if (Option.isSome(stats) && stats.value.type === "File") {
      return cached;
    }

    yield* Cache.invalidate(faviconCache, key);
    return yield* Cache.get(faviconCache, key);
  });

  return ProjectFaviconResolver.of({ resolvePath });
});

export const layer = Layer.effect(ProjectFaviconResolver, make);
