import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { Page } from "playwright-core";
import * as BrowserPage from "./ServerBrowserPage.ts";
import { VAULT_FILLED_ATTRIBUTE, credentialsFor } from "./ScreenshotMask.ts";

/** A fill target whose document can change during Playwright's locator wait. */
const fillPage = (origin: string, navigateWhileWaiting = false) => {
  const fields = { value: "", events: [] as string[], attributes: [] as string[] };
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
    setAttribute: (name: string) => {
      fields.attributes.push(name);
    },
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
    // Tracked so screenshots keep the field masked after "show password".
    expect(fields.attributes).toEqual([VAULT_FILLED_ATTRIBUTE]);
    expect(credentialsFor(page)).toEqual(["vault-password"]);
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
      locator: () => ({ evaluateAll: async () => [] }),
      // A page with nothing to mask: the scan confirms and capture proceeds.
      frames: () => [
        {
          evaluate: async (_mask: unknown, command: { op: string }) =>
            command.op === "collect" ? { texts: [], flagged: [], frames: 0 } : { restored: true },
          childFrames: () => [],
          isDetached: () => false,
        },
      ],
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

describe("vault capture", () => {
  it.effect("saves a page value but returns only vault metadata", () => {
    const fakeSecret = "GOCSPX-fakeOnly_0123456789abCDef";
    let saved = false;
    const page = { locator: () => ({ evaluate: async () => fakeSecret }) } as unknown as Page;
    return BrowserPage.capture(page, { locator: "input" }, (value) => {
      saved = value === fakeSecret;
      return Effect.succeed({ item: { id: "vault:captured", name: "google-oauth-client" } });
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(saved).toBe(true);
          expect(JSON.stringify(result).includes(fakeSecret)).toBe(false);
          expect(result.item.id).toBe("vault:captured");
        }),
      ),
    );
  });
  it.effect("does not leak page errors through capture failures", () => {
    const page = {
      locator: () => ({
        evaluate: async () => {
          throw new Error("GOCSPX-fakeOnly_0123456789abCDef");
        },
      }),
    } as unknown as Page;
    return BrowserPage.capture(page, { locator: "input" }, () => Effect.succeed({})).pipe(
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => expect(error.message).not.toContain("fakeOnly"))),
    );
  });
});

describe("checkbox click fallback and selector lists", () => {
  const checkboxPage = (pointerWorks: boolean) => {
    const control = {
      tagName: "INPUT",
      type: "checkbox",
      checked: false,
      disabled: false,
      click: () => {
        control.checked = !control.checked;
      },
      matches: () => true,
    };
    let fallback = 0;
    const nativeClick = control.click;
    control.click = () => {
      fallback++;
      nativeClick();
    };
    const locator = {
      evaluate: async (fn: (element: unknown, args: unknown) => unknown, args: unknown) =>
        fn(control, args),
      scrollIntoViewIfNeeded: async () => {},
      boundingBox: async () => ({ x: 0, y: 0, width: 20, height: 20 }),
      click: async () => {
        if (pointerWorks) control.checked = !control.checked;
      },
    };
    const select = vi.fn(() => locator);
    const page = { locator: select, once: () => {}, off: () => {} } as unknown as Page;
    return { page, control, select, fallback: () => fallback };
  };
  it.each([false, true])("toggles once when pointer click works: %s", async (pointerWorks) => {
    const fixture = checkboxPage(pointerWorks);
    const result = await BrowserPage.click(fixture.page, { locator: "mat-checkbox" });
    expect(fixture.control.checked).toBe(true);
    expect(fixture.fallback()).toBe(pointerWorks ? 0 : 1);
    expect(result.strategy).toBe(pointerWorks ? "pointer" : "input.click");
    expect(result.clicked).toBe("mat-checkbox");
  });
  it("passes CSS selector lists to the browser", async () => {
    const fixture = checkboxPage(true);
    await BrowserPage.click(fixture.page, { locator: 'input[type="checkbox"], label' });
    expect(fixture.select).toHaveBeenCalledWith('input[type="checkbox"], label');
  });
  it("explains that snapshot refs and role locators cannot be comma-joined", async () => {
    const fixture = checkboxPage(true);
    await expect(
      BrowserPage.click(fixture.page, { locator: "aria-ref=one, aria-ref=two" }),
    ).rejects.toThrow("Use one snapshot aria-ref");
    await expect(
      BrowserPage.click(fixture.page, { locator: "role=checkbox, role=button" }),
    ).rejects.toThrow("CSS selectors only");
  });
});
