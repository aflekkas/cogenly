import { describe, expect, it } from "vite-plus/test";

import {
  preloadRailDestination,
  railDestinationRoutes,
  scheduleIdleRailPreload,
  type IdleScheduler,
} from "./routeChunkPreload";

function fakeRouter(ids: ReadonlyArray<string>) {
  const loaded: string[] = [];
  const routesById = Object.fromEntries(ids.map((id) => [id, { id }]));
  const router = {
    routesById,
    loadRouteChunk: (route: { id: string }) => {
      loaded.push(route.id);
      return Promise.resolve();
    },
  } as unknown as Parameters<typeof preloadRailDestination>[0];
  return { router, loaded };
}

function manualIdle() {
  const queue = new Map<number, () => void>();
  let next = 1;
  const idle: IdleScheduler = {
    request: (callback) => {
      const handle = next++;
      queue.set(handle, callback);
      return handle;
    },
    cancel: (handle) => {
      queue.delete(handle);
    },
  };
  const runOne = () => {
    const [handle, callback] = queue.entries().next().value ?? [];
    if (handle === undefined || callback === undefined) return false;
    queue.delete(handle);
    callback();
    return true;
  };
  return { idle, runOne, pending: () => queue.size };
}

describe("preloadRailDestination", () => {
  it("loads Settings with the General page it lands on", () => {
    const { router, loaded } = fakeRouter(["/settings", "/settings/general", "/usage"]);
    preloadRailDestination(router, "settings");
    expect(loaded).toEqual(["/settings", "/settings/general"]);
  });

  it("skips routes the tree does not have", () => {
    const { router, loaded } = fakeRouter(["/usage"]);
    preloadRailDestination(router, "projects");
    expect(loaded).toEqual([]);
  });

  it("keeps Projects inside the chat layout", () => {
    expect(railDestinationRoutes("projects")).toContain("/_chat");
  });
});

describe("scheduleIdleRailPreload", () => {
  const ids = [...railDestinationRoutes("settings"), ...railDestinationRoutes("usage")];

  it("loads one destination per idle slot, in order", () => {
    const { router, loaded } = fakeRouter(ids);
    const { idle, runOne, pending } = manualIdle();
    scheduleIdleRailPreload(router, ["usage", "settings"], idle);
    expect(loaded).toEqual([]);
    runOne();
    expect(loaded).toEqual(["/usage"]);
    runOne();
    expect(loaded).toEqual(["/usage", "/settings", "/settings/general"]);
    runOne();
    expect(pending()).toBe(0);
  });

  it("stops when cancelled", () => {
    const { router, loaded } = fakeRouter(ids);
    const { idle, runOne, pending } = manualIdle();
    const cancel = scheduleIdleRailPreload(router, ["usage", "settings"], idle);
    runOne();
    cancel();
    expect(pending()).toBe(0);
    expect(runOne()).toBe(false);
    expect(loaded).toEqual(["/usage"]);
  });
});
