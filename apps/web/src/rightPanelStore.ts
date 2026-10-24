/**
 * Thread-scoped right-panel surface state.
 *
 * This is intentionally a shallow workspace model: it owns an ordered set of
 * surface descriptors and the active surface, while each feature continues to
 * own its durable resource state. Browser surfaces point at preview tab ids,
 * file surfaces point at workspace paths, and files/device remain
 * singleton surfaces. Agent terminals live in the bottom panel
 * (bottomPanelStore), not here. The most recently changed threads are kept
 * (recentThreadEntries).
 */
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { useClosedViewStore } from "./closedViewStore";
import { setRecentThreadEntry, withoutThreadEntry } from "./lib/recentThreadEntries";
import { resolveStorage } from "./lib/storage";
import type { ChatFileAttachment } from "./types";

const RIGHT_PANEL_KINDS = ["files", "file", "preview", "device"] as const;
export type RightPanelKind = (typeof RIGHT_PANEL_KINDS)[number];

export interface DeviceTabTarget {
  hostId: string;
  deviceId: string;
  platform: "ios" | "android";
  name: string;
}

export type RightPanelSurface =
  | { id: `browser:${string}`; kind: "preview"; resourceId: string }
  | { id: "browser:new"; kind: "preview"; resourceId: null }
  | { id: "device" | `device:${string}`; kind: "device"; target?: DeviceTabTarget; title?: string }
  | {
      id: "files";
      kind: "files";
      /** Set when breadcrumbs moved a folder browser up to the workspace root. */
      folderTrail?: string;
    }
  | {
      id: `file:${string}` | `attachment:${string}`;
      kind: "file";
      /** Workspace-relative, or absolute for a host file outside the workspace. */
      relativePath: string;
      revealLine: number | null;
      revealRequestId: number;
      /** Present when the file lives in the thread's attachment store rather
          than at a workspace or host path. */
      attachment?: ChatFileAttachment;
      /**
       * Set when breadcrumbs moved a folder browser up from a deeper path: the
       * deepest workspace path the breadcrumbs keep offering on the way back down.
       */
      folderTrail?: string;
    };

const RIGHT_PANEL_STORAGE_KEY = "cogenly:right-panel-state:v2";
// v9 removed the "plan" surface kind (plans render inline in the transcript).
// v10 keys pull-request surfaces by reference instead of a singleton tab.
// v11 stops persisting the pull-request list's shared panel, so a restart opens the page fresh.
// v12 adds the device surface.
// v14 removes the agents surface; lineage lives in the thread title bar.
// v16 folds per-shell terminal surfaces into the single agent terminal surface.
// v17 removes the diff surface and the thread details panel's visibility.
// v18 moves agent terminals to the bottom panel: terminal surfaces are dropped.
const RIGHT_PANEL_STORAGE_VERSION = 18;

export interface ThreadRightPanelState {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: RightPanelSurface[];
  dismissedDeviceSurfaceIds?: string[];
  /** Kept with the thread so the layout survives a ChatView remount or a reload. */
  maximized?: true;
  /**
   * Surfaces in most-recently-active order, newest first. A header button
   * that switches back to a kind returns to the tab the user last had there.
   */
  recentSurfaceIds?: string[];
}

/**
 * The header's switcher groups surfaces by what they show: the files explorer
 * and file previews are one group, every other kind is its own.
 */
export type RightPanelSurfaceGroup = "browser" | "device" | "files";

export function surfaceGroupOf(surface: Pick<RightPanelSurface, "kind">): RightPanelSurfaceGroup {
  switch (surface.kind) {
    case "preview":
      return "browser";
    case "files":
    case "file":
      return "files";
    case "device":
      return surface.kind;
  }
}

