/**
 * Per-thread preview UI state.
 *
 * Each thread owns an independent atom. Most consumers read exactly one
 * thread; the desktop browser host uses the aggregate session atom because it
 * is the one place that must enumerate every live preview tab.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@cogenly/client-runtime/environment";
import {
  type DesktopPreviewColorScheme,
  type DesktopPreviewFavicon,
  type PreviewEvent,
  type PreviewListResult,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@cogenly/contracts";
import { Atom } from "effect/reactivity";

import { PREVIEW_RECENT_URL_LIMIT } from "./components/preview/previewConstants";
import { appAtomRegistry } from "./rpc/atomRegistry";

export interface DesktopPreviewOverlay {
  hasWebContents: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  zoomFactor: number;
  pictureInPicture: boolean;
  colorScheme: DesktopPreviewColorScheme;
  audioMuted: boolean;
  audible: boolean;
  controller: "human" | "agent" | "none";
  favicon: DesktopPreviewFavicon | null;
}

export interface ThreadPreviewState {
  snapshot: PreviewSessionSnapshot | null;
  sessions: Record<string, PreviewSessionSnapshot>;
  /** Tabs intentionally closed by this client. Stale list snapshots must not resurrect them. */
  suppressedTabIds: ReadonlySet<string>;
  activeTabId: string | null;
  desktopOverlay: DesktopPreviewOverlay | null;
  desktopByTabId: Record<string, DesktopPreviewOverlay>;
  recentlySeenUrls: string[];
  /** Whether the first authoritative tab list has arrived. */
  listLoaded: boolean;
  /** Server process currently authoritative for revision ordering. */
  serverEpoch: string | null;
  /** Latest ordered server revision applied from a list response or event. */
  serverRevision: number;
}

const EMPTY_THREAD_PREVIEW_STATE: ThreadPreviewState = Object.freeze({
  snapshot: null,
  sessions: {},
  suppressedTabIds: new Set<string>(),
  activeTabId: null,
  desktopOverlay: null,
  desktopByTabId: {},
  recentlySeenUrls: [] as string[],
  listLoaded: false,
  serverEpoch: null,
  serverRevision: 0,
});

const emptyPreviewStateAtom = Atom.make<ThreadPreviewState>(EMPTY_THREAD_PREVIEW_STATE).pipe(
  Atom.withLabel("preview:empty-thread"),
);

export const previewStateAtom = Atom.family((threadKey: string) =>
  Atom.make<ThreadPreviewState>(EMPTY_THREAD_PREVIEW_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`preview:thread:${threadKey}`),
  ),
);

// Only the Electron browser host needs a cross-thread view. Keep that index
// separate so thread-local readers never subscribe to unrelated previews.
interface ActivePreviewThreadIndex {
  readonly keys: ReadonlySet<string>;
}

const activePreviewThreadKeysAtom = Atom.make<ActivePreviewThreadIndex>({
  keys: new Set<string>(),
}).pipe(Atom.keepAlive, Atom.withLabel("preview:active-thread-keys"));

const activePreviewSessionsAtom = Atom.make((get) => {
  const byThreadKey: Record<string, ThreadPreviewState> = {};
  for (const threadKey of get(activePreviewThreadKeysAtom).keys) {
    const state = get(previewStateAtom(threadKey));
    if (Object.keys(state.sessions).length > 0) {
      byThreadKey[threadKey] = state;
    }
  }
  return byThreadKey;
}).pipe(Atom.withLabel("preview:active-sessions"));

const changedPreviewThreadKeys = new Set<string>();

function syncActivePreviewThread(threadKey: string, state: ThreadPreviewState): void {
  const active = Object.keys(state.sessions).length > 0;
  appAtomRegistry.update(activePreviewThreadKeysAtom, (current) => {
    if (current.keys.has(threadKey) === active) return current;
    const next = new Set(current.keys);
    if (active) next.add(threadKey);
    else next.delete(threadKey);
    return { keys: next };
  });
}

