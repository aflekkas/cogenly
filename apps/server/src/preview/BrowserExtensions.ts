// @effect-diagnostics nodeBuiltinImport:off - Copies unpacked folders without following links, and makes extension keys.
/**
 * Chromium extensions installed into a browser profile. Each environment owns
 * its list per profile: the files sit unpacked under
 * `<stateDir>/browser-extensions/<profile>/<id>/<version>`, next to a
 * `registry.json`, and full server Chrome loads the enabled ones from there
 * and streams to web and desktop clients (see `ServerBrowser`). Profiles are per client and
 * do not sync between machines, so neither does this list.
 *
 * Installs come only from the Chrome Web Store, verified as Chrome verifies
 * them (`BrowserExtensionCrx`), or from a folder on this machine.
 */
import {
  type BrowserExtension,
  BrowserExtensionError,
  type BrowserExtensionInstallInput,
  type BrowserExtensionInstallResult,
  type BrowserExtensionPage,
  type BrowserExtensionRemoveInput,
  type BrowserExtensionReloadInput,
  type BrowserExtensionOpenSurfaceInput,
  type BrowserExtensionOpenSurfaceResult,
  type BrowserExtensionsListInput,
  type BrowserExtensionsListResult,
  type BrowserExtensionSource,
  type BrowserExtensionToggleInput,
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  browserExtensionPageUrl,
} from "@cogenly/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as EffectNodeStream from "@effect/platform-node/NodeStream";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import * as ServerConfig from "../config.ts";
import { openZipArchive } from "../zipArchive.ts";
import {
  CrxError,
  extensionIdFromPublicKey,
  verifyCrx3,
  webStoreDownloadUrl,
  webStoreExtensionId,
} from "./BrowserExtensionCrx.ts";
import {
  ExtensionManifestError,
  manifestMessagesPath,
  summarizeManifest,
} from "./BrowserExtensionManifest.ts";
import { PREVIEW_BROWSER_CHROME_VERSION } from "./PreviewBrowser.ts";

/** Larger than any Web Store extension; bounds a download and what its archive may unpack to. */
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 50_000;
const DOWNLOAD_TIMEOUT = "3 minutes";

/** One extension as `registry.json` keeps it. */
const StoredExtension = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  description: Schema.String,
  manifestVersion: Schema.Int,
  enabled: Schema.Boolean,
  source: Schema.Union([
    Schema.Struct({ type: Schema.Literal("webStore") }),
    Schema.Struct({ type: Schema.Literal("folder"), path: Schema.String }),
  ]),
  permissions: Schema.Array(Schema.String),
  hostPermissions: Schema.Array(Schema.String),
  icon: Schema.optional(Schema.String),
  hasAction: Schema.optional(Schema.Boolean),
  sidePanelPage: Schema.optional(Schema.String),
  popupPage: Schema.optional(Schema.String),
  optionsPage: Schema.optional(Schema.String),
  installedAt: Schema.String,
  /** The directory under the extension's own folder holding this version's files. */
  directory: Schema.String,
  /**
   * For a folder install without a manifest `key`: the private key whose
   * public half Cogenly wrote into the copy's manifest, so a reinstall from
   * the same folder keeps the ID, and with it the extension's storage.
   */
  generatedKey: Schema.optional(Schema.String),
});
type StoredExtension = typeof StoredExtension.Type;

const Registry = Schema.Struct({ extensions: Schema.Array(StoredExtension) });
// Chrome tolerates a byte order mark before a manifest or messages file.
const decodeJsonValue = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = (text: string) => decodeJsonValue(text.replace(/^﻿/, ""));
const decodeObject = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isBrowserExtensionError = Schema.is(BrowserExtensionError);
const decodeRegistry = Schema.decodeUnknownEffect(Schema.fromJsonString(Registry));
const encodeRegistry = Schema.encodeEffect(Schema.fromJsonString(Registry));

export interface LoadableExtension {
  readonly id: string;
  /** The unpacked extension root on this machine. */
  readonly path: string;
}

