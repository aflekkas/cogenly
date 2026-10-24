import type { EnvironmentId } from "@cogenly/contracts";
import { ENVIRONMENT_NAME_MAX_LENGTH } from "@cogenly/shared/environmentLinks";
import { useState, type FormEvent } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

/**
 * Renames a saved environment on this device. The name is this client's own; the machine,
 * its routes, and the connection stay as they are.
 */
export function RenameEnvironmentDialog({
  environment,
  onClose,
}: {
  /** The environment being renamed; null keeps the dialog closed. */
  readonly environment: { readonly environmentId: EnvironmentId; readonly label: string } | null;
  readonly onClose: () => void;
}) {
  const rename = useAtomCommand(environmentCatalog.rename, "Rename environment");
  // Keep the last environment through the close animation.
  const [shown, setShown] = useState(environment);
  const [draft, setDraft] = useState(environment?.label ?? "");
  if (environment !== null && environment !== shown) {
    setShown(environment);
    setDraft(environment.label);
  }
  const trimmed = draft.trim();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (shown === null || trimmed === "") return;
    if (trimmed === shown.label) {
      onClose();
      return;
    }
    const result = await rename({ environmentId: shown.environmentId, label: trimmed });
    if (result._tag === "Success") onClose();
  };

  return (
    <Dialog
      open={environment !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Rename environment</DialogTitle>
            <DialogDescription>
              The name this device shows for {shown?.label ?? "this environment"}.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Input
              aria-label="Environment name"
              autoFocus
              value={draft}
              maxLength={ENVIRONMENT_NAME_MAX_LENGTH}
              onChange={(event) => setDraft(event.target.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={trimmed === ""}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
