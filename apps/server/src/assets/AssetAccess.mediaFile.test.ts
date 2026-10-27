import {
  AssetPreviewTypeValidationError,
  AssetWorkspaceAssetNotFoundError,
  ThreadId,
} from "@cogenly/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { issueAssetUrl, resolveAsset } from "./AssetAccess.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";

const signingKey = new Uint8Array(32).fill(9);

const layer = Layer.mergeAll(
  Layer.mock(ServerSecretStore.ServerSecretStore)({
    getOrCreateRandom: () => Effect.succeed(signingKey),
  }),
  Layer.mock(WorkspacePaths.WorkspacePaths)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  Layer.mock(NativeAppIconResolver.NativeAppIconResolver)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  ServerConfig.layerTest(process.cwd(), { prefix: "cogenly-asset-media-file-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const threadId = ThreadId.make("thread-media-file");

// `/api/assets/<token>/<file name>` → the token and file name `resolveAsset` takes.
const splitAssetUrl = (relativeUrl: string) => {
  const [token = "", ...rest] = relativeUrl.slice("/api/assets/".length).split("/");
  return { token, fileName: decodeURIComponent(rest.join("/")) };
};

const mint = (path: string, disposition?: "attachment") =>
  issueAssetUrl({
    resource: {
      _tag: "media-file",
      threadId,
      path,
      ...(disposition ? { disposition } : {}),
    },
  }).pipe(Effect.map((issued) => splitAssetUrl(issued.relativeUrl)));

/** A host file outside any workspace, as an agent leaves one for the user. */
const writeHostFile = (name: string, contents = "contents") =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const filePath = path.join(directory, name);
    yield* fileSystem.writeFileString(filePath, contents);
    return { directory, filePath };
  });

describe("media-file asset URLs", () => {
  it.effect("keeps refusing to preview a type the host does not serve inline", () =>
    Effect.gen(function* () {
      const { filePath } = yield* writeHostFile("Agreement.docx");
      const error = yield* mint(filePath).pipe(Effect.flip);
      assert.instanceOf(error, AssetPreviewTypeValidationError);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("serves any regular file as a download when asked for one", () =>
    Effect.gen(function* () {
      const { filePath } = yield* writeHostFile("Alex x Davin Agreement.docx");
      const { token, fileName } = yield* mint(filePath, "attachment");
      assert.equal(fileName, "Alex x Davin Agreement.docx");
      const asset = yield* resolveAsset(token, fileName);
      assert.equal(asset?.kind, "file");
      if (asset?.kind !== "file" || !("download" in asset))
        return assert.fail("expected a file download");
      assert.isTrue(asset.download);
      assert.equal(asset.fileName, "Alex x Davin Agreement.docx");
      // No preview type: the route answers with an octet-stream attachment.
      assert.isUndefined(asset.mimeType);
      // The signature binds the file name segment too.
      assert.isNull(yield* resolveAsset(token, "other.docx"));
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("a download of a previewable file still downloads", () =>
    Effect.gen(function* () {
      const { filePath } = yield* writeHostFile("report.pdf");
      const download = yield* mint(filePath, "attachment");
      const downloaded = yield* resolveAsset(download.token, download.fileName);
      assert.isTrue(
        downloaded?.kind === "file" && "download" in downloaded && downloaded.download === true,
      );
      const preview = yield* mint(filePath);
      const previewed = yield* resolveAsset(preview.token, preview.fileName);
      assert.isTrue(previewed?.kind === "file" && !("download" in previewed && previewed.download));
      assert.equal(previewed?.kind === "file" ? previewed.mimeType : null, "application/pdf");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("never serves a folder or a missing path as a download", () =>
    Effect.gen(function* () {
      const { directory, filePath } = yield* writeHostFile("notes.txt");
      const folderError = yield* mint(directory, "attachment").pipe(Effect.flip);
      assert.instanceOf(folderError, AssetWorkspaceAssetNotFoundError);
      const missingError = yield* mint(`${filePath}.missing`, "attachment").pipe(Effect.flip);
      assert.instanceOf(missingError, AssetWorkspaceAssetNotFoundError);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("stops resolving once the file is gone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { filePath } = yield* writeHostFile("archive.zip");
      const { token, fileName } = yield* mint(filePath, "attachment");
      yield* fileSystem.remove(filePath);
      assert.isNull(yield* resolveAsset(token, fileName));
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
