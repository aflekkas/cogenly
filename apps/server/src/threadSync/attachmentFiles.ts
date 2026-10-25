/**
 * Attachment files that travel with a request to another machine, by their
 * names in the attachments directory. Only complete, verified files receive
 * their final names.
 */
import {
  type ChatAttachment,
  THREAD_FORWARD_MAX_FILE_BYTES,
  type ThreadAttachmentFile,
  ThreadRemoteError,
} from "@cogenly/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { attachmentRelativePath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";

/** Reads the files of `attachments` this machine has, up to the forward limit. */
export const readAttachmentFiles = Effect.fn("attachmentFiles.read")(function* (
  attachments: ReadonlyArray<ChatAttachment>,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<ThreadAttachmentFile> = [];
  let total = 0;
  for (const attachment of attachments) {
    const name = attachmentRelativePath(attachment);
    if (name === null) continue;
    const bytes = yield* fileSystem
      .readFile(path.join(config.attachmentsDir, name))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (bytes === undefined) continue;
    total += bytes.byteLength;
    if (total > THREAD_FORWARD_MAX_FILE_BYTES)
      return yield* new ThreadRemoteError({
        reason: "too-large",
        detail: "These attachments are too large to send to another machine.",
      });
    files.push({ name, base64: Buffer.from(bytes).toString("base64") });
  }
  return files;
});

/** Verifies existing copies and atomically publishes complete replacements. */
export const writeAttachmentFiles = Effect.fn("attachmentFiles.write")(
  function* (files: ReadonlyArray<ThreadAttachmentFile>) {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    if (
      files.reduce((total, file) => total + Buffer.byteLength(file.base64, "base64"), 0) >
      THREAD_FORWARD_MAX_FILE_BYTES
    )
      return yield* new ThreadRemoteError({ reason: "too-large" });
    for (const file of files) {
      const target = path.join(config.attachmentsDir, file.name);
      const bytes = new Uint8Array(Buffer.from(file.base64, "base64"));
      const digest = Buffer.from(yield* crypto.digest("SHA-256", bytes));
      const existing = yield* fileSystem.readFile(target).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      );
      if (
        existing !== undefined &&
        existing.byteLength === bytes.byteLength &&
        digest.equals(Buffer.from(yield* crypto.digest("SHA-256", existing)))
      )
        continue;
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const temporary = yield* fileSystem.makeTempFileScoped({
            directory: config.attachmentsDir,
            prefix: ".transfer-",
          });
          yield* fileSystem.writeFile(temporary, bytes);
          yield* fileSystem.rename(temporary, target);
        }),
      );
    }
  },
  Effect.mapError((error) =>
    error._tag === "ThreadRemoteError"
      ? error
      : new ThreadRemoteError({ reason: "rejected", detail: "Could not store an attachment." }),
  ),
);
