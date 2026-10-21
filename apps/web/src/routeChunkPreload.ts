import type { AnyRouter } from "@tanstack/react-router";

import type { FileRoutesById } from "./routeTree.gen";

/**
 * Route components are split chunks (autoCodeSplitting). The rail navigates
 * with buttons rather than links, so the router's intent preload never sees
 * them; these load the code of the screens a rail click opens, on hover or
 * focus and once the app is idle. Code only: no beforeLoad or loader runs.
 */
export type RouteChunkId = Exclude<keyof FileRoutesById, "__root__">;

export type RailDestination = "threads" | "projects" | "settings" | "usage";

const RAIL_DESTINATION_ROUTES: Record<RailDestination, ReadonlyArray<RouteChunkId>> = {
  threads: ["/_chat", "/_chat/", "/_chat/$environmentId/$threadId", "/_chat/draft/$draftId"],
  projects: ["/_chat", "/_chat/project/", "/_chat/project/$environmentId/$labelId"],
  // "/settings" lands on General.
  settings: ["/settings", "/settings/general"],
  usage: ["/usage"],
};

/** Warmed while idle, most likely next screen first. */
export const IDLE_PRELOAD_DESTINATIONS: ReadonlyArray<RailDestination> = [
  "threads",
  "settings",
  "usage",
  "projects",
];

export function railDestinationRoutes(destination: RailDestination): ReadonlyArray<RouteChunkId> {
  return RAIL_DESTINATION_ROUTES[destination];
}

type ChunkRouter = Pick<AnyRouter, "loadRouteChunk" | "routesById">;

/** Loads the split code of `destination`'s routes; repeat calls are free. */
export function preloadRailDestination(router: ChunkRouter, destination: RailDestination): void {
  for (const id of railDestinationRoutes(destination)) {
    const route = router.routesById[id];
    if (!route) continue;
    // A chunk that fails to load here loads again on navigation, which reports it.
    void Promise.resolve(router.loadRouteChunk(route)).catch(() => undefined);
  }
}

export interface IdleScheduler {
  readonly request: (callback: () => void) => number;
  readonly cancel: (handle: number) => void;
}

const IDLE_TIMEOUT_MS = 2000;

const browserIdle: IdleScheduler =
  typeof requestIdleCallback === "function"
    ? {
        request: (callback) => requestIdleCallback(callback, { timeout: IDLE_TIMEOUT_MS }),
        cancel: (handle) => cancelIdleCallback(handle),
      }
    : {
        request: (callback) => window.setTimeout(callback, 200),
        cancel: (handle) => window.clearTimeout(handle),
      };

/**
 * Preloads `destinations` one per idle slot, so parsing a chunk never adds to
 * a busy frame. Returns a cancel function for whatever has not started.
 */
export function scheduleIdleRailPreload(
  router: ChunkRouter,
  destinations: ReadonlyArray<RailDestination> = IDLE_PRELOAD_DESTINATIONS,
  idle: IdleScheduler = browserIdle,
): () => void {
  let next = 0;
  let handle: number | null = null;
  const step = () => {
    handle = null;
    const destination = destinations[next++];
    if (destination === undefined) return;
    preloadRailDestination(router, destination);
    handle = idle.request(step);
  };
  handle = idle.request(step);
  return () => {
    if (handle !== null) idle.cancel(handle);
    handle = null;
    next = destinations.length;
  };
}
