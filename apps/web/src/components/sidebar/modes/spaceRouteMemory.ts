/**
 * The per-space page memory (spaceRouteMemory.logic): recorded as pages
 * settle, kept in localStorage per primary environment, and read when a
 * space is picked. See useSelectSidebarMode and the rail's Settings button.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";

import { type DraftId, useComposerDraftStore } from "../../../composerDraftStore";
import { useThreadKind, useThreadKindResolver } from "../../../hooks/useThreadKind";
import { projectLabelKey } from "../../../projectLabels/projectLabels.logic";
import { useProjectLabelDirectory } from "../../../projectLabels/useProjectLabels";
import { appAtomRegistry } from "../../../rpc/atomRegistry";
import { readThreadShell, useThreadShell } from "../../../state/entities";
import { useConnectedEnvironmentIds } from "../../../state/environments";
import { primaryEnvironmentIdAtom } from "../../../state/primaryEnvironment";
import { allEnvironmentShellsBootstrappedAtom } from "../../../state/shell";
import { sidebarModeForThreadKind } from "../../../threadCapabilities";
import {
  parseStoredSpaceRouteMemory,
  rememberSpaceRoute,
  resolveSpaceReturn,
  spaceOfRoute,
  spaceRouteForMatch,
  type RememberedSpaceRoute,
  type SidebarSpace,
  type SpaceRouteAvailability,
  type SpaceRouteMemory,
} from "./spaceRouteMemory.logic";

const STORAGE_PREFIX = "cogenly:space-routes:v1:";

let cached: { readonly key: string; memory: SpaceRouteMemory } | null = null;

function storageKey(): string {
  return `${STORAGE_PREFIX}${appAtomRegistry.get(primaryEnvironmentIdAtom) ?? "local"}`;
}

function readMemory(): SpaceRouteMemory {
  const key = storageKey();
  if (cached?.key === key) return cached.memory;
  let memory: SpaceRouteMemory = {};
  try {
    const raw = localStorage.getItem(key);
    memory = raw ? parseStoredSpaceRouteMemory(JSON.parse(raw)) : {};
  } catch {
    // Unavailable or corrupted storage: start with nothing remembered.
  }
  cached = { key, memory };
  return memory;
}

function recordSpaceRoute(space: SidebarSpace, entry: RememberedSpaceRoute): void {
  const memory = readMemory();
  const next = rememberSpaceRoute(memory, space, entry);
  if (next === memory) return;
  const key = storageKey();
  cached = { key, memory: next };
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Best effort: losing it only forgets across a reload.
  }
}

/** Where Settings opens: the settings page last shown, else its first page. */
export function settingsReturnHref(): string {
  return resolveSpaceReturn(readMemory(), "settings", () => "available") ?? "/settings";
}

/**
 * Mount once in the app shell. Records each settled page against the space
 * that owns it; a thread or draft is recorded once its mode is known, so a
 * reload onto a thread that is still loading records it when it arrives.
 */
export function SpaceRouteMemoryTracker() {
  const settled = useRouterState({
    select: (state) => {
      const leaf = state.matches.at(-1);
      const href = state.resolvedLocation?.href;
      return leaf && href && state.status === "idle"
        ? JSON.stringify([href, leaf.routeId, leaf.params])
        : null;
    },
  });
  const page = useMemo(() => {
    if (settled === null) return null;
    const [href, routeId, params] = JSON.parse(settled) as [
      string,
      string,
      Record<string, string | undefined>,
    ];
    const route = spaceRouteForMatch({ routeId, params });
    return route === null ? null : { href, route };
  }, [settled]);
  const route = page?.route ?? null;
  const thread = useThreadShell(
    route?.kind === "thread"
      ? scopeThreadRef(route.environmentId as EnvironmentId, route.threadId as ThreadId)
      : null,
  );
  const draft = useComposerDraftStore((store) =>
    route?.kind === "draft" ? store.getDraftSession(route.draftId as DraftId) : null,
  );
  const kind = useThreadKind(thread ?? draft ?? null);
  const space =
    route === null
      ? null
      : spaceOfRoute(route, kind === null ? null : sidebarModeForThreadKind(kind));
  useEffect(() => {
    if (page !== null && space !== null) recordSpaceRoute(space, page);
  }, [page, space]);
  return null;
}

/**
 * Reads, at call time, where picking a space returns: its last page while
 * that page still shows something the space lists, else null (land afresh).
 */
export function useSpaceReturn(): (space: SidebarSpace) => string | null {
  const resolveKind = useThreadKindResolver();
  const projectDirectory = useProjectLabelDirectory(useConnectedEnvironmentIds());
  return useCallback(
    (space) =>
      resolveSpaceReturn(readMemory(), space, (route, owner): SpaceRouteAvailability => {
        switch (route.kind) {
          case "thread": {
            const thread = readThreadShell(
              scopeThreadRef(route.environmentId as EnvironmentId, route.threadId as ThreadId),
            );
            if (thread === null) {
              return appAtomRegistry.get(allEnvironmentShellsBootstrappedAtom) ? "gone" : "unknown";
            }
            if (thread.archivedAt !== null) return "gone";
            return sidebarModeForThreadKind(resolveKind(thread)) === owner ? "available" : "gone";
          }
          case "draft": {
            const draft = useComposerDraftStore
              .getState()
              .getDraftSession(route.draftId as DraftId);
            if (draft === null) return "gone";
            return sidebarModeForThreadKind(resolveKind(draft)) === owner ? "available" : "gone";
          }
          case "project":
            // An empty directory is still loading (or holds nothing to tell by).
            if (projectDirectory.labels.length === 0) return "unknown";
            return projectDirectory.byKey.has(projectLabelKey(route.environmentId, route.labelId))
              ? "available"
              : "gone";
          default:
            return "available";
        }
      }),
    [projectDirectory, resolveKind],
  );
}
