import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { useComposerDraftStore } from "../../../composerDraftStore";
import { useThreadKindResolver } from "../../../hooks/useThreadKind";
import { readThreadShell } from "../../../state/entities";
import { sidebarModeForThreadKind } from "../../../threadCapabilities";
import { resolveThreadRouteTarget } from "../../../threadRoutes";
import { useUiStateStore } from "../../../uiStateStore";
import { isSidebarUtilityPage, useNavigateToMainApp } from "../mainAppLocation";
import { modeSwitchReplacesMainPanel, type MainPanelContent } from "./modeLanding.logic";
import type { SidebarMode } from "./sidebarModes.logic";

/**
 * Picking a sidebar mode by hand: the rail, the mobile switcher, the palette
 * and the mode shortcuts. When the main panel shows a thread or draft another
 * mode lists (or a project view outside Projects), it lands on the new mode
 * instead, so Chats never sits beside a repository draft. Following an opened
 * thread into its mode sets the mode directly and keeps the thread.
 */
export function useSelectSidebarMode() {
  const setMode = useUiStateStore((store) => store.setSidebarMode);
  const router = useRouter();
  const resolveThreadKind = useThreadKindResolver();
  const navigateToMainApp = useNavigateToMainApp();

  const readMainPanelContent = useCallback((): MainPanelContent => {
    const { location, matches } = router.state;
    if (location.pathname === "/") return { kind: "index" };
    if (location.pathname === "/project" || location.pathname.startsWith("/project/"))
      return { kind: "project-view" };
    const target = resolveThreadRouteTarget(matches.at(-1)?.params ?? {});
    if (target === null) return { kind: "other" };
    if (target.kind === "server") {
      const thread = readThreadShell(target.threadRef);
      return thread
        ? { kind: "thread", mode: sidebarModeForThreadKind(resolveThreadKind(thread)) }
        : { kind: "other" };
    }
    const draft = useComposerDraftStore.getState().getDraftSession(target.draftId);
    return draft
      ? { kind: "thread", mode: sidebarModeForThreadKind(resolveThreadKind(draft)) }
      : { kind: "other" };
  }, [resolveThreadKind, router]);

  return useCallback(
    (next: SidebarMode, options?: { readonly leaveUtilityPage?: boolean }) => {
      const previous = useUiStateStore.getState().sidebarMode;
      setMode(next);
      if (isSidebarUtilityPage(router.state.location.pathname)) {
        if (!options?.leaveUtilityPage) return;
        // Back to where the user was in the same mode; a fresh landing in another,
        // since the remembered page may be a thread that mode does not list.
        void (next === previous ? navigateToMainApp() : router.navigate({ to: "/" }));
        return;
      }
      if (modeSwitchReplacesMainPanel(next, readMainPanelContent())) {
        void router.navigate({ to: "/" });
      }
    },
    [navigateToMainApp, readMainPanelContent, router, setMode],
  );
}
