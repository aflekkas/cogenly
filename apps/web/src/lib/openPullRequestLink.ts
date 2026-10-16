import type { ScopedThreadRef } from "@t3tools/contracts";
import { type MouseEvent, useCallback } from "react";
import { useOpenLink } from "../browser/useOpenLink";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
export {
  gitHubPullRequestBrowserUrl,
  pullRequestCandidateUrlFromReferenceAutolink,
  matchesLinkedPullRequestUrl,
  changeRequestRepositoryUrl,
} from "@t3tools/shared/changeRequestUrl";
export function shouldOpenPullRequestExternally(
  event: Pick<MouseEvent<HTMLElement>, "metaKey" | "ctrlKey"> &
    Partial<Pick<MouseEvent<HTMLElement>, "button">>,
) {
  return event.metaKey || event.ctrlKey || event.button === 1;
}
export function useOpenPrLink(threadRef?: ScopedThreadRef) {
  const openLink = useOpenLink(threadRef);
  return useCallback(
    (event: MouseEvent<HTMLElement>, prUrl: string, targetThreadRef?: ScopedThreadRef) => {
      // Buttons also pass this to onAuxClick for middle-click; a right-click is not an open.
      if (event.button > 1) return false;
      event.stopPropagation();
      const openInBrowser = shouldOpenPullRequestExternally(event);
      const isAnchor =
        event.currentTarget instanceof HTMLAnchorElement && event.currentTarget.href.length > 0;
      // A real link already knows how to cmd/ctrl/middle-click. Leave its default
      // action alone so the browser (or Electron's window-open handler) opens
      // the host. Buttons have no href, so they still go through openExternal.
      if (openInBrowser && isAnchor) return false;

      event.preventDefault();

      // No project to show it in, so it is an ordinary link and follows the
      // "Open links in" setting; the modifier still forces the system browser.
      void openLink(prUrl, { event, threadRef: targetThreadRef }).catch((error: unknown) => {
        console.error(error);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open pull request link",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      });
      return false;
    },
    [openLink],
  );
}
