import { useState, type ReactNode } from "react";

import { readPanelAnimationsActive } from "../panelAnimations";

import { Sheet, SheetPopup } from "./ui/sheet";

export function RightPanelSheet(props: {
  animationDurationMs: number;
  children: ReactNode;
  open: boolean;
  onClose: () => void;
}) {
  // Whether the sheet slides is decided when it opens or closes: not under
  // reduced motion, nor on the first frame of a navigation that restores it.
  const [motion, setMotion] = useState(() => ({ open: props.open, animated: false }));
  if (motion.open !== props.open) {
    setMotion({ open: props.open, animated: readPanelAnimationsActive() });
  }
  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      {/* Never narrower than 24rem where the viewport allows, so the width
          only grows with the window. */}
      <SheetPopup
        transitionDurationMs={motion.animated ? props.animationDurationMs : 0}
        side="right"
        showCloseButton={false}
        keepMounted
        className="w-[min(88vw,max(24rem,42vw),28rem)] wco:mt-(--workspace-topbar-height) wco:h-[calc(100%-var(--workspace-topbar-height))] wco:max-h-[calc(100%-var(--workspace-topbar-height))]"
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
