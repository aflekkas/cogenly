import { type ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { memo } from "react";
import { CheckIcon, StarIcon } from "lucide-react";
import {
  getDisplayModelName,
  getProviderRowLabel,
  getTriggerDisplayModelLabel,
  type ModelEsque,
} from "./providerIconUtils";
import { ComboboxItem } from "../ui/combobox";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { modelPickerModelKey } from "./modelPickerKeys";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  model: ModelEsque;
  /** Instance the model belongs to — the routing key used in combobox values. */
  instanceId: ProviderInstanceId;
  /** Driver kind of the instance — used for the provider icon glyph. */
  driverKind: ProviderDriverKind;
  /**
   * Display name to show in the secondary line (provider footer). Usually
   * the instance's configured `displayName` so custom instances like
   * "Codex Personal" render with their user-authored label.
   */
  providerDisplayName: string;
  /**
   * The secondary line's provider label when it differs from the display
   * name, e.g. "Claude · Personal" for one of several Claude instances.
   */
  providerLabel?: string | undefined;
  providerAccentColor?: string | undefined;
  /** Dot the provider glyph in the instance's accent color. */
  showInstanceMark?: boolean;
  isFavorite?: boolean;
  /** Renders the row's star; omitted where favorites do not apply. */
  onToggleFavorite?: (() => void) | undefined;
  isSelected: boolean;
  showSelection?: boolean;
  showProvider: boolean;
  preferShortName?: boolean;
  useTriggerLabel?: boolean;
  showNewBadge?: boolean;
  unavailable?: boolean;
  jumpLabel?: string | null;
  disabledReason?: string | null;
}) {
  const providerLabel = getProviderRowLabel(
    props.providerLabel ?? props.providerDisplayName,
    props.model.subProvider,
  );
  const favoriteLabel = props.isFavorite ? "Remove from favorites" : "Add to favorites";

  const row = (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={modelPickerModelKey(props.instanceId, props.model.slug)}
      disabled={Boolean(props.disabledReason)}
      className={cn(
        "group relative w-full !min-w-0 max-w-full cursor-pointer",
        props.disabledReason &&
          "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed",
      )}
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 truncate text-xs font-medium leading-snug">
            {props.useTriggerLabel
              ? getTriggerDisplayModelLabel(props.model)
              : getDisplayModelName(
                  props.model,
                  props.preferShortName ? { preferShortName: true } : undefined,
                )}
          </div>
          {props.showNewBadge ? (
            <span
              className="shrink-0 rounded border border-update/35 bg-update/15 px-0.5 py-px text-3xs font-bold uppercase leading-none tracking-wide text-update-foreground"
              aria-label="New model"
            >
              New
            </span>
          ) : null}
          {props.unavailable ? (
            <Badge variant="outline" size="sm">
              Unavailable
            </Badge>
          ) : null}
        </div>
        {props.showProvider && (
          <div className="mt-1 flex items-center gap-1.5">
            <ProviderInstanceIcon
              driverKind={props.driverKind}
              displayName={props.providerDisplayName}
              accentColor={props.providerAccentColor}
              showBadge={props.showInstanceMark === true}
              className="size-3"
              iconClassName="size-3"
              badgeClassName="size-1.5"
              indicatorBackground="var(--popover)"
            />
            <span className="truncate text-xs font-normal leading-snug text-muted-foreground/70">
              {providerLabel}
            </span>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {props.showSelection && props.isSelected ? (
          <CheckIcon className="size-3.5" aria-hidden="true" />
        ) : null}
        {props.jumpLabel ? <Kbd>{props.jumpLabel}</Kbd> : null}
        {props.onToggleFavorite ? (
          // Shows on hover or highlight and stays while starred; opacity only.
          <span
            className={cn(
              "group/favorite -mr-1 flex transition-opacity duration-(--motion-duration-fast) ease-standard motion-reduce:transition-none",
              props.isFavorite
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 group-data-highlighted:opacity-100 focus-within:opacity-100",
            )}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    onMouseDown={(event) => {
                      // Keep focus on the list so arrows and Enter keep working.
                      event.preventDefault();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onToggleFavorite?.();
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                    }}
                    disabled={Boolean(props.disabledReason)}
                    aria-label={favoriteLabel}
                    aria-pressed={props.isFavorite === true}
                    data-model-favorite-toggle=""
                  >
                    <StarIcon
                      className={cn(
                        "size-3.5 transition-[color,fill,scale] duration-(--motion-duration-fast) ease-standard motion-reduce:transition-none sm:size-3",
                        // Starred models read amber; an empty star warms on hover.
                        props.isFavorite
                          ? "scale-110 fill-current text-warning"
                          : "scale-100 group-hover/favorite:text-warning",
                      )}
                      aria-hidden
                    />
                  </Button>
                }
              />
              <TooltipPopup side="top" align="center">
                {favoriteLabel}
              </TooltipPopup>
            </Tooltip>
          </span>
        ) : null}
      </div>
    </ComboboxItem>
  );

  if (!props.disabledReason) {
    return row;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipPopup side="left" align="center">
        {props.disabledReason}
      </TooltipPopup>
    </Tooltip>
  );
});
