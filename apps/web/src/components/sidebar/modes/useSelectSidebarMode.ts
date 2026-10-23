import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { useReadRouteThreadKind } from "../../../hooks/useThreadKind";
import { sidebarModeForThreadKind } from "../../../threadCapabilities";
import { useUiStateStore } from "../../../uiStateStore";
import { isSidebarUtilityPage, useNavigateToMainApp } from "../mainAppLocation";
import { modeSwitchReplacesMainPanel, type MainPanelContent } from "./modeLanding.logic";
import { crossfadeModeSwitch } from "./modeSwitchMotion";
import { useLandOnMode } from "./useLandOnMode";
import { useSpaceReturn } from "./spaceRouteMemory";
import type { SidebarMode } from "./sidebarModes.logic";

/**
 * Picking a sidebar mode by hand: the rail, the mobile switcher, the palette
 * and the mode shortcuts. When the main panel shows a thread or draft another
 * mode lists, it lands on the new mode instead, so Chats never sits beside a
 * repository draft. From a utility page (Settings, Usage, Projects) it goes
 * back to the main app. Following an opened
 * thread into its mode sets the mode directly and keeps the thread. A landing
 * goes straight to its thread or draft; only a mode with nothing to open yet
 * (loading, or its empty state) passes through the index route.
 *
 * Before any landing, a mode returns to the page it last showed
 * (spaceRouteMemory), as a normal push, while that thread is still there.
 * Picking the mode already shown changes nothing.
 */
export function useSelectSidebarMode() {
  const setMode = useUiStateStore((store) => store.setSidebarMode);
  const router = useRouter();
  const readRouteThreadKind = useReadRouteThreadKind();
  const navigateToMainApp = useNavigateToMainApp();
  const landOnMode = useLandOnMode();
  const spaceReturn = useSpaceReturn();

  const readMainPanelContent = useCallback((): MainPanelContent => {
    const { pathname } = router.state.location;
    if (pathname === "/") return { kind: "index" };
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
      const land = () => {
        if (!landOnMode(next)) void router.navigate({ to: "/" });
      };
      const returnHref = spaceReturn(next);
      crossfadeModeSwitch(() => {
        setMode(next);
        if (returnHref !== null) {
          if (returnHref === router.state.location.href) return false;
          void router.navigate({ href: returnHref });
          return true;
        }
        if (onUtilityPage) {
          // Back to where the user was in the same mode; a fresh landing in another,
          // since the remembered page may be a thread that mode does not list.
          if (next === previous) void navigateToMainApp();
          else land();
          return true;
        }
        if (replacesMainPanel) land();
        // The index lands again on its own (ModeIndexLanding is keyed by mode).
        return replacesMainPanel || content?.kind === "index";
      });
    },
    [landOnMode, navigateToMainApp, readMainPanelContent, router, setMode, spaceReturn],
  );
}
