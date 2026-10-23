import { describe, expect, it } from "vite-plus/test";

import { hostedBrowserWebviewSurface } from "./hostedBrowserWebviewStyle";

describe("hostedBrowserWebviewSurface", () => {
  it("takes the app theme while a page is loading", () => {
    expect(hostedBrowserWebviewSurface({ loading: true, url: "https://example.com" })).toBe(
      "theme",
    );
  });

  it("takes the app theme for a new or blank tab", () => {
    expect(hostedBrowserWebviewSurface({ loading: false, url: "about:blank" })).toBe("theme");
    expect(hostedBrowserWebviewSurface({ loading: false, url: "" })).toBe("theme");
    expect(hostedBrowserWebviewSurface({ loading: false, url: null })).toBe("theme");
  });

  it("puts white behind a loaded page, the browser default for unstyled pages", () => {
    expect(hostedBrowserWebviewSurface({ loading: false, url: "http://localhost:4329/" })).toBe(
      "page",
    );
  });
});
