"use client";

import type { SitePermissionPrompt, SitePermissionPromptAnswer } from "@cogenly/contracts";

import { Button } from "~/components/ui/button";
import { useLastPresent } from "~/components/ui/overlay-presence";
import { cn } from "~/lib/utils";

import { sitePermissionPromptTitle } from "./sitePermissions.logic";

/**
 * The card under the browser toolbar for a page waiting on the person:
 * "<site> wants to use your camera" with Allow and Block. It sits right after
 * the toolbar in the tab order, so the keyboard reaches it without leaving the
 * panel, and it never takes focus from the page by itself. Escape dismisses it:
 * the page is denied this once and asks again later. It fades in and out and
 * keeps its last request while it does.
 */
export function PreviewPermissionPrompt(props: {
  readonly prompt: SitePermissionPrompt | null;
  readonly onAnswer: (promptId: string, answer: SitePermissionPromptAnswer) => void;
}) {
  const shown = useLastPresent(props.prompt);
  if (!shown) return null;
  const open = props.prompt !== null;
  return (
    <section
      role="group"
      aria-label="Site permission request"
      aria-hidden={open ? undefined : true}
      inert={!open}
      data-site-permission-prompt={open ? "open" : "closed"}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        props.onAnswer(shown.id, "dismiss");
      }}
      className={cn(
        "dropdown-glass surface-raised surface-raised-floating absolute top-2 left-2 z-30 flex w-[min(22rem,calc(100%-1rem))] flex-col gap-3 rounded-lg p-3 text-popover-foreground",
        "transition-opacity duration-(--motion-duration-base) ease-out starting:opacity-0 motion-reduce:transition-none",
        open ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <div className="flex flex-col gap-0.5">
        <p role="status" className="text-sm font-medium">
          {sitePermissionPromptTitle(shown)}
        </p>
        <p className="text-xs text-muted-foreground">
          Change this later in the ⋮ menu, under Site permissions.
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          type="button"
          onClick={() => props.onAnswer(shown.id, "block")}
        >
          Block
        </Button>
        <Button size="sm" type="button" onClick={() => props.onAnswer(shown.id, "allow")}>
          Allow
        </Button>
      </div>
    </section>
  );
}