function updateThreadPreviewState(
  ref: ScopedThreadRef,
  update: (current: ThreadPreviewState) => ThreadPreviewState,
): void {
  const threadKey = scopedThreadKey(ref);
  const atom = previewStateAtom(threadKey);
  let nextState = appAtomRegistry.get(atom);
  const changed = appAtomRegistry.modify(atom, (current) => {
    nextState = update(current);
    return [nextState !== current, nextState];
  });
  if (!changed) return;
  changedPreviewThreadKeys.add(threadKey);
  syncActivePreviewThread(threadKey, nextState);
}

const dedupeRecentUrls = (existing: string[], url: string): string[] => {
  const next = [url, ...existing.filter((entry) => entry !== url)];
  return next.slice(0, PREVIEW_RECENT_URL_LIMIT);
};

const rememberSnapshotUrl = (
  recentlySeenUrls: string[],
  snapshot: PreviewSessionSnapshot,
): string[] =>
  snapshot.navStatus._tag === "Idle"
    ? recentlySeenUrls
    : dedupeRecentUrls(recentlySeenUrls, snapshot.navStatus.url);

/**
 * An extension's popup or side panel: a server tab the panel draws beside its
 * host tab, never in the tab strip and never as the active tab.
 */
export const isExtensionSurface = (snapshot: PreviewSessionSnapshot | undefined | null): boolean =>
  snapshot?.extensionSurface !== undefined;

/** The sessions that are tabs, the ones the tab strip, panel and desktop webviews show. */
export const previewTabSessions = (
  sessions: Record<string, PreviewSessionSnapshot>,
): PreviewSessionSnapshot[] =>
  Object.values(sessions).filter((snapshot) => !isExtensionSurface(snapshot));

/**
 * The tab a session's reveal brings into view: the tab itself, or for an
 * extension's popup or side panel, the host tab it draws beside. Null for a
 * surface whose host isn't here.
 */
export function previewRevealTabId(
  sessions: Record<string, PreviewSessionSnapshot>,
  snapshot: PreviewSessionSnapshot,
): string | null {
  const hostTabId = snapshot.extensionSurface?.hostTabId;
  if (hostTabId === undefined) return snapshot.tabId;
  const host = sessions[hostTabId];
  return host && !isExtensionSurface(host) ? hostTabId : null;
}

/** The newest popup and side panel open on a host tab. */
export function selectExtensionSurfaces(
  sessions: Record<string, PreviewSessionSnapshot>,
  hostTabId: string | null,
): {
  readonly popup: PreviewSessionSnapshot | null;
  readonly sidePanel: PreviewSessionSnapshot | null;
} {
  let popup: PreviewSessionSnapshot | null = null;
  let sidePanel: PreviewSessionSnapshot | null = null;
  if (hostTabId === null) return { popup, sidePanel };
  for (const snapshot of Object.values(sessions)) {
    const surface = snapshot.extensionSurface;
    if (surface?.hostTabId !== hostTabId) continue;
    if (surface.kind === "popup") {
      if (!popup || popup.updatedAt < snapshot.updatedAt) popup = snapshot;
    } else if (!sidePanel || sidePanel.updatedAt < snapshot.updatedAt) {
      sidePanel = snapshot;
    }
  }
  return { popup, sidePanel };
}

const latestSnapshot = (
  sessions: Record<string, PreviewSessionSnapshot>,
): PreviewSessionSnapshot | null =>
  Object.values(sessions)
    .filter((snapshot) => !isExtensionSurface(snapshot))
    .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .at(-1) ?? null;

/** Surfaces live only as long as their host tab. */
const dropOrphanedSurfaces = (
  sessions: Record<string, PreviewSessionSnapshot>,
): Record<string, PreviewSessionSnapshot> => {
  const orphaned = Object.values(sessions).filter((snapshot) => {
    const hostTabId = snapshot.extensionSurface?.hostTabId;
    return hostTabId !== undefined && sessions[hostTabId] === undefined;
  });
  if (orphaned.length === 0) return sessions;
  const kept = { ...sessions };
  for (const snapshot of orphaned) delete kept[snapshot.tabId];
  return kept;
};