interface RightPanelStoreState {
  byThreadKey: Record<string, ThreadRightPanelState>;
  /**
   * A thread whose right panel should open maximized the next time it shows,
   * such as one started for a link the OS opened. Its view consumes it once.
   */
  pendingMaximizeThreadKey: string | null;
  requestMaximize: (ref: ScopedThreadRef) => void;
  consumeMaximizeRequest: (ref: ScopedThreadRef) => boolean;
  closeRevisionByThreadKey: Record<string, number>;
  open: (ref: ScopedThreadRef, kind: Exclude<RightPanelKind, "file">) => void;
  openDevice: (ref: ScopedThreadRef, target: DeviceTabTarget, automatic?: boolean) => void;
  renameDevice: (ref: ScopedThreadRef, surfaceId: string, title: string) => void;
  /**
   * Adds and selects a browser tab. With `reveal: false` a closed panel stays
   * closed: the tab is there, selected, when the user next opens the panel.
   */
  openBrowser: (
    ref: ScopedThreadRef,
    tabId: string | null,
    options?: { readonly reveal?: boolean },
  ) => void;
  openFile: (ref: ScopedThreadRef, relativePath: string, line?: number) => void;
  /**
   * Moves the folder browser in `surfaceId` to `relativePath` in place, so walking
   * the breadcrumbs does not leave a tab behind per folder. `""` is the workspace
   * root, which is the files explorer. `folderTrail` is kept for the way back down.
   * `keepSource` opens the folder beside the source tab instead, for a file preview.
   */
  navigateFolder: (
    ref: ScopedThreadRef,
    surfaceId: string,
    relativePath: string,
    folderTrail: string,
    keepSource?: boolean,
  ) => void;
  openAttachment: (ref: ScopedThreadRef, attachment: ChatFileAttachment) => void;
  activateSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  /**
   * Shows the group's most recently active surface and opens the panel. A
   * no-op when the thread has no surface in that group, so the caller can
   * decide what to create.
   */
  activateGroup: (ref: ScopedThreadRef, group: RightPanelSurfaceGroup) => void;
  closeSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeOtherSurfaces: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurfacesToRight: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeAllSurfaces: (ref: ScopedThreadRef) => void;
  moveSurface: (ref: ScopedThreadRef, surfaceId: string, toIndex: number) => void;
  reconcileBrowserSurfaces: (
    ref: ScopedThreadRef,
    tabIds: readonly string[],
    hiddenTabIds?: ReadonlySet<string>,
  ) => void;
  reconcileFileSurfaces: (ref: ScopedThreadRef, workspaceAvailable: boolean) => void;
  show: (ref: ScopedThreadRef) => void;
  close: (ref: ScopedThreadRef) => void;
  setMaximized: (ref: ScopedThreadRef, maximized: boolean) => void;
  toggleVisibility: (ref: ScopedThreadRef) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

const EMPTY_THREAD_STATE: ThreadRightPanelState = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
};

const singletonSurface = (kind: Exclude<RightPanelKind, "file" | "preview">): RightPanelSurface => {
  switch (kind) {
    case "files":
      return { id: "files", kind };
    case "device":
      return { id: "device", kind };
  }
};

const browserSurface = (tabId: string | null): RightPanelSurface =>
  tabId
    ? { id: `browser:${tabId}`, kind: "preview", resourceId: tabId }
    : { id: "browser:new", kind: "preview", resourceId: null };

const fileSurface = (
  relativePath: string,
  revealLine: number | null,
  revealRequestId: number,
): RightPanelSurface => ({
  id: `file:${relativePath}`,
  kind: "file",
  relativePath,
  revealLine,
  revealRequestId,
});

const attachmentSurface = (attachment: ChatFileAttachment): RightPanelSurface => ({
  id: `attachment:${attachment.id}`,
  kind: "file",
  relativePath: attachment.name,
  revealLine: null,
  revealRequestId: 0,
  attachment,
});

const upsertSurface = (
  current: ThreadRightPanelState,
  surface: RightPanelSurface,
  activate = true,
): ThreadRightPanelState => ({
  ...current,
  isOpen: true,
  surfaces: current.surfaces.some((entry) => entry.id === surface.id)
    ? current.surfaces
    : [...current.surfaces, surface],
  activeSurfaceId: activate ? surface.id : current.activeSurfaceId,
});

