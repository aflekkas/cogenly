/**
 * Attachment files that travel with a request to another machine, by their
 * names in the attachments directory. Ids name their files, so a file the
 * receiver already has is the same attachment and is kept.
 */
import {
  type ChatAttachment,
  THREAD_FORWARD_MAX_FILE_BYTES,
  type ThreadAttachmentFile,
  ThreadRemoteError,
} from "@cogenly/contracts";
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

/** Stores files another machine sent, keeping any this machine already has. */
export const writeAttachmentFiles = Effect.fn("attachmentFiles.write")(
  function* (files: ReadonlyArray<ThreadAttachmentFile>) {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const file of files) {
      const target = path.join(config.attachmentsDir, file.name);
      if (yield* fileSystem.exists(target)) continue;
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFile(target, new Uint8Array(Buffer.from(file.base64, "base64")));
    }
  },
  Effect.mapError(
    () => new ThreadRemoteError({ reason: "rejected", detail: "Could not store an attachment." }),
  ),
);