const removeSession = (current: ThreadPreviewState, tabId: string): ThreadPreviewState => {
  if (!current.sessions[tabId]) return current;
  const { [tabId]: _closed, ...remaining } = current.sessions;
  const sessions = dropOrphanedSurfaces(remaining);
  const desktopByTabId = Object.fromEntries(
    Object.entries(current.desktopByTabId).filter(([id]) => sessions[id] !== undefined),
  );
  const nextSnapshot = latestSnapshot(sessions);
  const activeTabId =
    current.activeTabId === tabId ? (nextSnapshot?.tabId ?? null) : current.activeTabId;
  const snapshot = activeTabId ? (sessions[activeTabId] ?? nextSnapshot) : nextSnapshot;
  return {
    ...current,
    sessions,
    desktopByTabId,
    activeTabId: snapshot?.tabId ?? null,
    snapshot,
    desktopOverlay: snapshot ? (desktopByTabId[snapshot.tabId] ?? null) : null,
  };
};

export function useThreadPreviewState(ref: ScopedThreadRef | null | undefined): ThreadPreviewState {
  const atom = ref ? previewStateAtom(scopedThreadKey(ref)) : emptyPreviewStateAtom;
  return useAtomValue(atom);
}

/** Whether a tab is an extension's popup or side panel; renders only when that answer changes. */
export function useIsExtensionSurfaceTab(ref: ScopedThreadRef, tabId: string): boolean {
  return useAtomValue(previewStateAtom(scopedThreadKey(ref)), (state) =>
    isExtensionSurface(state.sessions[tabId]),
  );
}

export function useActivePreviewSessions(): Record<string, ThreadPreviewState> {
  return useAtomValue(activePreviewSessionsAtom);
}

export function readThreadPreviewState(ref: ScopedThreadRef): ThreadPreviewState {
  return appAtomRegistry.get(previewStateAtom(scopedThreadKey(ref)));
}

export function applyPreviewServerEvent(ref: ScopedThreadRef, event: PreviewEvent): void {
  updateThreadPreviewState(ref, (current) => {
    if (current.serverEpoch !== null && event.serverEpoch !== current.serverEpoch) return current;
    if (event.revision < current.serverRevision) return current;
    const next = (() => {
      switch (event.type) {
        case "opened":
        case "navigated":
        case "resized": {
          const snapshot = event.snapshot;
          if (current.suppressedTabIds.has(snapshot.tabId)) return current;
          const surface = snapshot.extensionSurface;
          if (surface) {
            // A surface whose host already closed here has nothing to hang from.
            if (!current.sessions[surface.hostTabId]) return current;
            return { ...current, sessions: { ...current.sessions, [snapshot.tabId]: snapshot } };
          }
          const recentlySeenUrls =
            snapshot.navStatus._tag === "Idle"
              ? current.recentlySeenUrls
              : dedupeRecentUrls(current.recentlySeenUrls, snapshot.navStatus.url);
          const sessions = { ...current.sessions, [snapshot.tabId]: snapshot };
          const activeTabId = event.type === "opened" ? snapshot.tabId : current.activeTabId;
          const activeSnapshot = sessions[activeTabId ?? snapshot.tabId] ?? snapshot;
          return {
            ...current,
            sessions,
            activeTabId: activeTabId ?? snapshot.tabId,
            snapshot: activeSnapshot,
            desktopOverlay: current.desktopByTabId[activeSnapshot.tabId] ?? null,
            recentlySeenUrls,
          };
        }
        case "failed": {
          const existing = current.sessions[event.tabId];
          if (!existing) return current;
          const failedSnapshot = {
            ...existing,
            navStatus: {
              _tag: "LoadFailed" as const,
              url: event.url,
              title: event.title,
              code: event.code,
              description: event.description,
              ...(event.download === undefined ? {} : { download: event.download }),
            },
            updatedAt: event.createdAt,
          };
          const sessions = { ...current.sessions, [event.tabId]: failedSnapshot };
          return {
            ...current,
            sessions,
            snapshot: current.activeTabId === event.tabId ? failedSnapshot : current.snapshot,
          };
        }
        case "closed": {
          const closed = removeSession(current, event.tabId);
          if (!closed.suppressedTabIds.has(event.tabId)) return closed;
          const suppressedTabIds = new Set(closed.suppressedTabIds);
          suppressedTabIds.delete(event.tabId);
          return { ...closed, suppressedTabIds };
        }
      }
    })();
    return next.serverRevision === event.revision && next.serverEpoch === event.serverEpoch
      ? next
      : {
          ...next,
          serverEpoch: event.serverEpoch,
          serverRevision: event.revision,
        };
  });
}

