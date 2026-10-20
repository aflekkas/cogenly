import type { RefObject } from "react";
import { anchoredToastManager } from "./toast";

/** How long "Copied!" holds, and how long the copy icon stays a check beside it. */
export const ANCHORED_COPY_TOAST_TIMEOUT_MS = 1200;

export function showAnchoredCopySuccessToast(ref: RefObject<HTMLButtonElement | null>) {
  if (!ref.current) return;
  anchoredToastManager.add({
    data: {
      tooltipStyle: true,
    },
    positionerProps: {
      anchor: ref.current,
    },
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
    title: "Copied!",
  });
}

export function showAnchoredCopyErrorToast(ref: RefObject<HTMLButtonElement | null>, error: Error) {
  if (!ref.current) return;
  anchoredToastManager.add({
    data: {
      tooltipStyle: true,
    },
    positionerProps: {
      anchor: ref.current,
    },
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
    title: "Failed to copy",
    description: error.message,
  });
}
