import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";

import { cn } from "../../lib/utils";

/**
 * One group in the project panel: a small muted label with its count and an
 * optional trailing action, then its rows. Rows share the sidebar's density
 * (h-9, text-sm) so the panel reads as one list, not a stack of cards.
 */
export function ProjectPanelSection(props: {
  readonly title: string;
  readonly count?: number;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={props.title} className="flex flex-col gap-px">
      <div className="flex h-7 items-center gap-1.5 px-2.5 text-xs font-medium text-muted-foreground">
        <span>{props.title}</span>
        {props.count !== undefined && props.count > 0 ? (
          <span className="tabular-nums text-secondary-label">{props.count}</span>
        ) : null}
        {props.action !== undefined ? (
          <span className="ml-auto flex shrink-0 items-center">{props.action}</span>
        ) : null}
      </div>
      {props.children}
    </section>
  );
}

/**
 * A row in a panel section: a leading icon, a title, optional meta after it,
 * and what sits at the end (a time, or hover actions). Clickable rows are
 * buttons for the keyboard; actions inside them stop the click.
 */
export function ProjectPanelRow(props: {
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly trailing?: ReactNode;
  /** Shown on hover or focus within the row, after `trailing`. */
  readonly actions?: ReactNode;
  readonly onOpen?: () => void;
  readonly ariaLabel?: string;
}) {
  const interactive = props.onOpen !== undefined;
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    props.onOpen?.();
  };
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={props.ariaLabel}
      className={cn(
        "group/row flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none transition-colors duration-(--motion-duration-fast) ease-standard motion-reduce:transition-none",
        interactive &&
          "cursor-pointer select-none state-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        !interactive && props.actions !== undefined && "state-hover",
      )}
      onClick={props.onOpen}
      onKeyDown={interactive ? onKeyDown : undefined}
    >
      {props.icon !== undefined ? (
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-4">
          {props.icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{props.title}</span>
      {props.meta !== undefined ? (
        <span className="max-w-1/3 shrink-0 truncate text-xs text-secondary-label">
          {props.meta}
        </span>
      ) : null}
      {props.trailing !== undefined ? (
        <span className="shrink-0 text-xs tabular-nums text-secondary-label">{props.trailing}</span>
      ) : null}
      {props.actions !== undefined ? (
        <span
          className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-(--motion-duration-fast) ease-standard group-hover/row:opacity-100 group-focus-within/row:opacity-100 motion-reduce:transition-none"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {props.actions}
        </span>
      ) : null}
    </div>
  );
}

/** A section with nothing in it says so in one muted line, at row height. */
export function ProjectPanelEmptyRow(props: { readonly children: ReactNode }) {
  return (
    <p className="flex min-h-9 items-center px-2.5 py-1.5 text-sm text-muted-foreground">
      {props.children}
    </p>
  );
}
