import {
  BROWSER_IMPORT_FAILURE_COPY,
  BrowserCookieImportError,
  type BrowserCookieImportInput,
  type BrowserCookieImportResult,
  type BrowserImportSource,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Scope from "effect/Scope";
import { type ChromiumCookieReadError, readChromiumCookies } from "./ChromiumCookies.ts";
import { type ImportedCookie } from "./CookieDatabase.ts";
import { type FirefoxCookieReadError, readFirefoxCookies } from "./FirefoxCookies.ts";
import {
  type SafariCookieReadError,
  readSafariCookies,
  safariAccessDenied,
} from "./SafariCookies.ts";
import {
  BROWSER_IMPORT_SOURCES,
  listSourceProfiles,
  resolveCookieDatabase,
  sourcePathContext,
} from "./Sources.ts";

export class LocalBrowserCookies extends Context.Service<
  LocalBrowserCookies,
  {
    readonly listSources: Effect.Effect<ReadonlyArray<BrowserImportSource>>;
    readonly importCookies: (
      input: BrowserCookieImportInput,
      /** Local sink only: raw cookies must never be returned by a transport or stored in the vault. */
      write: (profileId: string, cookie: ImportedCookie) => Promise<void>,
    ) => Effect.Effect<BrowserCookieImportResult, BrowserCookieImportError>;
  }
>()("@cogenly/shared/browserCookies/LocalBrowserCookies") {}

/** A filter includes the exact host and its subdomains, never a suffix lookalike. */
export const matchesCookieDomain = (host: string, domains: readonly string[] | undefined) =>
  domains === undefined ||
  domains.some((domain) => {
    const normalized = domain.toLowerCase();
    return host === normalized || host.endsWith(`.${normalized}`);
  });

const make = Effect.gen(function* () {
  const context = yield* sourcePathContext;
  const services = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  const definitions = BROWSER_IMPORT_SOURCES.filter(
    (source) =>
      source.platforms.includes(context.platform) &&
      (context.platform !== "win32" || source.engine === "firefox"),
  );
  // No process-lock gate: the SQLite backup reads a consistent, read-only snapshot, including WAL.
  const listSources = Effect.forEach(
    definitions,
    Effect.fnUntraced(function* (definition) {
      const reported = yield* listSourceProfiles(definition, context);
      const found = yield* Effect.forEach(reported, (profile) =>
        resolveCookieDatabase(definition, context, profile.directory).pipe(
          Effect.map((database) => (database === undefined ? undefined : profile)),
        ),
      );
      const profiles = found.filter((profile) => profile !== undefined);
      if (profiles.length === 0) return undefined;
      const jar =
        definition.engine === "safari"
          ? yield* resolveCookieDatabase(definition, context, profiles[0]!.directory)
          : undefined;
      const denied = jar !== undefined && (yield* safariAccessDenied(jar));
      return {
        id: definition.id,
        name: definition.name,
        profiles,
        ...(denied ? { unavailable: "needsFullDiskAccess" as const } : {}),
      } satisfies BrowserImportSource;
    }),
  ).pipe(
    Effect.map((sources) => sources.filter((source) => source !== undefined)),
    Effect.provide(services),
  );

  const importCookies = Effect.fnUntraced(function* (
    input: BrowserCookieImportInput,
    write: (profileId: string, cookie: ImportedCookie) => Promise<void>,
  ) {
    const targetProfileId = input.targetProfileId ?? "default";
    if (targetProfileId === "incognito")
      return yield* new BrowserCookieImportError({
        message: "Choose a persistent Cogenly browser profile.",
      });
    const sources = (yield* listSources).filter(
      (source) => input.sourceId === undefined || source.id === input.sourceId,
    );
    if (sources.length === 0)
      return yield* new BrowserCookieImportError({
        message: "No matching browser cookie stores were found on this machine.",
      });
    if (input.sourceProfileDirectory !== undefined && input.sourceId === undefined) {
      return yield* new BrowserCookieImportError({
        message: "Choose a source browser when selecting a source profile.",
      });
    }
    const now = (yield* Clock.currentTimeMillis) / 1000;
    const counts = new Map<string, number>();
    const warnings = new Set<string>();
    let available = 0;
    let imported = 0;
    let skipped = 0;
    for (const source of sources) {
      const definition = definitions.find((candidate) => candidate.id === source.id)!;
      const profiles = source.profiles.filter(
        (profile) =>
          input.sourceProfileDirectory === undefined ||
          profile.directory === input.sourceProfileDirectory ||
          profile.name === input.sourceProfileDirectory,
      );
      if (profiles.length === 0)
        return yield* new BrowserCookieImportError({
          message: "That source browser profile was not found.",
        });
      for (const profile of profiles) {
        const database = yield* resolveCookieDatabase(definition, context, profile.directory).pipe(
          Effect.provide(services),
        );
        if (database === undefined) continue;
        const read: Effect.Effect<
          { cookies: readonly ImportedCookie[]; undecryptable: number },
          ChromiumCookieReadError | FirefoxCookieReadError | SafariCookieReadError,
          FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
        > =
          definition.engine === "safari"
            ? readSafariCookies(database).pipe(
                Effect.map((cookies) => ({ cookies, undecryptable: 0 })),
              )
            : definition.engine === "firefox"
              ? readFirefoxCookies(database).pipe(
                  Effect.map((cookies) => ({ cookies, undecryptable: 0 })),
                )
              : readChromiumCookies({
                  cookieDatabasePath: database,
                  keychainService: definition.keychainService,
                  keychainAccount: definition.keychainAccount,
                  linuxSecretApplication: definition.linuxSecretApplication,
                  platform: context.platform,
                });
        // Parser and driver errors can contain raw rows. Do not attach them as causes, log them,
        // or pass them into a traced transport. Only fixed, actionable copy escapes this boundary.
        const result = yield* read.pipe(
          Effect.withTracerEnabled(false),
          Effect.scoped,
          Effect.provide(services),
          Effect.mapError(
            (error) =>
              new BrowserCookieImportError({
                message:
                  "reason" in error
                    ? BROWSER_IMPORT_FAILURE_COPY[error.reason]
                    : BROWSER_IMPORT_FAILURE_COPY.readFailed,
              }),
          ),
        );
        skipped += result.undecryptable;
        if (result.undecryptable > 0)
          warnings.add("Some encrypted or partitioned cookies could not be imported.");
        for (const cookie of result.cookies) {
          let host: string;
          try {
            host = new URL(cookie.url).hostname.toLowerCase();
          } catch {
            skipped += 1;
            continue;
          }
          if (!matchesCookieDomain(host, input.domains)) continue;
          if (
            cookie.expirationDate !== undefined &&
            (!Number.isFinite(cookie.expirationDate) || cookie.expirationDate <= now)
          ) {
            skipped += 1;
            continue;
          }
          available += 1;
          if (input.dryRun) counts.set(host, (counts.get(host) ?? 0) + 1);
          if (!input.dryRun) {
            const written = yield* Effect.tryPromise({
              try: () => write(targetProfileId, cookie),
              catch: () =>
                new BrowserCookieImportError({ message: "The target browser rejected a cookie." }),
            }).pipe(
              Effect.as(true),
              Effect.catchTags({ BrowserCookieImportError: () => Effect.succeed(false) }),
            );
            if (written) {
              imported += 1;
              counts.set(host, (counts.get(host) ?? 0) + 1);
            } else {
              skipped += 1;
              warnings.add(
                "Some cookies were rejected by the target browser. Check that its profile can open.",
              );
            }
          }
        }
      }
    }
    if (
      definitions.some(
        (source) =>
          source.engine === "safari" && sources.some((candidate) => candidate.id === source.id),
      )
    )
      warnings.add("Safari does not expose reliable SameSite metadata; imported cookies use Lax.");
    return {
      targetProfileId,
      dryRun: input.dryRun ?? false,
      imported,
      available,
      skipped,
      domains: [...counts]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([domain, count]) => ({ domain, count })),
      warnings: [...warnings],
      reloadRequired: imported > 0,
    } satisfies BrowserCookieImportResult;
  });
  return LocalBrowserCookies.of({ listSources, importCookies });
});

export const layer = Layer.effect(LocalBrowserCookies, make);
