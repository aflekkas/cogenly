"use client";

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";

import { cn } from "~/lib/utils";

function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({ className, ...props }: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger
      className={cn("cursor-pointer", className)}
      data-slot="collapsible-trigger"
      {...props}
    />
  );
}

function CollapsiblePanel({
  className,
  animate = true,
  ...props
}: CollapsiblePrimitive.Panel.Props & { animate?: boolean }) {
  // Reuses the local shadcn/Base UI panel: height travels on Base UI's measured
  // --collapsible-panel-height while the content fades; reduced motion skips both.
  // https://ui.shadcn.com/docs/components/base/collapsible
  return (
    <CollapsiblePrimitive.Panel
      className={cn(
        "overflow-hidden",
        animate &&
          "h-(--collapsible-panel-height) transition-[height,opacity] duration-200 ease-drawer motion-reduce:transition-none data-ending-style:h-0 data-starting-style:h-0 data-ending-style:opacity-0 data-starting-style:opacity-0 data-open:data-ending-style:[height:var(--collapsible-panel-height)] data-open:data-ending-style:opacity-100",
        className,
      )}
      data-slot="collapsible-panel"
      {...props}
    />
  );
}

export {
  Collapsible,
  CollapsibleTrigger,
  CollapsiblePanel,
  CollapsiblePanel as CollapsibleContent,
};
