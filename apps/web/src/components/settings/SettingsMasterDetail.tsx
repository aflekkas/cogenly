import { PlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ScrollArea } from "../ui/scroll-area";
import { SettingsGroup } from "./SettingsGroup";

/**
 * The card's tallest footprint per size. `page` fills a page of its own
 * (Providers), `section` sits among other sections (Integrations, Vault). The
 * card is as tall as its longer pane up to this cap, so a short list never
 * leaves an empty slab and only long content scrolls. Shared with placeholder
 * states.
 */
export const SETTINGS_MASTER_DETAIL_HEIGHT = {
  page: "@min-[48rem]/settings-page:max-h-[calc(100dvh-11rem)]",
  section: "@min-[48rem]/settings-page:max-h-[min(40rem,calc(100dvh-11rem))]",
} as const;

/**
 * A list of things beside the selected one's details: Providers and
 * Integrations. Stacks on a narrow page. `list` takes `SettingsMasterDetailRow`s
 * and a `SettingsMasterDetailAddRow`; `detail` takes `SettingsMasterDetailEditor`
 * or an `Empty size="sm"`.
 */
export function SettingsMasterDetail({
  size,
  list,
  detail,
}: {
  readonly size: keyof typeof SETTINGS_MASTER_DETAIL_HEIGHT;
  readonly list: ReactNode;
  readonly detail: ReactNode;
}) {
  return (
    <SettingsGroup
      divided={false}
      // A flex row, not a grid: a single-line flex container clamps its
      // stretched panes to the max height, so each pane scrolls on its own.
      className={cn(
        SETTINGS_MASTER_DETAIL_HEIGHT[size],
        "overflow-hidden @min-[48rem]/settings-page:flex",
      )}
    >
      <div className="border-b border-border/60 bg-muted/10 @min-[48rem]/settings-page:flex @min-[48rem]/settings-page:min-h-0 @min-[48rem]/settings-page:w-68 @min-[48rem]/settings-page:shrink-0 @min-[48rem]/settings-page:flex-col @min-[48rem]/settings-page:border-r @min-[48rem]/settings-page:border-b-0">
        <ScrollArea
          scrollFade
          chainVerticalScroll
          className="@min-[48rem]/settings-page:min-h-0 @min-[48rem]/settings-page:flex-1"
        >
          <div className="divide-y divide-border/50">{list}</div>
        </ScrollArea>
      </div>
      <div className="min-w-0 @min-[48rem]/settings-page:min-h-0 @min-[48rem]/settings-page:flex-1">
        {detail}
      </div>
    </SettingsGroup>
  );
}

/**
 * The selected entry's details, scrolling on their own. Cards inside it sit
 * flat (border only, no raised surface), so the outer card stays the one
 * raised layer instead of doubling its shadow.
 */
export function SettingsMasterDetailEditor({ children }: { readonly children: ReactNode }) {
  return (
    <ScrollArea scrollFade chainVerticalScroll className="@min-[48rem]/settings-page:h-full">
      {/* Stacked on a narrow page, the nested cards give back their side inset. */}
      <div className="space-y-6 px-2 py-4 @min-[48rem]/settings-page:p-4 [&_[data-settings-group=grouped]]:bg-transparent [&_[data-settings-group=grouped]]:bg-none [&_[data-settings-group=grouped]]:shadow-none">
        {children}
      </div>
    </ScrollArea>
  );
}

/**
 * One entry in the list: icon, name and a status line. The whole row selects
 * it; `trailing` (a switch) and any control in `title` or `description` marked
 * `pointer-events-auto` stay clickable on their own.
 */
export function SettingsMasterDetailRow({
  selected,
  dimmed = false,
  onSelect,
  selectLabel,
  icon,
  title,
  description,
  trailing,
}: {
  readonly selected: boolean;
  /** An entry that is off reads faded until hovered or selected. */
  readonly dimmed?: boolean;
  readonly onSelect?: (() => void) | undefined;
  readonly selectLabel: string;
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly trailing?: ReactNode;
}) {
  return (
    <div
      data-slot="settings-row"
      className={cn(
        "group flex min-h-18 items-center gap-3 px-3 py-3 transition-colors duration-(--motion-duration-fast) ease-out sm:px-4",
        selected ? "bg-muted/45" : "hover:bg-muted/25",
      )}
    >
      <div
        className={cn(
          "pointer-events-none relative flex min-w-0 flex-1 items-start gap-3 rounded-md text-left transition-opacity duration-(--motion-duration-fast) ease-out",
          dimmed && !selected && "opacity-60 group-hover:opacity-100",
        )}
      >
        <button
          type="button"
          className="pointer-events-auto absolute inset-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={onSelect}
          aria-label={selectLabel}
          aria-pressed={selected}
        />
        {icon}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">{title}</span>
          <span className="mt-0.5 flex items-start gap-1.5 text-xs leading-normal text-muted-foreground">
            {description}
          </span>
        </span>
      </div>
      {trailing ? <span className="flex h-5 shrink-0 items-center gap-1">{trailing}</span> : null}
    </div>
  );
}

/** The list's last row, "Add provider": starts adding another entry. */
export function SettingsMasterDetailAddRow({
  disabled = false,
  onClick,
  children,
}: {
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="flex w-full cursor-pointer items-center gap-3 px-3 py-3 text-left text-sm text-muted-foreground transition-colors duration-(--motion-duration-fast) ease-out outline-none hover:bg-muted/25 hover:text-foreground focus-visible:bg-muted/25 focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-60 sm:px-4"
      onClick={onClick}
    >
      <PlusIcon className="size-4 shrink-0" />
      {children}
    </button>
  );
}
