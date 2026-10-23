import { describe, expect, it } from "@effect/vitest";

import { fillOnOrigin } from "./ServerBrowserPage.ts";

/** A page whose URL and focused element's document origin can drift apart. */
const fakePage = (pageUrl: string, documentOrigin: string) => {
  const filled: Array<string> = [];
  const handle = {
    evaluate: async () => documentOrigin,
    fill: async (text: string) => void filled.push(text),
    dispose: async () => undefined,
  };
  const locator = { elementHandle: async () => handle } as never;
  const page = { url: () => pageUrl, locator: () => ({ last: () => locator }) } as never;
  return { page, locator, filled };
};

describe("fillOnOrigin", () => {
  it("fills only while both the page and the field's document are on the checked origin", async () => {
    const same = fakePage("https://github.com/login", "https://github.com");
    await fillOnOrigin(same.page, same.locator, "octo-password", "https://github.com", 1000);
    expect(same.filled).toEqual(["octo-password"]);

    for (const drifted of [
      fakePage("https://evil.test/login", "https://evil.test"),
      fakePage("https://github.com/login", "https://evil.test"),
      fakePage("http://github.com/login", "http://github.com"),
    ]) {
      await expect(
        fillOnOrigin(drifted.page, null, "octo-password", "https://github.com", 1000),
      ).rejects.toThrow("nothing was typed");
      expect(drifted.filled).toEqual([]);
    }
  });
});
