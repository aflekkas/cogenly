import { EnvironmentMachineIcon } from "~/components/EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import type { PreviewMachine } from "./previewMachine";

/**
 * Quiet text beside the address bar naming the machine whose browser runs the
 * tab, with the same machine glyph and name the sidebar uses. Capped so a long
 * name never takes width from the address.
 */
export function PreviewMachineChip({ machine }: { readonly machine: PreviewMachine }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={machine.description}
            data-preview-machine={machine.machine}
            className="flex h-7 max-w-32 shrink-0 items-center gap-1 text-xs text-muted-foreground"
          />
        }
      >
        <EnvironmentMachineIcon aria-hidden kind={machine.machine} className="size-3.5 shrink-0" />
        <span className="truncate">{machine.label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{machine.description}</TooltipPopup>
    </Tooltip>
  );
}
