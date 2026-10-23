import { describe, expect, it, vi } from "@effect/vitest";
import type { Page } from "playwright-core";
import * as BrowserPage from "./ServerBrowserPage.ts";

/** A fill target whose document can change during Playwright's locator wait. */
const fillPage = (origin: string, navigateWhileWaiting = false) => {
  const fields = { value: "", events: [] as string[] };
  const view = {
    location: { origin },
    get top() {
      return { location: this.location };
    },
    HTMLInputElement: class {
      declare value: string;
    },
    HTMLTextAreaElement: class {
      declare value: string;
    },
    Event: class {
      readonly type: string;
      constructor(type: string) {
        this.type = type;
      }
    },
  };
  Object.defineProperty(view.HTMLInputElement.prototype, "value", {
    set(value: string) {
      fields.value = value;
    },
  });
  const element = Object.assign(new view.HTMLInputElement(), {
    tagName: "INPUT",
    disabled: false,
    readOnly: false,
    ownerDocument: { defaultView: view },
    focus: vi.fn(),
    dispatchEvent: (event: { type: string }) => {
      fields.events.push(event.type);
    },
  });
  const locator = {
    scrollIntoViewIfNeeded: async () => {},
    boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
    fill: vi.fn(async (value: string) => {
      fields.value = value;
    }),
    evaluate: async (fn: (el: unknown, args: unknown) => unknown, args: unknown) => {
      if (navigateWhileWaiting) view.location.origin = "https://evil.test";
      return fn(element, args);
    },
  };
  const page = { url: () => `${origin}/login`, locator: () => locator } as unknown as Page;
  return { page, fields };
};

describe("origin-bound vault typing", () => {
  it.each([false, true])(
    "refuses an origin change (during locator wait: %s)",
    async (duringWait) => {
      const { page, fields } = fillPage(
        duringWait ? "https://safe.test" : "https://evil.test",
        duringWait,
      );
      await expect(
        BrowserPage.type(page, {
          text: "vault-password",
          selector: "input",
          clear: true,
          expectedOrigin: "https://safe.test",
        }),
      ).rejects.toThrow(/origin/i);
      expect(fields.value).toBe("");
    },
  );
  it("fills a matching origin and dispatches input events", async () => {
    const { page, fields } = fillPage("https://safe.test");
    await BrowserPage.type(page, {
      text: "vault-password",
      selector: "input",
      clear: true,
      expectedOrigin: "https://safe.test",
    });
    expect(fields.value).toBe("vault-password");
    expect(fields.events).toEqual(["input", "change"]);
  });
});
