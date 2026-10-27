import { useState, type FormEvent } from "react";

import { WorkLogCollapse } from "~/components/chat/WorkLog";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";

import { isFolderInstallSource } from "./browserExtensions.logic";
import type { BrowserExtensionInstall } from "./useBrowserExtensions";

/**
 * One field that takes a Chrome Web Store link, an extension ID, or a folder on
 * the environment's machine. The browser panel's dialog and the Browser
 * settings row both use it, so adding an extension reads the same everywhere.
 */
export function BrowserExtensionInstallForm(props: {
  readonly install: BrowserExtensionInstall;
  readonly disabled?: boolean;
  readonly autoFocus?: boolean;
  /** Called after a successful install, such as to close a dialog. */
  readonly onInstalled?: () => void;
}) {
  const [source, setSource] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const trimmed = source.trim();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (trimmed === "" || pending !== null) return;
    setError(null);
    setPending(trimmed);
    const failure = await props.install(trimmed).finally(() => setPending(null));
    if (failure) {
      setError(failure);
      return;
    }
    setSource("");
    props.onInstalled?.();
  };

  return (
    <form className="grid gap-2" onSubmit={(event) => void submit(event)}>
      <div className="flex gap-2">
        <Input
          size="sm"
          aria-label="Chrome Web Store link, extension ID, or folder path"
          placeholder="Chrome Web Store link, ID, or folder path"
          autoFocus={props.autoFocus}
          spellCheck={false}
          autoComplete="off"
          value={source}
          disabled={props.disabled || pending !== null}
          onChange={(event) => {
            setSource(event.target.value);
            setError(null);
          }}
        />
        <Button
          type="submit"
          size="sm"
          disabled={props.disabled || trimmed === "" || pending !== null}
        >
          {pending !== null ? <Spinner /> : null}
          {pending !== null ? "Installing…" : "Install"}
        </Button>
      </div>
      <WorkLogCollapse open={pending !== null || error !== null}>
        <p
          aria-live="polite"
          className={error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
        >
          {error ??
            (pending !== null && isFolderInstallSource(pending)
              ? "Copying the folder into this profile…"
              : "Downloading from the Chrome Web Store. This can take a little while.")}
        </p>
      </WorkLogCollapse>
    </form>
  );
}

/** The browser panel's "Add from Chrome Web Store…" dialog. */
export function BrowserExtensionInstallDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly install: BrowserExtensionInstall;
  /** The profile the extension goes into, as the user named it. */
  readonly profileName: string | undefined;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add an extension</DialogTitle>
          <DialogDescription>
            {props.profileName
              ? `Installs into the ${props.profileName} profile on this tab's machine.`
              : "Installs into this tab's profile on its machine."}{" "}
            Paste a Chrome Web Store link or extension ID, or the path to an unpacked extension
            folder on that machine.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <BrowserExtensionInstallForm
            install={props.install}
            autoFocus
            onInstalled={() => props.onOpenChange(false)}
          />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
