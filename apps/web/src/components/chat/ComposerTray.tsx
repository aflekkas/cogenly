import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { DisclosureChevron, DisclosurePanel } from "../ui/disclosure";
import { ComposerBanner } from "./ComposerBanner";
import { composerStackBodyProps, useComposerStackFold } from "./ComposerStackColumn";
import { COMPOSER_TRAY_FOLD_RANK, type ComposerTrayId } from "./composerStackBudget.logic";

/**
 * Open state for a tray in the composer stack. `open` is the user's choice;
 * `shown` is whether the list is drawn, which is false while the stack has
 * folded it to fit. Toggling a folded tray reveals it instead of closing it,
 * so a header click always opens the list. Pass `null` for a tray the stack
 * never folds (a question waiting on the user).
 */
export function useComposerTrayDisclosure(
  trayId: ComposerTrayId | null,
  open: boolean,
  onOpenChange: (open: boolean) => void,
) {
  const fold = useComposerStackFold(trayId ?? "");
  const folded = trayId !== null && fold.folded;
  return {
    open,
    shown: open && !folded,
    folded,
    reveal: fold.reveal,
    toggle: () => (open && folded ? fold.reveal() : onOpenChange(!open)),
  };
}

/** The tray's disclosure glyph, in the same box as a row's icon-xs actions. */
function Chevron({ open }: { readonly open: boolean }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none flex size-7 flex-none items-center justify-center sm:size-6"
    >
      <DisclosureChevron open={open} />
    </span>
  );
}

/**
 * Every tray's header: icon, title, a muted summary that fades while the list
 * is open, trailing actions, a count, and one disclosure chevron. With
 * `onToggle`, the whole row toggles the list and the actions sit above that
 * toggle, so they keep their own clicks and focus rings. Without it the
 * header is a plain status row.
 */
function Header({
  icon,
  title,
  summary,
  count,
  actions,
  open = false,
  onToggle,
  toggleLabel,
  controls,
  className,
  ...props
}: Omit<ComponentProps<typeof ComposerBanner.Row>, "title" | "children" | "render"> & {
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly summary?: ReactNode;
  readonly count?: ReactNode;
  readonly actions?: ReactNode;
  readonly open?: boolean;
  readonly onToggle?: (() => void) | undefined;
  readonly toggleLabel?: string | undefined;
  /** The id of the list this header opens. */
  readonly controls?: string | undefined;
}) {
  const hasTrailing = actions !== undefined || count !== undefined || onToggle !== undefined;
  // Static header content lets clicks fall through to the toggle. The fading
  // summary needs it most: below full opacity it paints above the toggle.
  const passThrough = onToggle !== undefined && "pointer-events-none";
  return (
    <ComposerBanner.Row className={cn("relative", className)} {...props}>
      {onToggle ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={controls}
          aria-label={toggleLabel}
          className="absolute inset-0 cursor-pointer rounded-md focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          // Keeps the composer's focus, so opening a tray never closes the keyboard.
          onPointerDown={(event) => event.preventDefault()}
          onClick={onToggle}
        />
      ) : null}
      {icon !== undefined ? (
        <ComposerBanner.Icon
          className={cn("h-(--composer-banner-icon-column) self-start", passThrough)}
        >
          {icon}
        </ComposerBanner.Icon>
      ) : null}
      <ComposerBanner.Content className={cn("whitespace-nowrap", passThrough)}>
        <span className="min-w-0 truncate font-medium leading-7 sm:leading-6">{title}</span>
        {summary ? (
          <span
            aria-hidden={(onToggle !== undefined && open) || undefined}
            className={cn(
              "w-0 min-w-0 grow truncate text-muted-foreground transition-opacity duration-(--motion-duration-fast) ease-out motion-reduce:transition-none @max-[400px]:sr-only",
              onToggle !== undefined && open && "opacity-0",
            )}
          >
            {summary}
          </span>
        ) : null}
      </ComposerBanner.Content>
      {hasTrailing ? (
        <ComposerBanner.Actions>
          {actions ? <span className="relative flex items-center gap-1">{actions}</span> : null}
          {count !== undefined ? (
            <ComposerBanner.Count className={cn(passThrough)}>{count}</ComposerBanner.Count>
          ) : null}
          {onToggle ? <Chevron open={open} /> : null}
        </ComposerBanner.Actions>
      ) : null}
    </ComposerBanner.Row>
  );
}

/**
 * The tray's list. It grows and fades in under its header through the shared
 * disclosure panel, scrolls past its own limit or the stack's budget, and is
 * registered with the stack (by `trayId`) so the stack can fold it to fit.
 */
function Body({
  id,
  trayId,
  open,
  shown,
  scrollClassName,
  children,
}: {
  readonly id?: string;
  readonly trayId: ComposerTrayId | null;
  /** The user's choice; the stack budgets only lists the user opened. */
  readonly open: boolean;
  readonly shown: boolean;
  /** Sets the list's own `--composer-banner-scroll-max`. */
  readonly scrollClassName?: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      id={id}
      {...(trayId === null
        ? {}
        : composerStackBodyProps(trayId, COMPOSER_TRAY_FOLD_RANK[trayId], open))}
    >
      <DisclosurePanel open={shown}>
        <ComposerBanner.Scroll className={scrollClassName}>{children}</ComposerBanner.Scroll>
      </DisclosurePanel>
    </div>
  );
}

/** One tray's surface; every tray shares the notices' padding. */
function Root(props: Omit<ComponentProps<typeof ComposerBanner.Root>, "density">) {
  return <ComposerBanner.Root density="comfortable" {...props} />;
}

/** One row in a tray's list, on the header's columns. */
const Item = ComposerBanner.Row;

export const ComposerTray = {
  Root,
  Header,
  Body,
  List: ComposerBanner.Children,
  Item,
};
