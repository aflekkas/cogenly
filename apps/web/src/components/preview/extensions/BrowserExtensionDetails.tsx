import type { BrowserExtension } from "@cogenly/contracts";

import {
  browserExtensionPermissionLines,
  browserExtensionStatus,
  isBrowserExtensionUsable,
} from "~/browser/browserExtensions.logic";
import type { BrowserExtensionActions } from "~/browser/useBrowserExtensions";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { useLastPresent } from "~/components/ui/overlay-presence";

import { BrowserExtensionIcon } from "./BrowserExtensionIcon";

export type BrowserExtensionPageKind = "popup" | "sidePanel" | "options";

const PAGE_LABELS: Record<BrowserExtensionPageKind, string> = {
  popup: "Popup",
  sidePanel: "Side panel",
  options: "Options",
};

function extensionPages(extension: BrowserExtension) {
  return [
    extension.popupPage ? { kind: "popup" as const, path: extension.popupPage } : null,
    extension.sidePanelPage ? { kind: "sidePanel" as const, path: extension.sidePanelPage } : null,
    extension.optionsPage ? { kind: "options" as const, path: extension.optionsPage } : null,
  ].filter((page) => page !== null);
}

/**
 * Everything about one extension: where it came from, what it may touch,
 * whether it loaded, its pages, and Reload and Remove. The browser panel's
 * extensions menu and Settings open the same dialog.
 */
export function BrowserExtensionDetailsDialog(props: {
  /** The extension to show, or null to close. */
  readonly extension: BrowserExtension | null;
  readonly onClose: () => void;
  readonly actions: Pick<BrowserExtensionActions, "reloadFromFolder" | "remove">;
  /** Opens a page in the current tab's browser; absent where there is no tab, as in Settings. */
  readonly onOpenPage?: ((kind: BrowserExtensionPageKind) => void) | undefined;
  /** Why pages can't open from here, shown in place of their buttons. */
  readonly pagesUnavailableReason?: string | null | undefined;
}) {
  // Holds the last extension while the dialog animates out.
  const extension = useLastPresent(props.extension);
  const status = extension ? browserExtensionStatus(extension) : null;
  const pages = extension ? extensionPages(extension) : [];
  const canOpenPages =
    props.onOpenPage !== undefined &&
    !props.pagesUnavailableReason &&
    extension !== null &&
    extension !== undefined &&
    isBrowserExtensionUsable(extension);
  return (
    <Dialog
      open={props.extension !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        {extension ? (
          <>
            <DialogHeader>
              <div className="flex items-center gap-3">
                <BrowserExtensionIcon extension={extension} size="md" />
                <div className="grid min-w-0 gap-1.5">
                  <DialogTitle>{extension.name}</DialogTitle>
                  <DialogDescription>Version {extension.version}</DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <DialogPanel>
              {status?.tone === "destructive" ? (
                <Alert variant="error">
                  <AlertTitle>{status.label}</AlertTitle>
                  {status.detail ? <AlertDescription>{status.detail}</AlertDescription> : null}
                </Alert>
              ) : null}
              {extension.description ? (
                <p className="text-sm text-muted-foreground">{extension.description}</p>
              ) : null}
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Status</dt>
                <dd>{status?.label ?? "Running"}</dd>
                <dt className="text-muted-foreground">ID</dt>
                <dd className="font-mono text-xs leading-5 wrap-anywhere select-all">
                  {extension.id}
                </dd>
                <dt className="text-muted-foreground">Source</dt>
                <dd className="wrap-anywhere">
                  {extension.source.type === "folder" ? extension.source.path : "Chrome Web Store"}
                </dd>
                <dt className="text-muted-foreground">Access</dt>
                <dd className="grid gap-0.5">
                  {browserExtensionPermissionLines(extension).map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </dd>
                {pages.length > 0 ? (
                  <>
                    <dt className="text-muted-foreground">Pages</dt>
                    <dd className="grid gap-1.5">
                      {pages.map((page) => (
                        <span key={page.kind} className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate">
                            {PAGE_LABELS[page.kind]}
                            <span className="text-muted-foreground"> {page.path}</span>
                          </span>
                          {canOpenPages ? (
                            <Button
                              size="xs"
                              variant="outline"
                              onClick={() => {
                                props.onOpenPage?.(page.kind);
                                props.onClose();
                              }}
                            >
                              Open
                            </Button>
                          ) : null}
                        </span>
                      ))}
                      {props.onOpenPage && props.pagesUnavailableReason ? (
                        <span className="text-xs text-muted-foreground">
                          {props.pagesUnavailableReason}
                        </span>
                      ) : null}
                    </dd>
                  </>
                ) : null}
              </dl>
            </DialogPanel>
            <DialogFooter>
              <Button
                variant="destructive-outline"
                onClick={() => {
                  props.onClose();
                  void props.actions.remove(extension);
                }}
              >
                Remove
              </Button>
              {extension.source.type === "folder" ? (
                <Button
                  variant="outline"
                  onClick={() => void props.actions.reloadFromFolder(extension)}
                >
                  Reload from folder
                </Button>
              ) : null}
              <Button onClick={props.onClose}>Done</Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