const updateThreadStateMap = (
  byThreadKey: Record<string, ThreadRightPanelState>,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Record<string, ThreadRightPanelState> => {
  const current = byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
  const next = withRecentSurfaces(current, updater(current));
  if (
    !next.isOpen &&
    next.activeSurfaceId === null &&
    next.surfaces.length === 0 &&
    !next.dismissedDeviceSurfaceIds?.length
  ) {
    return withoutThreadEntry(byThreadKey, threadKey);
  }
  if (next === current) return byThreadKey;
  return setRecentThreadEntry(byThreadKey, threadKey, next);
};

/**
 * Keeps `recentSurfaceIds` in step with the selection: the active surface
 * moves to the front, and closed surfaces drop out. Runs on every update so
 * no action has to remember it.
 */
function withRecentSurfaces(
  current: ThreadRightPanelState,
  next: ThreadRightPanelState,
): ThreadRightPanelState {
  if (next === current) return current;
  const alive = new Set<string>(next.surfaces.map((surface) => surface.id));
  const previous = next.recentSurfaceIds ?? current.recentSurfaceIds ?? [];
  const recent = [
    ...(next.activeSurfaceId !== null && alive.has(next.activeSurfaceId)
      ? [next.activeSurfaceId]
      : []),
    ...previous.filter((id) => alive.has(id) && id !== next.activeSurfaceId),
  ];
  const unchanged =
    recent.length === previous.length && recent.every((id, index) => id === previous[index]);
  if (unchanged && (next.recentSurfaceIds !== undefined || recent.length === 0)) return next;
  if (recent.length === 0) {
    const { recentSurfaceIds: _empty, ...rest } = next;
    return rest;
  }
  return { ...next, recentSurfaceIds: recent };
}

/** The group's surface the user had most recently, falling back to its first tab. */
export function selectGroupSurface(
  state: ThreadRightPanelState,
  group: RightPanelSurfaceGroup,
): RightPanelSurface | null {
  const inGroup = state.surfaces.filter((surface) => surfaceGroupOf(surface) === group);
  if (inGroup.length === 0) return null;
  for (const id of state.recentSurfaceIds ?? []) {
    const match = inGroup.find((surface) => surface.id === id);
    if (match) return match;
  }
  return inGroup[0] ?? null;
}

const updateThread = (
  state: Pick<RightPanelStoreState, "byThreadKey">,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Pick<RightPanelStoreState, "byThreadKey"> => ({
  byThreadKey: updateThreadStateMap(state.byThreadKey, threadKey, updater),
});

// Every store action is a user choice unless it goes through `automaticUpdate`.
// Only device reveals and resource reconciliation are
// automatic: a user choice is what remembers dismissed devices.
const automaticUpdate = (
  state: RightPanelStoreState,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Partial<RightPanelStoreState> => ({
  ...updateThread(state, threadKey, updater),
});

const userAction = (
  state: RightPanelStoreState,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
  closesView = false,
): Partial<RightPanelStoreState> => ({
  ...updateThread(state, threadKey, (current) => {
    const next = updater(current);
    if (next === current) return current;
    const removedDevices = current.surfaces.filter(
      (surface) =>
        surface.kind === "device" && !next.surfaces.some((entry) => entry.id === surface.id),
    );
    if (removedDevices.length === 0) return next;
    return {
      ...next,
      dismissedDeviceSurfaceIds: [
        ...new Set([
          ...(next.dismissedDeviceSurfaceIds ?? []),
          ...removedDevices.map((surface) => surface.id),
        ]),
      ],
    };
  }),
  ...(closesView
    ? {
        closeRevisionByThreadKey: {
          ...state.closeRevisionByThreadKey,
          [threadKey]: (state.closeRevisionByThreadKey[threadKey] ?? 0) + 1,
        },
      }
    : {}),
});

const closeAction = (
  state: RightPanelStoreState,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Partial<RightPanelStoreState> => userAction(state, threadKey, updater, true);

function normalizeRevealLine(line: number | undefined): number | null {
  if (line === undefined || !Number.isFinite(line)) return null;
  return Math.max(1, Math.trunc(line));
}

export function migratePersistedRightPanelState(persistedState: unknown): {
  byThreadKey: Record<string, ThreadRightPanelState>;
} {
  if (!persistedState || typeof persistedState !== "object") {
    return { byThreadKey: {} };
  }
  const byThreadKey =
    "byThreadKey" in persistedState &&
    persistedState.byThreadKey &&
    typeof persistedState.byThreadKey === "object"
      ? Object.fromEntries(
          Object.entries(persistedState.byThreadKey as Record<string, ThreadRightPanelState>)
            .filter(([threadKey]) => !threadKey.endsWith(":pull-requests-panel"))
            .map(([threadKey, threadState]) => {
              const validThreadState =
                threadState && typeof threadState === "object" ? threadState : null;
              const surfaces = Array.isArray(validThreadState?.surfaces)
                ? validThreadState.surfaces.flatMap<RightPanelSurface>((surface) => {
                    // Removed surfaces: plans render inline, agents in thread lineage,
                    // the thread UI has no diff view, and terminals moved to the bottom panel.
                    const kind = (surface as { kind?: string }).kind;
                    if (
                      kind === "terminal" ||
                      kind === "plan" ||
                      kind === "diff" ||
                      kind === "agents" ||
                      kind === "pull-request" ||
                      kind === "pull-requests"
                    )
                      return [];
                    if (
                      (surface.kind === "file" || surface.kind === "files") &&
                      "folderTrail" in surface &&
                      typeof surface.folderTrail !== "string"
                    ) {
                      const { folderTrail: _invalid, ...rest } = surface;
                      surface = rest;
                    }
                    if (surface.kind === "file") {
                      const revealLine =
                        typeof surface.revealLine === "number" &&
                        Number.isFinite(surface.revealLine)
                          ? Math.max(1, Math.trunc(surface.revealLine))
                          : null;
                      const revealRequestId =
                        typeof surface.revealRequestId === "number" &&
                        Number.isSafeInteger(surface.revealRequestId) &&
                        surface.revealRequestId >= 0
                          ? surface.revealRequestId
                          : 0;
                      return [{ ...surface, revealLine, revealRequestId }];
                    }
                    return [surface];
                  })
                : [];
              const rawActiveSurfaceId = validThreadState?.activeSurfaceId;
              const persistedActiveSurfaceId = surfaces.some(
                (surface) => surface.id === rawActiveSurfaceId,
              )
                ? (rawActiveSurfaceId ?? null)
                : null;
              // A migration that dropped every surface (e.g. plan-only panels
              // in v9) must not reopen an empty panel.
              const isOpen =
                surfaces.length > 0 &&
                (typeof validThreadState?.isOpen === "boolean"
                  ? validThreadState.isOpen
                  : persistedActiveSurfaceId !== null);
              // An open panel needs an active surface: if migration dropped
              // the persisted one (e.g. plan was active), fall back to the
              // first survivor instead of rendering an open empty panel. Removed
              // agents selections also keep a survivor ready while the panel is closed.
              const activeSurfaceId =
                persistedActiveSurfaceId ??
                (isOpen || rawActiveSurfaceId === "agents" ? (surfaces[0]?.id ?? null) : null);
              return [
                threadKey,
                {
                  isOpen,
                  surfaces,
                  activeSurfaceId,
                  ...(Array.isArray(validThreadState?.dismissedDeviceSurfaceIds)
                    ? {
                        dismissedDeviceSurfaceIds:
                          validThreadState.dismissedDeviceSurfaceIds.filter(
                            (id): id is string => typeof id === "string",
                          ),
                      }
                    : {}),
                  ...(validThreadState?.maximized === true ? { maximized: true as const } : {}),
                  ...(Array.isArray(validThreadState?.recentSurfaceIds)
                    ? {
                        recentSurfaceIds: validThreadState.recentSurfaceIds.filter(
                          (id): id is string =>
                            typeof id === "string" && surfaces.some((surface) => surface.id === id),
                        ),
                      }
                    : {}),
                },
              ];
            }),
        )
      : {};
  return { byThreadKey };
}

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(
    (set, get) => ({
      byThreadKey: {},
      pendingMaximizeThreadKey: null,
      requestMaximize: (ref) => set({ pendingMaximizeThreadKey: scopedThreadKey(ref) }),
      consumeMaximizeRequest: (ref) => {
        if (get().pendingMaximizeThreadKey !== scopedThreadKey(ref)) return false;
        set({ pendingMaximizeThreadKey: null });
        return true;
      },
      closeRevisionByThreadKey: {},
      open: (ref, kind) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            if (kind === "preview") {
              const existing = current.surfaces.find((surface) => surface.kind === "preview");
              return upsertSurface(current, existing ?? browserSurface(null));
            }
            return upsertSurface(current, singletonSurface(kind));
          }),
        ),
      openDevice: (ref, target, automatic = false) =>
        set((state) =>
          (automatic ? automaticUpdate : userAction)(state, scopedThreadKey(ref), (current) => {
            const id =
              `device:${encodeURIComponent(target.hostId)}:${encodeURIComponent(target.deviceId)}` as const;
            if (automatic && current.dismissedDeviceSurfaceIds?.includes(id)) return current;
            const surface: RightPanelSurface = { id, kind: "device", target };
            const existing = current.surfaces.find((entry) => entry.id === id);
            const surfaces = existing
              ? current.surfaces.filter((entry) => entry.id !== "device")
              : current.surfaces.map((entry) => (entry.id === "device" ? surface : entry));
            return upsertSurface(
              {
                ...current,
                surfaces,
                dismissedDeviceSurfaceIds: (current.dismissedDeviceSurfaceIds ?? []).filter(
                  (entry) => entry !== id,
                ),
              },
              existing ?? surface,
            );
          }),
        ),
      renameDevice: (ref, surfaceId, title) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => ({
            ...current,
            surfaces: current.surfaces.map((surface) =>
              surface.id === surfaceId && surface.kind === "device"
                ? { ...surface, title: title.trim() || surface.target?.name || "Device" }
                : surface,
            ),
          })),
        ),
      openBrowser: (ref, tabId, options) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const surface = browserSurface(tabId);
            const withoutPlaceholder = tabId
              ? current.surfaces.filter((entry) => entry.id !== "browser:new")
              : current.surfaces;
            const next = upsertSurface({ ...current, surfaces: withoutPlaceholder }, surface);
            return options?.reveal === false && !current.isOpen ? { ...next, isOpen: false } : next;
          }),
        ),

      openFile: (ref, requestedPath, line) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            if (requestedPath === ".") {
              return upsertSurface(current, singletonSurface("files"));
            }
            // Workspace entry paths use '/', including on Windows.
            const relativePath = /^[A-Za-z]:\/+$/.test(requestedPath)
              ? requestedPath
              : requestedPath.replace(/\/+$/, "") || requestedPath;
            const withoutStandaloneExplorer = current.surfaces.filter(
              (surface) => surface.kind !== "files",
            );
            const surfaceId = `file:${relativePath}` as const;
            const existing = withoutStandaloneExplorer.find(
              (surface): surface is Extract<RightPanelSurface, { kind: "file" }> =>
                surface.id === surfaceId && surface.kind === "file",
            );
            const surface = fileSurface(
              relativePath,
              normalizeRevealLine(line),
              (existing?.revealRequestId ?? 0) + 1,
            );
            return {
              ...current,
              isOpen: true,
              activeSurfaceId: surface.id,
              surfaces: existing
                ? withoutStandaloneExplorer.map((entry) =>
                    entry.id === surface.id ? surface : entry,
                  )
                : [...withoutStandaloneExplorer, surface],
            };
          }),
        ),

      navigateFolder: (ref, surfaceId, relativePath, folderTrail, keepSource = false) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0) return current;
            const trail = folderTrail === relativePath ? {} : { folderTrail };
            const target: RightPanelSurface =
              relativePath === ""
                ? { ...singletonSurface("files"), ...trail }
                : { ...fileSurface(relativePath, null, 1), ...trail };
            const source = current.surfaces[index]!;
            // A tab already showing the target wins, so its state is never replaced.
            const existing = current.surfaces.some(
              (surface, i) => i !== index && surface.id === target.id,
            );
            const surfaces = current.surfaces.flatMap((surface, i) => {
              if (i === index) {
                const kept = keepSource ? [source] : [];
                return existing ? kept : [...kept, target];
              }
              // Like openFile: a file surface replaces the standalone explorer.
              return !existing && target.kind === "file" && surface.kind === "files"
                ? []
                : [surface];
            });
            return { ...current, isOpen: true, activeSurfaceId: target.id, surfaces };
          }),
        ),

      openAttachment: (ref, attachment) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const withoutStandaloneExplorer = current.surfaces.filter(
              (surface) => surface.kind !== "files",
            );
            return upsertSurface(
              { ...current, surfaces: withoutStandaloneExplorer },
              attachmentSurface(attachment),
            );
          }),
        ),
      activateSurface: (ref, surfaceId) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            current.surfaces.some((surface) => surface.id === surfaceId)
              ? { ...current, isOpen: true, activeSurfaceId: surfaceId }
              : current,
          ),
        ),
      activateGroup: (ref, group) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const surface = selectGroupSurface(current, group);
            if (!surface) return current;
            if (current.isOpen && current.activeSurfaceId === surface.id) return current;
            return { ...current, isOpen: true, activeSurfaceId: surface.id };
          }),
        ),
      closeSurface: (ref, surfaceId) =>
        set((state) =>
          closeAction(state, scopedThreadKey(ref), (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0) return current;
            const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId);
            const next = {
              ...current,
              isOpen: surfaces.length > 0 && current.isOpen,
              surfaces,
            };
            if (current.activeSurfaceId !== surfaceId) {
              return next;
            }
            const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
            return {
              ...next,
              activeSurfaceId: fallback?.id ?? null,
            };
          }),
        ),
      closeOtherSurfaces: (ref, surfaceId) =>
        set((state) =>
          closeAction(state, scopedThreadKey(ref), (current) => {
            const surface = current.surfaces.find((entry) => entry.id === surfaceId);
            if (!surface || current.surfaces.length === 1) return current;
            return {
              ...current,
              isOpen: true,
              surfaces: [surface],
              activeSurfaceId: surface.id,
            };
          }),
        ),
      closeSurfacesToRight: (ref, surfaceId) =>
        set((state) =>
          closeAction(state, scopedThreadKey(ref), (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0 || index === current.surfaces.length - 1) return current;
            const surfaces = current.surfaces.slice(0, index + 1);
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            return {
              ...current,
              surfaces,
              activeSurfaceId: activeStillExists ? current.activeSurfaceId : surfaceId,
            };
          }),
        ),
      closeAllSurfaces: (ref) =>
        set((state) =>
          closeAction(state, scopedThreadKey(ref), (current) =>
            current.surfaces.length === 0
              ? current
              : { ...current, isOpen: false, surfaces: [], activeSurfaceId: null },
          ),
        ),
      // Reordering is not a choice about what the panel shows.
      moveSurface: (ref, surfaceId, toIndex) =>
        set((state) =>
          updateThread(state, scopedThreadKey(ref), (current) => {
            const fromIndex = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (fromIndex < 0 || fromIndex === toIndex) return current;
            const surfaces = [...current.surfaces];
            surfaces.splice(toIndex, 0, ...surfaces.splice(fromIndex, 1));
            return { ...current, surfaces };
          }),
        ),
      reconcileBrowserSurfaces: (ref, tabIds, hiddenTabIds) =>
        set((state) =>
          automaticUpdate(state, scopedThreadKey(ref), (current) => {
            const validIds = new Set(tabIds.map((tabId) => `browser:${tabId}`));
            // Filtered in place so browser tabs keep the order the user dragged them into.
            const kept = current.surfaces.filter(
              (surface) =>
                surface.kind !== "preview" ||
                (surface.id !== "browser:new" && validIds.has(surface.id)),
            );
            const knownIds = new Set(kept.map((surface) => surface.id));
            const added = tabIds
              .filter((tabId) => !knownIds.has(`browser:${tabId}`) && !hiddenTabIds?.has(tabId))
              .map((tabId) => browserSurface(tabId));
            const surfaces = [...kept, ...added];
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            const fallbackBrowser = surfaces.find((surface) => surface.kind === "preview");
            return {
              ...current,
              surfaces,
              activeSurfaceId: activeStillExists
                ? current.activeSurfaceId
                : (fallbackBrowser?.id ?? surfaces[0]?.id ?? null),
            };
          }),
        ),
      reconcileFileSurfaces: (ref, workspaceAvailable) =>
        set((state) =>
          automaticUpdate(state, scopedThreadKey(ref), (current) => {
            if (workspaceAvailable) return current;
            const surfaces = current.surfaces.filter(
              (surface) =>
                surface.kind !== "files" &&
                (surface.kind !== "file" || surface.attachment !== undefined),
            );
            if (surfaces.length === current.surfaces.length) return current;
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            return {
              ...current,
              isOpen: surfaces.length > 0 ? current.isOpen : false,
              surfaces,
              activeSurfaceId: activeStillExists
                ? current.activeSurfaceId
                : (surfaces.at(-1)?.id ?? null),
            };
          }),
        ),
      show: (ref) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            current.isOpen ? current : { ...current, isOpen: true },
          ),
        ),
      close: (ref) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            current.isOpen ? { ...current, isOpen: false } : current,
          ),
        ),
      // Layout only: it changes no surface.
      setMaximized: (ref, maximized) =>
        set((state) =>
          automaticUpdate(state, scopedThreadKey(ref), (current) => {
            if ((current.maximized ?? false) === maximized) return current;
            const { maximized: _maximized, ...rest } = current;
            return maximized ? { ...rest, maximized: true } : rest;
          }),
        ),
      toggleVisibility: (ref) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => ({
            ...current,
            isOpen: !current.isOpen,
          })),
        ),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey) && !(threadKey in state.closeRevisionByThreadKey)) {
            return state;
          }
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          const { [threadKey]: _closeRevision, ...closeRevisionByThreadKey } =
            state.closeRevisionByThreadKey;
          return {
            byThreadKey,
            closeRevisionByThreadKey,
          };
        }),
    }),
    {
      name: RIGHT_PANEL_STORAGE_KEY,
      version: RIGHT_PANEL_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        byThreadKey: Object.fromEntries(
          Object.entries(state.byThreadKey).filter(
            ([threadKey]) => !threadKey.endsWith(":pull-requests-panel"),
          ),
        ),
      }),
      migrate: migratePersistedRightPanelState,
    },
  ),
);

