import { useAtomValue } from "@effect/atom-react";
import { useParams } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { isElectron } from "../env";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isMacPlatform } from "../lib/utils";
import { isModelPickerOpen } from "../modelPickerVisibility";
import {
  navigateHistoryBack,
  navigateHistoryForward,
  useNavigationHistoryAvailability,
} from "../navigationHistory";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { primaryServerKeybindingsAtom } from "../state/server";
import { resolveThreadRouteRef } from "../threadRoutes";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// Mouse side buttons, as MouseEvent.button reports them.
const MOUSE_BUTTON_BACK = 3;
const MOUSE_BUTTON_FORWARD = 4;

/**
 * Back and forward through the app's pages, Safari style, after the sidebar
 * toggle in the titlebar. Hidden in the sheet layout, where the toggle row is
 * tight and the sheet owns the sidebar.
 */
export function NavigationHistoryButtons() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { canGoBack, canGoForward } = useNavigationHistoryAvailability();
  const backShortcut = shortcutLabelForCommand(keybindings, "navigation.back");
  const forwardShortcut = shortcutLabelForCommand(keybindings, "navigation.forward");

  return (
    <div
      className="ml-1 hidden items-center gap-1 desktop-layout:flex"
      data-navigation-history-controls=""
    >
      <HistoryButton
        label="Back"
        shortcut={backShortcut}
        enabled={canGoBack}
        onClick={navigateHistoryBack}
      >
        <ChevronLeftIcon className="size-4.5" />
      </HistoryButton>
      <HistoryButton
        label="Forward"
        shortcut={forwardShortcut}
        enabled={canGoForward}
        onClick={navigateHistoryForward}
      >
        <ChevronRightIcon className="size-4.5" />
      </HistoryButton>
    </div>
  );
}

function HistoryButton({
  label,
  shortcut,
  enabled,
  onClick,
  children,
}: {
  label: string;
  shortcut: string | null;
  enabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      {/* The span keeps the tooltip on a disabled button. */}
      <TooltipTrigger
        render={<span className="pointer-events-auto flex shrink-0 [-webkit-app-region:no-drag]" />}
      >
        <Button
          aria-label={label}
          className="shrink-0 [-webkit-app-region:no-drag]"
          disabled={!enabled}
          onClick={onClick}
          // Chrome, like a native toolbar button: focus stays where it was.
          onPointerDown={(event) => event.preventDefault()}
          size="icon-sm"
          variant="ghost-muted"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{shortcut ? `${label} (${shortcut})` : label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The back/forward shortcuts (mod+[ / mod+] by default), the desktop's
 * swipe and app-command gestures (forwarded as menu actions), and on macOS
 * desktop the mouse side buttons, which Windows and Linux deliver as
 * app-commands instead. The web build leaves mouse buttons to the browser.
 */
export function NavigationHistoryShortcuts() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          previewFocus: isPreviewFocused(),
          previewOpen: routeThreadRef
            ? selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, routeThreadRef) ===
              "preview"
            : false,
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      if (command !== "navigation.back" && command !== "navigation.forward") return;

      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (command === "navigation.back") navigateHistoryBack();
      else navigateHistoryForward();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, routeThreadRef]);

  useEffect(() => {
    const unsubscribe = window.desktopBridge?.onMenuAction((action) => {
      if (action === "navigation.back") navigateHistoryBack();
      else if (action === "navigation.forward") navigateHistoryForward();
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    if (!isElectron || !isMacPlatform(navigator.platform)) return;
    // mouseup, so the press itself never selects text or starts a drag.
    const onMouseUp = (event: MouseEvent) => {
      if (event.button === MOUSE_BUTTON_BACK) {
        event.preventDefault();
        navigateHistoryBack();
      } else if (event.button === MOUSE_BUTTON_FORWARD) {
        event.preventDefault();
        navigateHistoryForward();
      }
    };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, []);

  return null;
}
