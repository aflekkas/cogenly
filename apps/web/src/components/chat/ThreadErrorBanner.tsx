import type { OrchestrationV2ProviderFailureClass, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { toastManager } from "../ui/toast";

export function getThreadErrorBannerKey(threadKey: string, error: string | null): string | null {
  return error === null ? null : `${threadKey}\u0000${error}`;
}

export function shouldShowThreadErrorBanner(
  threadKey: string,
  error: string | null,
  isDismissed: boolean,
): boolean {
  return getThreadErrorBannerKey(threadKey, error) !== null && !isDismissed;
}

// Session-scoped (module-level so it survives ChatView remounts, e.g. route
// changes between threads). Mirrors the branch-mismatch banner: a dismissal
// is remembered per thread key plus message, so navigating away to a thread
// with no error cannot resurrect the banner, while a different error message
// on the same thread still appears.
const sessionDismissedThreadErrorBannerKeys = new Set<string>();

export function dismissThreadErrorBannerForSession(bannerKey: string | null): void {
  if (bannerKey !== null) {
    sessionDismissedThreadErrorBannerKeys.add(bannerKey);
  }
}

export function isThreadErrorBannerDismissedForSession(bannerKey: string | null): boolean {
  return bannerKey !== null && sessionDismissedThreadErrorBannerKeys.has(bannerKey);
}

/**
 * Shows a thread's error as a top toast, persistent until dismissed, so it sits
 * with the app's other toasts above the header instead of over the transcript.
 * Renders nothing itself. The toast closes when the error clears, changes or
 * the thread changes; only the user's own dismissal calls `onDismiss`.
 */
export function ThreadErrorToast({
  threadRef,
  error,
  errorClass,
  onDismiss,
}: {
  threadRef: ScopedThreadRef;
  error: string | null;
  errorClass?: OrchestrationV2ProviderFailureClass | null;
  onDismiss: () => void;
}) {
  const dismiss = useStableCallback(onDismiss);
  const usageLimit = errorClass === "usage_limit";
  const { environmentId, threadId } = threadRef;

  useEffect(() => {
    if (!error) return;
    let closingFromCode = false;
    const toastId = toastManager.add({
      type: usageLimit ? "warning" : "error",
      title: usageLimit ? "Usage limit reached" : "Run failed",
      description: error,
      timeout: 0,
      priority: "high",
      data: { threadRef: { environmentId, threadId } },
      // Base UI closes on the corner button and on swipe; both are the user's dismissal.
      onClose: () => {
        if (!closingFromCode) dismiss();
      },
    });
    return () => {
      closingFromCode = true;
      toastManager.close(toastId);
    };
  }, [dismiss, environmentId, error, threadId, usageLimit]);

  return null;
}
