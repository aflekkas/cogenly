import { ChatAttachmentId, ChatFileAttachment, ChatImageAttachment } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "./attachmentPrompt.ts";

const document = ChatFileAttachment.make({
  id: ChatAttachmentId.make("file-document"),
  type: "file",
  name: "spec.pdf",
  mimeType: "application/pdf",
  sizeBytes: 123,
});
const image = ChatImageAttachment.make({
  id: ChatAttachmentId.make("file-image"),
  type: "image",
  name: "diagram.png",
  mimeType: "image/png",
  sizeBytes: 456,
});

// Stands in for the host's resolver, which maps stored attachments to their files.
const resolveAttachmentPath = (attachment: { readonly id: string; readonly name: string }) =>
  `/attachments/${attachment.id}${attachment.name.slice(attachment.name.lastIndexOf("."))}`;

describe("provider attachment prompts", () => {
  it("appends resolvable file paths for documents and images", () => {
    assert.equal(
      providerMessageTextWithAttachmentPaths({
        text: "Review these.",
        attachments: [document, image],
        resolveAttachmentPath,
      }),
      'Review these.\n\n[Attached file "spec.pdf" is saved at: /attachments/file-document.pdf]\n' +
        '\n[Attached image "diagram.png" is saved at: /attachments/file-image.png]',
    );
  });

  it("classifies only image MIME types for native image payloads", () => {
    assert.isTrue(isProviderNativeImageAttachment(image));
    assert.isFalse(isProviderNativeImageAttachment(document));
  });
});
