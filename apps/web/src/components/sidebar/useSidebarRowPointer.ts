import { useEffect, useState } from "react";

// Breathing room between the end of the title fade and the hover actions.
const ACTIONS_CLEARANCE_PX = 4;

/**
 * Pointer-driven state for a sidebar row with the sidebar-row-motion utility.
 *
 * - On pointer enter and keyboard focus it measures how far the hover actions
 *   (`[data-row-hover-actions]`, layered over the status slot) reach over the
 *   title (`.pan-text`), as `--sidebar-row-actions-overlap`.
 * - While the selected row is hovered it writes the pointer position as
 *   `--sidebar-row-glow-x/-y`, once per frame, so the corner wash follows it;
 *   leaving clears them and the wash eases back to its corner. Skipped under
 *   prefers-reduced-motion, where the wash stays put.
 *
 * Returns a ref callback for the row element.
 */
export function useSidebarRowPointer() {
  const [row, setRow] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!row) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let pointerX = 0;
    let pointerY = 0;

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
    const paintGlow = () => {
      frame = 0;
      const rect = row.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      row.style.setProperty(
        "--sidebar-row-glow-x",
        `${((pointerX - rect.left) / rect.width) * 100}%`,
      );
      row.style.setProperty(
        "--sidebar-row-glow-y",
        `${((pointerY - rect.top) / rect.height) * 100}%`,
      );
      row.dataset.glowTracking = "";
    };
    const clearGlow = () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      row.style.removeProperty("--sidebar-row-glow-x");
      row.style.removeProperty("--sidebar-row-glow-y");
      delete row.dataset.glowTracking;
    };
    const onPointerMove = (event: PointerEvent) => {
      if (reducedMotion.matches || !row.classList.contains("state-selected")) {
        if (row.dataset.glowTracking !== undefined) clearGlow();
        return;
      }
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (frame === 0) frame = requestAnimationFrame(paintGlow);
    };

    row.addEventListener("pointerenter", measureActions);
    row.addEventListener("focusin", measureActions);
    row.addEventListener("pointermove", onPointerMove);
    row.addEventListener("pointerleave", clearGlow);
    return () => {
      clearGlow();
      row.removeEventListener("pointerenter", measureActions);
      row.removeEventListener("focusin", measureActions);
      row.removeEventListener("pointermove", onPointerMove);
      row.removeEventListener("pointerleave", clearGlow);
    };
  }, [row]);
  return setRow;
}
