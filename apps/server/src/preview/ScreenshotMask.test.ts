import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import type { Frame, Page } from "playwright-core";
import * as BrowserPage from "./ServerBrowserPage.ts";
import {
  MASK_WITHHELD_NOTE,
  VAULT_FILLED_ATTRIBUTE,
  frameMask,
  rememberCredential,
  credentialsFor,
  withMaskedPage,
} from "./ScreenshotMask.ts";

/** Just enough DOM for `frameMask`: elements, text nodes, attributes and inline styles. */
class FakeText {
  readonly nodeType = 3;
  parentElement: FakeElement | null = null;
  readonly nodeValue: string;
  constructor(nodeValue: string) {
    this.nodeValue = nodeValue;
  }
}

class FakeElement {
  readonly nodeType = 1;
  parentElement: FakeElement | null = null;
  shadowRoot: null = null;
  readonly isConnected = true;
  readonly children: Array<FakeElement | FakeText> = [];
  readonly attributes = new Map<string, string>();
  value?: string;
  readonly tagName: string;
  constructor(
    tagName: string,
    attributes: Record<string, string> = {},
    children: Array<FakeElement | FakeText | string> = [],
  ) {
    this.tagName = tagName;
    for (const [name, value] of Object.entries(attributes)) this.attributes.set(name, value);
    for (const child of children) {
      const node = typeof child === "string" ? new FakeText(child) : child;
      node.parentElement = this;
      this.children.push(node);
    }
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  readonly style = {
    setProperty: (name: string, value: string, priority: string) => {
      const rules = (this.getAttribute("style") ?? "")
        .split(";")
        .map((rule) => rule.trim())
        .filter((rule) => rule && !rule.startsWith(`${name}:`));
      this.setAttribute("style", [...rules, `${name}: ${value} !${priority}`].join("; "));
    },
  };
  /** The inline filter is the computed one: no page CSS in these fixtures. */
  get filter() {
    return /filter: ([^;!]+)/.exec(this.getAttribute("style") ?? "")?.[1]?.trim() ?? "none";
  }
}

const installDocument = (body: FakeElement) => {
  const walk = (node: FakeElement | FakeText): Array<FakeElement | FakeText> =>
    node instanceof FakeElement ? [node, ...node.children.flatMap(walk)] : [node];
  const document = {
    createTreeWalker: (root: unknown) => {
      const nodes = root === document ? walk(body) : [];
      let index = -1;
      return { nextNode: () => nodes[++index] ?? null };
    },
  };
  Object.assign(globalThis, {
    document,
    getComputedStyle: (element: FakeElement) => ({ filter: element.filter }),
  });
};

const frame = (overrides: Partial<Frame> = {}) =>
  ({
    evaluate: async (fn: typeof frameMask, command: Parameters<typeof frameMask>[0]) => fn(command),
    childFrames: () => [],
    isDetached: () => false,
    ...overrides,
  }) as unknown as Frame;

const pageWith = (...frames: Frame[]) => ({ frames: () => frames }) as unknown as Page;

afterEach(() => {
  Reflect.deleteProperty(globalThis, "document");
  Reflect.deleteProperty(globalThis, "getComputedStyle");
});

describe("screenshot credential masks", () => {
  it("masks before capture and restores the page's own styles after", async () => {
    const password = new FakeElement("INPUT", { type: "password", style: "color: red" });
    installDocument(new FakeElement("BODY", {}, [password]));
    const page = pageWith(frame());
    const during = await withMaskedPage(
      page,
      async () => [],
      async () => password.filter,
    );
    expect(during).toBe("brightness(0)");
    expect(password.getAttribute("style")).toBe("color: red");
  });

  it("masks text matching the redactor's secret patterns, and nothing else", async () => {
    const secret = new FakeElement("CODE", {}, ["GOCSPX-a1B2c3D4e5F6g7H8i9J0kLmN"]);
    const prose = new FakeElement("P", {}, ["Copy your client secret now"]);
    installDocument(new FakeElement("BODY", {}, [new FakeElement("DIALOG", {}, [secret, prose])]));
    const masked = await withMaskedPage(
      pageWith(frame()),
      async () => [],
      async () => [secret.filter, prose.filter],
    );
    expect(masked).toEqual(["brightness(0)", "none"]);
    expect(secret.getAttribute("style")).toBeNull();
  });

  it("keeps a password masked after the page reveals it", async () => {
    // Revealed in place: type flips to text, but vault_fill tagged the field.
    const tagged = Object.assign(
      new FakeElement("INPUT", { type: "text", [VAULT_FILLED_ATTRIBUTE]: "" }),
      { value: "hunter2-correct" },
    );
    // Revealed by re-rendering: a new, untagged field holding the filled value.
    const replaced = Object.assign(new FakeElement("INPUT", { type: "text" }), {
      value: "hunter2-correct",
    });
    const echoed = new FakeElement("SPAN", {}, ["Your password is hunter2-correct"]);
    const username = Object.assign(new FakeElement("INPUT", { autocomplete: "username" }), {
      value: "octocat",
    });
    const otp = new FakeElement("INPUT", { autocomplete: "one-time-code" });
    installDocument(new FakeElement("BODY", {}, [tagged, replaced, echoed, username, otp]));
    const page = pageWith(frame());
    rememberCredential(page, "hunter2-correct");
    const filters = await withMaskedPage(
      page,
      async () => credentialsFor(page),
      async () => [tagged, replaced, echoed, username, otp].map((element) => element.filter),
    );
    expect(filters).toEqual([
      "brightness(0)",
      "brightness(0)",
      "brightness(0)",
      "none",
      "brightness(0)",
    ]);
  });

  it("masks a typed password that was read before the page revealed it", async () => {
    const revealed = Object.assign(new FakeElement("INPUT", { type: "text" }), {
      value: "typed-by-user-77",
    });
    installDocument(new FakeElement("BODY", {}, [revealed]));
    // The password field holds the value until "show password" turns it into text.
    const passwordFields = [["typed-by-user-77"], []];
    const page = {
      frames: () => [frame()],
      locator: () => ({ evaluateAll: async () => passwordFields.shift() ?? [] }),
    } as unknown as Page;
    await BrowserPage.credentialValues(page); // read before the agent's click
    const filter = await withMaskedPage(
      page,
      () => BrowserPage.credentialValues(page),
      async () => revealed.filter,
    );
    expect(filter).toBe("brightness(0)");
  });

  it.each([
    [
      "a frame cannot be scanned",
      [],
      () => [
        frame(),
        frame({
          evaluate: async () => {
            throw new Error("Execution context was destroyed");
          },
        } as Partial<Frame>),
      ],
    ],
    // Playwright lists no frame for this iframe, so its contents were never scanned.
    ["an iframe has no frame to scan", [new FakeElement("IFRAME")], () => [frame()]],
  ])("withholds the image when %s", async (_case, children, frames) => {
    installDocument(new FakeElement("BODY", {}, children));
    const capture = vi.fn(async () => "image");
    expect(await withMaskedPage(pageWith(...frames()), async () => [], capture)).toBe(null);
    expect(capture).not.toHaveBeenCalled();
  });

  it("returns a vault_capture note instead of an unmasked screenshot", async () => {
    const send = vi.fn(async () => ({ data: "aW1hZ2U=" }));
    const page = {
      viewportSize: () => ({ width: 1280, height: 800 }),
      locator: () => ({ evaluateAll: async () => [] }),
      frames: () => [
        frame({
          evaluate: async () => {
            throw new Error("cross-origin frame");
          },
        } as Partial<Frame>),
      ],
    } as unknown as Page;
    const result = await BrowserPage.screenshot({
      page,
      cdp: { send } as unknown as import("playwright-core").CDPSession,
      renderScale: 1,
    });
    expect(result).toEqual({ screenshotError: MASK_WITHHELD_NOTE });
    expect(result.screenshotError).toContain("vault_capture");
    expect(send).not.toHaveBeenCalled();
  });
});
