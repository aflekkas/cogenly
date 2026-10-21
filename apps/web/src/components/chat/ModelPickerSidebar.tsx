import { Toolbar } from "@base-ui/react/toolbar";
import { type ProviderInstanceId } from "@t3tools/contracts";
import { memo, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { SparklesIcon, StarIcon, type LucideIcon } from "lucide-react";
import { ProviderInstanceIcon, providerTextColor } from "./ProviderInstanceIcon";
import {
  createTooltipHandle,
  Tooltip,
  TooltipPopup,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import { cn } from "~/lib/utils";
import {
  isProviderInstancePickerReady,
  providerInstanceEntryLabel,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";

/**
 * Build the hover tooltip for an instance button. Mirrors the old
 * kind-based copy but uses the entry's configured `displayName` so custom
 * instances get their user-authored name (e.g. "Codex Personal — Unavailable.").
 */
function describeUnavailableInstance(entry: ProviderInstanceEntry): string {
  const label = entry.displayName;
  if (!entry.enabled || entry.status === "disabled") {
    return `${label} — Disabled in settings.`;
  }
  if (entry.status === "ready" && entry.isAvailable) {
    return label;
  }
  const kind =
    entry.status === "error" ? "Unavailable" : entry.status === "warning" ? "Limited" : "Not ready";
  const msg = entry.snapshot.message?.trim();
  return msg ? `${label} — ${kind}. ${msg}` : `${label} — ${kind}.`;
}

const SELECTED_INDICATOR_CLASS =
  "pointer-events-none absolute -right-1 top-1/2 z-10 h-5 w-0.75 -translate-y-1/2 rounded-l-full";
const BADGE_BASE_CLASS =
  "pointer-events-none absolute -right-0.5 top-0.5 z-10 flex size-3.5 items-center justify-center rounded-full bg-transparent shadow-sm ";
const NEW_BADGE_CLASS = `${BADGE_BASE_CLASS} text-update-foreground `;

/**
 * Rail tooltips open to the right, over the list's leading edge, so they wait
 * out a short hover before showing. The rail's own provider overrides the
 * picker's zero-delay one; the timeout keeps the group warm so moving between
 * icons switches the one shared tooltip at once instead of re-opening it.
 */
const RAIL_TOOLTIP_DELAY = 350;
const RAIL_TOOLTIP_GROUP_TIMEOUT = 400;
/** Fade only: the shared popup's scale-in is for overlays, not for labels. */
const RAIL_TOOLTIP_POPUP_CLASS =
  "scale-100! data-ending-style:scale-100! data-starting-style:scale-100!";
const railTooltipHandle = createTooltipHandle<string>();

/** The rail entry that lists starred models, in the order they were starred. */
export const MODEL_PICKER_FAVORITES = "favorites";
export type ModelPickerRailSelection = ProviderInstanceId | typeof MODEL_PICKER_FAVORITES;

const RAIL_LIST_BUTTON_CLASS =
  "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded-md transition-colors state-hover focus-visible:bg-state-hover focus-visible:outline-none aria-pressed:state-selected";

/** A rail entry for a cross-provider list (Favorites) rather than one instance. */
function RailListButton(props: {
  readonly value: typeof MODEL_PICKER_FAVORITES;
  readonly label: string;
  readonly tooltip: string;
  readonly icon: LucideIcon;
  readonly iconClassName?: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const Icon = props.icon;
  return (
    <div className="relative w-full" data-model-picker-provider={props.value}>
      <TooltipTrigger
        handle={railTooltipHandle}
        payload={props.tooltip}
        render={
          <Toolbar.Button
            className={RAIL_LIST_BUTTON_CLASS}
            onClick={props.onSelect}
            type="button"
            aria-label={props.label}
            aria-pressed={props.selected}
          >
            <Icon className={cn("size-5 shrink-0", props.iconClassName)} aria-hidden />
          </Toolbar.Button>
        }
      />
    </div>
  );
}

export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  selectedInstanceId: ModelPickerRailSelection;
  onSelectInstance: (instanceId: ModelPickerRailSelection) => void;
  /** Shows the Favorites entry at the top. */
  showFavorites?: boolean;
  /** Move focus from the rail into the model list. */
  onFocusList: () => void;
  /**
   * Instance entries to render as rail buttons. Each entry becomes one icon
   * keyed by `instanceId`, so the default built-in Codex and a user-authored
   * `codex_personal` appear as two distinct rail items, each routing to
   * their own model list.
   */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  /** Instance ids shown in the rail but unavailable for the current picker context. */
  disabledInstanceIds?: ReadonlySet<ProviderInstanceId>;
  /** Non-ready instances whose selected unavailable model remains reachable. */
  selectableUnavailableInstanceIds?: ReadonlySet<ProviderInstanceId>;
  getDisabledInstanceTooltip?: (entry: ProviderInstanceEntry) => string;
  /**
   * Instance id values that should render the "new" sparkle badge. Callers
   * pass the subset of default built-in ids they want flagged (custom
   * instances are never flagged — the user just made them).
   */
  newBadgeInstanceIds?: ReadonlySet<ProviderInstanceId>;
}) {
  const handleSelect = (instanceId: ModelPickerRailSelection) => {
    props.onSelectInstance(instanceId);
  };
  const [hoveredInstanceId, setHoveredInstanceId] = useState<ProviderInstanceId | null>(null);
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const [selectedIndicatorTop, setSelectedIndicatorTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const content = sidebarContentRef.current;
    if (!content) {
      return;
    }
    const selectedItem = Array.from(
      content.querySelectorAll<HTMLElement>("[data-model-picker-provider]"),
    ).find((item) => item.dataset.modelPickerProvider === props.selectedInstanceId);
    if (!selectedItem) {
      setSelectedIndicatorTop(null);
      return;
    }
    setSelectedIndicatorTop(selectedItem.offsetTop + selectedItem.offsetHeight / 2 - 10);
  }, [props.instanceEntries, props.selectedInstanceId, props.showFavorites]);

  const selectedEntry = props.instanceEntries.find(
    (entry) => entry.instanceId === props.selectedInstanceId,
  );
  const indicatorColor = selectedEntry ? providerTextColor(selectedEntry.driverKind) : {};

  return (
    <TooltipProvider delay={RAIL_TOOLTIP_DELAY} closeDelay={0} timeout={RAIL_TOOLTIP_GROUP_TIMEOUT}>
      <Toolbar.Root
        className="w-11 shrink-0 overflow-hidden bg-muted/30"
        data-model-picker-sidebar="true"
        aria-label="Providers"
        orientation="vertical"
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          if (event.key === "ArrowRight") {
            event.preventDefault();
            props.onFocusList();
            return;
          }
        }}
      >
        <div className="scroll-fade-y h-full overflow-y-auto overscroll-contain [--scroll-fade-lane:0px] [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div ref={sidebarContentRef} className="relative flex min-h-full flex-col gap-1 p-1">
            {selectedIndicatorTop !== null ? (
              <div
                data-model-picker-selected-indicator="true"
                className={cn(
                  SELECTED_INDICATOR_CLASS,
                  indicatorColor.className ? "bg-current" : "bg-primary",
                  indicatorColor.className,
                  "top-0 right-0 translate-y-(--indicator-y) transition-[translate,background-color] duration-(--motion-duration-base) ease-standard motion-reduce:transition-none",
                )}
                style={
                  {
                    ...indicatorColor.style,
                    "--indicator-y": `${selectedIndicatorTop}px`,
                  } as CSSProperties
                }
              />
            ) : null}
            {props.showFavorites ? (
              <RailListButton
                value={MODEL_PICKER_FAVORITES}
                label="Favorite models"
                tooltip="Favorites"
                icon={StarIcon}
                iconClassName="fill-current text-warning"
                selected={props.selectedInstanceId === MODEL_PICKER_FAVORITES}
                onSelect={() => handleSelect(MODEL_PICKER_FAVORITES)}
              />
            ) : null}
            {props.showFavorites ? (
              <div className="border-b border-border/70" aria-hidden="true" />
            ) : null}
            {/* Instance buttons (one per configured instance — built-in + custom) */}
            {props.instanceEntries.map((entry) => {
              const isUnavailable = !isProviderInstancePickerReady(entry);
              const isContextDisabled = props.disabledInstanceIds?.has(entry.instanceId) ?? false;
              const unavailableSelectionIsReachable =
                props.selectableUnavailableInstanceIds?.has(entry.instanceId) ?? false;
              const isDisabled =
                (isUnavailable && !unavailableSelectionIsReachable) || isContextDisabled;
              const isSelected = props.selectedInstanceId === entry.instanceId;
              const isHovered = hoveredInstanceId === entry.instanceId;
              const showNewBadge = props.newBadgeInstanceIds?.has(entry.instanceId) ?? false;
              const showInstanceBadge = shouldShowInstanceBadge(entry, props.instanceEntries);

              const tooltip = isUnavailable
                ? describeUnavailableInstance(entry)
                : isContextDisabled
                  ? (props.getDisabledInstanceTooltip?.(entry) ?? entry.displayName)
                  : showNewBadge
                    ? `${entry.displayName} — New`
                    : entry.displayName;

              const button = (
                <Toolbar.Button
                  className={cn(
                    "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded-md transition-colors focus-visible:bg-state-hover focus-visible:outline-none aria-pressed:state-selected",
                    isDisabled ? "opacity-50 cursor-not-allowed" : "state-hover",
                  )}
                  data-provider-accent-color={entry.accentColor}
                  onClick={() => !isDisabled && handleSelect(entry.instanceId)}
                  onMouseEnter={() => setHoveredInstanceId(entry.instanceId)}
                  onMouseLeave={() =>
                    setHoveredInstanceId((current) =>
                      current === entry.instanceId ? null : current,
                    )
                  }
                  onFocus={() => setHoveredInstanceId(entry.instanceId)}
                  onBlur={() =>
                    setHoveredInstanceId((current) =>
                      current === entry.instanceId ? null : current,
                    )
                  }
                  disabled={isDisabled}
                  focusableWhenDisabled={!isDisabled}
                  aria-pressed={isSelected}
                  type="button"
                  aria-label={
                    isUnavailable || isContextDisabled
                      ? tooltip
                      : showNewBadge
                        ? `${entry.displayName}, new`
                        : entry.displayName
                  }
                >
                  <ProviderInstanceIcon
                    driverKind={entry.driverKind}
                    displayName={entry.displayName}
                    accentColor={entry.accentColor}
                    showBadge={showInstanceBadge}
                    className="size-6 z-30"
                    iconClassName="size-5"
                    indicatorBackground={
                      isHovered && !isDisabled
                        ? "var(--muted)"
                        : isSelected
                          ? "var(--background)"
                          : "color-mix(in oklab, var(--muted) 30%, transparent)"
                    }
                  />
                  {showNewBadge ? (
                    <span className={NEW_BADGE_CLASS} aria-hidden>
                      <SparklesIcon className="size-2" />
                    </span>
                  ) : null}
                </Toolbar.Button>
              );

              const railTooltip =
                isUnavailable || isContextDisabled ? tooltip : providerInstanceEntryLabel(entry);
              const trigger = isDisabled ? (
                <span className="relative block w-full">{button}</span>
              ) : (
                button
              );

              return (
                <div
                  key={entry.instanceId}
                  className="relative w-full"
                  data-model-picker-provider={entry.instanceId}
                >
                  <TooltipTrigger
                    handle={railTooltipHandle}
                    payload={railTooltip}
                    render={trigger}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </Toolbar.Root>
      <Tooltip handle={railTooltipHandle}>
        {({ payload }) =>
          payload ? (
            <TooltipPopup
              side="right"
              sideOffset={6}
              align="center"
              className={RAIL_TOOLTIP_POPUP_CLASS}
            >
              {payload}
            </TooltipPopup>
          ) : null
        }
      </Tooltip>
    </TooltipProvider>
  );
});
