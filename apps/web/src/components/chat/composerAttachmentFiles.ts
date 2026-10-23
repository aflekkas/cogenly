import {
  type EnvironmentId,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import {
  clampFileAttachmentUploadBytes,
  fileAttachmentTooLargeMessage,
} from "@t3tools/client-runtime/state/attachments";

import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  composerFileMatchesReattachMarker,
} from "../../composerDraftStore";
import { isHeicImageFile, prepareImageForAttachment } from "../../lib/imageCompression";
import { randomUUID } from "../../lib/utils";
import { isVideoAttachment, videoMimeType } from "../../types";

type ComposerAttachmentFileKind = "image" | "file" | "unsupported-image";

interface FileAttachmentCapabilityState {
  readonly attachmentUploadsCapabilityKnown: boolean;
  readonly supportsAttachmentUploads: boolean;
  readonly maxFileAttachmentBytes: number | null;
}

const IMAGE_MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * Some sources (drags from other apps, files piped through a shell) hand over
 * a `File` with an empty or generic MIME type. Maps the extension to a
 * provider-supported image type so a plain `photo.jpg` still lands on the
 * image path; anything unrecognized stays a generic file.
 */
export function inferImageMimeTypeFromName(name: string): string | null {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) {
    return null;
  }
  return IMAGE_MIME_TYPE_BY_EXTENSION[name.slice(dotIndex + 1).toLowerCase()] ?? null;
}

function inferImageMimeTypeForUnknownFile(file: Pick<File, "name" | "type">): string | null {
  const mimeType = file.type.toLowerCase();
  if (mimeType !== "" && mimeType !== "application/octet-stream") {
    return null;
  }
  return inferImageMimeTypeFromName(file.name);
}

/** Give extension-recognized images a concrete type before compression. */
export function normalizeComposerImageFileMimeType(file: File): File {
  const inferredMimeType = inferImageMimeTypeForUnknownFile(file);
  if (!inferredMimeType) {
    return file;
  }
  return new File([file], file.name, {
    type: inferredMimeType,
    lastModified: file.lastModified,
  });
}

export function classifyComposerAttachmentFile(
  file: Pick<File, "name" | "type">,
): ComposerAttachmentFileKind {
  if (isHeicImageFile(file)) {
    return "image";
  }
  if (inferImageMimeTypeForUnknownFile(file)) {
    return "image";
  }
  if (!file.type.toLowerCase().startsWith("image/")) {
    return "file";
  }
  return isProviderSendTurnSupportedImageMimeType(file.type) ? "image" : "unsupported-image";
}

export function isPreviewableComposerVideo(
  file: ComposerFileAttachment,
  environmentId: EnvironmentId,
): boolean {
  return (
    isVideoAttachment(file) &&
    (file.file !== null ||
      (file.uploadedAttachmentId !== undefined && file.uploadEnvironmentId === environmentId))
  );
}

/** Non-media files without an inline reference still need the legacy attachment row. */
export function composerOtherFilesForPresentation(
  files: ReadonlyArray<ComposerFileAttachment>,
  environmentId: EnvironmentId,
  inlineFileIds: ReadonlySet<string>,
): ComposerFileAttachment[] {
  return files.filter(
    (file) => !isPreviewableComposerVideo(file, environmentId) && !inlineFileIds.has(file.id),
  );
}

/** Byte limit for adding a generic file to the local composer draft. */
export function fileAttachmentStagingLimit(input: FileAttachmentCapabilityState): number | null {
  if (!input.attachmentUploadsCapabilityKnown) {
    return PROVIDER_SEND_TURN_MAX_FILE_BYTES;
  }
  if (!input.supportsAttachmentUploads || input.maxFileAttachmentBytes === null) {
    return null;
  }
  return clampFileAttachmentUploadBytes(input.maxFileAttachmentBytes);
}

/** Why retained generic files cannot send with the current server config. */
export function fileAttachmentCapabilityBlockReason(
  input: FileAttachmentCapabilityState & {
    readonly files: ReadonlyArray<{ readonly name: string; readonly sizeBytes: number }>;
  },
): string | null {
  if (input.files.length === 0) {
    return null;
  }
  if (!input.attachmentUploadsCapabilityKnown) {
    return "Waiting for the server before file attachments can send";
  }
  const maxFileAttachmentBytes = fileAttachmentStagingLimit(input);
  if (maxFileAttachmentBytes === null) {
    return "This server does not accept file attachments right now. Remove the files to send.";
  }
  const oversizedFile = input.files.find((file) => file.sizeBytes > maxFileAttachmentBytes);
  if (oversizedFile) {
    return fileAttachmentTooLargeMessage(oversizedFile.name, maxFileAttachmentBytes);
  }
  return null;
}

/**
 * When `capabilities.attachmentUploads` flips off (reconnect, version skew),
 * tear down only uploads that have not been persisted onto a draft file.
 * Once `uploadedAttachmentId` is stamped, the draft references that server
 * copy after reload even if its local `File` is still available in memory.
 * Explicit attachment removal releases persisted uploads through
 * `releaseDraftAttachment`.
 */
export function attachmentsToReleaseOnUploadCapabilityLoss(
  attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>,
): Array<ComposerImageAttachment | ComposerFileAttachment> {
  return attachments.filter(
    (attachment) => !(attachment.type === "file" && attachment.uploadedAttachmentId !== undefined),
  );
}

