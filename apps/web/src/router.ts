import { beginAction } from "./observability/actionLatency";
import { createRouter, RouterHistory } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory) {
  const router = createRouter({
    routeTree,
    history,
    context: {},
    // Route components are split chunks (autoCodeSplitting in vite.config);
    // fetching them on hover/focus intent hides the load from the first
    // settings or pull-request navigation.
    defaultPreload: "intent",
  });
  router.subscribe("onBeforeNavigate", ({ toLocation, pathChanged }) => {
    if (!pathChanged) return;
    if (toLocation.pathname.startsWith("/settings")) {
      beginAction("settings.open");
      beginAction("settings.load");
    }
    if (toLocation.pathname.startsWith("/projects/")) beginAction("project.switch");
    const match = /^\/([^/]+)\/([^/]+)$/.exec(toLocation.pathname);
    if (match && match[1] !== "settings" && match[1] !== "draft" && match[1] !== "projects")
      beginAction(
        "thread.open",
        `${decodeURIComponent(match[1]!)}:${decodeURIComponent(match[2]!)}`,
      );
  });
  return router;
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