export function applyPreviewServerSnapshot(
  ref: ScopedThreadRef,
  snapshot: PreviewSessionSnapshot | null,
): void {
  updateThreadPreviewState(ref, (current) => {
    if (!snapshot && current.snapshot === null) return current;
    if (!snapshot) {
      return {
        ...current,
        snapshot: null,
        sessions: {},
        activeTabId: null,
        desktopOverlay: null,
        desktopByTabId: {},
      };
    }
    if (current.suppressedTabIds.has(snapshot.tabId)) return current;
    const existing = current.sessions[snapshot.tabId];
    if (existing && existing.updatedAt > snapshot.updatedAt) return current;
    if (isExtensionSurface(snapshot)) {
      return { ...current, sessions: { ...current.sessions, [snapshot.tabId]: snapshot } };
    }
    const recentlySeenUrls = rememberSnapshotUrl(current.recentlySeenUrls, snapshot);
    return {
      ...current,
      snapshot,
      sessions: { ...current.sessions, [snapshot.tabId]: snapshot },
      activeTabId: snapshot.tabId,
      desktopOverlay: current.desktopByTabId[snapshot.tabId] ?? null,
      recentlySeenUrls,
    };
  });
}

/**
 * Merge a server mutation without changing which tab the user is viewing.
 *
 * Commands such as resize can target background tabs. Their response is
 * authoritative for that tab, but it is not a request to focus the tab.
 */
export function updatePreviewServerSnapshot(
  ref: ScopedThreadRef,
  snapshot: PreviewSessionSnapshot,
): void {
  updateThreadPreviewState(ref, (current) => {
    if (current.suppressedTabIds.has(snapshot.tabId)) return current;
    const existing = current.sessions[snapshot.tabId];
    if (existing && existing.updatedAt > snapshot.updatedAt) return current;
    const sessions = { ...current.sessions, [snapshot.tabId]: snapshot };
    if (isExtensionSurface(snapshot)) return { ...current, sessions };
    const activeTabId =
      current.activeTabId && sessions[current.activeTabId] ? current.activeTabId : snapshot.tabId;
    const activeSnapshot = sessions[activeTabId] ?? snapshot;
    return {
      ...current,
      sessions,
      activeTabId,
      snapshot: activeSnapshot,
      desktopOverlay: current.desktopByTabId[activeTabId] ?? null,
      recentlySeenUrls: rememberSnapshotUrl(current.recentlySeenUrls, snapshot),
    };
  });
}

/**
 * Replace the local session index from an authoritative preview.list result.
 * Missing tabs are removed while the current active tab is preserved whenever
 * it still exists in the server result.
 */