/**
 * Sorts a batch of picked, pasted or dropped files into images still to compress and
 * generic files ready for the draft, refusing what this message cannot take. Every
 * composer funnels attachments through here. It runs synchronously so concurrent
 * pastes see each other's reserved slots. A file matching a needs-reattach marker
 * replaces it and takes no new slot; a draft full of markers would otherwise hit the
 * capacity error before the replacement could land.
 */
export function acceptComposerAttachmentFiles(input: {
  readonly files: ReadonlyArray<File>;
  /** Attachments the draft already holds or has in flight. */
  readonly reservedCount: number;
  /** From fileAttachmentStagingLimit; null refuses generic files. */
  readonly stagingLimit: number | null;
  readonly reattachMarkers?: ReadonlyArray<ComposerFileAttachment>;
  readonly source?: ComposerFileAttachment["source"];
}): {
  readonly images: File[];
  readonly files: ComposerFileAttachment[];
  /** The last refusal in the batch, or null when everything was taken. */
  readonly error: string | null;
} {
  let reservedCount = input.reservedCount;
  const replacedReattachMarkerIds = new Set<string>();
  const images: File[] = [];
  const files: ComposerFileAttachment[] = [];
  let error: string | null = null;
  for (const file of input.files) {
    const attachmentKind = classifyComposerAttachmentFile(file);
    const fileMimeType =
      attachmentKind === "file"
        ? (videoMimeType({ name: file.name, mimeType: file.type }) ??
          (file.type || "application/octet-stream"))
        : file.type;
    const matchingReattachMarker =
      attachmentKind === "file"
        ? input.reattachMarkers?.find(
            (marker) =>
              !replacedReattachMarkerIds.has(marker.id) &&
              composerFileMatchesReattachMarker(marker, {
                name: file.name || "file",
                mimeType: fileMimeType,
                sizeBytes: file.size,
              }),
          )
        : undefined;
    if (matchingReattachMarker) {
      replacedReattachMarkerIds.add(matchingReattachMarker.id);
    }
    if (!matchingReattachMarker && reservedCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`;
      // Keep scanning: a later file in this batch can still replace a
      // needs-reattach marker without needing a free slot.
      continue;
    }
    if (attachmentKind === "unsupported-image") {
      error = `'${file.name}' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.`;
      continue;
    }
    if (attachmentKind === "image") {
      images.push(normalizeComposerImageFileMimeType(file));
    } else {
      if (input.stagingLimit === null) {
        error = "This server does not support file attachments.";
        continue;
      }
      if (file.size <= 0) {
        error = `'${file.name}' is empty or could not be read.`;
        continue;
      }
      if (file.size > input.stagingLimit) {
        error = fileAttachmentTooLargeMessage(file.name, input.stagingLimit);
        continue;
      }
      const attachmentFile =
        file.type === fileMimeType
          ? file
          : new File([file], file.name, { type: fileMimeType, lastModified: file.lastModified });
      files.push({
        type: "file",
        id: randomUUID(),
        name: attachmentFile.name || "file",
        mimeType: fileMimeType,
        sizeBytes: attachmentFile.size,
        file: attachmentFile,
        ...(input.source ? { source: input.source } : {}),
      });
    }
    if (!matchingReattachMarker) {
      reservedCount += 1;
    }
  }
  return { images, files, error };
}

/**
 * Turns accepted image files into draft attachments with local previews. Images over
 * the wire cap are downscaled to fit rather than refused; files already within it pass
 * through byte-for-byte.
 */
export async function prepareComposerImageAttachments(files: ReadonlyArray<File>): Promise<{
  readonly images: ComposerImageAttachment[];
  readonly error: string | null;
}> {
  const images: ComposerImageAttachment[] = [];
  let error: string | null = null;
  for (const file of files) {
    const compressed = await prepareImageForAttachment(file, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
    if (!compressed.ok) {
      error =
        compressed.reason === "unreadable"
          ? `'${file.name}' could not be read as an image.`
          : `'${file.name}' is too large to attach, even after compression.`;
      continue;
    }
    const attachmentFile = compressed.file;
    images.push({
      type: "image",
      id: randomUUID(),
      name: attachmentFile.name || "image",
      mimeType: attachmentFile.type,
      sizeBytes: attachmentFile.size,
      previewUrl: URL.createObjectURL(attachmentFile),
      file: attachmentFile,
    });
  }
  return { images, error };
}

/**
 * Whether a paste's files should be claimed as composer attachments instead of
 * falling through to the default text paste. Deliberately no capacity or
 * pending-plan-question gate here: `addComposerAttachments` owns those limits
 * and reports them, while a gate at this layer would swallow the paste with no
 * feedback.
 */
export function shouldHandleComposerAttachmentPaste(input: {
  readonly files: ReadonlyArray<File>;
  readonly plainText: string;
}): boolean {
  if (
    input.files.some((file) => {
      const classification = classifyComposerAttachmentFile(file);
      return classification === "image" || classification === "unsupported-image";
    })
  ) {
    return true;
  }

  if (input.plainText.length > 0) {
    return false;
  }

  return input.files.some((file) => classifyComposerAttachmentFile(file) === "file");
}
