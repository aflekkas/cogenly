import type { PreviewSessionSnapshot, ScopedThreadRef } from "@cogenly/contracts";

import { browserExtensionPopupSize } from "~/browser/browserExtensions.logic";
import { useLastPresent } from "~/components/ui/overlay-presence";
import { Popover, PopoverPopup } from "~/components/ui/popover";

import { ExtensionSurface } from "./ExtensionSurface";

/**
 * An extension's popup, hung from its toolbar icon at the size the page asks
 * for, as Chrome draws it. A click outside or Esc closes it, which closes its
 * tab; a click on the icon itself is left to the icon, which toggles.
 */
export function ExtensionPopupPopover(props: {
  readonly threadRef: ScopedThreadRef;
  /** The popup's surface tab, or null when none is open. */
  readonly snapshot: PreviewSessionSnapshot | null;
  readonly extensionName: string;
  /** The extension's icon, or the extensions menu button while the icon is in the menu. */
  readonly anchor: () => Element | null;
  readonly visible: boolean;
  readonly onClose: (snapshot: PreviewSessionSnapshot) => void;
}) {
  const snapshot = useLastPresent(props.snapshot);
  const size = browserExtensionPopupSize(snapshot?.viewport);
  return (
    <Popover
      open={props.snapshot !== null}
      onOpenChange={(open, details) => {
        if (open || !props.snapshot) return;
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
        aria-label={`${props.extensionName} popup`}
      >
        {snapshot ? (
          <div className="relative" style={{ width: size.width, height: size.height }}>
            <ExtensionSurface
              threadRef={props.threadRef}
              snapshot={snapshot}
              visible={props.visible && props.snapshot !== null}
            />
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