useRightPanelStore.subscribe((next, previous) => {
  if (next.closeRevisionByThreadKey === previous.closeRevisionByThreadKey) return;
  for (const [threadKey, revision] of Object.entries(next.closeRevisionByThreadKey)) {
    if (revision === previous.closeRevisionByThreadKey[threadKey]) continue;
    const threadRef = parseScopedThreadKey(threadKey);
    if (!threadRef) continue;
    const before = previous.byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
    const after = next.byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
    const removed = before.surfaces.filter(
      (surface) => !after.surfaces.some((entry) => entry.id === surface.id),
    );
    const closedInOrder = [
      ...removed.filter((surface) => surface.id !== before.activeSurfaceId),
      ...removed.filter((surface) => surface.id === before.activeSurfaceId),
    ];
    for (const surface of closedInOrder) {
      if (surface.kind === "preview" && surface.resourceId !== null) continue;
      useClosedViewStore.getState().remember({ kind: "panel-tab", threadRef, surface });
    }
  }
});

export function selectThreadRightPanelState(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): ThreadRightPanelState {
  if (!ref) return EMPTY_THREAD_STATE;
  return byThreadKey[scopedThreadKey(ref)] ?? EMPTY_THREAD_STATE;
}

export function selectActiveRightPanel(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelKind | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  if (!state.isOpen) return null;
  return selectedSurface(state)?.kind ?? null;
}

/** An open tab strip always shows one of its tabs, the first when the selection is missing. */
function selectedSurface(state: ThreadRightPanelState): RightPanelSurface | null {
  return (
    state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ??
    state.surfaces[0] ??
    null
  );
}

export function selectActiveRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  if (!state.isOpen) return null;
  return selectSelectedRightPanelSurface(byThreadKey, ref);
}

/** The selected surface even while the panel is hidden, so a layout control can restore it. */
export function selectSelectedRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface | null {
  return selectedSurface(selectThreadRightPanelState(byThreadKey, ref));
}
