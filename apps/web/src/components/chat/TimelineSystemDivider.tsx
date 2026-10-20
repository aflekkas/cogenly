import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

export function TimelineSystemDivider(props: {
  readonly label: string;
  readonly detail?: ReactNode | null;
  readonly tone?: "neutral" | "danger";
  readonly icon?: LucideIcon;
  readonly iconClassName?: string;
  /** Shown in a tooltip when hovering the label, e.g. when it happened. */
  readonly hint?: ReactNode;
  readonly showDetailSeparator?: boolean;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}) {
  const Icon = props.icon;
  const content = (
    <>
      {Icon ? <Icon className={cn("size-3 shrink-0", props.iconClassName)} /> : null}
      <span className="font-medium">{props.label}</span>
      {props.detail ? (
        <span
          className={cn(
            "inline-flex min-w-0 items-center opacity-70",
            typeof props.detail === "string" && "max-w-80 truncate",
          )}
        >
          {props.showDetailSeparator === false ? null : "·\u00a0"}
          {props.detail}
        </span>
      ) : null}
    </>
  );

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 py-2 text-2xs text-muted-foreground",
        props.tone === "danger" && "text-destructive",
      )}
    >
      <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
      {props.onAction ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={props.actionLabel}
                onClick={props.onAction}
                className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 py-1 transition-colors state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
              />
            }
          >
            {content}
          </TooltipTrigger>
          <TooltipPopup side="top">{props.actionLabel}</TooltipPopup>
        </Tooltip>
      ) : props.hint ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="flex min-w-0 flex-wrap items-center justify-center gap-1.5 rounded-full px-2 py-1" />
            }
          >
            {content}
          </TooltipTrigger>
          <TooltipPopup side="top">{props.hint}</TooltipPopup>
        </Tooltip>
      ) : (
        <span className="flex min-w-0 flex-wrap items-center justify-center gap-1.5 rounded-full px-2 py-1">
          {content}
        </span>
      )}
      <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
    </div>
  );
}
