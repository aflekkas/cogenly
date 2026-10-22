import { describe, expect, it } from "vite-plus/test";

import {
  previewTabHasPage,
  resolvePreviewMiniPlayerPresence,
} from "./previewMiniPlayerVisibility.logic";

const page = (tag: "Loading" | "Success", url: string) => ({ _tag: tag, url, title: "" }) as const;

describe("previewTabHasPage", () => {
  it("treats a new or blank tab as having nothing to show", () => {
    expect(previewTabHasPage(null)).toBe(false);
    expect(previewTabHasPage({ _tag: "Idle" })).toBe(false);
    expect(previewTabHasPage(page("Success", "about:blank"))).toBe(false);
    expect(previewTabHasPage(page("Loading", "about:blank"))).toBe(false);
    expect(previewTabHasPage(page("Success", "chrome://newtab/"))).toBe(false);
    expect(previewTabHasPage(page("Success", " "))).toBe(false);
  });

  it("counts a tab sent to a real address, loaded, loading, or failed", () => {
    expect(previewTabHasPage(page("Success", "http://localhost:5173/"))).toBe(true);
    expect(previewTabHasPage(page("Loading", "https://example.com/"))).toBe(true);
    expect(
      previewTabHasPage({
        _tag: "LoadFailed",
        url: "http://localhost:3000/",
        title: "",
        code: -102,
        description: "ERR_CONNECTION_REFUSED",
      }),
    ).toBe(true);
  });
});

describe("resolvePreviewMiniPlayerPresence", () => {
  const idle = { hasPage: false, painted: false, agentDriving: false, waitExpired: false };

  it("never shows a tab nobody used", () => {
    expect(resolvePreviewMiniPlayerPresence(idle)).toBe("hidden");
    // A blank page paints too, but there is still nothing to show.
    expect(resolvePreviewMiniPlayerPresence({ ...idle, painted: true })).toBe("hidden");
  });

  it("waits out a first load invisibly, then shows the painted page", () => {
    expect(resolvePreviewMiniPlayerPresence({ ...idle, hasPage: true })).toBe("hidden");
    expect(resolvePreviewMiniPlayerPresence({ ...idle, hasPage: true, painted: true })).toBe(
      "shown",
    );
  });

  it("shows a spinner only while an agent drives an unpainted tab, and only until the wait runs out", () => {
    expect(resolvePreviewMiniPlayerPresence({ ...idle, agentDriving: true })).toBe("loading");
    expect(resolvePreviewMiniPlayerPresence({ ...idle, hasPage: true, agentDriving: true })).toBe(
      "loading",
    );
    expect(
      resolvePreviewMiniPlayerPresence({
        ...idle,
        hasPage: true,
        agentDriving: true,
        waitExpired: true,
      }),
    ).toBe("hidden");
  });

  it("shows a page that paints after the wait ran out", () => {
    expect(
      resolvePreviewMiniPlayerPresence({
        hasPage: true,
        painted: true,
        agentDriving: false,
        waitExpired: true,
      }),
    ).toBe("shown");
  });
});
