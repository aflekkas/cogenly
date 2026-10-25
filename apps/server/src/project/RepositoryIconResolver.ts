import * as GitHubRest from "@cogenly/source-control-github/server/GitHubRest";
import { repositoryRemoteParts } from "@cogenly/contracts";
import { isProjectFaviconPath } from "@cogenly/shared/projectFavicon";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";

/** Where a linked repository's icon comes from on this server. */
export type RepositoryIcon =
  /** A file on this server: a checkout's favicon, or a cached copy of the synced one. */
  | { readonly kind: "file"; readonly path: string }
  /** The owner's GitHub avatar, for the image proxy to fetch. */
  | { readonly kind: "avatar"; readonly url: string }
  | null;

/**
 * The one place a linked repository's icon is decided, cloned here or not,
 * in order: the favicon of a checkout on this machine (the project icon
 * resolver, honouring the record's chosen favicon), then the icon file a
 * machine with a checkout recorded on the link (fetched once from GitHub
 * with this machine's GitHub auth and cached on disk), then the owner's
 * GitHub avatar. Null for a remote that is not on GitHub and has no
 * checkout here.
 */
export class RepositoryIconResolver extends Context.Service<
  RepositoryIconResolver,
  {
    readonly resolve: (remote: string) => Effect.Effect<RepositoryIcon>;
  }
>()("cogenly-server/project/RepositoryIconResolver") {}

// A cached copy is refetched after a week; a failed fetch is not retried for ten minutes.
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;
const MAX_ICON_BYTES = 1024 * 1024;

const decodeContents = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ encoding: Schema.Literal("base64"), content: Schema.String }),
  ),
);

/** A synced icon path that can only name a file inside the repository. */
const isSafeIconPath = (iconPath: string) =>
  isProjectFaviconPath(iconPath) &&
  !iconPath.startsWith("/") &&
  iconPath.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");

/** A GitHub owner's own "remote", as clients ask for a project's owner avatar. */
const GITHUB_OWNER_REMOTE = /^github\.com\/([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)$/i;

const ownerAvatar = (owner: string): RepositoryIcon => ({
  kind: "avatar",
  url: `https://github.com/${encodeURIComponent(owner)}.png?size=96`,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const favicons = yield* ProjectFaviconResolver.ProjectFaviconResolver;
  const github = yield* Effect.serviceOption(GitHubRest.GitHubRest);
  const cacheDir = path.join(config.providerStatusCacheDir, "repository-icons");
  const misses = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

  const fromCheckout = (remote: string) =>
    Effect.gen(function* () {
      const records = yield* sql<{
        readonly workspaceRoot: string;
        readonly faviconPath: string | null;
      }>`SELECT p.workspace_root AS "workspaceRoot", p.favicon_path AS "faviconPath"
        FROM label_repositories r JOIN projection_projects p ON p.project_id = r.repository_id
        WHERE r.remote = ${remote} AND p.deleted_at IS NULL`;
      for (const record of records) {
        if (!(yield* fileSystem.exists(path.join(record.workspaceRoot, ".git")))) continue;
        const found = yield* favicons.resolvePath(
          record.workspaceRoot,
          record.faviconPath ?? undefined,
        );
        if (found !== null) return found;
      }
      return null;
    }).pipe(Effect.orElseSucceed(() => null));

  /** The synced icon, from the disk cache or fetched through GitHub's contents API. */
  const fromSyncedPath = (remote: string, owner: string, name: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly iconPath: string }>`
        SELECT icon_path AS "iconPath" FROM label_repositories
        WHERE remote = ${remote} AND icon_path IS NOT NULL LIMIT 1`;
      const iconPath = rows[0]?.iconPath;
      if (iconPath === undefined || !isSafeIconPath(iconPath)) return null;
      const digest = Hex.encode(
        yield* crypto.digest("SHA-256", new TextEncoder().encode(`${remote}\0${iconPath}`)),
      );
      const cached = path.join(cacheDir, `${digest}${path.extname(iconPath).toLowerCase()}`);
      const now = yield* Clock.currentTimeMillis;
      const info = yield* fileSystem.stat(cached).pipe(Effect.option);
      const age = Option.flatMap(info, (stat) => stat.mtime).pipe(
        Option.map((mtime) => now - mtime.getTime()),
      );
      if (Option.isSome(age) && age.value < CACHE_MAX_AGE_MS) return cached;
      const stale = Option.isSome(info) ? cached : null;
      if (((yield* Ref.get(misses)).get(digest) ?? 0) > now || Option.isNone(github)) return stale;
      const fetched = yield* github.value
        .rest({
          host: "github.com",
          operation: "repositoryIcon",
          path: `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${iconPath
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`,
          maxResponseBytes: MAX_ICON_BYTES * 2,
        })
        .pipe(
          Effect.map((response) =>
            response.status === 200 ? Option.getOrNull(decodeContents(response.body)) : null,
          ),
          Effect.orElseSucceed(() => null),
        );
      const decoded =
        fetched === null ? null : Base64.decode(fetched.content.replaceAll(/\s/g, ""));
      const bytes = decoded !== null && Result.isSuccess(decoded) ? decoded.success : null;
      if (bytes === null || bytes.length === 0 || bytes.length > MAX_ICON_BYTES) {
        yield* Ref.update(misses, (current) => new Map(current).set(digest, now + MISS_TTL_MS));
        return stale;
      }
      yield* fileSystem.makeDirectory(cacheDir, { recursive: true });
      // Written whole under a temporary name, so a reader never sees half an icon.
      const staging = `${cached}.${digest.slice(0, 8)}.tmp`;
      yield* fileSystem.writeFile(staging, bytes);
      yield* fileSystem.rename(staging, cached);
      return cached;
    }).pipe(Effect.orElseSucceed(() => null));

  const resolve: RepositoryIconResolver["Service"]["resolve"] = Effect.fn(
    "RepositoryIconResolver.resolve",
  )(function* (remote) {
    // `github.com/<owner>` alone names an owner, not a repository: a project
    // linked to that owner shows its avatar.
    const owner = GITHUB_OWNER_REMOTE.exec(remote)?.[1];
    if (owner !== undefined) return ownerAvatar(owner);
    const local = yield* fromCheckout(remote);
    if (local !== null) return { kind: "file", path: local };
    const parts = repositoryRemoteParts(remote);
    if (parts?.host !== "github.com" || !parts.owner || parts.owner.includes("/")) return null;
    const synced = yield* fromSyncedPath(remote, parts.owner, parts.name);
    if (synced !== null) return { kind: "file", path: synced };
    return ownerAvatar(parts.owner);
  });

  return RepositoryIconResolver.of({ resolve });
});

export const layer = Layer.effect(RepositoryIconResolver, make);
