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

describe("optional browser screenshots", () => {
  const fakePage = () =>
    ({
      viewportSize: () => ({ width: 2560, height: 1600 }),
      on: vi.fn(),
      evaluate: async () => ({
        url: "https://example.com",
        title: "Form",
        loading: false,
        visibleText: "Save",
        interactiveElements: [],
      }),
      ariaSnapshot: async () => '- button "Save" [ref=e1] [box=0,0,100,30]',
      title: async () => "Form",
      url: () => "https://example.com",
    }) as unknown as Page;

  it("returns structured data even if screenshot capture fails", async () => {
    const cdp = {
      send: vi.fn(async () => {
        throw new Error("UnknownVizError");
      }),
    } as unknown as import("playwright-core").CDPSession;
    const result = await BrowserPage.snapshot({
      page: fakePage(),
      cdp,
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });
    expect(result.title).toBe("Form");
    expect(result.accessibilityTree).toContain('button "Save"');
    expect(result.screenshot).toBeUndefined();
    expect(result.screenshotError).toContain("structured page data is still available");
  });

  it("never invokes screenshot CDP when images are not requested", async () => {
    const send = vi.fn();
    await BrowserPage.snapshot({
      page: fakePage(),
      cdp: { send } as unknown as import("playwright-core").CDPSession,
      renderScale: 1,
      includeScreenshot: false,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("downscales and compresses requested images and isolates their failure", async () => {
    const send = vi.fn(async (method: string) =>
      method === "Page.getLayoutMetrics"
        ? { cssVisualViewport: { pageX: 0, pageY: 0 } }
        : { data: "aW1hZ2U=" },
    );
    const input = {
      page: fakePage(),
      cdp: { send } as unknown as import("playwright-core").CDPSession,
      renderScale: 1,
    };
    expect(await BrowserPage.screenshot(input)).toEqual({
      screenshot: { mimeType: "image/jpeg", data: "aW1hZ2U=", width: 1280, height: 800 },
    });
    expect(send).toHaveBeenLastCalledWith("Page.captureScreenshot", {
      format: "jpeg",
      quality: 70,
      clip: { x: 0, y: 0, width: 2560, height: 1600, scale: 0.5 },
    });
    send.mockRejectedValueOnce(new Error("capture failed"));
    expect(await BrowserPage.screenshot(input)).toMatchObject({
      screenshotError: expect.any(String),
    });
  });

  it("keeps refs stable across observations and invalidates them on takeover", async () => {
    const page = fakePage();
    const first = await BrowserPage.observe(page);
    const second = await BrowserPage.observe(page);
    expect(first.elements?.[0]?.ref).toBe(second.elements?.[0]?.ref);
    BrowserPage.invalidateRefs(page);
    expect((await BrowserPage.observe(page)).elements?.[0]?.ref).not.toBe(first.elements?.[0]?.ref);
  });
});

it("extracts bounded JSON without a tree or image and quotes selectors and attributes safely", async () => {
  const selector = 'a[data-label="a\\"b"]';
  const attributes = ["href", "text", "missing"];
  const querySelectorAll = vi.fn(() =>
    Array.from({ length: 3 }, (_, index) => ({
      innerText: ` Link ${index} `,
      getAttribute: (name: string) => (name === "missing" ? null : `${name}:${index}`),
    })),
  );
  const send = vi.fn(async (_method: string, params: { expression: string }) => ({
    result: {
      value: new Function("document", `return ${params.expression}`)({ querySelectorAll }),
    },
  }));
  const value = await BrowserPage.extract(
    { send } as unknown as import("playwright-core").CDPSession,
    { selector, attributes, limit: 2 },
    15000,
  );
  expect(querySelectorAll).toHaveBeenCalledWith(selector);
  expect(value).toEqual({
    items: [
      { text: "Link 0", attributes: { href: "href:0", text: "text:0", missing: null } },
      { text: "Link 1", attributes: { href: "href:1", text: "text:1", missing: null } },
    ],
    total: 3,
    omitted: 1,
  });
  expect(send).toHaveBeenCalledTimes(1);
});
