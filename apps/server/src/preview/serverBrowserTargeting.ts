/**
 * Which server browser tab an agent's request means, and whether that tab is
 * the browser the user sees.
 *
 * Native desktop tabs share the user's Electron profile. A tab that starts
 * headless keeps its separate browsing session and streams into the panel
 * when shown. Until then, agents must hear that its login can differ from
 * the user's desktop tabs.
 */

export interface TargetableTab {
  readonly tabId: string;
  readonly threadId: string;
  /** The agent session that opened the tab, if an agent did. */
  readonly agentId: string | null;
  readonly createdAt: number;
  readonly usedAt: number;
  /** Streaming viewers watching the tab. */
  readonly viewerCount: number;
  /** The desktop app renders the tab in its panel. */
  readonly rendersOnDesktop: boolean;
}

export interface ShownTabs {
  /**
   * Native tabs the desktop app reported on screen. Null until it reports, in
   * which case a tab it renders counts as shown.
   */
  readonly reported: ReadonlySet<string> | null;
}

export const targetKey = (threadId: string, tabId: string) => `${threadId}\u0000${tabId}`;

/**
 * Whether the user can see a tab: a streaming viewer watches it, or the
 * desktop app shows it in its panel. Advisory only: nothing refuses to act on
 * a tab because it is not shown.
 */
export const isTabShown = (tab: TargetableTab, shown: ShownTabs): boolean => {
  if (tab.viewerCount > 0) return true;
  if (!tab.rendersOnDesktop) return false;
  return shown.reported === null || shown.reported.has(targetKey(tab.threadId, tab.tabId));
};

/**
 * The tab a request without a tabId means. The caller keeps working in its own
 * tab, the one on screen first, then its newest: an agent mid-flow must not
 * jump to another page because the user glanced at it (the result says the
 * user looks elsewhere, and acting on the tab brings it on screen). An agent
 * with no tab of its own gets the tab the user is looking at, so "this page"
 * means the page on screen, else the thread's most recently used tab.
 */
export const pickDefaultTab = <T extends TargetableTab>(
  tabs: Iterable<T>,
  threadId: string,
  agentSessionId: string | undefined,
  shown: ShownTabs,
): T | undefined => {
  const threadTabs = [...tabs].filter((tab) => tab.threadId === threadId);
  const byRecentUse = (left: T, right: T) => right.usedAt - left.usedAt;
  const own = threadTabs
    .filter((tab) => agentSessionId !== undefined && tab.agentId === agentSessionId)
    .toSorted((left, right) => right.createdAt - left.createdAt);
  return (
    own.find((tab) => isTabShown(tab, shown)) ??
    own[0] ??
    threadTabs.filter((tab) => isTabShown(tab, shown)).toSorted(byRecentUse)[0] ??
    threadTabs.toSorted(byRecentUse)[0]
  );
};

export type TabRendering = "panel" | "background";

export interface TabRenderingStatus {
  /** `panel`: the desktop's browser panel renders it. `background`: the server's own browser does. */
  readonly rendering: TabRendering;
  /** The tab runs in a browser whose logins differ from the panel the user sees. */
  readonly sessionMismatch?: true;
  readonly notice?: string;
}

export const BACKGROUND_TAB_NOTICE =
  "This tab runs in Cogenly's background browser and can have different logins from the desktop's native tabs. A sign-in page here does not mean the user is signed out. Showing this tab streams the same page into the panel, preserving its login and page state. Keep working: retry or use preview_wait_for rather than asking the user to show the panel or reply. If a sign-in page remains, sign in with vault_fill, or ask for a missing login privately; do not ask the user to sign in again in chat.";

export const notShownNotice = (shownTab: { readonly tabId: string; readonly url: string | null }) =>
  `The user is looking at another tab (${shownTab.tabId}${shownTab.url ? `, ${shownTab.url}` : ""}), not this one. Pass that tabId to work on the page they see.`;

/**
 * How a tab renders, and what the agent should know about it. `desktopAvailable`
 * is whether a desktop app renders this server's tabs at all; without one,
 * every tab is a background tab and that is expected.
 */
export const tabRenderingStatus = (
  tab: TargetableTab,
  desktopAvailable: boolean,
): TabRenderingStatus =>
  tab.rendersOnDesktop || tab.viewerCount > 0
    ? { rendering: "panel" }
    : desktopAvailable
      ? { rendering: "background", sessionMismatch: true, notice: BACKGROUND_TAB_NOTICE }
      : { rendering: "background" };

/**
 * The notice for a request's target: a session mismatch first, else that the
 * user looks at a different tab of the thread.
 */
export const targetNotice = <T extends TargetableTab & { readonly url: string | null }>(
  target: T,
  threadTabs: ReadonlyArray<T>,
  desktopAvailable: boolean,
  shown: ShownTabs,
): string | undefined => {
  const rendering = tabRenderingStatus(target, desktopAvailable);
  if (rendering.notice) return rendering.notice;
  if (isTabShown(target, shown)) return undefined;
  const shownTab = threadTabs.find(
    (tab) =>
      tab.tabId !== target.tabId && tab.threadId === target.threadId && isTabShown(tab, shown),
  );
  return shownTab ? notShownNotice(shownTab) : undefined;
};

/**
 * How a new server tab gets its page. A popup keeps its opener's page and
 * context. Otherwise the desktop's `<webview>` is used whenever it attached,
 * so the tab shares the panel's profile; only without one does the server run
 * it headless, in the profile's own context or, for a profile-less agent tab
 * or incognito, a throwaway one.
 */
export const tabBacking = (input: {
  readonly adopted: boolean;
  readonly desktopAttached: boolean;
  readonly agentOwned: boolean;
  readonly profileId: string | undefined;
  readonly incognitoProfileId: string;
}): "popup" | "desktop" | "headless" | "headless-isolated" => {
  if (input.adopted) return "popup";
  if (input.desktopAttached) return "desktop";
  return (input.agentOwned && input.profileId === undefined) ||
    input.profileId === input.incognitoProfileId
    ? "headless-isolated"
    : "headless";
};

/**
 * Whether a new tab should ask the desktop panel to show it before waiting for
 * its `<webview>`. Agent tabs do: an agent tab nobody shows never attaches, and
 * then runs headless with different logins. A person's own tabs already show,
 * and an agent that opened a tab in the background (`open: false`) keeps it
 * out of the panel, running headless.
 */
export const revealBeforeAttach = (input: {
  readonly desktopAvailable: boolean;
  readonly alreadyAttached: boolean;
  readonly adopted: boolean;
  readonly agentOwned: boolean;
  readonly background: boolean;
}): boolean =>
  input.desktopAvailable &&
  !input.alreadyAttached &&
  !input.adopted &&
  input.agentOwned &&
  !input.background;
