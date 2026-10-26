import { describe, expect, it } from "@effect/vitest";
import type { Page } from "playwright-core";

import * as ServerBrowserPage from "./ServerBrowserPage.ts";

/** A focused password field living in a document on `host`. */
const field = (host: string) => {
  const element = {
    tagName: "INPUT",
    type: "password",
    value: "",
    focus: () => {},
    select: () => {},
    contains: () => false,
    dispatchEvent: () => true,
    getRootNode: () => ({ activeElement: element }),
    ownerDocument: {
      defaultView: { location: { hostname: host } },
      getSelection: () => null,
      execCommand: (_command: string, _ui: boolean, text: string) => {
        element.value = text;
        return true;
      },
    },
  };
  return element;
};

/** A page that reports `url` and whose focused element is `element`; keyboard input is recorded. */
const pageWith = (url: string, element: ReturnType<typeof field>) => {
  const typed: Array<string> = [];
  const focused = {
    count: async () => 1,
    last: () => focused,
    evaluate: async <A, R>(run: (element: never, arg: A) => R, arg: A) =>
      run(element as never, arg),
  };
  const page = {
    url: () => url,
    locator: () => focused,
    keyboard: {
      press: async () => {},
      insertText: async (text: string) => {
        typed.push(text);
      },
    },
  } as unknown as Page;
  return { page, typed };
};

const binding = { origin: "https://good.test", allowedHosts: ["good.test"] };
const fill = { text: "hunter-2-secret", clear: true, vaultFill: binding };

describe("vault fill typing", () => {
  it("fills a field on the checked page", async () => {
    const element = field("login.good.test");
    const { page } = pageWith("https://good.test/login", element);
    await ServerBrowserPage.type(page, fill);
    expect(element.value).toBe("hunter-2-secret");
  });

  it("refuses when the field's document moved to another host after the check", async () => {
    // The page still reported the checked URL, but the document holding the
    // focused field is now another site's.
    const element = field("evil.test");
    const { page, typed } = pageWith("https://good.test/login", element);
    await expect(ServerBrowserPage.type(page, fill)).rejects.toMatchObject({
      tag: "PreviewAutomationVaultOriginError",
    });
    expect(element.value).toBe("");
    expect(typed).toEqual([]);
  });

  it("refuses when the page navigated away after the check", async () => {
    const element = field("evil.test");
    const { page, typed } = pageWith("https://evil.test/", element);
    await expect(ServerBrowserPage.type(page, fill)).rejects.toMatchObject({
      tag: "PreviewAutomationVaultOriginError",
    });
    expect(element.value).toBe("");
    expect(typed).toEqual([]);
  });
});
