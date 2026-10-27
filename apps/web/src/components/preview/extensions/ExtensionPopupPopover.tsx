import type { PreviewSessionSnapshot, ScopedThreadRef } from "@cogenly/contracts";
import { XIcon } from "lucide-react";

import { browserExtensionPopupSize } from "~/browser/browserExtensions.logic";
import { useLastPresent } from "~/components/ui/overlay-presence";
import { Popover, PopoverPopup } from "~/components/ui/popover";

import { ToolbarButton } from "../PreviewChromeRow";
import { ExtensionSurface } from "./ExtensionSurface";

/**
 * An extension's popup, hung from its toolbar icon at the size the page asks
 * for, as Chrome draws it, capped to the space on screen. One the user opened
 * takes focus, and a click outside or Esc closes it, which closes its tab; a
 * click on the icon itself is left to the icon, which toggles. One an agent
 * opened leaves focus where it is and stays until the agent closes it or the
 * user presses its close button.
 */
export function ExtensionPopupPopover(props: {
  readonly threadRef: ScopedThreadRef;
  /** The popup's surface tab, or null when none is open. */
  readonly snapshot: PreviewSessionSnapshot | null;
  readonly userOpened: boolean;
  readonly extensionName: string;
  /** The extension's icon, or the extensions menu button while the icon is in the menu. */
  readonly anchor: () => Element | null;
  readonly visible: boolean;
  readonly onClose: (snapshot: PreviewSessionSnapshot) => void;
}) {
  const snapshot = useLastPresent(props.snapshot);
  const size = browserExtensionPopupSize(snapshot?.extensionSurface);
  const { userOpened } = props;
  return (
    <Popover
      open={props.snapshot !== null}
      onOpenChange={(open, details) => {
        if (open || !props.snapshot || !userOpened) return;
        const target = details.event?.target;
        if (
          details.reason === "outside-press" &&
          target instanceof Node &&
          props.anchor()?.contains(target)
        ) {
          return;
        }
        props.onClose(props.snapshot);
      }}
    >
      <PopoverPopup
        anchor={props.anchor}
        side="bottom"
        align="end"
        sideOffset={6}
        padding="none"
        animateHeight={false}
        initialFocus={userOpened}
        finalFocus={userOpened}
        aria-label={`${props.extensionName} popup`}
      >
        {snapshot ? (
          <div
            className="flex max-h-(--available-height) max-w-(--available-width) flex-col"
            style={{ width: size.width }}
          >
            {userOpened ? null : (
              <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 ps-3 pe-0.5">
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  Opened by the agent
                </span>
                <ToolbarButton
                  label={`Close ${props.extensionName} popup`}
                  tooltip="Close popup"
                  onClick={() => {
                    if (props.snapshot) props.onClose(props.snapshot);
                  }}
                >
                  <XIcon />
                </ToolbarButton>
              </div>
            )}
            <div className="relative min-h-0" style={{ height: size.height }}>
              <ExtensionSurface
                threadRef={props.threadRef}
                snapshot={snapshot}
                visible={props.visible && props.snapshot !== null}
              />
            </div>
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
