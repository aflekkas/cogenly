import { describe, expect, it } from "vite-plus/test";

import { middleTruncateAttachmentName } from "./composerInlineChip";

describe("middleTruncateAttachmentName", () => {
  it("keeps short names whole", () => {
    expect(middleTruncateAttachmentName("Q3-Invoice.pdf")).toBe("Q3-Invoice.pdf");
  });

  it("shortens the stem so the extension stays visible", () => {
    expect(
      middleTruncateAttachmentName("Alex x Davin Termination Agreement Final Copy.pdf", 30),
    ).toBe("Alex x Davin Termination….pdf");
  });

  it("falls back to keeping the end when there is no short extension", () => {
    const name = "a-very-long-file-name-without-any-extension-at-all";
    const truncated = middleTruncateAttachmentName(name, 20);
    expect(truncated).toHaveLength(20);
    expect(truncated.endsWith("at-all")).toBe(true);
  });
});
