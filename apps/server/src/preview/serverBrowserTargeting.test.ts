import { describe, expect, it } from "@effect/vitest";

import {
  BACKGROUND_TAB_NOTICE,
  isTabShown,
  pickDefaultTab,
  revealBeforeAttach,
  tabBacking,
  tabRenderingStatus,
  targetKey,
  targetNotice,
  type TargetableTab,
} from "./serverBrowserTargeting.ts";

const tab = (overrides: Partial<TargetableTab & { url: string | null }> & { tabId: string }) => ({
  threadId: "thread-1",
  agentId: null,
  createdAt: 0,
  usedAt: 0,
  viewerCount: 0,
  rendersOnDesktop: false,
  url: null,
  ...overrides,
});

const unreported = { reported: null };

describe("isTabShown", () => {
  it("counts a tab the desktop panel renders as shown, though it has no stream viewers", () => {
    // The regression: desktop tabs never have stream viewers, so they all read
    // as hidden while the user was looking right at them.
    expect(isTabShown(tab({ tabId: "a", rendersOnDesktop: true }), unreported)).toBe(true);
  });

  it("follows the panel's report once the desktop sends one", () => {
    const shown = { reported: new Set([targetKey("thread-1", "a")]) };
    expect(isTabShown(tab({ tabId: "a", rendersOnDesktop: true }), shown)).toBe(true);
    expect(isTabShown(tab({ tabId: "b", rendersOnDesktop: true }), shown)).toBe(false);
  });

  it("counts a streamed tab as shown while someone watches it", () => {
    expect(isTabShown(tab({ tabId: "a", viewerCount: 1 }), unreported)).toBe(true);
    expect(isTabShown(tab({ tabId: "a" }), unreported)).toBe(false);
  });
});

describe("pickDefaultTab", () => {
  it("gives an agent without a tab the one the user is looking at", () => {
    const shown = { reported: new Set([targetKey("thread-1", "visible")]) };
    const picked = pickDefaultTab(
      [
        tab({ tabId: "recent", rendersOnDesktop: true, usedAt: 9 }),
        tab({ tabId: "visible", rendersOnDesktop: true, usedAt: 1 }),
      ],
      "thread-1",
      "agent-1",
      shown,
    );
    expect(picked?.tabId).toBe("visible");
  });

  it("keeps an agent on its own tab, preferring the one on screen", () => {
    const shown = { reported: new Set([targetKey("thread-1", "own-old")]) };
    const tabs = [
      tab({ tabId: "own-old", agentId: "agent-1", createdAt: 1, rendersOnDesktop: true }),
      tab({ tabId: "own-new", agentId: "agent-1", createdAt: 2, rendersOnDesktop: true }),
      tab({ tabId: "user", rendersOnDesktop: true, usedAt: 5 }),
    ];
    expect(pickDefaultTab(tabs, "thread-1", "agent-1", shown)?.tabId).toBe("own-old");
    expect(pickDefaultTab(tabs, "thread-1", "agent-1", { reported: new Set() })?.tabId).toBe(
      "own-new",
    );
  });

  it("never picks a tab from another thread", () => {
    expect(
      pickDefaultTab(
        [tab({ tabId: "other", threadId: "thread-2", rendersOnDesktop: true })],
        "thread-1",
        "agent-1",
        unreported,
      ),
    ).toBeUndefined();
  });
});

describe("tabBacking", () => {
  const base = {
    adopted: false,
    desktopAttached: false,
    agentOwned: true,
    profileId: "default",
    incognitoProfileId: "incognito",
  };

  it("uses the panel's page for a new agent tab when the desktop attached it", () => {
    expect(tabBacking({ ...base, desktopAttached: true })).toBe("desktop");
    expect(tabBacking({ ...base, desktopAttached: true, profileId: undefined })).toBe("desktop");
  });

  it("keeps a popup in its opener's page and context", () => {
    expect(tabBacking({ ...base, adopted: true, desktopAttached: true })).toBe("popup");
  });

  it("runs headless only without a desktop page", () => {
    expect(tabBacking(base)).toBe("headless");
    expect(tabBacking({ ...base, profileId: undefined })).toBe("headless-isolated");
    expect(tabBacking({ ...base, profileId: "incognito" })).toBe("headless-isolated");
  });
});

describe("revealBeforeAttach", () => {
  const base = {
    desktopAvailable: true,
    alreadyAttached: false,
    adopted: false,
    agentOwned: true,
    background: false,
  };

  it("asks the panel to show a new agent tab before waiting for its webview", () => {
    expect(revealBeforeAttach(base)).toBe(true);
  });

  it("leaves the panel alone otherwise", () => {
    expect(revealBeforeAttach({ ...base, desktopAvailable: false })).toBe(false);
    expect(revealBeforeAttach({ ...base, alreadyAttached: true })).toBe(false);
    expect(revealBeforeAttach({ ...base, adopted: true })).toBe(false);
    expect(revealBeforeAttach({ ...base, agentOwned: false })).toBe(false);
  });

  it("keeps a tab the agent opened in the background out of the panel", () => {
    expect(revealBeforeAttach({ ...base, background: true })).toBe(false);
  });
});

describe("session mismatch", () => {
  it("flags a headless tab while the desktop app renders this server's tabs", () => {
    expect(tabRenderingStatus(tab({ tabId: "a" }), true)).toEqual({
      rendering: "background",
      sessionMismatch: true,
      notice: BACKGROUND_TAB_NOTICE,
    });
  });

  it("does not flag a panel tab, or a headless tab with no desktop app", () => {
    expect(tabRenderingStatus(tab({ tabId: "a", rendersOnDesktop: true }), true)).toEqual({
      rendering: "panel",
    });
    expect(tabRenderingStatus(tab({ tabId: "a" }), false)).toEqual({ rendering: "background" });
  });

  it("reports a streamed headless page as the panel's own page", () => {
    expect(tabRenderingStatus(tab({ tabId: "a", viewerCount: 1 }), true)).toEqual({
      rendering: "panel",
    });
  });

  it("names the tab the user is looking at when the target is another one", () => {
    const shown = { reported: new Set([targetKey("thread-1", "user")]) };
    const target = tab({ tabId: "agent", rendersOnDesktop: true });
    const user = tab({ tabId: "user", rendersOnDesktop: true, url: "https://grok.com/" });
    expect(targetNotice(target, [target, user], true, shown)).toContain("user");
    expect(targetNotice(target, [target, user], true, shown)).toContain("https://grok.com/");
    expect(targetNotice(user, [target, user], true, shown)).toBeUndefined();
  });
});
