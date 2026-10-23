import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerFileAttachment } from "../../composerDraftStore";
import { acceptComposerAttachmentFiles } from "./composerAttachmentFiles";

const png = (name = "screen.png") => new File([new Uint8Array([1, 2, 3])], name, { type: "" });
const text = (name = "notes.txt", body = "hello") => new File([body], name, { type: "text/plain" });

describe("acceptComposerAttachmentFiles", () => {
  it("sends images to compression and files straight to the draft", () => {
    const accepted = acceptComposerAttachmentFiles({
      files: [png(), text()],
      reservedCount: 0,
      stagingLimit: 1024,
    });
    expect(accepted.error).toBeNull();
    // An extension-recognized image gets a concrete type before compression.
    expect(accepted.images.map((file) => file.type)).toEqual(["image/png"]);
    expect(accepted.files).toMatchObject([
      { type: "file", name: "notes.txt", mimeType: "text/plain", sizeBytes: 5 },
    ]);
  });

  it("refuses files past the per-message cap and keeps the rest of the batch", () => {
    const accepted = acceptComposerAttachmentFiles({
      files: [png("a.png"), png("b.png")],
      reservedCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1,
      stagingLimit: 1024,
    });
    expect(accepted.images.map((file) => file.name)).toEqual(["a.png"]);
    expect(accepted.error).toContain(`${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files`);
  });

  it("lets a file replace its needs-reattach marker without a free slot", () => {
    const marker: ComposerFileAttachment = {
      type: "file",
      id: "marker",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      file: null,
    };
    const accepted = acceptComposerAttachmentFiles({
      files: [text()],
      reservedCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
      stagingLimit: 1024,
      reattachMarkers: [marker],
    });
    expect(accepted.error).toBeNull();
    expect(accepted.files).toHaveLength(1);
  });

  it("explains why a generic file cannot be staged", () => {
    expect(
      acceptComposerAttachmentFiles({ files: [text()], reservedCount: 0, stagingLimit: null })
        .error,
    ).toBe("This server does not support file attachments.");
    expect(
      acceptComposerAttachmentFiles({
        files: [text("empty.txt", "")],
        reservedCount: 0,
        stagingLimit: 1024,
      }).error,
    ).toBe("'empty.txt' is empty or could not be read.");
    const oversized = acceptComposerAttachmentFiles({
      files: [text("big.txt", "too large")],
      reservedCount: 0,
      stagingLimit: 4,
    });
    expect(oversized.files).toEqual([]);
    expect(oversized.error).toContain("big.txt");
  });
});
