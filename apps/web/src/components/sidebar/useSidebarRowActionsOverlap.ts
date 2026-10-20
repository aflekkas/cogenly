import { useEffect, useState } from "react";

// Breathing room between the end of the title fade and the hover actions.
const ACTIONS_CLEARANCE_PX = 4;

/**
 * For a sidebar row with the sidebar-row-motion utility: on pointer enter and
 * keyboard focus it measures how far the hover actions
 * (`[data-row-hover-actions]`, layered over the status slot) reach over the
 * title (`.pan-text`), as `--sidebar-row-actions-overlap`, so the title's end
 * fades out under them.
 *
 * Returns a ref callback for the row element.
 */
export function useSidebarRowActionsOverlap() {
  const [row, setRow] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!row) return;
    const measureActions = () => {
      const actions = row.querySelector<HTMLElement>("[data-row-hover-actions]");
      const title = row.querySelector<HTMLElement>(".pan-text");
      const slot = actions?.parentElement;
      if (!actions || !title || !slot) return;
      // Layout widths, so the actions' own enter translate does not count.
      const actionsLeft = slot.getBoundingClientRect().right - actions.offsetWidth;
      const overlap = title.getBoundingClientRect().right - actionsLeft + ACTIONS_CLEARANCE_PX;
      row.style.setProperty(
        "--sidebar-row-actions-overlap",
        `${Math.max(0, Math.round(overlap))}px`,
      );
    };
    row.addEventListener("pointerenter", measureActions);
    row.addEventListener("focusin", measureActions);
    return () => {
      row.removeEventListener("pointerenter", measureActions);
      row.removeEventListener("focusin", measureActions);
    };
  }, [row]);
  return setRow;
}
