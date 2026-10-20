import { type ReactNode } from "react";

import { Sheet, SheetPopup } from "./ui/sheet";

export function RightPanelSheet(props: {
  animationDurationMs: number;
  children: ReactNode;
  open: boolean;
  onClose: () => void;
}) {
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
        transitionDurationMs={props.animationDurationMs}
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