// The broker supplies agent identity internally; toolbar RPCs use the wire input unchanged.
type SurfaceOpenInput = BrowserExtensionOpenSurfaceInput & {
  readonly agentSessionId?: string | undefined;
};

export class BrowserExtensions extends Context.Service<
  BrowserExtensions,
  {
    readonly list: (
      input: BrowserExtensionsListInput,
    ) => Effect.Effect<BrowserExtensionsListResult, BrowserExtensionError>;
    /** Installs or updates one extension, enabled. Replaces an installed copy with the same ID. */
    readonly install: (
      input: BrowserExtensionInstallInput,
    ) => Effect.Effect<BrowserExtensionInstallResult, BrowserExtensionError>;
    readonly reload: (
      input: BrowserExtensionReloadInput,
    ) => Effect.Effect<BrowserExtensionInstallResult, BrowserExtensionError>;
    readonly openSurface: (
      input: SurfaceOpenInput,
    ) => Effect.Effect<BrowserExtensionOpenSurfaceResult, BrowserExtensionError>;
    readonly registerSurfaceOpener: (
      open: (
        input: SurfaceOpenInput & { readonly profileId: string },
        extension: BrowserExtension,
      ) => Effect.Effect<BrowserExtensionOpenSurfaceResult, BrowserExtensionError>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly changes: Stream.Stream<string>;
    readonly subscribe: (
      input: BrowserExtensionsListInput,
    ) => Stream.Stream<BrowserExtensionsListResult, BrowserExtensionError>;
    readonly remove: (
      input: BrowserExtensionRemoveInput,
    ) => Effect.Effect<BrowserExtensionsListResult, BrowserExtensionError>;
    readonly toggle: (
      input: BrowserExtensionToggleInput,
    ) => Effect.Effect<BrowserExtension, BrowserExtensionError>;
    /** The enabled extensions a profile's browser loads. */
    readonly loadable: (profileId: string) => Effect.Effect<ReadonlyArray<LoadableExtension>>;
    /** Registers the browser adapter; the application scope owns background load attempts. */
    readonly registerLoader: (
      load: (profileId: string) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly reportLoad: (
      profileId: string,
      directory: string,
      error?: string,
    ) => Effect.Effect<void>;
    /** The URL of an installed extension's popup, options, or another page inside it. */
    readonly pageUrl: (input: {
      readonly profileId?: string | undefined;
      readonly id: string;
      readonly page: BrowserExtensionPage;
    }) => Effect.Effect<string, BrowserExtensionError>;
  }
>()("cogenly-server/preview/BrowserExtensions") {}

const fail = (message: string) => new BrowserExtensionError({ message });

const publicExtension = ({
  directory: _directory,
  generatedKey: _key,
  ...extension
}: StoredExtension) => ({
  ...extension,
  hasAction: extension.hasAction ?? Boolean(extension.popupPage),
});

export const makeBrowserExtensions = Effect.fn("BrowserExtensions.make")(function* (options: {
  readonly rootDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  // One change at a time per environment: installs are rare and touch shared registry files.
  const gate = yield* Semaphore.make(1);
  let loader: ((profileId: string) => Effect.Effect<void>) | undefined;
  let loaderScope: Scope.Scope | undefined;
  let surfaceOpener:
    | Parameters<BrowserExtensions["Service"]["registerSurfaceOpener"]>[0]
    | undefined;
  const loadGate = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<string>();
  const loadResults = new Map<string, string | undefined>();
  const loading = new Set<string>();
  const extensionPath = (profileId: string, extension: StoredExtension) =>
    path.join(profileDir(profileId), extension.id, extension.directory);
  const withLoadError = (profileId: string, stored: StoredExtension): BrowserExtension => {
    const error = stored.enabled ? loadResults.get(extensionPath(profileId, stored)) : undefined;
    return {
      ...publicExtension(stored),
      state: !stored.enabled
        ? "disabled"
        : error
          ? "failed"
          : loadResults.has(extensionPath(profileId, stored))
            ? "loaded"
            : loading.has(extensionPath(profileId, stored))
              ? "installing"
              : "pending",
      ...(error
        ? { error: `${stored.name}: ${error}`, loadError: `${stored.name}: ${error}` }
        : {}),
    };
  };

  const profileDir = (profileId: string) => {
    const encoded = encodeURIComponent(profileId);
    return path.join(
      options.rootDir,
      profileId === "." || profileId === ".." ? encoded.replaceAll(".", "%2E") : encoded,
    );
  };
  const registryPath = (profileId: string) => path.join(profileDir(profileId), "registry.json");

  const resolveProfile = (profileId: string | undefined) => {
    const id = profileId ?? DEFAULT_BROWSER_PROFILE_ID;
    return id === INCOGNITO_BROWSER_PROFILE_ID
      ? Effect.fail(fail("Incognito keeps nothing between sessions, so it has no extensions."))
      : Effect.succeed(id);
  };

  const readRegistry = (profileId: string) =>
    fs.readFileString(registryPath(profileId)).pipe(
      Effect.flatMap(decodeRegistry),
      Effect.flatMap((registry) =>
        Effect.forEach(registry.extensions, (stored) => {
          if (stored.hasAction !== undefined) return Effect.succeed(stored);
          // Older registries predate toolbar metadata. Read the installed copy,
          // without starting Chrome or changing the registry during a list read.
          return readManifest(extensionPath(profileId, stored)).pipe(
            Effect.map(({ summary, icon }) => ({
              ...stored,
              hasAction: summary.hasAction,
              ...(icon ? { icon } : {}),
              ...(summary.sidePanelPage ? { sidePanelPage: summary.sidePanelPage } : {}),
            })),
            Effect.orElseSucceed(() => stored),
          );
        }),
      ),
      Effect.catchCause(() => Effect.succeed<ReadonlyArray<StoredExtension>>([])),
    );

  const writeRegistry = (profileId: string, extensions: ReadonlyArray<StoredExtension>) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(profileDir(profileId), { recursive: true });
      const target = registryPath(profileId);
      const staged = `${target}.${NodeCrypto.randomUUID()}.tmp`;
      yield* fs.writeFileString(staged, yield* encodeRegistry({ extensions }));
      yield* fs.rename(staged, target);
    }).pipe(Effect.mapError(() => fail("Could not save the extension list in Cogenly's home.")));

  const listOf = (profileId: string) =>
    readRegistry(profileId).pipe(
      Effect.map((extensions) => ({
        profileId,
        extensions: extensions.map((extension) => withLoadError(profileId, extension)),
      })),
    );

  /** Unpacks a verified ZIP into `destination`, refusing anything that could escape it. */
  const unpack = Effect.fn("BrowserExtensions.unpack")(
    function* (archivePath: string, destination: string) {
      const archive = yield* openZipArchive(archivePath, (detail) => fail(`${detail}`));
      if (archive.entryCount > MAX_ENTRIES) return yield* fail("The package has too many files.");
      const unsafe = fail("The package contains an unexpected or unsafe file.");
      yield* fs.makeDirectory(destination, { recursive: true });
      let total = 0;
      for (;;) {
        const entry = yield* archive.next;
        if (!entry) break;
        const name = entry.fileName.replaceAll("\\", "/");
        const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
        const isDirectory = name.endsWith("/");
        const target = path.resolve(destination, name);
        if (
          name.startsWith("/") ||
          name.split("/").includes("..") ||
          !target.startsWith(`${destination}${path.sep}`) ||
          (unixType !== 0 && unixType !== (isDirectory ? 0o040000 : 0o100000)) ||
          (entry.generalPurposeBitFlag & 1) !== 0 ||
          ![0, 8].includes(entry.compressionMethod)
        ) {
          return yield* unsafe;
        }
        // The Web Store's signature data; Chrome refuses an unpacked extension that carries it.
        if (name === "_metadata/" || name.startsWith("_metadata/")) continue;
        if (isDirectory) {
          yield* fs.makeDirectory(target, { recursive: true });
          continue;
        }
        total += entry.uncompressedSize;
        if (total > MAX_UNPACKED_BYTES) return yield* fail("The package unpacks too large.");
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* Effect.gen(function* () {
          const readable = yield* archive.streamEntry(entry);
          yield* EffectNodeStream.fromReadable<Uint8Array, BrowserExtensionError>({
            evaluate: () => readable,
            onError: () => fail("Could not unpack the extension."),
          }).pipe(Stream.run(fs.sink(target, { flag: "wx" })));
        }).pipe(Effect.scoped);
      }
    },
    Effect.scoped,
    Effect.mapError((cause) =>
      isBrowserExtensionError(cause) ? cause : fail("Could not unpack the extension."),
    ),
  );

  const readManifest = (root: string) =>
    Effect.gen(function* () {
      const raw = yield* fs
        .readFileString(path.join(root, "manifest.json"))
        .pipe(Effect.mapError(() => fail("The extension has no manifest.json.")));
      const manifest = yield* decodeJson(raw).pipe(
        Effect.flatMap(decodeObject),
        Effect.mapError(() => fail("manifest.json is not a valid JSON object.")),
      );
      const messagesPath = manifestMessagesPath(manifest);
      const messages = messagesPath
        ? yield* fs.readFileString(path.join(root, messagesPath)).pipe(
            Effect.flatMap(decodeJson),
            Effect.orElseSucceed(() => undefined),
          )
        : undefined;
      const summary = yield* Effect.try({
        try: () => summarizeManifest(manifest, messages),
        catch: (cause) =>
          fail(
            cause instanceof ExtensionManifestError ? cause.message : "manifest.json is invalid.",
          ),
      });
      let icon: string | undefined;
      for (const candidate of summary.iconPaths) {
        const target = path.resolve(root, candidate);
        const mime = (
          {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
            ".ico": "image/x-icon",
            ".svg": "image/svg+xml",
          } as Readonly<Record<string, string>>
        )[path.extname(target).toLowerCase()];
        if (mime && target.startsWith(`${root}${path.sep}`)) {
          icon = yield* Effect.gen(function* () {
            const info = yield* fs.stat(target);
            if (info.type !== "File" || info.size > 12_288) return undefined;
            const bytes = yield* fs.readFile(target);
            const url = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
            return url.length <= 16_384 ? url : undefined;
          }).pipe(Effect.orElseSucceed(() => undefined));
          if (icon) break;
        }
      }
      return { manifest, summary, icon };
    });

  /** Pins the unpacked copy's ID to `publicKey` by writing it as the manifest `key`. */
  const writeManifestKey = (
    root: string,
    manifest: Readonly<Record<string, unknown>>,
    publicKey: Buffer,
  ) =>
    encodeJson({ ...manifest, key: publicKey.toString("base64") }).pipe(
      Effect.flatMap((text) => fs.writeFileString(path.join(root, "manifest.json"), text)),
      Effect.mapError(() => fail("Could not prepare the extension's manifest.")),
    );

  const downloadWebStore = Effect.fn("BrowserExtensions.downloadWebStore")(
    function* (extensionId: string, archivePath: string) {
      const response = yield* http
        .execute(
          HttpClientRequest.get(webStoreDownloadUrl(extensionId, PREVIEW_BROWSER_CHROME_VERSION)),
        )
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      const declared = Number(response.headers["content-length"] ?? 0);
      if (declared > MAX_PACKAGE_BYTES) return yield* fail("The extension is too large.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      yield* response.stream.pipe(
        Stream.runForEach((chunk) =>
          Effect.suspend(() => {
            size += chunk.byteLength;
            if (size > MAX_PACKAGE_BYTES) return Effect.fail(fail("The extension is too large."));
            chunks.push(chunk);
            return Effect.void;
          }),
        ),
      );
      if (size === 0) {
        return yield* fail(
          `The Chrome Web Store has no download for ${extensionId}. Check the link, or whether the extension is still listed.`,
        );
      }
      const verified = yield* Effect.try({
        try: () =>
          verifyCrx3(Buffer.concat(chunks), { expectedId: extensionId, requirePublisher: true }),
        catch: (cause) =>
          fail(cause instanceof CrxError ? cause.message : "The package is invalid."),
      });
      yield* fs
        .writeFile(archivePath, verified.archive)
        .pipe(Effect.mapError(() => fail("Could not save the download in Cogenly's home.")));
      return verified;
    },
    Effect.timeoutOrElse({
      duration: DOWNLOAD_TIMEOUT,
      orElse: () => Effect.fail(fail("The Chrome Web Store download timed out.")),
    }),
    Effect.mapError((cause) =>
      isBrowserExtensionError(cause)
        ? cause
        : fail("The Chrome Web Store download failed. Check this machine's network access."),
    ),
  );

  /** Copies a folder's regular files and directories; links are refused, never followed. */
  const copyFolder = (source: string, destination: string) =>
    Effect.tryPromise({
      try: async () => {
        let total = 0;
        let entries = 0;
        await NodeFSP.cp(source, destination, {
          recursive: true,
          errorOnExist: true,
          force: false,
          filter: async (from) => {
            const info = await NodeFSP.lstat(from);
            if (info.isSymbolicLink()) throw new Error(`symlink:${from}`);
            entries += 1;
            total += info.isFile() ? info.size : 0;
            if (entries > MAX_ENTRIES || total > MAX_UNPACKED_BYTES) throw new Error("too-large");
            const relative = from.slice(source.length).replaceAll("\\", "/");
            // Version control and the Web Store's signature data are not part of the extension.
            return !/^\/(\.git|_metadata)(\/|$)/.test(relative);
          },
        });
      },
      catch: (cause) =>
        fail(
          String(cause).includes("symlink:")
            ? "The folder contains a symbolic link. Copy the real files into it and try again."
            : String(cause).includes("too-large")
              ? "The folder is too large to be an extension."
              : "Could not copy the extension folder.",
        ),
    });

  const install = Effect.fn("BrowserExtensions.install")(function* (
    input: BrowserExtensionInstallInput,
    reloading?: StoredExtension,
  ) {
    const profileId = yield* resolveProfile(input.profileId);
    const webStoreId = webStoreExtensionId(input.source);
    const isFolder = webStoreId === null && path.isAbsolute(input.source);
    if (webStoreId === null && !isFolder) {
      return yield* fail(
        "Install from a Chrome Web Store link (chromewebstore.google.com/detail/...), an extension ID, or an absolute path to an unpacked extension folder on this machine.",
      );
    }
    const extensions = yield* readRegistry(profileId);
    yield* fs
      .makeDirectory(profileDir(profileId), { recursive: true })
      .pipe(
        Effect.mapError(() => fail("Could not create the extension folder in Cogenly's home.")),
      );
    const staging = yield* fs
      .makeTempDirectoryScoped({ directory: profileDir(profileId), prefix: ".install-" })
      .pipe(Effect.mapError(() => fail("Could not stage the extension in Cogenly's home.")));
    const unpacked = path.join(staging, "extension");

    let id: string;
    let source: BrowserExtensionSource;
    let generatedKey: string | undefined;
    if (webStoreId !== null) {
      const archivePath = path.join(staging, "package.zip");
      const verified = yield* downloadWebStore(webStoreId, archivePath);
      yield* unpack(archivePath, unpacked);
      const { manifest } = yield* readManifest(unpacked);
      yield* writeManifestKey(unpacked, manifest, verified.publicKey);
      id = verified.extensionId;
      source = { type: "webStore" };
    } else {
      const folder = path.resolve(input.source);
      const info = yield* fs
        .stat(folder)
        .pipe(Effect.mapError(() => fail(`There is no folder at ${folder} on this machine.`)));
      if (info.type !== "Directory") return yield* fail(`${folder} is not a folder.`);
      yield* copyFolder(folder, unpacked);
      const { manifest, summary } = yield* readManifest(unpacked);
      if (reloading) {
        // A source edit cannot change the identity (and storage) of a reload.
        const publicKey = yield* Effect.try({
          try: () =>
            reloading.generatedKey
              ? NodeCrypto.createPublicKey(reloading.generatedKey).export({
                  format: "der",
                  type: "spki",
                })
              : Buffer.from(summary.key ?? "", "base64"),
          catch: () => fail("Could not recover the extension's key for reload."),
        });
        if (publicKey.length === 0 || extensionIdFromPublicKey(publicKey) !== reloading.id) {
          return yield* fail(
            "The source manifest key must match the installed extension to reload it.",
          );
        }
        yield* writeManifestKey(unpacked, manifest, publicKey);
        id = reloading.id;
        generatedKey = reloading.generatedKey;
      } else if (summary.key) {
        const publicKey = yield* Effect.try({
          try: () => Buffer.from(summary.key ?? "", "base64"),
          catch: () => fail("manifest.json has an invalid key."),
        });
        id = extensionIdFromPublicKey(publicKey);
      } else {
        // Chrome names an unpacked extension after its path, which differs per
        // host. A generated key gives every host, and every reinstall, one ID.
        const previous = extensions.find(
          (extension) =>
            extension.source.type === "folder" &&
            extension.source.path === folder &&
            extension.generatedKey !== undefined,
        );
        const privateKey = previous?.generatedKey
          ? NodeCrypto.createPrivateKey(previous.generatedKey)
          : NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
        const publicKey = NodeCrypto.createPublicKey(privateKey).export({
          format: "der",
          type: "spki",
        });
        yield* writeManifestKey(unpacked, manifest, publicKey);
        id = extensionIdFromPublicKey(publicKey);
        generatedKey = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
      }
      source = { type: "folder", path: folder };
    }

    const { summary, icon } = yield* readManifest(unpacked);
    const now = yield* Clock.currentTimeMillis;
    // A fresh directory per install, so a host that loaded the old one sees a new path to load.
    const directory = `${summary.version}-${NodeCrypto.randomUUID()}`;
    const extensionDir = path.join(profileDir(profileId), id);
    yield* fs.makeDirectory(extensionDir, { recursive: true }).pipe(
      Effect.andThen(fs.rename(unpacked, path.join(extensionDir, directory))),
      Effect.mapError(() => fail("Could not save the extension in Cogenly's home.")),
    );
    const previous = extensions.find((extension) => extension.id === id);
    const stored: StoredExtension = {
      id,
      name: summary.name,
      version: summary.version,
      description: summary.description,
      manifestVersion: summary.manifestVersion,
      enabled: reloading?.enabled ?? true,
      source,
      permissions: summary.permissions,
      hostPermissions: summary.hostPermissions,
      hasAction: summary.hasAction,
      ...(icon ? { icon } : {}),
      ...(summary.sidePanelPage ? { sidePanelPage: summary.sidePanelPage } : {}),
      ...(summary.popupPage ? { popupPage: summary.popupPage } : {}),
      ...(summary.optionsPage ? { optionsPage: summary.optionsPage } : {}),
      installedAt: reloading?.installedAt ?? DateTime.formatIso(DateTime.makeUnsafe(now)),
      directory,
      ...(generatedKey ? { generatedKey } : {}),
    };
    yield* writeRegistry(profileId, [
      ...extensions.filter((extension) => extension.id !== id),
      stored,
    ]);

    yield* publishAndLoad(profileId, stored.enabled, id);
    return {
      profileId,
      extension: withLoadError(profileId, stored),
      updated: previous !== undefined,
      ...(previous ? { previousVersion: previous.version } : {}),
    } satisfies BrowserExtensionInstallResult;
  }, Effect.scoped);

  const reload = Effect.fn("BrowserExtensions.reload")(function* (
    input: BrowserExtensionReloadInput,
  ) {
    const profileId = yield* resolveProfile(input.profileId);
    const extension = (yield* readRegistry(profileId)).find((entry) => entry.id === input.id);
    if (!extension) return yield* fail(`Extension ${input.id} is not installed in this profile.`);
    if (extension.source.type !== "folder")
      return yield* fail(
        "Only unpacked folder extensions can be reloaded. Reinstall a Web Store extension to update it.",
      );
    return yield* install({ profileId, source: extension.source.path }, extension);
  });

  const removeOldVersions = (profileId: string, id: string, keep: string | null) =>
    Effect.gen(function* () {
      const extensionDir = path.join(profileDir(profileId), id);
      for (const directory of loadResults.keys()) {
        if (
          directory.startsWith(`${extensionDir}${path.sep}`) &&
          directory !== (keep === null ? null : path.join(extensionDir, keep))
        )
          loadResults.delete(directory);
      }
      if (keep === null) {
        yield* fs.remove(extensionDir, { recursive: true, force: true });
        return;
      }
      const entries = yield* fs.readDirectory(extensionDir);
      yield* Effect.forEach(
        entries.filter((name) => name !== keep),
        (name) => fs.remove(path.join(extensionDir, name), { recursive: true, force: true }),
        { discard: true },
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not remove an old extension version.", { id, cause }),
      ),
    );

  const remove = Effect.fn("BrowserExtensions.remove")(function* (
    input: BrowserExtensionRemoveInput,
  ) {
    const profileId = yield* resolveProfile(input.profileId);
    const extensions = yield* readRegistry(profileId);
    if (!extensions.some((extension) => extension.id === input.id)) {
      return yield* fail(`Extension ${input.id} is not installed in this profile.`);
    }
    yield* writeRegistry(
      profileId,
      extensions.filter((extension) => extension.id !== input.id),
    );

    yield* publishAndLoad(profileId, true, input.id);
    return yield* listOf(profileId);
  });

  const toggle = Effect.fn("BrowserExtensions.toggle")(function* (
    input: BrowserExtensionToggleInput,
  ) {
    const profileId = yield* resolveProfile(input.profileId);
    const extensions = yield* readRegistry(profileId);
    const current = extensions.find((extension) => extension.id === input.id);
    if (!current) return yield* fail(`Extension ${input.id} is not installed in this profile.`);
    if (current.enabled === input.enabled) return withLoadError(profileId, current);
    const next = { ...current, enabled: input.enabled };
    yield* writeRegistry(
      profileId,
      extensions.map((extension) => (extension.id === input.id ? next : extension)),
    );
    yield* publishAndLoad(profileId);
    return withLoadError(profileId, next);
  });

  const pageUrl = Effect.fn("BrowserExtensions.pageUrl")(function* (input: {
    readonly profileId?: string | undefined;
    readonly id: string;
    readonly page: BrowserExtensionPage;
  }) {
    if (input.page === "sidePanel" || input.page === "action") {
      return yield* fail(
        "Use openSurface to click the toolbar action or open a side panel on a host tab.",
      );
    }
    const profileId = yield* resolveProfile(input.profileId);
    const extension = (yield* readRegistry(profileId)).find((entry) => entry.id === input.id);
    if (!extension) {
      return yield* fail(`Extension ${input.id} is not installed in profile ${profileId}.`);
    }
    const loadError = withLoadError(profileId, extension).loadError;
    if (loadError) return yield* fail(loadError);
    if (!extension.enabled) {
      return yield* fail(
        `${extension.name} is turned off. Turn it on with browser_extension_toggle first.`,
      );
    }
    if (input.page === "popup" && !extension.popupPage) {
      return yield* fail(
        `${extension.name} has no popup page. Use browser_extension_open with page action to click its toolbar button.${extension.optionsPage ? " Open its options page instead." : ""}`,
      );
    }
    if (input.page === "options" && !extension.optionsPage) {
      return yield* fail(`${extension.name} has no options page.`);
    }
    const page =
      input.page === "popup"
        ? extension.popupPage
        : input.page === "options"
          ? extension.optionsPage
          : input.page;
    return browserExtensionPageUrl(extension.id, page ?? "");
  });

  const loadable = (profileId: string) =>
    readRegistry(profileId).pipe(
      Effect.map((extensions) =>
        extensions
          .filter((extension) => extension.enabled)
          .map((extension) => ({
            id: extension.id,
            path: path.join(profileDir(profileId), extension.id, extension.directory),
          })),
      ),
    );

  /** Publish once, then load outside the mutation permit so Chrome's download cannot block the registry. */
  const publishAndLoad = Effect.fnUntraced(function* (
    profileId: string,
    shouldLoad = true,
    cleanId?: string,
  ) {
    const load = shouldLoad ? loader : undefined;
    const pending = load
      ? (yield* loadable(profileId)).filter((extension) => !loadResults.has(extension.path))
      : [];
    for (const extension of pending) loading.add(extension.path);
    const attempt = Effect.gen(function* () {
      if (load) yield* load(profileId);
      if (cleanId) {
        // Another mutation may have committed while Chrome was starting.
        const current = (yield* readRegistry(profileId)).find((entry) => entry.id === cleanId);
        yield* removeOldVersions(profileId, cleanId, current?.directory ?? null);
      }
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          let changed = false;
          for (const extension of pending) {
            loading.delete(extension.path);
            if (!loadResults.has(extension.path)) changed = true;
          }
          if (changed) yield* PubSub.publish(changes, profileId);
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Extension background load failed.", { profileId, cause }),
      ),
    );
    yield* PubSub.publish(changes, profileId);
    if (load && loaderScope) yield* Effect.forkIn(loadGate.withPermit(attempt), loaderScope);
    else yield* attempt;
  });

  const serialized = <A, E>(effect: Effect.Effect<A, E>) => gate.withPermit(effect);

  return BrowserExtensions.of({
    list: (input) =>
      Effect.gen(function* () {
        const profileId = yield* resolveProfile(input.profileId);
        return yield* listOf(profileId);
      }),
    install: (input) => serialized(install(input)),
    reload: (input) => serialized(reload(input)),
    openSurface: (input) =>
      Effect.gen(function* () {
        const profileId = yield* resolveProfile(input.profileId);
        const extension = (yield* listOf(profileId)).extensions.find(
          (entry) => entry.id === input.id,
        );
        if (!extension)
          return yield* fail(`Extension ${input.id} is not installed in profile ${profileId}.`);
        if (!extension.enabled)
          return yield* fail(
            `${extension.name} is turned off. Turn it on with browser_extension_toggle first.`,
          );
        if (extension.loadError) return yield* fail(extension.loadError);
        if (!surfaceOpener)
          return yield* fail(
            "Extension surfaces require the server Chrome runtime. Open a server browser tab in this profile first.",
          );
        return yield* surfaceOpener({ ...input, profileId }, extension);
      }),
    registerSurfaceOpener: (open) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          surfaceOpener = open;
        }),
        () =>
          Effect.sync(() => {
            if (surfaceOpener === open) surfaceOpener = undefined;
          }),
      ),
    changes: Stream.fromPubSub(changes),
    subscribe: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const profileId = yield* resolveProfile(input.profileId);
          // Subscribe before reading so a concurrent mutation cannot be missed.
          // Registry writes rename atomically; reads need no mutation permit, so
          // subscribers can see installing while the loader is still working.
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(listOf(profileId)),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((changedProfileId) => changedProfileId === profileId),
              Stream.mapEffect(() => listOf(profileId)),
            ),
          ).pipe(Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)));
        }),
      ),
    remove: (input) => serialized(remove(input)),
    toggle: (input) => serialized(toggle(input)),
    loadable,
    registerLoader: (load) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          loaderScope = yield* Effect.scope;
          loader = load;
        }),
        () =>
          Effect.sync(() => {
            if (loader === load) {
              loader = undefined;
              loaderScope = undefined;
            }
          }),
      ),
    reportLoad: (profileId, directory, error) =>
      Effect.gen(function* () {
        const changed = !loadResults.has(directory) || loadResults.get(directory) !== error;
        loadResults.set(directory, error);
        if (changed) yield* PubSub.publish(changes, profileId);
      }),
    pageUrl,
  });
});

export const layer = Layer.effect(
  BrowserExtensions,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* makeBrowserExtensions({
      rootDir: (yield* Path.Path).join(config.stateDir, "browser-extensions"),
    });
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
