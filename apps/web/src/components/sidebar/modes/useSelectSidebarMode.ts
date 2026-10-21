import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { useReadRouteThreadKind } from "../../../hooks/useThreadKind";
import { sidebarModeForThreadKind } from "../../../threadCapabilities";
import { useUiStateStore } from "../../../uiStateStore";
import { isSidebarUtilityPage, useNavigateToMainApp } from "../mainAppLocation";
import { modeSwitchReplacesMainPanel, type MainPanelContent } from "./modeLanding.logic";
import { crossfadeModeSwitch } from "./modeSwitchMotion";
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
  const readRouteThreadKind = useReadRouteThreadKind();
  const navigateToMainApp = useNavigateToMainApp();

  const readMainPanelContent = useCallback((): MainPanelContent => {
    const { pathname } = router.state.location;
    if (pathname === "/") return { kind: "index" };
    if (pathname === "/project" || pathname.startsWith("/project/"))
      return { kind: "project-view" };
    const kind = readRouteThreadKind();
    return kind === null
      ? { kind: "other" }
      : { kind: "thread", mode: sidebarModeForThreadKind(kind) };
  }, [readRouteThreadKind, router]);

  return useCallback(
    (next: SidebarMode, options?: { readonly leaveUtilityPage?: boolean }) => {
      const previous = useUiStateStore.getState().sidebarMode;
      const onUtilityPage = isSidebarUtilityPage(router.state.location.pathname);
      if (onUtilityPage && !options?.leaveUtilityPage) {
        setMode(next);
        return;
      }
      const content = onUtilityPage ? null : readMainPanelContent();
      const replacesMainPanel = content !== null && modeSwitchReplacesMainPanel(next, content);
      // The same mode again changes nothing on screen, unless it leaves a utility page.
      if (next === previous && !onUtilityPage && !replacesMainPanel) {
        setMode(next);
        return;
      }
      crossfadeModeSwitch(() => {
        setMode(next);
        if (onUtilityPage) {
          // Back to where the user was in the same mode; a fresh landing in another,
          // since the remembered page may be a thread that mode does not list.
          void (next === previous ? navigateToMainApp() : router.navigate({ to: "/" }));
          return true;
        }
        if (replacesMainPanel) void router.navigate({ to: "/" });
        // The index lands again on its own (ModeIndexLanding is keyed by mode).
        return replacesMainPanel || content?.kind === "index";
      });
    },
    [navigateToMainApp, readMainPanelContent, router, setMode],
  );
}