export function reconcilePreviewServerSessions(
  ref: ScopedThreadRef,
  result: PreviewListResult,
): void {
  updateThreadPreviewState(ref, (current) => {
    const sameServer = current.serverEpoch === result.serverEpoch;
    if (sameServer && result.revision < current.serverRevision) {
      return current;
    }
    const snapshots = result.sessions;
    const listed: Record<string, PreviewSessionSnapshot> = {};
    const currentSuppressedTabIds = sameServer ? current.suppressedTabIds : new Set<string>();
    let recentlySeenUrls = current.recentlySeenUrls;
    for (const snapshot of snapshots) {
      if (currentSuppressedTabIds.has(snapshot.tabId)) continue;
      const existing = sameServer ? current.sessions[snapshot.tabId] : undefined;
      const next = existing && existing.updatedAt > snapshot.updatedAt ? existing : snapshot;
      listed[next.tabId] = next;
      if (!isExtensionSurface(next)) recentlySeenUrls = rememberSnapshotUrl(recentlySeenUrls, next);
    }
    const sessions = dropOrphanedSurfaces(listed);

    const fallback = latestSnapshot(sessions);
    const activeTabId =
      current.activeTabId &&
      sessions[current.activeTabId] &&
      !isExtensionSurface(sessions[current.activeTabId])
        ? current.activeTabId
        : (fallback?.tabId ?? null);
    const snapshot = activeTabId ? (sessions[activeTabId] ?? null) : null;
    const desktopByTabId = sameServer
      ? Object.fromEntries(
          Object.entries(current.desktopByTabId).filter(([tabId]) => sessions[tabId] !== undefined),
        )
      : {};
    const suppressedTabIds = new Set(
      [...currentSuppressedTabIds].filter((tabId) =>
        snapshots.some((snapshot) => snapshot.tabId === tabId),
      ),
    );
    return {
      ...current,
      sessions,
      suppressedTabIds,
      activeTabId,
      snapshot,
      desktopByTabId,
      desktopOverlay: activeTabId ? (desktopByTabId[activeTabId] ?? null) : null,
      recentlySeenUrls,
      listLoaded: true,
      serverEpoch: result.serverEpoch,
      serverRevision: result.revision,
    };
  });
}

function isPreviewStateEqual(
  previous: DesktopPreviewOverlay | null,
  next: DesktopPreviewOverlay | null,
) {
  return (
    previous === next ||
    (previous !== null &&
      next !== null &&
      previous.hasWebContents === next.hasWebContents &&
      previous.canGoBack === next.canGoBack &&
      previous.canGoForward === next.canGoForward &&
      previous.loading === next.loading &&
      previous.zoomFactor === next.zoomFactor &&
      previous.pictureInPicture === next.pictureInPicture &&
      previous.colorScheme === next.colorScheme &&
      previous.audioMuted === next.audioMuted &&
      previous.audible === next.audible &&
      previous.controller === next.controller &&
      previous.favicon?.dataUrl === next.favicon?.dataUrl &&
      previous.favicon?.pageUrl === next.favicon?.pageUrl &&
      previous.favicon?.capturedAt === next.favicon?.capturedAt)
  );
}

export function applyPreviewDesktopState(
  ref: ScopedThreadRef,
  tabId: string,
  overlay: DesktopPreviewOverlay | null,
): void {
  updateThreadPreviewState(ref, (current) => {
    if (isPreviewStateEqual(current.desktopByTabId[tabId] ?? null, overlay)) {
      return current;
    }
    const desktopByTabId = { ...current.desktopByTabId };
    if (overlay) desktopByTabId[tabId] = overlay;
    else delete desktopByTabId[tabId];
    return {
      ...current,
      desktopByTabId,
      desktopOverlay: current.activeTabId === tabId ? overlay : current.desktopOverlay,
    };
  });
}

export function beginPreviewSessionClose(ref: ScopedThreadRef, tabId: string): void {
  updateThreadPreviewState(ref, (current) => {
    const suppressedTabIds = new Set(current.suppressedTabIds);
    suppressedTabIds.add(tabId);
    return {
      ...removeSession(current, tabId),
      suppressedTabIds,
    };
  });
}

export function cancelPreviewSessionClose(
  ref: ScopedThreadRef,
  snapshot: PreviewSessionSnapshot | null,
  tabId: string,
): void {
  updateThreadPreviewState(ref, (current) => {
    if (!current.suppressedTabIds.has(tabId)) return current;
    const suppressedTabIds = new Set(current.suppressedTabIds);
    suppressedTabIds.delete(tabId);
    if (!snapshot) {
      return { ...current, suppressedTabIds };
    }
    if (isExtensionSurface(snapshot)) {
      return {
        ...current,
        sessions: { ...current.sessions, [snapshot.tabId]: snapshot },
        suppressedTabIds,
      };
    }
    const recentlySeenUrls =
      snapshot.navStatus._tag !== "Idle"
        ? dedupeRecentUrls(current.recentlySeenUrls, snapshot.navStatus.url)
        : current.recentlySeenUrls;
    return {
      ...current,
      snapshot,
      sessions: { ...current.sessions, [snapshot.tabId]: snapshot },
      suppressedTabIds,
      activeTabId: snapshot.tabId,
      desktopOverlay: current.desktopByTabId[snapshot.tabId] ?? null,
      recentlySeenUrls,
    };
  });
}

export function setActivePreviewTab(ref: ScopedThreadRef, tabId: string): void {
  updateThreadPreviewState(ref, (current) => {
    const snapshot = current.sessions[tabId];
    if (!snapshot || isExtensionSurface(snapshot) || current.activeTabId === tabId) return current;
    return {
      ...current,
      activeTabId: tabId,
      snapshot,
      desktopOverlay: current.desktopByTabId[tabId] ?? null,
    };
  });
}

/**
 * Runs `action` once the thread's preview state has the tab, which a popup's
 * `opened` event may deliver after the stream that announced it. Gives up
 * after `timeoutMs`. Returns a cancel function.
 */
export function whenPreviewTabKnown(
  ref: ScopedThreadRef,
  tabId: string,
  action: () => void,
  timeoutMs = 5_000,
): () => void {
  const atom = previewStateAtom(scopedThreadKey(ref));
  if (appAtomRegistry.get(atom).sessions[tabId]) {
    action();
    return () => {};
  }
  const stop = () => {
    clearTimeout(timer);
    unsubscribe();
  };
  const unsubscribe = appAtomRegistry.subscribe(atom, (state) => {
    if (!state.sessions[tabId]) return;
    stop();
    action();
  });
  const timer = setTimeout(stop, timeoutMs);
  return stop;
}

export function rememberPreviewUrl(ref: ScopedThreadRef, url: string): void {
  if (url.trim().length === 0) return;
  updateThreadPreviewState(ref, (current) => ({
    ...current,
    recentlySeenUrls: dedupeRecentUrls(current.recentlySeenUrls, url),
  }));
}

export function isPreviewSupportedInRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.desktopBridge?.preview);
}

/**
 * Forgets a deleted thread's previews. The server closes their sessions too,
 * but the desktop host keeps a page for every session held here.
 */
export function clearThreadPreviewState(ref: ScopedThreadRef): void {
  updateThreadPreviewState(ref, (current) =>
    Object.keys(current.sessions).length === 0 ? current : EMPTY_THREAD_PREVIEW_STATE,
  );
}

export function resetPreviewStateForTests(): void {
  for (const threadKey of changedPreviewThreadKeys) {
    appAtomRegistry.set(previewStateAtom(threadKey), EMPTY_THREAD_PREVIEW_STATE);
  }
  changedPreviewThreadKeys.clear();
  appAtomRegistry.set(activePreviewThreadKeysAtom, { keys: new Set<string>() });
}

export const __testing = {
  EMPTY_THREAD_PREVIEW_STATE,
  RECENT_URL_LIMIT: PREVIEW_RECENT_URL_LIMIT,
};
